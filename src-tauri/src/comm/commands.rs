//! Tauri 命令层（协议 §6 超时表：一般 2s / 电机·流程 6s / ESTOP 3s）
//!
//! 双板模式：BoardMap 管理 A/B 两块独立下位机，命令按板侧路由；
//! 全局参数（SET REPORT 等）与全局停止类命令同时下发两块板。

use super::protocol::{Command, MotorGlobalOp, Reply};
use super::state::{BoardMap, DeviceState, LogEntry};

const T_FAST: u64 = 2000;
const T_MOTOR: u64 = 6000;

fn parse_side(side: &str) -> Result<char, String> {
    match side.to_uppercase().as_str() {
        "A" => Ok('A'),
        "B" => Ok('B'),
        _ => Err(format!("侧别仅支持 A/B，当前: {}", side)),
    }
}

/// MOTOR 轴 → 所属板侧：A/PUSH_A → A；B/PUSH_B → B
fn axis_side(axis: &str) -> Result<&'static str, String> {
    match axis.to_uppercase().as_str() {
        "A" | "PUSH_A" => Ok("A"),
        "B" | "PUSH_B" => Ok("B"),
        other => Err(format!("未知轴名: {}", other)),
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

/// 同一命令下发两块板；任一块成功即视为成功（离线板忽略）
async fn send_both(state: &BoardMap, cmd: Command, timeout_ms: u64) -> Result<(), String> {
    let mut any_ok = false;
    let mut last_err = String::from("未连接");
    for (label, mgr) in [("A", &state.a), ("B", &state.b)] {
        match mgr.send_and_wait(cmd.clone(), timeout_ms).await {
            Ok(reply) => match expect_ok(reply) {
                Ok(()) => any_ok = true,
                Err(e) => last_err = format!("{} 板: {}", label, e),
            },
            Err(e) => last_err = format!("{} 板: {}", label, e),
        }
    }
    if any_ok {
        Ok(())
    } else {
        Err(last_err)
    }
}

/// 免等待命令下发两块板（ESTOP 等）
async fn send_now_both(state: &BoardMap, cmd: Command) -> Result<(), String> {
    let mut any_ok = false;
    let mut last_err = String::from("未连接");
    for (label, mgr) in [("A", &state.a), ("B", &state.b)] {
        match mgr.send_now(cmd.clone()).await {
            Ok(()) => any_ok = true,
            Err(e) => last_err = format!("{} 板: {}", label, e),
        }
    }
    if any_ok {
        Ok(())
    } else {
        Err(last_err)
    }
}

// ============ 连接管理（按板独立） ============

#[tauri::command]
pub async fn device_connect(
    side: String,
    ip: String,
    port: u16,
    state: tauri::State<'_, BoardMap>,
) -> Result<(), String> {
    state.get(&side)?.connect(&ip, port).await
}

#[tauri::command]
pub async fn device_disconnect(
    side: String,
    state: tauri::State<'_, BoardMap>,
) -> Result<(), String> {
    state.get(&side)?.disconnect().await;
    Ok(())
}

#[tauri::command]
pub async fn device_get_state(
    side: String,
    state: tauri::State<'_, BoardMap>,
) -> Result<DeviceState, String> {
    Ok(state.get(&side)?.get_state().await)
}

/// 两块板当前状态（前端启动时初始化）
#[tauri::command]
pub async fn device_get_board_states(
    state: tauri::State<'_, BoardMap>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "a": state.a.get_state().await,
        "b": state.b.get_state().await,
    }))
}

#[tauri::command]
pub async fn device_estop(state: tauri::State<'_, BoardMap>) -> Result<(), String> {
    // 急停免等待直发，两块板同时下发
    send_now_both(&state, Command::Estop).await
}

#[tauri::command]
pub async fn device_info_get(
    side: String,
    state: tauri::State<'_, BoardMap>,
) -> Result<serde_json::Value, String> {
    let mgr = state.get(&side)?;
    // 新固件用裸 INFO；旧固件回退 INFO GET
    let first = mgr.send_and_wait(Command::Info, T_FAST).await;
    let reply = if matches!(&first, Ok(Reply::Info { .. })) {
        first
    } else {
        mgr.send_and_wait(Command::InfoGet, T_FAST).await
    };
    expect_data(reply, |r| match r {
        Reply::Info { fw, hw, uptime, ssid, side } => Some(serde_json::json!({
            "fw": fw, "hw": hw, "uptime": uptime, "ssid": ssid, "side": side,
        })),
        _ => None,
    })
}

#[tauri::command]
pub async fn device_send_raw(
    side: String,
    command: String,
    state: tauri::State<'_, BoardMap>,
) -> Result<(), String> {
    state
        .get(&side)?
        .send_and_wait(Command::Raw(command), T_FAST)
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn device_get_debug_log(
    state: tauri::State<'_, BoardMap>,
) -> Result<Vec<LogEntry>, String> {
    let mut logs = state.a.get_debug_log().await;
    logs.extend(state.b.get_debug_log().await);
    logs.sort_by(|x, y| x.timestamp.cmp(&y.timestamp));
    Ok(logs)
}

// ============ 调试 ============

#[tauri::command]
pub async fn debug_set(
    side: String,
    on: bool,
    state: tauri::State<'_, BoardMap>,
) -> Result<(), String> {
    let cmd = if on { Command::DebugOn } else { Command::DebugOff };
    expect_ok(state.get(&side)?.send_and_wait(cmd, T_FAST).await?)
}

/// 明文模式切换（协议 §1.3 特殊编排，按板独立）
#[tauri::command]
pub async fn plain_mode_set(
    side: String,
    enable: bool,
    state: tauri::State<'_, BoardMap>,
) -> Result<(), String> {
    state.get(&side)?.set_plain_mode(enable).await
}

// ============ SET 参数 ============

#[tauri::command]
pub async fn set_report(hz: u32, state: tauri::State<'_, BoardMap>) -> Result<(), String> {
    if !(1..=50).contains(&hz) {
        return Err("频率范围 1-50Hz".into());
    }
    send_both(&state, Command::SetReport(hz), T_FAST).await
}

#[tauri::command]
pub async fn set_push_pulses_per_mm(v: f64, state: tauri::State<'_, BoardMap>) -> Result<(), String> {
    if !(10.0..=10000.0).contains(&v) {
        return Err("脉冲当量范围 10-10000".into());
    }
    send_both(&state, Command::SetPushPulsesPerMm(v), T_FAST).await
}

#[tauri::command]
pub async fn set_push_feed(v: f64, state: tauri::State<'_, BoardMap>) -> Result<(), String> {
    if !(1.0..=500.0).contains(&v) {
        return Err("推杆速度范围 1-500 RPM".into());
    }
    send_both(&state, Command::SetPushFeed(v), T_FAST).await
}

#[tauri::command]
pub async fn set_level_speed(v: f64, state: tauri::State<'_, BoardMap>) -> Result<(), String> {
    if !(1.0..=360.0).contains(&v) {
        return Err("调平速度范围 1-360".into());
    }
    send_both(&state, Command::SetLevelSpeed(v), T_FAST).await
}

/// 补正模式：1=一体倾角闭环，2=分离初始角度 ± 倾角
#[tauri::command]
pub async fn set_level_method(
    method: u8,
    state: tauri::State<'_, BoardMap>,
) -> Result<(), String> {
    if method != 1 && method != 2 {
        return Err("补正模式仅支持 1/2".into());
    }
    send_both(&state, Command::SetLevelMethod(method), T_FAST).await
}

#[tauri::command]
pub async fn set_level_tol(v: f64, state: tauri::State<'_, BoardMap>) -> Result<(), String> {
    if !(0.001..=5.0).contains(&v) {
        return Err("调平死区范围 0.001-5".into());
    }
    send_both(&state, Command::SetLevelTol(v), T_FAST).await
}

#[tauri::command]
pub async fn set_level_ratio(v: f64, state: tauri::State<'_, BoardMap>) -> Result<(), String> {
    if !(0.01..=100.0).contains(&v) {
        return Err("传动比范围 0.01-100".into());
    }
    send_both(&state, Command::SetLevelRatio(v), T_FAST).await
}

/// 清除指定板侧 MSH 角度软零点（SET MSH_ZERO_CLEAR）
#[tauri::command]
pub async fn set_msh_zero_clear(
    side: String,
    state: tauri::State<'_, BoardMap>,
) -> Result<(), String> {
    expect_ok(
        state
            .get(&side)?
            .send_and_wait(Command::SetMshZeroClear, T_FAST)
            .await?,
    )
}

/// 运行时修改板侧（SET SIDE A|B，写 NVS，重启后仍生效）
#[tauri::command]
pub async fn set_board_side(
    side: String,
    new_side: String,
    state: tauri::State<'_, BoardMap>,
) -> Result<(), String> {
    let s = parse_side(&new_side)?;
    expect_ok(
        state
            .get(&side)?
            .send_and_wait(Command::SetSide(s.to_string()), T_FAST)
            .await?,
    )
}

/// 读取固件参数（GET PARAMS，数据行 PARAMS ... 先到，OK GET 收尾）
#[tauri::command]
pub async fn get_params(
    side: String,
    state: tauri::State<'_, BoardMap>,
) -> Result<serde_json::Value, String> {
    let mgr = state.get(&side)?;
    expect_ok(mgr.send_and_wait(Command::GetParams, T_FAST).await?)?;
    let params = mgr.get_state().await.params;
    Ok(serde_json::to_value(params).unwrap_or(serde_json::json!({})))
}

/// 扫描 Modbus 从站（SCAN start end）：无固定应答，结果以日志行返回
#[tauri::command]
pub async fn scan_modbus(
    side: String,
    start: u8,
    end: u8,
    state: tauri::State<'_, BoardMap>,
) -> Result<(), String> {
    if start == 0 || end < start {
        return Err("扫描范围无效".into());
    }
    state.get(&side)?.send_now(Command::Scan { start, end }).await
}

/// 故障复位（ESTOP 后唯一恢复入口，RESET FAULT）
#[tauri::command]
pub async fn reset_fault(
    side: Option<String>,
    state: tauri::State<'_, BoardMap>,
) -> Result<(), String> {
    match side {
        Some(x) => {
            let mgr = state.get(&x)?;
            expect_ok(mgr.send_and_wait(Command::ResetFault, T_FAST).await?)
        }
        None => send_both(&state, Command::ResetFault, T_FAST).await,
    }
}

// ============ NET 网络配置（按板） ============

#[tauri::command]
pub async fn net_getcfg(
    side: String,
    state: tauri::State<'_, BoardMap>,
) -> Result<serde_json::Value, String> {
    let reply = state.get(&side)?.send_and_wait(Command::NetGetcfg, T_FAST).await;
    expect_data(reply, |r| match r {
        Reply::Netcfg { ssid, pass } => Some(serde_json::json!({ "ssid": ssid, "pass": pass })),
        _ => None,
    })
}

#[tauri::command]
pub async fn net_setcfg(
    side: String,
    old_pass: String,
    new_ssid: String,
    new_pass: String,
    state: tauri::State<'_, BoardMap>,
) -> Result<(), String> {
    expect_ok(
        state
            .get(&side)?
            .send_and_wait(
                Command::NetSetcfg { old_pass, new_ssid, new_pass },
                T_FAST,
            )
            .await?,
    )
}

#[tauri::command]
pub async fn net_reset(
    side: String,
    pass: String,
    state: tauri::State<'_, BoardMap>,
) -> Result<(), String> {
    expect_ok(
        state
            .get(&side)?
            .send_and_wait(Command::NetReset(pass), T_FAST)
            .await?,
    )
}

// ============ PEDAL 踏板（按板侧路由） ============

#[tauri::command]
pub async fn pedal_select(side: String, state: tauri::State<'_, BoardMap>) -> Result<(), String> {
    let s = side.to_uppercase();
    if !["A", "B", "NONE"].contains(&s.as_str()) {
        return Err("仅支持 A/B/NONE".into());
    }
    if s == "NONE" {
        // 两侧硬件同时工作：两块板都同步为 NONE
        send_both(&state, Command::PedalSelect("NONE".into()), T_FAST).await
    } else {
        expect_ok(
            state
                .get(&s)?
                .send_and_wait(Command::PedalSelect(s), T_FAST)
                .await?,
        )
    }
}

#[tauri::command]
pub async fn pedal_start(side: String, state: tauri::State<'_, BoardMap>) -> Result<(), String> {
    let s = parse_side(&side)?;
    expect_ok(
        state
            .get(&side)?
            .send_and_wait(Command::PedalStart(s), T_MOTOR)
            .await?,
    )
}

#[tauri::command]
pub async fn pedal_stop(side: String, state: tauri::State<'_, BoardMap>) -> Result<(), String> {
    let s = parse_side(&side)?;
    expect_ok(
        state
            .get(&side)?
            .send_and_wait(Command::PedalStop(s), T_MOTOR)
            .await?,
    )
}

/// 兼容旧协议：两侧同时开始自动流程（PEDAL TEST START）
#[tauri::command]
pub async fn pedal_test_start(state: tauri::State<'_, BoardMap>) -> Result<(), String> {
    send_both(&state, Command::PedalTestStart, T_MOTOR).await
}

/// 兼容旧协议：两侧同时停止自动流程（PEDAL TEST STOP）
#[tauri::command]
pub async fn pedal_test_stop(state: tauri::State<'_, BoardMap>) -> Result<(), String> {
    send_both(&state, Command::PedalTestStop, T_MOTOR).await
}

#[tauri::command]
pub async fn pedal_setload(
    side: String,
    load: f64,
    state: tauri::State<'_, BoardMap>,
) -> Result<(), String> {
    let s = parse_side(&side)?;
    expect_ok(
        state
            .get(&side)?
            .send_and_wait(Command::PedalSetLoad(s, load), T_FAST)
            .await?,
    )
}

#[tauri::command]
pub async fn pedal_level(side: String, state: tauri::State<'_, BoardMap>) -> Result<(), String> {
    let s = parse_side(&side)?;
    expect_ok(
        state
            .get(&side)?
            .send_and_wait(Command::PedalLevel(s), T_MOTOR)
            .await?,
    )
}

#[tauri::command]
pub async fn pedal_push_start(
    side: String,
    state: tauri::State<'_, BoardMap>,
) -> Result<(), String> {
    let s = parse_side(&side)?;
    expect_ok(
        state
            .get(&side)?
            .send_and_wait(Command::PedalPushStart(s), T_MOTOR)
            .await?,
    )
}

#[tauri::command]
pub async fn pedal_push_stop(
    side: String,
    state: tauri::State<'_, BoardMap>,
) -> Result<(), String> {
    let s = parse_side(&side)?;
    expect_ok(
        state
            .get(&side)?
            .send_and_wait(Command::PedalPushStop(s), T_MOTOR)
            .await?,
    )
}

#[tauri::command]
pub async fn pedal_set(
    side: String,
    key: String,
    value: String,
    state: tauri::State<'_, BoardMap>,
) -> Result<(), String> {
    let s = parse_side(&side)?;
    expect_ok(
        state
            .get(&side)?
            .send_and_wait(Command::PedalSet { side: s, key, value }, T_FAST)
            .await?,
    )
}

#[tauri::command]
pub async fn pedal_zero(
    side: Option<String>,
    state: tauri::State<'_, BoardMap>,
) -> Result<(), String> {
    match side {
        Some(x) => {
            let s = parse_side(&x)?;
            expect_ok(
                state
                    .get(&x)?
                    .send_and_wait(Command::PedalOp { side: Some(s), op: "ZERO".into() }, T_FAST)
                    .await?,
            )
        }
        None => send_both(&state, Command::PedalOp { side: None, op: "ZERO".into() }, T_FAST).await,
    }
}

#[tauri::command]
pub async fn pedal_clear(
    side: Option<String>,
    state: tauri::State<'_, BoardMap>,
) -> Result<(), String> {
    match side {
        Some(x) => {
            let s = parse_side(&x)?;
            expect_ok(
                state
                    .get(&x)?
                    .send_and_wait(Command::PedalOp { side: Some(s), op: "CLEAR".into() }, T_FAST)
                    .await?,
            )
        }
        None => send_both(&state, Command::PedalOp { side: None, op: "CLEAR".into() }, T_FAST).await,
    }
}

#[tauri::command]
pub async fn pedal_record(
    side: Option<String>,
    state: tauri::State<'_, BoardMap>,
) -> Result<(), String> {
    match side {
        Some(x) => {
            let s = parse_side(&x)?;
            expect_ok(
                state
                    .get(&x)?
                    .send_and_wait(Command::PedalOp { side: Some(s), op: "RECORD".into() }, T_FAST)
                    .await?,
            )
        }
        None => send_both(&state, Command::PedalOp { side: None, op: "RECORD".into() }, T_FAST).await,
    }
}

// ============ MOTOR 电机（轴名决定板侧） ============

#[tauri::command]
pub async fn motor_enable(state: tauri::State<'_, BoardMap>) -> Result<(), String> {
    send_both(&state, Command::MotorGlobal(MotorGlobalOp::Enable), T_FAST).await
}

#[tauri::command]
pub async fn motor_disable(state: tauri::State<'_, BoardMap>) -> Result<(), String> {
    send_both(&state, Command::MotorGlobal(MotorGlobalOp::Disable), T_FAST).await
}

#[tauri::command]
pub async fn motor_stop_all(state: tauri::State<'_, BoardMap>) -> Result<(), String> {
    send_both(&state, Command::MotorGlobal(MotorGlobalOp::Stop), T_MOTOR).await
}

#[tauri::command]
pub async fn motor_move(
    axis: String,
    pos: f64,
    feed: Option<f64>,
    state: tauri::State<'_, BoardMap>,
) -> Result<(), String> {
    let board = axis_side(&axis)?;
    expect_ok(
        state
            .get(board)?
            .send_and_wait(Command::MotorMove { axis, pos, feed }, T_MOTOR)
            .await?,
    )
}

#[tauri::command]
pub async fn motor_moveabs(
    axis: String,
    pos: f64,
    feed: Option<f64>,
    state: tauri::State<'_, BoardMap>,
) -> Result<(), String> {
    let board = axis_side(&axis)?;
    expect_ok(
        state
            .get(board)?
            .send_and_wait(Command::MotorMoveAbs { axis, pos, feed }, T_MOTOR)
            .await?,
    )
}

#[tauri::command]
pub async fn motor_home(axis: String, state: tauri::State<'_, BoardMap>) -> Result<(), String> {
    let board = axis_side(&axis)?;
    expect_ok(
        state
            .get(board)?
            .send_and_wait(Command::MotorHome(axis), T_MOTOR)
            .await?,
    )
}

#[tauri::command]
pub async fn motor_stop(axis: String, state: tauri::State<'_, BoardMap>) -> Result<(), String> {
    let board = axis_side(&axis)?;
    expect_ok(
        state
            .get(board)?
            .send_and_wait(Command::MotorStop(axis), T_MOTOR)
            .await?,
    )
}

#[tauri::command]
pub async fn motor_zero(axis: String, state: tauri::State<'_, BoardMap>) -> Result<(), String> {
    let board = axis_side(&axis)?;
    expect_ok(
        state
            .get(board)?
            .send_and_wait(Command::MotorZero(axis), T_MOTOR)
            .await?,
    )
}

// ============ STEER 转盘测试（两板同时） ============

#[tauri::command]
pub async fn steer_start(state: tauri::State<'_, BoardMap>) -> Result<(), String> {
    send_both(&state, Command::SteerStart, T_MOTOR).await
}

#[tauri::command]
pub async fn steer_stop(state: tauri::State<'_, BoardMap>) -> Result<(), String> {
    send_both(&state, Command::SteerStop, T_MOTOR).await
}
