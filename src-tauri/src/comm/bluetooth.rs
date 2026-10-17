//! 三通道 BLE 力值管理器（复刻 SSTS bluetooth.rs，单设备 → A/B/STEER 三通道）
//!
//! 三个 BLE 力传感器通道：
//! - `A`：踏板 A 加载力
//! - `B`：踏板 B 加载力
//! - `STEER`：转盘（转向角）力值
//!
//! 各通道独立的连接/特征/状态，共享同一蓝牙适配器。
//! 帧协议见 scale_protocol.rs（nRF52 UART 透传）。

use btleplug::api::{Central, CharPropFlags, Manager as _, Peripheral as _, ScanFilter, WriteType, Characteristic};
use btleplug::platform::{Adapter, Manager, Peripheral};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tauri::AppHandle;
use tauri::Emitter;
use tokio::sync::Mutex;

use super::scale_protocol::{self, ScaleData};

const NUS_RX_CHAR_UUID: &str = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_TX_CHAR_UUID: &str = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

pub const CHANNELS: [&str; 3] = ["A", "B", "STEER"];

// ============ 数据结构 ============

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForceDeviceInfo {
    /// 平台设备标识（macOS 上是 CoreBluetooth UUID；地址在 macOS 全零不可用于匹配）
    pub id: String,
    pub name: String,
    /// 显示用（macOS 上为全零，前端应显示占位）
    pub address: String,
    pub rssi: Option<i16>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ForceChannelState {
    pub is_connected: bool,
    pub device_name: String,
    pub device_address: String,
    /// 最新力值（未连接或无数据时为 None）
    pub latest: Option<ScaleData>,
    /// 会话内最大力值（N）
    pub max_n: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForceDataEvent {
    pub channel: String,
    pub data: ScaleData,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForceConnectionEvent {
    pub channel: String,
    pub state: ForceChannelState,
}

// ============ 通道内部状态 ============

#[derive(Default)]
struct ChannelInner {
    peripheral: Option<Peripheral>,
    write_char: Option<Characteristic>,
    notify_char: Option<Characteristic>,
    is_connected: bool,
    device_name: String,
    device_address: String,
    latest: Option<ScaleData>,
    max_n: f64,
}

impl ChannelInner {
    fn public_state(&self) -> ForceChannelState {
        ForceChannelState {
            is_connected: self.is_connected,
            device_name: self.device_name.clone(),
            device_address: self.device_address.clone(),
            latest: self.latest.clone(),
            max_n: self.max_n,
        }
    }
}

// ============ ForceManager ============

pub struct ForceManager {
    adapter: Arc<Mutex<Option<Adapter>>>,
    channels: Arc<Mutex<HashMap<String, ChannelInner>>>,
}

impl ForceManager {
    pub fn new() -> Self {
        let mut channels = HashMap::new();
        for ch in CHANNELS {
            channels.insert(ch.to_string(), ChannelInner::default());
        }
        Self {
            adapter: Arc::new(Mutex::new(None)),
            channels: Arc::new(Mutex::new(channels)),
        }
    }

    fn normalize_channel(channel: &str) -> Result<String, String> {
        let up = channel.to_uppercase();
        if CHANNELS.contains(&up.as_str()) {
            Ok(up)
        } else {
            Err(format!("未知力值通道: {}（支持 A/B/STEER）", channel))
        }
    }

    async fn ensure_adapter(&self) -> Result<Adapter, String> {
        let mut guard = self.adapter.lock().await;
        if let Some(ref a) = *guard {
            return Ok(a.clone());
        }
        let manager = Manager::new()
            .await
            .map_err(|e| format!("创建蓝牙管理器失败: {}", e))?;
        let adapters = manager
            .adapters()
            .await
            .map_err(|e| format!("获取蓝牙适配器失败: {}", e))?;
        let adapter = adapters
            .into_iter()
            .next()
            .ok_or_else(|| "未找到蓝牙适配器".to_string())?;
        log::info!("[Force] 蓝牙适配器已初始化");
        *guard = Some(adapter.clone());
        Ok(adapter)
    }

    /// 扫描 BLE 设备（约 3 秒，三通道共享）
    pub async fn scan_devices(&self) -> Result<Vec<ForceDeviceInfo>, String> {
        let adapter = self.ensure_adapter().await?;

        log::info!("[Force] 开始扫描 BLE 设备...");
        adapter
            .start_scan(ScanFilter::default())
            .await
            .map_err(|e| format!("启动扫描失败: {}", e))?;
        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
        adapter
            .stop_scan()
            .await
            .map_err(|e| format!("停止扫描失败: {}", e))?;

        let peripherals = adapter
            .peripherals()
            .await
            .map_err(|e| format!("获取设备列表失败: {}", e))?;

        let mut devices = Vec::new();
        for p in peripherals {
            if let Ok(Some(props)) = p.properties().await {
                let name = props.local_name.unwrap_or_default();
                if !name.is_empty() {
                    devices.push(ForceDeviceInfo {
                        id: p.id().to_string(),
                        name,
                        address: props.address.to_string(),
                        rssi: props.rssi,
                    });
                }
            }
        }
        log::info!("[Force] 扫描完成，发现 {} 个有名设备", devices.len());
        Ok(devices)
    }

    /// 连接指定通道到指定设备（device_id = scan 返回的平台标识）
    ///
    /// 全链路带超时（CoreBluetooth 在设备不可达时 connect() 会永久挂起，
    /// 无超时会导致前端 invoke 不返回、按钮永久禁用），任一步失败即清理
    /// 通道状态并上报，保证可立即重试。
    pub async fn connect(&self, channel: &str, device_id: &str, app: AppHandle) -> Result<(), String> {
        let channel = Self::normalize_channel(channel)?;
        let adapter = self.ensure_adapter().await?;

        // 若该通道已连接，先断开
        let _ = self.disconnect(&channel, app.clone()).await;

        let peripherals = tokio::time::timeout(
            tokio::time::Duration::from_secs(5),
            adapter.peripherals(),
        )
        .await
        .map_err(|_| "获取设备列表超时".to_string())?
        .map_err(|e| format!("获取设备列表失败: {}", e))?;

        // 用平台标识匹配（macOS 不暴露 MAC，address 全零不可用）
        let mut target: Option<Peripheral> = None;
        for p in peripherals {
            if p.id().to_string() == device_id {
                target = Some(p);
                break;
            }
        }
        let peripheral = target.ok_or_else(|| {
            format!(
                "未找到设备 {}（设备可能已下线，请重新扫描后再连接）",
                &device_id[..8.min(device_id.len())]
            )
        })?;

        log::info!("[Force:{}] 正在连接设备: {}", channel, device_id);

        // connect 带超时：设备关机/超范围时 CoreBluetooth 会无限等待
        match tokio::time::timeout(
            tokio::time::Duration::from_secs(15),
            peripheral.connect(),
        )
        .await
        {
            Err(_) => {
                self.cleanup_failed_connect(&channel, &peripheral, &app).await;
                return Err(
                    "连接超时（15 秒）——请确认设备已开机、在通信范围内且未被其他程序占用"
                        .to_string(),
                );
            }
            Ok(Err(e)) => {
                self.cleanup_failed_connect(&channel, &peripheral, &app).await;
                return Err(format!("连接设备失败: {}", e));
            }
            Ok(Ok(())) => {}
        }

        match tokio::time::timeout(
            tokio::time::Duration::from_secs(10),
            peripheral.discover_services(),
        )
        .await
        {
            Err(_) => {
                self.cleanup_failed_connect(&channel, &peripheral, &app).await;
                return Err("发现服务超时（10 秒）".to_string());
            }
            Ok(Err(e)) => {
                self.cleanup_failed_connect(&channel, &peripheral, &app).await;
                return Err(format!("发现服务失败: {}", e));
            }
            Ok(Ok(())) => {}
        }

        #[cfg(target_os = "windows")]
        {
            log::info!("[Force:{}] Windows: 等待 GATT 缓存同步...", channel);
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        }

        let services = peripheral.services();
        let mut write_char: Option<Characteristic> = None;
        let mut write_char_no_resp: Option<Characteristic> = None;
        let mut notify_char: Option<Characteristic> = None;

        // 第一轮：精确匹配 nRF52 UART 特征
        for service in &services {
            for characteristic in &service.characteristics {
                let char_uuid = characteristic.uuid.to_string().to_lowercase();
                if char_uuid == NUS_RX_CHAR_UUID {
                    write_char = Some(characteristic.clone());
                }
                if char_uuid == NUS_TX_CHAR_UUID {
                    notify_char = Some(characteristic.clone());
                }
            }
        }

        // 第二轮：按属性回退匹配（兼容自定义 UUID 设备）
        if write_char.is_none() && notify_char.is_none() {
            log::warn!("[Force:{}] 未找到标准 NUS 特征，按属性匹配...", channel);
            for service in &services {
                for characteristic in &service.characteristics {
                    if characteristic.properties.contains(CharPropFlags::NOTIFY) && notify_char.is_none() {
                        notify_char = Some(characteristic.clone());
                    }
                    if characteristic.properties.contains(CharPropFlags::WRITE) && write_char.is_none() {
                        write_char = Some(characteristic.clone());
                    }
                    if characteristic.properties.contains(CharPropFlags::WRITE_WITHOUT_RESPONSE)
                        && write_char_no_resp.is_none()
                    {
                        write_char_no_resp = Some(characteristic.clone());
                    }
                }
            }
        }

        let final_write_char = write_char.or(write_char_no_resp);

        // Notify 特征缺失：清理通道状态并返回
        let notify_c = match notify_char {
            Some(c) => c,
            None => {
                self.cleanup_failed_connect(&channel, &peripheral, &app).await;
                let all_chars: Vec<String> = services
                    .iter()
                    .flat_map(|s| s.characteristics.iter().map(|c| c.uuid.to_string()))
                    .collect();
                return Err(format!(
                    "未找到 Notify 特征，无法接收数据。设备服务特征: {:?}（可能不是力值模块）",
                    all_chars
                ));
            }
        };

        if let Err(_) = tokio::time::timeout(
            tokio::time::Duration::from_secs(5),
            peripheral.subscribe(&notify_c),
        )
        .await
        {
            self.cleanup_failed_connect(&channel, &peripheral, &app).await;
            return Err("订阅通知超时（5 秒）".to_string());
        }

        let device_name = if let Ok(Some(props)) = peripheral.properties().await {
            props
                .local_name
                .unwrap_or_else(|| format!("设备 {}", &device_id[..8.min(device_id.len())]))
        } else {
            format!("设备 {}", &device_id[..8.min(device_id.len())])
        };

        // 探测写入触发 Windows 配对（SSTS 成熟模式）
        if let Some(ref wc) = final_write_char {
            let probe: &[u8] = &[0xAA];
            let wt = if wc.properties.contains(CharPropFlags::WRITE) {
                WriteType::WithResponse
            } else {
                WriteType::WithoutResponse
            };
            if peripheral.write(wc, probe, wt).await.is_err() {
                log::warn!("[Force:{}] 探测写入失败，等待配对后重试...", channel);
                tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
                let _ = peripheral.write(wc, probe, wt).await;
            }
        }

        // 存入通道状态
        {
            let mut channels = self.channels.lock().await;
            let inner = channels.get_mut(&channel).expect("channel exists");
            inner.peripheral = Some(peripheral.clone());
            inner.write_char = final_write_char;
            inner.notify_char = Some(notify_c);
            inner.is_connected = true;
            inner.device_name = device_name.clone();
            inner.device_address = device_id.to_string();
            inner.latest = None;
            inner.max_n = 0.0;
            let _ = app.emit(
                "force-connection-changed",
                ForceConnectionEvent {
                    channel: channel.clone(),
                    state: inner.public_state(),
                },
            );
        }

        log::info!("[Force:{}] 设备已连接: {} ({})", channel, device_name, device_id);

        // 启动通知接收循环
        let channels_arc = self.channels.clone();
        let ch = channel.clone();
        tokio::spawn(async move {
            Self::notification_loop(ch, peripheral, channels_arc, app).await;
        });

        Ok(())
    }

    /// 通知数据接收循环（节流 100ms）
    async fn notification_loop(
        channel: String,
        peripheral: Peripheral,
        channels: Arc<Mutex<HashMap<String, ChannelInner>>>,
        app: AppHandle,
    ) {
        let mut stream = match peripheral.notifications().await {
            Ok(s) => s,
            Err(e) => {
                log::error!("[Force:{}] 获取通知流失败: {}", channel, e);
                return;
            }
        };

        let mut last_emit = Instant::now();
        let throttle = std::time::Duration::from_millis(100);

        while let Some(notification) = stream.next().await {
            {
                let guard = channels.lock().await;
                let connected = guard.get(&channel).map(|c| c.is_connected).unwrap_or(false);
                if !connected {
                    break;
                }
            }

            match scale_protocol::parse_scale_frame(&notification.value) {
                Ok(frame) => {
                    let data: ScaleData = frame.into();
                    let now = Instant::now();
                    if now.duration_since(last_emit) >= throttle {
                        {
                            let mut guard = channels.lock().await;
                            if let Some(inner) = guard.get_mut(&channel) {
                                inner.latest = Some(data.clone());
                                if data.weight_n > inner.max_n {
                                    inner.max_n = data.weight_n;
                                }
                            }
                        }
                        let _ = app.emit(
                            "force-data",
                            ForceDataEvent {
                                channel: channel.clone(),
                                data,
                            },
                        );
                        last_emit = now;
                    }
                }
                Err(e) => {
                    log::error!(
                        "[Force:{}] 帧解析失败: {}, 原始数据: {:02X?}",
                        channel, e, &notification.value
                    );
                    // 诊断事件（节流 1s）：前端可见设备实际发送的数据
                    let now = Instant::now();
                    if now.duration_since(last_emit) >= std::time::Duration::from_millis(1000) {
                        let _ = app.emit(
                            "force-debug",
                            serde_json::json!({
                                "channel": channel,
                                "message": format!(
                                    "收到 {} 字节但非有效帧（{}）: {:02X?}——可能不是力值模块",
                                    notification.value.len(),
                                    e,
                                    &notification.value[..notification.value.len().min(16)]
                                ),
                            }),
                        );
                        last_emit = now;
                    }
                }
            }
        }

        log::info!("[Force:{}] 通知接收循环已结束", channel);

        // 标记断开
        let mut guard = channels.lock().await;
        if let Some(inner) = guard.get_mut(&channel) {
            if inner.is_connected {
                inner.is_connected = false;
                inner.peripheral = None;
                inner.latest = None;
                let _ = app.emit(
                    "force-connection-changed",
                    ForceConnectionEvent {
                        channel: channel.clone(),
                        state: inner.public_state(),
                    },
                );
            }
        }
    }

    /// 连接失败后的通道清理：best-effort 断开底层连接 + 复位状态 + 通知前端
    ///
    /// btleplug 的 Peripheral 实例按地址缓存在 adapter 中，连接失败后若不
    /// 复位 CoreBluetooth 状态，后续对该地址的连接会持续失败。
    async fn cleanup_failed_connect(&self, channel: &str, peripheral: &Peripheral, app: &AppHandle) {
        log::warn!("[Force:{}] 连接失败，清理通道状态", channel);
        // best-effort 断开（3s 超时防止再次挂起）
        let _ = tokio::time::timeout(
            tokio::time::Duration::from_secs(3),
            peripheral.disconnect(),
        )
        .await;
        {
            let mut channels = self.channels.lock().await;
            if let Some(inner) = channels.get_mut(channel) {
                inner.peripheral = None;
                inner.write_char = None;
                inner.notify_char = None;
                inner.is_connected = false;
                inner.latest = None;
                let _ = app.emit(
                    "force-connection-changed",
                    ForceConnectionEvent {
                        channel: channel.to_string(),
                        state: inner.public_state(),
                    },
                );
            }
        }
    }

    /// 断开指定通道
    ///
    /// 先立即标记断开（通知循环自动退出、UI 即时恢复），底层
    /// unsubscribe/disconnect 全部带超时且 best-effort——CoreBluetooth
    /// 对无响应设备执行这些操作同样可能挂起，绝不能阻塞命令返回。
    pub async fn disconnect(&self, channel: &str, app: AppHandle) -> Result<(), String> {
        let channel = Self::normalize_channel(channel)?;

        // 1. 立即标记断开并取出 peripheral（通知循环检测到 is_connected=false 自动退出）
        let (peripheral, notify_c, device_name) = {
            let mut channels = self.channels.lock().await;
            let inner = channels.get_mut(&channel).expect("channel exists");
            inner.is_connected = false;
            let p = inner.peripheral.take();
            inner.write_char = None;
            let nc = inner.notify_char.take();
            inner.latest = None;
            let name = inner.device_name.clone();
            inner.device_name.clear();
            inner.device_address.clear();
            (p, nc, name)
        };

        // 2. 推送状态（UI 即时恢复为未连接）
        {
            let channels = self.channels.lock().await;
            if let Some(inner) = channels.get(&channel) {
                let _ = app.emit(
                    "force-connection-changed",
                    ForceConnectionEvent {
                        channel: channel.clone(),
                        state: inner.public_state(),
                    },
                );
            }
        }

        log::info!("[Force:{}] 已标记断开，开始底层清理: {}", channel, device_name);

        // 3. best-effort 底层清理（带超时，失败/超时都直接放行）
        if let Some(peripheral) = peripheral {
            if let Some(ref nc) = notify_c {
                let _ = tokio::time::timeout(
                    tokio::time::Duration::from_secs(3),
                    peripheral.unsubscribe(nc),
                )
                .await;
            }
            let _ = tokio::time::timeout(
                tokio::time::Duration::from_secs(5),
                peripheral.disconnect(),
            )
            .await;
        }

        log::info!("[Force:{}] 底层清理完成", channel);
        Ok(())
    }

    /// 零点校准（清零）
    pub async fn zero_calibration(&self, channel: &str) -> Result<(), String> {
        let cmd = scale_protocol::build_zero_command();
        self.write_to_device(channel, &cmd).await
    }

    /// 砝码标定（校准）
    pub async fn weight_calibration(&self, channel: &str, weight_g: u32) -> Result<(), String> {
        let cmd = scale_protocol::build_calibrate_command(weight_g);
        self.write_to_device(channel, &cmd).await
    }

    /// 全通道状态
    pub async fn all_states(&self) -> HashMap<String, ForceChannelState> {
        let channels = self.channels.lock().await;
        channels
            .iter()
            .map(|(k, v)| (k.clone(), v.public_state()))
            .collect()
    }

    /// 重置会话最大力值
    pub async fn reset_max(&self, channel: &str) -> Result<(), String> {
        let channel = Self::normalize_channel(channel)?;
        let mut channels = self.channels.lock().await;
        let inner = channels.get_mut(&channel).expect("channel exists");
        inner.max_n = 0.0;
        Ok(())
    }

    /// 写入原始字节（双重写入策略，兼容 Windows BLE 权限模型）
    async fn write_to_device(&self, channel: &str, data: &[u8]) -> Result<(), String> {
        let channel = Self::normalize_channel(channel)?;
        let (peripheral, write_c) = {
            let channels = self.channels.lock().await;
            let inner = channels.get(&channel).expect("channel exists");
            let p = inner.peripheral.as_ref()
                .ok_or_else(|| format!("通道 {} 设备未连接", channel))?.clone();
            let c = inner.write_char.as_ref()
                .ok_or_else(|| "未找到 Write 特征，无法发送命令".to_string())?.clone();
            (p, c)
        };

        let has_write = write_c.properties.contains(CharPropFlags::WRITE);
        let has_write_no_resp = write_c.properties.contains(CharPropFlags::WRITE_WITHOUT_RESPONSE);
        let write_types: Vec<WriteType> = {
            #[cfg(target_os = "windows")]
            {
                match (has_write, has_write_no_resp) {
                    (true, true) => vec![WriteType::WithResponse, WriteType::WithoutResponse],
                    (true, false) => vec![WriteType::WithResponse],
                    (false, true) => vec![WriteType::WithoutResponse],
                    (false, false) => vec![WriteType::WithResponse],
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                match (has_write, has_write_no_resp) {
                    (true, true) => vec![WriteType::WithoutResponse, WriteType::WithResponse],
                    (true, false) => vec![WriteType::WithResponse],
                    (false, true) => vec![WriteType::WithoutResponse],
                    (false, false) => vec![WriteType::WithResponse],
                }
            }
        };

        // 写入带 5s 超时（挂起的 write 同样会阻塞命令返回）
        async fn try_write(
            peripheral: &Peripheral,
            write_c: &Characteristic,
            data: &[u8],
            wt: WriteType,
        ) -> Result<Result<(), btleplug::Error>, tokio::time::error::Elapsed> {
            tokio::time::timeout(
                tokio::time::Duration::from_secs(5),
                peripheral.write(write_c, data, wt),
            )
            .await
        }

        let mut last_error = String::new();
        for write_type in &write_types {
            match try_write(&peripheral, &write_c, data, *write_type).await {
                Ok(Ok(())) => return Ok(()),
                Ok(Err(e)) => last_error = format!("{}", e),
                Err(_) => last_error = "写入超时（5 秒）".to_string(),
            }
        }

        // 首轮失败延迟重试（Windows 配对延迟 / GATT 缓存未同步）
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        for write_type in &write_types {
            match try_write(&peripheral, &write_c, data, *write_type).await {
                Ok(Ok(())) => return Ok(()),
                Ok(Err(e)) => last_error = format!("{}", e),
                Err(_) => last_error = "写入超时（5 秒）".to_string(),
            }
        }

        Err(format!("通道 {} 写入数据失败（含重试）: {}", channel, last_error))
    }
}

impl Default for ForceManager {
    fn default() -> Self {
        Self::new()
    }
}
