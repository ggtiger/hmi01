//! 三通道 BLE 力值 Tauri 命令

use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State};

use super::bluetooth::{ForceChannelState, ForceDeviceInfo, ForceManager};

pub type ForceState = ForceManager;

#[tauri::command]
pub async fn force_scan(state: State<'_, ForceState>) -> Result<Vec<ForceDeviceInfo>, String> {
    state.scan_devices().await
}

#[tauri::command]
pub async fn force_connect(
    channel: String,
    device_id: String,
    state: State<'_, ForceState>,
    app: AppHandle,
) -> Result<(), String> {
    state.connect(&channel, &device_id, app).await
}

#[tauri::command]
pub async fn force_disconnect(
    channel: String,
    state: State<'_, ForceState>,
    app: AppHandle,
) -> Result<(), String> {
    state.disconnect(&channel, app).await
}

#[tauri::command]
pub async fn force_zero(channel: String, state: State<'_, ForceState>) -> Result<(), String> {
    state.zero_calibration(&channel).await
}

#[tauri::command]
pub async fn force_calibrate(
    channel: String,
    weight: u32,
    state: State<'_, ForceState>,
) -> Result<(), String> {
    state.weight_calibration(&channel, weight).await
}

#[tauri::command]
pub async fn force_reset_max(channel: String, state: State<'_, ForceState>) -> Result<(), String> {
    state.reset_max(&channel).await
}

#[tauri::command]
pub async fn force_get_state(
    state: State<'_, ForceState>,
) -> Result<HashMap<String, ForceChannelState>, String> {
    Ok(state.all_states().await)
}

// ============ 手动调试 ============

/// hex 字符串解析为字节（支持空格/冒号分隔）
fn parse_hex_str(hex: &str) -> Result<Vec<u8>, String> {
    let cleaned: String = hex.chars().filter(|c| !c.is_whitespace() && *c != ':').collect();
    if cleaned.is_empty() {
        return Err("数据为空".into());
    }
    if cleaned.len() % 2 != 0 {
        return Err("hex 长度必须为偶数".into());
    }
    let mut out = Vec::with_capacity(cleaned.len() / 2);
    let bytes = cleaned.as_bytes();
    for i in (0..bytes.len()).step_by(2) {
        let hi = (bytes[i] as char).to_digit(16).ok_or_else(|| format!("非法 hex 字符: {}", bytes[i] as char))?;
        let lo = (bytes[i + 1] as char).to_digit(16).ok_or_else(|| format!("非法 hex 字符: {}", bytes[i + 1] as char))?;
        out.push(((hi << 4) | lo) as u8);
    }
    Ok(out)
}

#[tauri::command]
pub async fn force_send_raw(
    channel: String,
    hex: String,
    state: State<'_, ForceState>,
    app: AppHandle,
) -> Result<(), String> {
    let bytes = parse_hex_str(&hex)?;
    state.send_raw_bytes(&channel, &bytes).await?;
    let hex_str: Vec<String> = bytes.iter().map(|b| format!("{:02X}", b)).collect();
    let _ = app.emit(
        "force-debug",
        serde_json::json!({
            "channel": channel,
            "message": format!("TX(手动) → {}（{} 字节）", hex_str.join(" "), bytes.len()),
        }),
    );
    Ok(())
}

#[tauri::command]
pub async fn force_raw_monitor(
    channel: String,
    on: bool,
    state: State<'_, ForceState>,
) -> Result<(), String> {
    state.set_raw_monitor(&channel, on).await
}

/// 二路开关控制（EE 协议，SWITCH 通道）
///
/// action: "on" | "off" | "momentary"（点动约 2s）| "query"（查询当前值）
/// relay: 1 / 2；seconds: 延迟秒数（延迟开/关预留，action 为 delay_on/delay_off 时生效）
#[tauri::command]
pub async fn force_switch_control(
    relay: u8,
    action: String,
    seconds: Option<u16>,
    state: State<'_, ForceState>,
) -> Result<(), String> {
    if !(1..=2).contains(&relay) {
        return Err("路数仅支持 1/2".into());
    }
    let frame = match action.as_str() {
        "on" => super::switch_protocol::build_switch(relay, true),
        "off" => super::switch_protocol::build_switch(relay, false),
        "momentary" => super::switch_protocol::build_momentary(relay),
        "query" => super::switch_protocol::build_query(),
        "delay_on" => super::switch_protocol::build_delayed(
            relay,
            true,
            seconds.ok_or("缺少延迟秒数")?,
        ),
        "delay_off" => super::switch_protocol::build_delayed(
            relay,
            false,
            seconds.ok_or("缺少延迟秒数")?,
        ),
        other => return Err(format!("未知开关操作: {}", other)),
    };
    state.send_raw_bytes("SWITCH", &frame).await
}
