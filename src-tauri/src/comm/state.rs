//! CommManager：连接编排、命令-应答匹配（pending 表）、加密收发、状态分发
//!
//! 关键并发设计：
//! - crypto 用 tokio::sync::Mutex，tx_nonce 分配与 socket 写同临界区（保证 nonce 顺序 = 线序）
//! - cmd_mutex 串行化 send_and_wait（协议 §2.1：除 PING/ESTOP 外命令须串行）
//! - pending: HashMap<命令头, oneshot::Sender<Reply>>，超时即清理防串包

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use super::connection::DeviceConnection;
use super::crypto::Crypto;
use super::heartbeat::HeartbeatManager;
use super::protocol::{command_head, parse_reply, Command, Reply, TelemetryData};

// ============ 对外状态结构 ============

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DeviceInfo {
    pub fw: String,
    pub hw: String,
    pub uptime: u64,
    pub ssid: String,
    /// 新固件 INFO 上报的板侧 A / B
    #[serde(default)]
    pub side: String,
}

/// 设备状态（snake_case 字段直接暴露给前端）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceState {
    /// 所属板侧 A / B（双板模式下前端据此路由）
    #[serde(default)]
    pub board: String,
    pub is_connected: bool,
    pub plain_mode: bool,
    pub device_id: String,
    pub fw_version: String,
    pub info: Option<DeviceInfo>,
    pub telemetry: TelemetryData,
    /// GET PARAMS 返回的参数（最近一次）
    #[serde(default)]
    pub params: HashMap<String, String>,
    /// 最近一次 PONG 心跳时间（本地 HH:MM:SS）
    #[serde(default)]
    pub last_pong: Option<String>,
    /// 最近一次命令错误（ERR 应答说明）
    pub last_error: Option<String>,
}

impl Default for DeviceState {
    fn default() -> Self {
        DeviceState {
            board: String::new(),
            is_connected: false,
            plain_mode: false,
            device_id: String::new(),
            fw_version: String::new(),
            info: None,
            telemetry: TelemetryData::default(),
            params: HashMap::new(),
            last_pong: None,
            last_error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    #[serde(default)]
    pub board: String,
    pub timestamp: String,
    pub direction: String,
    pub content: String,
}

const CLIENT_ID: &str = "xdesin-host";
const MAX_LOG_ENTRIES: usize = 1000;
/// 遥测 emit 节流（~20Hz）
const TELEMETRY_EMIT_INTERVAL_MS: u128 = 50;

// ============ CommManager ============

pub struct CommManager {
    /// 板侧标识 A / B
    board: String,
    connection: tokio::sync::Mutex<DeviceConnection>,
    /// 加密上下文（tokio Mutex：发送时跨 await 持锁，保证 nonce 顺序=写序）
    crypto: tokio::sync::Mutex<Crypto>,
    heartbeat: HeartbeatManager,
    state: tokio::sync::RwLock<DeviceState>,
    debug_log: tokio::sync::RwLock<Vec<LogEntry>>,
    /// 命令头 → 应答发送端
    pending: std::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<Reply>>>,
    /// 命令串行化
    cmd_mutex: tokio::sync::Mutex<()>,
    telemetry_emit_gate: std::sync::Mutex<Option<Instant>>,
    telemetry_log_gate: std::sync::Mutex<Option<Instant>>,
    /// 主动断开标记（区分心跳超时断开）
    manual_disconnect: Arc<AtomicBool>,
    app_handle: tokio::sync::OnceCell<tauri::AppHandle>,
}

/// A/B 双板管理：两块板各自独立 TCP、加密上下文、心跳与遥测
pub struct BoardMap {
    pub a: CommManager,
    pub b: CommManager,
}

impl BoardMap {
    pub fn new() -> Self {
        Self {
            a: CommManager::new("A"),
            b: CommManager::new("B"),
        }
    }

    /// 按板侧取通信管理器（不区分大小写）
    pub fn get(&self, side: &str) -> Result<&CommManager, String> {
        match side.trim().to_uppercase().as_str() {
            "A" => Ok(&self.a),
            "B" => Ok(&self.b),
            _ => Err(format!("板侧仅支持 A/B，当前: {}", side)),
        }
    }

    pub fn set_app_handle(&self, handle: tauri::AppHandle) {
        self.a.set_app_handle(handle.clone());
        self.b.set_app_handle(handle);
    }
}

impl Default for BoardMap {
    fn default() -> Self {
        Self::new()
    }
}

impl CommManager {
    pub fn new(board: impl Into<String>) -> Self {
        let board = board.into();
        Self {
            board: board.clone(),
            connection: tokio::sync::Mutex::new(DeviceConnection::new()),
            crypto: tokio::sync::Mutex::new(Crypto::new()),
            heartbeat: HeartbeatManager::new(),
            state: tokio::sync::RwLock::new(DeviceState {
                board: board.clone(),
                ..Default::default()
            }),
            debug_log: tokio::sync::RwLock::new(Vec::new()),
            pending: std::sync::Mutex::new(HashMap::new()),
            cmd_mutex: tokio::sync::Mutex::new(()),
            telemetry_emit_gate: std::sync::Mutex::new(None),
            telemetry_log_gate: std::sync::Mutex::new(None),
            manual_disconnect: Arc::new(AtomicBool::new(false)),
            app_handle: tokio::sync::OnceCell::new(),
        }
    }

    pub fn set_app_handle(&self, handle: tauri::AppHandle) {
        let _ = self.app_handle.set(handle);
    }

    // ============ 连接编排 ============

    /// 完整连接流程：TCP → 复位加密 → HELLO → INFO → SET REPORT → 心跳
    pub async fn connect(&self, ip: &str, port: u16) -> Result<(), String> {
        // 1. TCP 连接
        {
            let mut conn = self.connection.lock().await;
            conn.connect(ip, port).await?;
        }
        // 2. 复位加密上下文（重连 nonce 双方都归零，明文模式复位）
        {
            let mut crypto = self.crypto.lock().await;
            crypto.reset();
        }
        self.manual_disconnect.store(false, Ordering::SeqCst);
        {
            let mut state = self.state.write().await;
            *state = DeviceState {
                board: self.board.clone(),
                is_connected: true,
                ..Default::default()
            };
            self.emit_state(&state);
        }
        self.add_log("SYS", &format!("TCP 已连接 {}:{}", ip, port)).await;

        // 3. 启动接收循环
        let (line_tx, line_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        {
            let conn = self.connection.lock().await;
            if let Some(stream) = conn.get_stream() {
                DeviceConnection::start_receive_loop(stream, conn.running.clone(), line_tx);
            }
        }

        // 4. 启动后台消息处理任务
        self.spawn_message_handler(line_rx);

        // 5. 握手 HELLO（旧固件 HELLO <client_id>；新固件允许裸 HELLO，失败时回退）
        let first = self.send_and_wait(Command::Hello(CLIENT_ID.into()), 2000).await;
        let hello_reply = if matches!(&first, Ok(Reply::HelloOk { .. })) {
            first
        } else {
            self.send_and_wait(Command::Hello(String::new()), 2000).await
        };
        match &hello_reply {
            Ok(Reply::HelloOk { device_id, fw }) => {
                let mut state = self.state.write().await;
                state.device_id = device_id.clone();
                state.fw_version = fw.clone();
                self.emit_state(&state);
            }
            _ => {
                self.disconnect().await;
                return Err("HELLO 应答异常".to_string());
            }
        }

        // 6. 查询设备信息（新固件用裸 INFO，旧固件回退 INFO GET）
        let info = self.send_and_wait(Command::Info, 2000).await;
        let info_reply = if matches!(&info, Ok(Reply::Info { .. })) {
            info
        } else {
            self.send_and_wait(Command::InfoGet, 2000).await
        };
        if let Ok(Reply::Info { fw, hw, uptime, ssid, side }) = info_reply {
            let mut state = self.state.write().await;
            state.info = Some(DeviceInfo { fw, hw, uptime, ssid, side });
            self.emit_state(&state);
        }

        // 7. 设置遥测频率（默认 10Hz）
        let _ = self.send_and_wait(Command::SetReport(10), 2000).await;

        self.add_log("SYS", "握手完成，启动心跳").await;

        // 8. 启动心跳 + 断开监听
        self.start_heartbeat();
        self.spawn_heartbeat_watcher();

        Ok(())
    }

    /// 断开连接
    pub async fn disconnect(&self) {
        self.manual_disconnect.store(true, Ordering::SeqCst);
        self.heartbeat.stop();

        // 清空 pending（所有等待方收到通道关闭错误）
        self.pending.lock().unwrap().clear();

        {
            let mut conn = self.connection.lock().await;
            conn.disconnect().await;
        }
        {
            let mut crypto = self.crypto.lock().await;
            crypto.reset();
        }

        {
            let mut state = self.state.write().await;
            state.is_connected = false;
            state.plain_mode = false;
            state.last_pong = None;
            // 断开后清空遥测，避免合并视图中残留上一帧数据
            state.telemetry = TelemetryData::default();
            self.emit_state(&state);
        }
        self.add_log("SYS", "已断开连接").await;
    }

    #[allow(dead_code)]
    pub async fn is_connected(&self) -> bool {
        self.connection.lock().await.is_connected()
    }

    // ============ 发送 ============

    /// 发送一行（自动按当前模式加密封装；force_plain=true 时强制明文发出）
    /// crypto 锁跨 await 持有：保证 tx_nonce 分配顺序 = 线上字节顺序
    async fn send_line(&self, plaintext: &str, force_plain: bool) -> Result<(), String> {
        let mut crypto = self.crypto.lock().await;
        let wire = if crypto.plain_mode || force_plain {
            plaintext.to_string()
        } else {
            crypto.encrypt_line(plaintext.as_bytes())
        };
        let conn = self.connection.lock().await;
        if !conn.is_connected() {
            return Err("未连接".to_string());
        }
        conn.send_line(&wire).await
    }

    /// 发送命令并等待应答（串行化 + pending 匹配）
    pub async fn send_and_wait(&self, cmd: Command, timeout_ms: u64) -> Result<Reply, String> {
        let frame = cmd.to_frame();
        let head = command_head(&cmd);
        if head.is_empty() {
            // Raw 命令（调试手发）无应答匹配，应答异步出现在日志中
            self.send_line(&frame, false).await?;
            self.add_log("TX", &frame).await;
            return Ok(Reply::Unknown(String::new()));
        }

        let _guard = self.cmd_mutex.lock().await;

        let (tx, rx) = tokio::sync::oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            // 同头旧 pending 直接被替换（超时残留防串包）
            pending.insert(head.clone(), tx);
        }

        if let Err(e) = self.send_line(&frame, false).await {
            self.pending.lock().unwrap().remove(&head);
            return Err(e);
        }
        self.add_log("TX", &frame).await;

        match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(reply)) => Ok(reply),
            Ok(_) => Err("应答通道关闭".to_string()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&head);
                self.add_log("SYS", &format!("命令超时({}ms): {}", timeout_ms, frame)).await;
                Err(format!("命令超时({}ms): {}", timeout_ms, frame))
            }
        }
    }

    /// 免等待直发（ESTOP / SCAN / PING）
    pub async fn send_now(&self, cmd: Command) -> Result<(), String> {
        let frame = cmd.to_frame();
        self.send_line(&frame, false).await?;
        self.add_log("TX", &frame).await;
        Ok(())
    }

    /// 心跳 PING（明文模式自动发明文 PING，协议 §1.3）
    pub async fn send_ping(&self) -> Result<(), String> {
        self.send_line("PING", false).await
    }

    /// 明文模式切换（协议 §1.3 编排）：
    /// - ON：收到 OK（最后一帧加密）后才翻 plain_mode
    /// - OFF：明文发出后立即翻回加密，再等加密 OK
    pub async fn set_plain_mode(&self, enable: bool) -> Result<(), String> {
        if enable {
            let reply = self.send_and_wait(Command::DebugPlainOn, 2000).await?;
            match reply {
                Reply::Ok { head, .. } if head == "DEBUG" => {
                    self.crypto.lock().await.plain_mode = true;
                    let mut state = self.state.write().await;
                    state.plain_mode = true;
                    self.emit_state(&state);
                    Ok(())
                }
                _ => Err("DEBUG PLAIN ON 应答异常".to_string()),
            }
        } else {
            let _guard = self.cmd_mutex.lock().await;
            let (tx, rx) = tokio::sync::oneshot::channel();
            self.pending.lock().unwrap().insert("DEBUG".into(), tx);

            // 明文发出 PLAIN OFF
            if let Err(e) = self.send_line("DEBUG PLAIN OFF", true).await {
                self.pending.lock().unwrap().remove("DEBUG");
                return Err(e);
            }
            self.add_log("TX", "DEBUG PLAIN OFF").await;
            // 发出后立即切回加密
            self.crypto.lock().await.plain_mode = false;

            match tokio::time::timeout(Duration::from_millis(2000), rx).await {
                Ok(Ok(_)) => {
                    let mut state = self.state.write().await;
                    state.plain_mode = false;
                    self.emit_state(&state);
                    Ok(())
                }
                Ok(_) => Err("应答通道关闭".to_string()),
                Err(_) => {
                    self.pending.lock().unwrap().remove("DEBUG");
                    Err("命令超时(2000ms): DEBUG PLAIN OFF".to_string())
                }
            }
        }
    }

    // ============ 心跳 ============

    fn start_heartbeat(&self) {
        let app = self.app_handle.get().cloned();
        let board = self.board.clone();
        self.heartbeat.start(move || {
            let app = app.clone();
            let board = board.clone();
            Box::pin(async move {
                match app {
                    Some(app) => {
                        let maps = app.state::<BoardMap>();
                        match board.as_str() {
                            "A" => maps.a.send_ping().await,
                            "B" => maps.b.send_ping().await,
                            _ => Err("未知板侧".into()),
                        }
                    }
                    None => Err("AppHandle 未初始化".into()),
                }
            })
        });
    }

    /// 心跳停止且非主动断开 → 心跳超时，触发断开
    fn spawn_heartbeat_watcher(&self) {
        let app = self.app_handle.get().cloned();
        let running = self.heartbeat.running.clone();
        let manual = self.manual_disconnect.clone();
        let board = self.board.clone();
        tokio::spawn(async move {
            // 等待心跳任务结束
            while running.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            if !manual.load(Ordering::SeqCst) {
                if let Some(app) = app {
                    let maps = app.state::<BoardMap>();
                    let manager = match board.as_str() {
                        "A" => &maps.a,
                        "B" => &maps.b,
                        _ => return,
                    };
                    manager.add_log("SYS", "心跳超时，连接断开").await;
                    manager.disconnect().await;
                }
            }
        });
    }

    // ============ 接收处理 ============

    fn spawn_message_handler(&self, mut line_rx: tokio::sync::mpsc::UnboundedReceiver<String>) {
        let app_handle = self.app_handle.get().cloned();
        let board = self.board.clone();

        tokio::spawn(async move {
            while let Some(raw) = line_rx.recv().await {
                if let Some(ref app) = app_handle {
                    let maps = app.state::<BoardMap>();
                    let manager = match board.as_str() {
                        "A" => &maps.a,
                        "B" => &maps.b,
                        _ => continue,
                    };
                    manager.handle_raw_line(raw).await;
                }
            }
        });
    }

    /// 解密 + 分发一行
    async fn handle_raw_line(&self, raw: String) {
        // 解密（加密模式下收到非加密行视为异常丢弃）
        let decoded = {
            let mut crypto = self.crypto.lock().await;
            if crypto.plain_mode {
                // 双模式收包：形似加密帧的行尝试解密，否则按明文
                if Crypto::looks_encrypted(&raw) {
                    match crypto.decrypt_line(&raw) {
                        Ok(Some(pt)) => Some(String::from_utf8_lossy(&pt).to_string()),
                        Ok(None) => Some(raw), // HMAC 不过 → 按明文处理
                        Err(e) => {
                            self.add_log("SYS", &e).await;
                            None
                        }
                    }
                } else {
                    Some(raw)
                }
            } else {
                match crypto.decrypt_line(&raw) {
                    Ok(Some(pt)) => Some(String::from_utf8_lossy(&pt).to_string()),
                    Ok(None) => {
                        self.add_log("RX", &format!("[非加密行丢弃] {}", truncate(&raw, 80))).await;
                        None
                    }
                    Err(e) => {
                        self.add_log("SYS", &e).await;
                        None
                    }
                }
            }
        };
        let line = match decoded {
            Some(l) => l,
            None => return,
        };

        // 有效数据 → 重置心跳超时
        self.heartbeat.mark_rx();

        let reply = parse_reply(&line);
        self.dispatch(reply, &line).await;
    }

    async fn dispatch(&self, reply: Reply, raw_line: &str) {
        match reply {
            Reply::Telemetry(t) => {
                self.handle_telemetry(t).await;
            }
            Reply::DebugEvent(mut ev) => {
                self.add_log("RX", raw_line).await;
                ev.board = self.board.clone();
                if let Some(app) = self.app_handle.get() {
                    let _ = app.emit("pedal-event", &ev);
                }
            }
            Reply::HelloOk { device_id, fw } => {
                self.add_log("RX", raw_line).await;
                {
                    let mut state = self.state.write().await;
                    state.device_id = device_id.clone();
                    state.fw_version = fw.clone();
                    state.last_error = None;
                }
                self.resolve_pending("HELLO", Reply::HelloOk { device_id, fw });
            }
            Reply::Info { fw, hw, uptime, ssid, side } => {
                self.add_log("RX", raw_line).await;
                {
                    let mut state = self.state.write().await;
                    state.info = Some(DeviceInfo {
                        fw: fw.clone(),
                        hw: hw.clone(),
                        uptime,
                        ssid: ssid.clone(),
                        side: side.clone(),
                    });
                    state.last_error = None;
                    self.emit_state(&state);
                }
                self.resolve_pending(
                    "INFO",
                    Reply::Info { fw, hw, uptime, ssid, side },
                );
            }
            Reply::Params(params) => {
                self.add_log("RX", raw_line).await;
                let mut state = self.state.write().await;
                state.params = params;
                self.emit_state(&state);
            }
            Reply::Netcfg { ssid, pass } => {
                self.add_log("RX", raw_line).await;
                self.resolve_pending("NET", Reply::Netcfg { ssid, pass });
            }
            Reply::Ok { head, rest } => {
                self.add_log("RX", raw_line).await;
                let head_clone = head.clone();
                self.resolve_pending(&head_clone, Reply::Ok { head, rest });
            }
            Reply::Err { head, code, msg } => {
                self.add_log("RX", raw_line).await;
                {
                    let mut state = self.state.write().await;
                    state.last_error = Some(format!("[{}] {} {}", head, code, msg));
                }
                let head_clone = head.clone();
                self.resolve_pending(&head_clone, Reply::Err { head, code, msg });
            }
            Reply::Pong => {
                // 心跳应答：更新时间并推送给前端（A/B 各自独立）
                {
                    let mut state = self.state.write().await;
                    state.last_pong = Some(chrono::Local::now().format("%H:%M:%S").to_string());
                    self.emit_state(&state);
                }
                self.add_log("RX", "PONG").await;
            }
            Reply::Unknown(_) => {
                self.add_log("RX", raw_line).await;
            }
        }
    }

    fn resolve_pending(&self, head: &str, reply: Reply) {
        if let Some(sender) = self.pending.lock().unwrap().remove(head) {
            let _ = sender.send(reply);
        }
    }

    async fn handle_telemetry(&self, t: TelemetryData) {
        {
            let mut state = self.state.write().await;
            state.telemetry = t.clone();
        }
        // emit 节流 ~20Hz（状态数据始终更新，只是事件发布限频）
        let should_emit = {
            let mut gate = self.telemetry_emit_gate.lock().unwrap();
            let now = Instant::now();
            let emit = match *gate {
                Some(last) => now.duration_since(last).as_millis() >= TELEMETRY_EMIT_INTERVAL_MS,
                None => true,
            };
            if emit {
                *gate = Some(now);
            }
            emit
        };
        if should_emit {
            let state = self.state.read().await.clone();
            self.emit_state(&state);
        }
        // 遥测采样记日志：约 1s 一条（10Hz 时每 10 帧取 1），防刷屏同时可观测数据流
        let should_log = {
            let mut gate = self.telemetry_log_gate.lock().unwrap();
            let now = Instant::now();
            let log = match *gate {
                Some(last) => now.duration_since(last).as_millis() >= 1000,
                None => true,
            };
            if log {
                *gate = Some(now);
            }
            log
        };
        if should_log {
            let line = super::protocol::telemetry_to_line(&t);
            self.add_log("RX", &truncate(&line, 110)).await;
        }
    }

    // ============ 状态 / 日志 ============

    pub async fn get_state(&self) -> DeviceState {
        self.state.read().await.clone()
    }

    fn emit_state(&self, state: &DeviceState) {
        if let Some(app) = self.app_handle.get() {
            let _ = app.emit("device-state-changed", state);
        }
    }

    pub async fn add_log(&self, direction: &str, content: &str) {
        let entry = LogEntry {
            board: self.board.clone(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            direction: direction.to_string(),
            content: content.to_string(),
        };
        if let Some(app) = self.app_handle.get() {
            let _ = app.emit("device-debug-log", &entry);
        }
        let mut log = self.debug_log.write().await;
        log.push(entry);
        if log.len() > MAX_LOG_ENTRIES {
            let drain = log.len() - MAX_LOG_ENTRIES;
            log.drain(..drain);
        }
    }

    pub async fn get_debug_log(&self) -> Vec<LogEntry> {
        self.debug_log.read().await.clone()
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        format!("{}...", &s[..n])
    }
}
