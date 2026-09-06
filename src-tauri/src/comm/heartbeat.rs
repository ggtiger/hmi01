//! 心跳管理（协议 §1.1/§2.3）
//!
//! - 每 5s 发送 PING（免等待），明文模式下改发明文 PING
//! - 双向 15s 无数据视为超时（3 次 PING 周期），触发断开

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

pub const HEARTBEAT_INTERVAL_SECS: u64 = 5;
pub const DATA_TIMEOUT_SECS: u64 = 15;

pub struct HeartbeatManager {
    pub running: Arc<AtomicBool>,
    /// 最近一次收到任何有效数据的时刻
    pub last_rx: Arc<std::sync::Mutex<Option<Instant>>>,
}

#[allow(dead_code)]
impl HeartbeatManager {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            last_rx: Arc::new(std::sync::Mutex::new(None)),
        }
    }

    /// 收到任何有效数据时调用
    pub fn mark_rx(&self) {
        *self.last_rx.lock().unwrap() = Some(Instant::now());
    }

    /// 启动心跳任务。send_ping: 发送一次 PING（由 CommManager 提供封装好的闭包）
    pub fn start<F>(&self, send_ping: F)
    where
        F: Fn() -> futures::future::BoxFuture<'static, Result<(), String>> + Send + 'static,
    {
        self.running.store(true, Ordering::SeqCst);
        self.mark_rx();
        let running = self.running.clone();
        let last_rx = self.last_rx.clone();

        tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(tokio::time::Duration::from_secs(HEARTBEAT_INTERVAL_SECS));
            interval.tick().await; // 跳过第一个立即 tick

            while running.load(Ordering::SeqCst) {
                interval.tick().await;
                if !running.load(Ordering::SeqCst) {
                    break;
                }

                // 数据超时检测（15s 无任何下行数据）
                {
                    let last = *last_rx.lock().unwrap();
                    if let Some(t) = last {
                        if t.elapsed().as_secs() >= DATA_TIMEOUT_SECS {
                            println!("[Comm] 心跳超时（{}s 无数据）", DATA_TIMEOUT_SECS);
                            break;
                        }
                    }
                }

                if let Err(e) = send_ping().await {
                    println!("[Comm] 心跳发送失败: {}", e);
                    break;
                }
            }
            running.store(false, Ordering::SeqCst);
        });
    }

    /// 是否仍在运行（用于判断心跳超时触发断开）
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// 停止心跳
    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
    }
}

impl Default for HeartbeatManager {
    fn default() -> Self {
        Self::new()
    }
}
