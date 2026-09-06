//! Tauri 命令层（协议 §6 超时表：一般 2s / 电机·流程 6s / ESTOP 3s）

use super::protocol::{Command, MotorGlobalOp, Reply};
use super::state::{CommManager, DeviceState, LogEntry};

const T_FAST: u64 = 2000;
const T_MOTOR: u64 = 6000;

fn parse_side(side: &str) -> Result<char, String> {
    match side.to_uppercase().as_str() {
        "A" => Ok('A'),
        "B" => Ok('B'),
        _ => Err(format!("侧别仅支持 A/B，当前: {}", side)),
    }
}

fn expect_ok(reply: Reply) -> Result<(), String> {
    match reply {
        Reply::Ok { .. } => Ok(()),
        Reply::Err { code, msg, .. } => Err(format!("[{}] {}", code, msg)),
        other => Err(format!("应答异常: {:?}", other)),
    }
}

fn expect_data<T>(reply: Result<Reply, String>, f: impl FnOnce(Reply) -> Option<T>) -> Result<T, String> {
    match reply? {
        Reply::Err { code, msg, .. } => Err(format!("[{}] {}", code, msg)),
        r => f(r).ok_or_else(|| "应答数据异常".to_string()),
    }
}

// ============ 连接管理 ============

#[tauri::command]
pub async fn device_connect(
    ip: String,
    port: u16,
    state: tauri::State<'_, CommManager>,
) -> Result<(), String> {
    state.connect(&ip, port).await
}

#[tauri::command]
pub async fn device_disconnect(state: tauri::State<'_, CommManager>) -> Result<(), String> {
    state.disconnect().await;
    Ok(())
}

#[tauri::command]
pub async fn device_get_state(
    state: tauri::State<'_, CommManager>,
) -> Result<DeviceState, String> {
    Ok(state.get_state().await)
}

#[tauri::command]
pub async fn device_estop(state: tauri::State<'_, CommManager>) -> Result<(), String> {
    // 急停免等待直发，不占用命令串行队列
    state.send_now(Command::Estop).await
}

#[tauri::command]
pub async fn device_info_get(
    state: tauri::State<'_, CommManager>,
) -> Result<serde_json::Value, String> {
    match state.send_and_wait(Command::InfoGet, T_FAST).await? {
        Reply::Info { fw, hw, uptime, ssid } => Ok(serde_json::json!({
            "fw": fw, "hw": hw, "uptime": uptime, "ssid": ssid,
        })),
        Reply::Err { code, msg, .. } => Err(format!("[{}] {}", code, msg)),
        other => Err(format!("应答异常: {:?}", other)),
    }
}

#[tauri::command]
pub async fn device_send_raw(
    command: String,
    state: tauri::State<'_, CommManager>,
) -> Result<(), String> {
    state.send_and_wait(Command::Raw(command), T_FAST).await.map(|_| ())
}

#[tauri::command]
pub async fn device_get_debug_log(
    state: tauri::State<'_, CommManager>,
) -> Result<Vec<LogEntry>, String> {
    Ok(state.get_debug_log().await)
}

// ============ 调试 ============

#[tauri::command]
pub async fn debug_set(
    on: bool,
    state: tauri::State<'_, CommManager>,
) -> Result<(), String> {
    let cmd = if on { Command::DebugOn } else { Command::DebugOff };
    expect_ok(state.send_and_wait(cmd, T_FAST).await?)
}

/// 明文模式切换（协议 §1.3 特殊编排）
#[tauri::command]
pub async fn plain_mode_set(
    enable: bool,
    state: tauri::State<'_, CommManager>,
) -> Result<(), String> {
    state.set_plain_mode(enable).await
}

// ============ SET 参数 ============

#[tauri::command]
pub async fn set_report(hz: u32, state: tauri::State<'_, CommManager>) -> Result<(), String> {
    if !(1..=50).contains(&hz) {
        return Err("频率范围 1-50Hz".into());
    }
    expect_ok(state.send_and_wait(Command::SetReport(hz), T_FAST).await?)
}

#[tauri::command]
pub async fn set_push_pulses_per_mm(v: f64, state: tauri::State<'_, CommManager>) -> Result<(), String> {
    if !(10.0..=10000.0).contains(&v) {
        return Err("脉冲当量范围 10-10000".into());
    }
    expect_ok(state.send_and_wait(Command::SetPushPulsesPerMm(v), T_FAST).await?)
}

#[tauri::command]
pub async fn set_level_ratio(v: f64, state: tauri::State<'_, CommManager>) -> Result<(), String> {
    if !(0.01..=100.0).contains(&v) {
        return Err("传动比范围 0.01-100".into());
    }
    expect_ok(state.send_and_wait(Command::SetLevelRatio(v), T_FAST).await?)
}

// ============ NET 网络配置 ============

#[tauri::command]
pub async fn net_getcfg(state: tauri::State<'_, CommManager>) -> Result<serde_json::Value, String> {
    let reply = state.send_and_wait(Command::NetGetcfg, T_FAST).await;
    expect_data(reply, |r| match r {
        Reply::Netcfg { ssid, pass } => Some(serde_json::json!({ "ssid": ssid, "pass": pass })),
        _ => None,
    })
}

#[tauri::command]
pub async fn net_setcfg(
    old_pass: String,
    new_ssid: String,
    new_pass: String,
    state: tauri::State<'_, CommManager>,
) -> Result<(), String> {
    expect_ok(
        state
            .send_and_wait(
                Command::NetSetcfg { old_pass, new_ssid, new_pass },
                T_FAST,
            )
            .await?,
    )
}

#[tauri::command]
pub async fn net_reset(pass: String, state: tauri::State<'_, CommManager>) -> Result<(), String> {
    expect_ok(state.send_and_wait(Command::NetReset(pass), T_FAST).await?)
}

// ============ PEDAL 踏板 ============

#[tauri::command]
pub async fn pedal_select(side: String, state: tauri::State<'_, CommManager>) -> Result<(), String> {
    let s = side.to_uppercase();
    if !["A", "B", "NONE"].contains(&s.as_str()) {
        return Err("仅支持 A/B/NONE".into());
    }
    expect_ok(state.send_and_wait(Command::PedalSelect(s), T_FAST).await?)
}

#[tauri::command]
pub async fn pedal_start(side: String, state: tauri::State<'_, CommManager>) -> Result<(), String> {
    let s = parse_side(&side)?;
    expect_ok(state.send_and_wait(Command::PedalStart(s), T_MOTOR).await?)
}

#[tauri::command]
pub async fn pedal_stop(side: String, state: tauri::State<'_, CommManager>) -> Result<(), String> {
    let s = parse_side(&side)?;
    expect_ok(state.send_and_wait(Command::PedalStop(s), T_MOTOR).await?)
}

#[tauri::command]
pub async fn pedal_setload(
    side: String,
    load: f64,
    state: tauri::State<'_, CommManager>,
) -> Result<(), String> {
    let s = parse_side(&side)?;
    expect_ok(state.send_and_wait(Command::PedalSetLoad(s, load), T_FAST).await?)
}

#[tauri::command]
pub async fn pedal_level(side: String, state: tauri::State<'_, CommManager>) -> Result<(), String> {
    let s = parse_side(&side)?;
    expect_ok(state.send_and_wait(Command::PedalLevel(s), T_MOTOR).await?)
}

#[tauri::command]
pub async fn pedal_push_start(
    side: String,
    state: tauri::State<'_, CommManager>,
) -> Result<(), String> {
    let s = parse_side(&side)?;
    expect_ok(state.send_and_wait(Command::PedalPushStart(s), T_MOTOR).await?)
}

#[tauri::command]
pub async fn pedal_push_stop(
    side: String,
    state: tauri::State<'_, CommManager>,
) -> Result<(), String> {
    let s = parse_side(&side)?;
    expect_ok(state.send_and_wait(Command::PedalPushStop(s), T_MOTOR).await?)
}

#[tauri::command]
pub async fn pedal_set(
    side: String,
    key: String,
    value: String,
    state: tauri::State<'_, CommManager>,
) -> Result<(), String> {
    let s = parse_side(&side)?;
    expect_ok(
        state
            .send_and_wait(Command::PedalSet { side: s, key, value }, T_FAST)
            .await?,
    )
}

#[tauri::command]
pub async fn pedal_zero(
    side: Option<String>,
    state: tauri::State<'_, CommManager>,
) -> Result<(), String> {
    let s = match side {
        Some(x) => Some(parse_side(&x)?),
        None => None,
    };
    expect_ok(state.send_and_wait(Command::PedalOp { side: s, op: "ZERO".into() }, T_FAST).await?)
}

#[tauri::command]
pub async fn pedal_clear(
    side: Option<String>,
    state: tauri::State<'_, CommManager>,
) -> Result<(), String> {
    let s = match side {
        Some(x) => Some(parse_side(&x)?),
        None => None,
    };
    expect_ok(state.send_and_wait(Command::PedalOp { side: s, op: "CLEAR".into() }, T_FAST).await?)
}

#[tauri::command]
pub async fn pedal_record(
    side: Option<String>,
    state: tauri::State<'_, CommManager>,
) -> Result<(), String> {
    let s = match side {
        Some(x) => Some(parse_side(&x)?),
        None => None,
    };
    expect_ok(state.send_and_wait(Command::PedalOp { side: s, op: "RECORD".into() }, T_FAST).await?)
}

// ============ MOTOR 电机 ============

#[tauri::command]
pub async fn motor_enable(state: tauri::State<'_, CommManager>) -> Result<(), String> {
    expect_ok(state.send_and_wait(Command::MotorGlobal(MotorGlobalOp::Enable), T_FAST).await?)
}

#[tauri::command]
pub async fn motor_disable(state: tauri::State<'_, CommManager>) -> Result<(), String> {
    expect_ok(state.send_and_wait(Command::MotorGlobal(MotorGlobalOp::Disable), T_FAST).await?)
}

#[tauri::command]
pub async fn motor_stop_all(state: tauri::State<'_, CommManager>) -> Result<(), String> {
    expect_ok(state.send_and_wait(Command::MotorGlobal(MotorGlobalOp::Stop), T_MOTOR).await?)
}

#[tauri::command]
pub async fn motor_move(
    axis: String,
    pos: f64,
    feed: Option<f64>,
    state: tauri::State<'_, CommManager>,
) -> Result<(), String> {
    expect_ok(state.send_and_wait(Command::MotorMove { axis, pos, feed }, T_MOTOR).await?)
}

#[tauri::command]
pub async fn motor_moveabs(
    axis: String,
    pos: f64,
    feed: Option<f64>,
    state: tauri::State<'_, CommManager>,
) -> Result<(), String> {
    expect_ok(state.send_and_wait(Command::MotorMoveAbs { axis, pos, feed }, T_MOTOR).await?)
}

#[tauri::command]
pub async fn motor_home(axis: String, state: tauri::State<'_, CommManager>) -> Result<(), String> {
    expect_ok(state.send_and_wait(Command::MotorHome(axis), T_MOTOR).await?)
}

#[tauri::command]
pub async fn motor_stop(axis: String, state: tauri::State<'_, CommManager>) -> Result<(), String> {
    expect_ok(state.send_and_wait(Command::MotorStop(axis), T_MOTOR).await?)
}

#[tauri::command]
pub async fn motor_zero(axis: String, state: tauri::State<'_, CommManager>) -> Result<(), String> {
    expect_ok(state.send_and_wait(Command::MotorZero(axis), T_MOTOR).await?)
}
