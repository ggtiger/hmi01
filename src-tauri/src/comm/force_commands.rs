//! 三通道 BLE 力值 Tauri 命令

use std::collections::HashMap;
use tauri::{AppHandle, State};

use super::bluetooth::{ForceChannelState, ForceDeviceInfo, ForceManager};

pub type ForceState = ForceManager;

#[tauri::command]
pub async fn force_scan(state: State<'_, ForceState>) -> Result<Vec<ForceDeviceInfo>, String> {
    state.scan_devices().await
}

#[tauri::command]
pub async fn force_connect(
    channel: String,
    address: String,
    state: State<'_, ForceState>,
    app: AppHandle,
) -> Result<(), String> {
    state.connect(&channel, &address, app).await
}

#[tauri::command]
pub async fn force_disconnect(
    channel: String,
    state: State<'_, ForceState>,
) -> Result<(), String> {
    state.disconnect(&channel).await
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
