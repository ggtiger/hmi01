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
use super::switch_protocol::{self, SwitchState};
use super::tilt_protocol::{self, AngleData};

const NUS_RX_CHAR_UUID: &str = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_TX_CHAR_UUID: &str = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

pub const CHANNELS: [&str; 5] = ["A", "B", "STEER", "SWITCH", "TORQUE"];

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
    /// STEER 通道：最新倾角（Modbus RTU 读角度）
    pub latest_angle: Option<AngleData>,
    /// SWITCH 通道：两路开关状态
    pub switch_state: Option<SwitchState>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForceDataEvent {
    pub channel: String,
    pub data: ScaleData,
}

/// STEER 通道倾角数据事件
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SteerAngleEvent {
    pub channel: String,
    pub angle_x: f64,
    pub angle_y: f64,
}

/// SWITCH 通道开关状态事件
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchStateEvent {
    pub channel: String,
    pub state: SwitchState,
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
    /// WCH 透传模块配置特征（FFF3，波特率/Modem 设置）
    config_write_char: Option<Characteristic>,
    notify_char: Option<Characteristic>,
    is_connected: bool,
    device_name: String,
    device_address: String,
    latest: Option<ScaleData>,
    max_n: f64,
    /// STEER：最新倾角 + 接收缓冲（透传流重组）
    latest_angle: Option<AngleData>,
    /// SWITCH：两路开关状态
    switch_state: Option<SwitchState>,
    /// 最近一次收到角度帧的时刻（波特率校准用）
    last_angle_at: Option<Instant>,
    /// 手动调试：原始数据监视（每帧通知的原始 hex 全量上报）
    debug_raw: bool,
    rx_buf: Vec<u8>,
}

impl ChannelInner {
    fn public_state(&self) -> ForceChannelState {
        ForceChannelState {
            is_connected: self.is_connected,
            device_name: self.device_name.clone(),
            device_address: self.device_address.clone(),
            latest: self.latest.clone(),
            max_n: self.max_n,
            latest_angle: self.latest_angle.clone(),
            switch_state: self.switch_state.clone(),
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
            Err(format!(
                "未知力值通道: {}（支持 A/B/STEER/SWITCH/TORQUE）",
                channel
            ))
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
    ///
    /// 设备查找：适配器缓存中没有该 id 时（应用重启后/断开较久后缓存为空）
    /// 自动扫描 3 秒再找，用户无需手动点「扫描」即可重连。
    pub async fn connect(&self, channel: &str, device_id: &str, app: AppHandle) -> Result<(), String> {
        let channel = Self::normalize_channel(channel)?;
        let adapter = self.ensure_adapter().await?;

        // 若该通道已连接，先断开
        let _ = self.disconnect(&channel, app.clone()).await;

        // 用平台标识匹配（macOS 不暴露 MAC，address 全零不可用）
        let find_by_id = |peripherals: &[btleplug::platform::Peripheral]| {
            peripherals
                .iter()
                .find(|p| p.id().to_string() == device_id)
                .cloned()
        };

        let peripherals = tokio::time::timeout(
            tokio::time::Duration::from_secs(5),
            adapter.peripherals(),
        )
        .await
        .map_err(|_| "获取设备列表超时".to_string())?
        .map_err(|e| format!("获取设备列表失败: {}", e))?;
        let mut target = find_by_id(&peripherals);

        // 缓存中没有 → 自动扫描 3 秒再找（重连开箱即用）
        if target.is_none() {
            log::info!(
                "[Force:{}] 设备不在适配器缓存中，自动扫描 3 秒...",
                channel
            );
            let scan_result = tokio::time::timeout(
                tokio::time::Duration::from_secs(8),
                async {
                    adapter.start_scan(ScanFilter::default()).await?;
                    tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
                    adapter.stop_scan().await?;
                    adapter.peripherals().await
                },
            )
            .await;
            match scan_result {
                Ok(Ok(peripherals)) => {
                    target = find_by_id(&peripherals);
                }
                Ok(Err(e)) => log::warn!("[Force:{}] 自动扫描失败: {}", channel, e),
                Err(_) => log::warn!("[Force:{}] 自动扫描超时", channel),
            }
        }

        let peripheral = target.ok_or_else(|| {
            format!(
                "未找到设备 {}（设备可能已下线或不可达，请确认已开机后重试）",
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

        // ---- 特征发现（WCH 透传模块感知）----
        // WCH BLE 串口模块（CH9140 等，WCHBLEWxJsLib 约定）：
        //   FFF2 = 数据写入（用户数据 → 串口）；
        //   FFF3 = 配置写入（波特率/Modem 命令，发用户数据会被静默丢弃！）
        //   数据通知在其余 notify 特征上。
        // 策略：NUS 精确 → FFF2 → 其他 WRITE（排除 FFF3）→ WRITE_WITHOUT_RESPONSE → FFF3 兜底
        let mut write_char: Option<Characteristic> = None;
        let mut write_char_no_resp: Option<Characteristic> = None;
        let mut config_write_char: Option<Characteristic> = None;
        let mut notify_candidates: Vec<Characteristic> = Vec::new();

        // 第一轮：精确匹配 nRF52 UART 特征
        for service in &services {
            for characteristic in &service.characteristics {
                let u = characteristic.uuid.to_string().to_lowercase();
                if u == NUS_RX_CHAR_UUID {
                    write_char = Some(characteristic.clone());
                }
                if u == NUS_TX_CHAR_UUID {
                    notify_candidates.insert(0, characteristic.clone());
                }
            }
        }

        // 第二轮：属性 + WCH UUID 优先级
        if write_char.is_none() {
            log::info!("[Force:{}] 未找到 NUS 特征，按属性/WCH 约定匹配...", channel);
            for service in &services {
                for c in &service.characteristics {
                    let u = c.uuid.to_string().to_lowercase();
                    let has_w = c.properties.contains(CharPropFlags::WRITE);
                    let has_wnr = c.properties.contains(CharPropFlags::WRITE_WITHOUT_RESPONSE);
                    let has_n = c.properties.contains(CharPropFlags::NOTIFY)
                        || c.properties.contains(CharPropFlags::INDICATE);
                    if has_n {
                        notify_candidates.push(c.clone());
                    }
                    if !has_w && !has_wnr {
                        continue;
                    }
                    if u.contains("fff2") {
                        if write_char.is_none() {
                            write_char = Some(c.clone());
                        }
                    } else if u.contains("fff3") {
                        // WCH 配置特征：只作兜底，绝不优先
                        if config_write_char.is_none() {
                            config_write_char = Some(c.clone());
                        }
                    } else if write_char.is_none() {
                        if has_w {
                            write_char = Some(c.clone());
                        } else if write_char_no_resp.is_none() {
                            write_char_no_resp = Some(c.clone());
                        }
                    }
                }
            }
            // 只有 FFF3 可写时才兜底使用（同时保留为配置特征）
            if write_char.is_none() {
                write_char = config_write_char.clone();
            }
        }
        let final_write_char = write_char.or(write_char_no_resp);

        if notify_candidates.is_empty() {
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

        // 订阅所有 notify/indicate 特征（WCH 模块数据/配置应答可能分属不同特征）
        let mut subscribed = 0usize;
        for nc in &notify_candidates {
            if tokio::time::timeout(
                tokio::time::Duration::from_secs(5),
                peripheral.subscribe(nc),
            )
            .await
            .map(|r| r.is_ok())
            .unwrap_or(false)
            {
                subscribed += 1;
            } else {
                log::warn!("[Force:{}] 订阅特征 {} 失败", channel, nc.uuid);
            }
        }
        if subscribed == 0 {
            self.cleanup_failed_connect(&channel, &peripheral, &app).await;
            return Err("订阅通知失败（所有特征均超时）".to_string());
        }
        log::info!(
            "[Force:{}] 已订阅 {} 个通知特征；写入特征: {}",
            channel,
            subscribed,
            final_write_char
                .as_ref()
                .map(|c| c.uuid.to_string())
                .unwrap_or_else(|| "无".into())
        );
        let notify_c = notify_candidates[0].clone();

        let device_name = if let Ok(Some(props)) = peripheral.properties().await {
            props
                .local_name
                .unwrap_or_else(|| format!("设备 {}", &device_id[..8.min(device_id.len())]))
        } else {
            format!("设备 {}", &device_id[..8.min(device_id.len())])
        };

        // 探测写入触发 Windows 配对（SSTS 成熟模式）
        // STEER 跳过：0xAA 会经 WCH 透传进传感器制造串口噪音
        if channel != "STEER" {
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
        }

        // 存入通道状态
        {
            let mut channels = self.channels.lock().await;
            let inner = channels.get_mut(&channel).expect("channel exists");
            inner.peripheral = Some(peripheral.clone());
            inner.write_char = final_write_char.clone();
            inner.config_write_char = config_write_char.clone();
            inner.notify_char = Some(notify_c);
            inner.is_connected = true;
            inner.device_name = device_name.clone();
            inner.device_address = device_id.to_string();
            inner.latest = None;
            inner.max_n = 0.0;
            inner.latest_angle = None;
            inner.switch_state = None;
            inner.rx_buf.clear();
            let _ = app.emit(
                "force-connection-changed",
                ForceConnectionEvent {
                    channel: channel.clone(),
                    state: inner.public_state(),
                },
            );
        }

        log::info!("[Force:{}] 设备已连接: {} ({})", channel, device_name, device_id);

        // 特征清单诊断：前端通道卡可见，便于排查"写到哪个口、听哪个口"
        {
            let fmt_char = |c: &Option<Characteristic>| {
                c.as_ref()
                    .map(|x| x.uuid.to_string())
                    .unwrap_or_else(|| "无".into())
            };
            let notify_uuids: Vec<String> =
                notify_candidates.iter().map(|c| c.uuid.to_string()).collect();
            let _ = app.emit(
                "force-debug",
                serde_json::json!({
                    "channel": channel,
                    "message": format!(
                        "已连接。写特征: {} | 配置特征: {} | 通知特征: {:?}",
                        fmt_char(&final_write_char),
                        fmt_char(&config_write_char),
                        notify_uuids
                    ),
                }),
            );
        }

        // STEER 通道：读取 WCH 模块当前串口配置（诊断波特率状态）
        if channel == "STEER" {
            if let Some(ref cfg_c) = config_write_char {
                if cfg_c.properties.contains(CharPropFlags::READ) {
                    match tokio::time::timeout(
                        tokio::time::Duration::from_secs(3),
                        peripheral.read(cfg_c),
                    )
                    .await
                    {
                        Ok(Ok(data)) => {
                            let hex: Vec<String> =
                                data.iter().map(|b| format!("{:02X}", b)).collect();
                            let _ = app.emit(
                                "force-debug",
                                serde_json::json!({
                                    "channel": channel,
                                    "message": format!(
                                        "模块当前串口配置（FFF3 读回）: {}（88 应答帧的字节 4-5 为配置位）",
                                        hex.join(" ")
                                    ),
                                }),
                            );
                        }
                        Ok(Err(e)) => log::warn!("[Force:STEER] 读取模块配置失败: {}", e),
                        Err(_) => log::warn!("[Force:STEER] 读取模块配置超时"),
                    }
                }
            }
        }

        // 启动通知接收循环
        let peripheral_for_notify = peripheral.clone();
        let channels_arc = self.channels.clone();
        let ch = channel.clone();
        let app_notify = app.clone();
        tokio::spawn(async move {
            Self::notification_loop(ch, peripheral_for_notify, channels_arc, app_notify).await;
        });

        // STEER 通道：启动读角度轮询（Modbus RTU 问答式，10Hz）+ 波特率自动校准
        if channel == "STEER" {
            if let Some(wc) = final_write_char {
                let peripheral_for_poll = peripheral.clone();
                let channels_arc2 = self.channels.clone();
                let ch2 = channel.clone();
                let app2 = app.clone();
                tokio::spawn(async move {
                    Self::steer_polling_loop(ch2, peripheral_for_poll, wc, channels_arc2, app2).await;
                });
                // 波特率校准：确保模块 UART 与传感器一致（先 115200，无应答再试 9600）
                if let Some(cfg_c) = config_write_char {
                    let channels_arc3 = self.channels.clone();
                    let ch3 = channel.clone();
                    let app3 = app.clone();
                    tokio::spawn(async move {
                        Self::steer_baud_calibration(ch3, peripheral, cfg_c, channels_arc3, app3)
                            .await;
                    });
                }
            } else {
                log::warn!("[Force:STEER] 无 Write 特征，无法轮询读角度");
            }
        }

        Ok(())
    }

    /// STEER 波特率自动校准：确保 WCH 透传 UART 与传感器波特率一致
    ///
    /// 流程：设 115200 → 观察是否收到角度帧 → 无则试 9600 → 仍无则恢复
    /// 115200 并诊断（说明问题不在波特率，需查传感器地址/接线/供电）。
    async fn steer_baud_calibration(
        channel: String,
        peripheral: Peripheral,
        cfg_c: Characteristic,
        channels: Arc<Mutex<HashMap<String, ChannelInner>>>,
        app: AppHandle,
    ) {
        let wt = if cfg_c.properties.contains(CharPropFlags::WRITE) {
            WriteType::WithResponse
        } else {
            WriteType::WithoutResponse
        };
        let emit = |app: &AppHandle, msg: String| {
            let _ = app.emit(
                "force-debug",
                serde_json::json!({ "channel": channel, "message": msg }),
            );
        };

        // 已有角度帧（上次会话残留的缓冲快速命中）则无需校准
        tokio::time::sleep(tokio::time::Duration::from_millis(2500)).await;
        let has_angle = channels
            .lock()
            .await
            .get(&channel)
            .and_then(|c| c.last_angle_at)
            .is_some();
        if has_angle {
            emit(&app, "✅ 已收到角度数据（波特率 115200 匹配）".into());
            return;
        }

        emit(
            &app,
            "未收到角度帧，尝试切换透传波特率为 9600（传感器出厂默认）...".into(),
        );
        let cfg = tilt_protocol::build_wch_uart_config(9600, 8, 1, 0);
        if tokio::time::timeout(
            tokio::time::Duration::from_secs(3),
            peripheral.write(&cfg_c, &cfg, wt),
        )
        .await
        .map(|r| r.is_ok())
        .unwrap_or(false)
        {
            // 模块应用配置 + 观察窗口
            tokio::time::sleep(tokio::time::Duration::from_millis(2500)).await;
            let has_angle = channels
                .lock()
                .await
                .get(&channel)
                .and_then(|c| c.last_angle_at)
                .map(|t| Instant::now().duration_since(t).as_secs() < 3)
                .unwrap_or(false);
            if has_angle {
                emit(&app, "✅ 9600 波特率下已收到角度数据（传感器实际为 9600，已保存）".into());
                return;
            }
        } else {
            emit(&app, "9600 配置写入失败".into());
        }

        // 都不通：恢复 115200（用户设定的目标值）
        let restore = tilt_protocol::build_wch_uart_config(115200, 8, 1, 0);
        let _ = tokio::time::timeout(
            tokio::time::Duration::from_secs(3),
            peripheral.write(&cfg_c, &restore, wt),
        )
        .await;
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        emit(
            &app,
            "⚠ 115200 / 9600 均未收到角度帧——问题不在波特率。请检查：①传感器供电与 RS485 A/B 接线 ②Modbus 从站地址 ③用厂家调试软件直连验证传感器".into(),
        );
    }

    /// STEER 通道轮询：周期发送 Modbus 读角度命令（应答经通知流异步返回）
    ///
    /// 写失败连续超过 5 次自动停止（设备断开时由通知循环/断开逻辑收尾）。
    async fn steer_polling_loop(
        channel: String,
        peripheral: Peripheral,
        write_c: Characteristic,
        channels: Arc<Mutex<HashMap<String, ChannelInner>>>,
        app: AppHandle,
    ) {
        let cmd = tilt_protocol::build_read_angle_command();
        let wt = if write_c.properties.contains(CharPropFlags::WRITE) {
            WriteType::WithResponse
        } else {
            WriteType::WithoutResponse
        };
        // 发送命令诊断（节流 2s，避免 10Hz 轮询刷屏）：前端可见 TX 帧内容
        let cmd_hex: Vec<String> = cmd.iter().map(|b| format!("{:02X}", b)).collect();
        let cmd_hex = cmd_hex.join(" ");
        let mut last_tx_debug = Instant::now() - std::time::Duration::from_secs(10);
        let mut interval = tokio::time::interval(tokio::time::Duration::from_millis(100));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        interval.tick().await; // 跳过首个立即 tick
        let mut consecutive_errors = 0u32;

        loop {
            // 检查连接状态
            {
                let guard = channels.lock().await;
                let connected = guard.get(&channel).map(|c| c.is_connected).unwrap_or(false);
                if !connected {
                    break;
                }
            }

            match tokio::time::timeout(
                tokio::time::Duration::from_secs(2),
                peripheral.write(&write_c, &cmd, wt),
            )
            .await
            {
                Ok(Ok(())) => {
                    consecutive_errors = 0;
                    // TX 诊断（节流 2s）
                    let now = Instant::now();
                    if now.duration_since(last_tx_debug) >= std::time::Duration::from_millis(2000) {
                        let _ = app.emit(
                            "force-debug",
                            serde_json::json!({
                                "channel": channel,
                                "message": format!("TX → {}（读 X/Y 角度，10Hz 轮询）", cmd_hex),
                            }),
                        );
                        last_tx_debug = now;
                    }
                }
                Ok(Err(e)) => {
                    consecutive_errors += 1;
                    if consecutive_errors <= 3 {
                        log::warn!("[Force:{}] 读角度命令写入失败: {}", channel, e);
                    }
                }
                Err(_) => consecutive_errors += 1,
            }
            if consecutive_errors >= 5 {
                log::error!("[Force:{}] 读角度连续写入失败 {} 次，停止轮询", channel, consecutive_errors);
                let _ = app.emit(
                    "force-debug",
                    serde_json::json!({
                        "channel": channel,
                        "message": "读角度命令连续写入失败，已停止轮询（请断开重连）",
                    }),
                );
                break;
            }
            interval.tick().await;
        }
        log::info!("[Force:{}] 读角度轮询已结束", channel);
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
                // 手动调试：原始数据监视（全量上报，无节流）
                if guard.get(&channel).map(|c| c.debug_raw).unwrap_or(false) {
                    if let Some(app) = Some(&app) {
                        let hex: Vec<String> = notification
                            .value
                            .iter()
                            .map(|b| format!("{:02X}", b))
                            .collect();
                        let _ = app.emit(
                            "force-debug",
                            serde_json::json!({
                                "channel": channel,
                                "message": format!(
                                    "RX ← {} ({} 字节, 特征 {})",
                                    hex.join(" "),
                                    notification.value.len(),
                                    notification.uuid
                                ),
                            }),
                        );
                    }
                }
            }

            // SWITCH 通道：EE 协议开关应答解析
            if channel == "SWITCH" {
                match switch_protocol::parse_switch_frame(&notification.value) {
                    Ok(Some(st)) => {
                        let now = Instant::now();
                        if now.duration_since(last_emit) >= throttle {
                            {
                                let mut guard = channels.lock().await;
                                if let Some(inner) = guard.get_mut(&channel) {
                                    inner.switch_state = Some(st.clone());
                                }
                            }
                            let _ = app.emit(
                                "switch-state",
                                SwitchStateEvent {
                                    channel: channel.clone(),
                                    state: st,
                                },
                            );
                            last_emit = now;
                        }
                    }
                    Ok(None) => {} // 非本协议帧（调试模式已在上方上报）
                    Err(e) => {
                        let now = Instant::now();
                        if now.duration_since(last_emit) >= std::time::Duration::from_millis(2000) {
                            log::warn!("[Force:SWITCH] 应答解析失败: {}", e);
                            last_emit = now;
                        }
                    }
                }
                continue;
            }

            // STEER 通道：Modbus RTU 倾角流解析（透传流含分帧/夹带，用缓冲重组）
            if channel == "STEER" {
                let new_bytes = notification.value;

                // WCH 模块自身应答识别（JS 库约定）：
                //   88 开头 7 字节 = 串口配置应答（对波特率配置命令的回应）
                //   87 开头 8 字节 = Modem 状态应答
                // 这些是模块正常应答，直接消费掉，不算解析错误
                if (new_bytes.first() == Some(&0x88) && new_bytes.len() == 7)
                    || (new_bytes.first() == Some(&0x87) && new_bytes.len() == 8)
                {
                    let now = Instant::now();
                    if now.duration_since(last_emit) >= std::time::Duration::from_millis(2000) {
                        let hex: Vec<String> =
                            new_bytes.iter().map(|b| format!("{:02X}", b)).collect();
                        let _ = app.emit(
                            "force-debug",
                            serde_json::json!({
                                "channel": channel,
                                "message": format!(
                                    "RX ← WCH 模块{}（正常应答，非传感器数据）: {}",
                                    if new_bytes[0] == 0x88 { "串口配置应答" } else { "Modem 状态应答" },
                                    hex.join(" ")
                                ),
                            }),
                        );
                        last_emit = now;
                    }
                    continue;
                }

                {
                    let mut guard = channels.lock().await;
                    if let Some(inner) = guard.get_mut(&channel) {
                        inner.rx_buf.extend_from_slice(&new_bytes);
                        if inner.rx_buf.len() > 256 {
                            // 异常流保护：只保留末尾可能构成帧的部分
                            let keep = tilt_protocol::ANGLE_REPLY_LEN - 1;
                            let l = inner.rx_buf.len();
                            inner.rx_buf.drain(..l - keep);
                        }
                        match tilt_protocol::parse_angle_stream(&inner.rx_buf) {
                            Ok(Some((angle, consumed))) => {
                                inner.rx_buf.drain(..consumed);
                                inner.latest_angle = Some(angle.clone());
                                inner.last_angle_at = Some(Instant::now());
                                let now = Instant::now();
                                if now.duration_since(last_emit) >= throttle {
                                    let _ = app.emit(
                                        "steer-angle-data",
                                        SteerAngleEvent {
                                            channel: channel.clone(),
                                            angle_x: angle.angle_x,
                                            angle_y: angle.angle_y,
                                        },
                                    );
                                    last_emit = now;
                                }
                            }
                            Ok(None) => {
                                // 收到数据但不足一帧：诊断上报原始字节（节流 2s）
                                let now = Instant::now();
                                if now.duration_since(last_emit) >= std::time::Duration::from_millis(2000) {
                                    let _ = app.emit(
                                        "force-debug",
                                        serde_json::json!({
                                            "channel": channel,
                                            "message": format!(
                                                "RX ← 已收到数据但未解析出角度帧（缓冲 {} 字节）: {:02X?}",
                                                inner.rx_buf.len(),
                                                &inner.rx_buf[..inner.rx_buf.len().min(24)]
                                            ),
                                        }),
                                    );
                                    last_emit = now;
                                }
                            }
                            Err((drop_n, msg)) => {
                                let hex: Vec<String> = new_bytes
                                    .iter()
                                    .take(16)
                                    .map(|b| format!("{:02X}", b))
                                    .collect();
                                inner.rx_buf.drain(..drop_n.min(inner.rx_buf.len()));
                                let now = Instant::now();
                                if now.duration_since(last_emit) >= std::time::Duration::from_millis(2000) {
                                    log::warn!("[Force:{}] 倾角流丢弃 {} 字节: {}", channel, drop_n, msg);
                                    let _ = app.emit(
                                        "force-debug",
                                        serde_json::json!({
                                            "channel": channel,
                                            "message": format!(
                                                "RX ← 非 Modbus 角度帧（{}）: {}——若持续出现，可能是透传波特率与传感器不匹配",
                                                msg,
                                                hex.join(" ")
                                            ),
                                        }),
                                    );
                                    last_emit = now;
                                }
                            }
                        }
                    }
                }
                continue;
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

    /// 手动调试：向通道写特征发送原始字节
    pub async fn send_raw_bytes(&self, channel: &str, data: &[u8]) -> Result<(), String> {
        self.write_to_device(channel, data).await
    }

    /// 手动调试：开关原始数据监视（每帧通知的原始 hex 全量上报 force-debug）
    pub async fn set_raw_monitor(&self, channel: &str, on: bool) -> Result<(), String> {
        let channel = Self::normalize_channel(channel)?;
        let mut channels = self.channels.lock().await;
        let inner = channels.get_mut(&channel).expect("channel exists");
        inner.debug_raw = on;
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
