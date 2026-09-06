//! TCP 连接管理：连接（10s 超时 + nodelay）、分行接收
//!
//! 接收循环只负责按 '\n' 切行，解密与解析由 CommManager 完成。

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Mutex;

pub struct DeviceConnection {
    stream: Option<Arc<Mutex<TcpStream>>>,
    pub ip: String,
    pub port: u16,
    pub running: Arc<AtomicBool>,
}

impl DeviceConnection {
    pub fn new() -> Self {
        Self {
            stream: None,
            ip: String::new(),
            port: 0,
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    /// 建立 TCP 连接，set_nodelay(true)，10 秒超时
    pub async fn connect(&mut self, ip: &str, port: u16) -> Result<(), String> {
        let addr = format!("{}:{}", ip, port);
        let stream = tokio::time::timeout(
            tokio::time::Duration::from_secs(10),
            TcpStream::connect(&addr),
        )
        .await
        .map_err(|_| format!("连接超时（10秒）: {}", addr))?
        .map_err(|e| format!("TCP 连接失败 {}: {}", addr, e))?;

        stream
            .set_nodelay(true)
            .map_err(|e| format!("设置 NoDelay 失败: {}", e))?;

        self.ip = ip.to_string();
        self.port = port;
        self.running.store(true, Ordering::SeqCst);
        self.stream = Some(Arc::new(Mutex::new(stream)));

        Ok(())
    }

    /// 断开连接
    pub async fn disconnect(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(stream) = self.stream.take() {
            let mut guard = stream.lock().await;
            let _ = guard.shutdown().await;
        }
    }

    pub fn is_connected(&self) -> bool {
        self.stream.is_some() && self.running.load(Ordering::SeqCst)
    }

    /// 获取 stream 引用
    pub fn get_stream(&self) -> Option<Arc<Mutex<TcpStream>>> {
        self.stream.clone()
    }

    /// 写入一行（data 不含 '\n'，此处补上）
    pub async fn send_line(&self, data: &str) -> Result<(), String> {
        let frame = format!("{}\n", data);
        match &self.stream {
            Some(stream) => {
                let mut guard = stream.lock().await;
                guard
                    .write_all(frame.as_bytes())
                    .await
                    .map_err(|e| format!("发送失败: {}", e))?;
                guard
                    .flush()
                    .await
                    .map_err(|e| format!("flush 失败: {}", e))?;
                Ok(())
            }
            None => Err("未连接".to_string()),
        }
    }

    /// 启动异步接收任务：按 '\n' 切行后把原始行发送到通道
    pub fn start_receive_loop(
        stream: Arc<Mutex<TcpStream>>,
        running: Arc<AtomicBool>,
        tx: tokio::sync::mpsc::UnboundedSender<String>,
    ) {
        tokio::spawn(async move {
            let mut buf = [0u8; 8192];
            let mut remainder: Vec<u8> = Vec::new();

            while running.load(Ordering::SeqCst) {
                let read_result = {
                    let mut guard = stream.lock().await;
                    tokio::select! {
                        result = guard.read(&mut buf) => result,
                        _ = tokio::time::sleep(tokio::time::Duration::from_millis(100)) => {
                            continue;
                        }
                    }
                };

                match read_result {
                    Ok(0) => {
                        println!("[Comm] TCP 连接已关闭");
                        running.store(false, Ordering::SeqCst);
                        break;
                    }
                    Ok(n) => {
                        remainder.extend_from_slice(&buf[..n]);

                        // 按 \n 分行提取完整帧
                        while let Some(pos) = remainder.iter().position(|&b| b == b'\n') {
                            let line_bytes: Vec<u8> = remainder.drain(..=pos).collect();
                            let line = String::from_utf8_lossy(&line_bytes[..pos])
                                .replace('\r', "")
                                .trim()
                                .to_string();
                            if line.is_empty() {
                                continue;
                            }
                            if tx.send(line).is_err() {
                                running.store(false, Ordering::SeqCst);
                                return;
                            }
                        }
                    }
                    Err(e) => {
                        if running.load(Ordering::SeqCst) {
                            println!("[Comm] 接收错误: {}", e);
                        }
                        running.store(false, Ordering::SeqCst);
                        break;
                    }
                }
            }
        });
    }
}
