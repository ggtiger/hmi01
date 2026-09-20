//! Xdesin 协议消息编解码（协议 §2/§3）
//!
//! 字符集 UTF-8，行结束 '\n'，命令大小写不敏感，nan 表示不可用数值。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ============ 命令（主机 → 设备） ============

/// 命令枚举（Ping/DebugPlainOff 由 send_ping / set_plain_mode 特殊路径发送）
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub enum Command {
    Hello(String),
    Ping,
    Estop,
    InfoGet,
    DebugOn,
    DebugOff,
    DebugPlainOn,
    DebugPlainOff,
    SetReport(u32),
    SetPushPulsesPerMm(f64),
    SetLevelRatio(f64),
    NetGetcfg,
    NetSetcfg {
        old_pass: String,
        new_ssid: String,
        new_pass: String,
    },
    NetReset(String),
    PedalSelect(String), // A | B | NONE
    PedalStart(char),
    PedalStop(char),
    PedalSetLoad(char, f64),
    PedalLevel(char),
    PedalPushStart(char),
    PedalPushStop(char),
    PedalSet {
        side: char,
        key: String,
        value: String,
    },
    /// PEDAL <side|空> ZERO/CLEAR/RECORD
    PedalOp {
        side: Option<char>,
        op: String, // ZERO | CLEAR | RECORD
    },
    MotorGlobal(MotorGlobalOp),
    MotorMove {
        axis: String,
        pos: f64,
        feed: Option<f64>,
    },
    MotorMoveAbs {
        axis: String,
        pos: f64,
        feed: Option<f64>,
    },
    MotorHome(String),
    MotorStop(String),
    MotorZero(String),
    /// 转盘（方向盘）测试启停（协议 §2.9）
    SteerStart,
    SteerStop,
    /// 原始行（调试 / 明文 PLAIN OFF 特殊序列）
    Raw(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MotorGlobalOp {
    Stop,
    Enable,
    Disable,
}

/// 命令头（用于应答匹配）
pub fn command_head(cmd: &Command) -> String {
    match cmd {
        Command::Hello(_) => "HELLO".into(),
        Command::Ping => "PING".into(),
        Command::Estop => "ESTOP".into(),
        Command::InfoGet => "INFO".into(),
        Command::DebugOn
        | Command::DebugOff
        | Command::DebugPlainOn
        | Command::DebugPlainOff => "DEBUG".into(),
        Command::SetReport(_) | Command::SetPushPulsesPerMm(_) | Command::SetLevelRatio(_) => {
            "SET".into()
        }
        Command::NetGetcfg | Command::NetSetcfg { .. } | Command::NetReset(_) => "NET".into(),
        Command::PedalSelect(_)
        | Command::PedalStart(_)
        | Command::PedalStop(_)
        | Command::PedalSetLoad(..)
        | Command::PedalLevel(_)
        | Command::PedalPushStart(_)
        | Command::PedalPushStop(_)
        | Command::PedalSet { .. }
        | Command::PedalOp { .. } => "PEDAL".into(),
        Command::MotorGlobal(_) | Command::MotorMove { .. } | Command::MotorMoveAbs { .. }
        | Command::MotorHome(_) | Command::MotorStop(_) | Command::MotorZero(_) => "MOTOR".into(),
        Command::SteerStart | Command::SteerStop => "STEER".into(),
        Command::Raw(_) => "".into(),
    }
}

fn fmt_float(v: f64) -> String {
    // 去除多余的小数尾零：320.0 → "320"，25.5 → "25.5"
    let s = format!("{}", v);
    s
}

impl Command {
    /// 编码为协议行（不含换行符）
    pub fn to_frame(&self) -> String {
        match self {
            Command::Hello(id) => format!("HELLO {}", id),
            Command::Ping => "PING".into(),
            Command::Estop => "ESTOP".into(),
            Command::InfoGet => "INFO GET".into(),
            Command::DebugOn => "DEBUG ON".into(),
            Command::DebugOff => "DEBUG OFF".into(),
            Command::DebugPlainOn => "DEBUG PLAIN ON".into(),
            Command::DebugPlainOff => "DEBUG PLAIN OFF".into(),
            Command::SetReport(hz) => format!("SET REPORT {}", hz),
            Command::SetPushPulsesPerMm(v) => format!("SET PUSH_PULSES_PER_MM {}", fmt_float(*v)),
            Command::SetLevelRatio(v) => format!("SET LEVEL_RATIO {}", fmt_float(*v)),
            Command::NetGetcfg => "NET GETCFG".into(),
            Command::NetSetcfg {
                old_pass,
                new_ssid,
                new_pass,
            } => format!("NET SETCFG {} {} {}", old_pass, new_ssid, new_pass),
            Command::NetReset(pass) => format!("NET RESET {}", pass),
            Command::PedalSelect(side) => format!("PEDAL SELECT {}", side),
            Command::PedalStart(side) => format!("PEDAL {} START", side),
            Command::PedalStop(side) => format!("PEDAL {} STOP", side),
            Command::PedalSetLoad(side, n) => format!("PEDAL {} SETLOAD {}", side, fmt_float(*n)),
            Command::PedalLevel(side) => format!("PEDAL {} LEVEL", side),
            Command::PedalPushStart(side) => format!("PEDAL {} PUSH START", side),
            Command::PedalPushStop(side) => format!("PEDAL {} PUSH STOP", side),
            Command::PedalSet { side, key, value } => {
                format!("PEDAL {} SET {} {}", side, key, value)
            }
            Command::PedalOp { side, op } => match side {
                Some(s) => format!("PEDAL {} {}", s, op),
                None => format!("PEDAL {}", op),
            },
            Command::MotorGlobal(op) => match op {
                MotorGlobalOp::Stop => "MOTOR STOP".into(),
                MotorGlobalOp::Enable => "MOTOR ENABLE".into(),
                MotorGlobalOp::Disable => "MOTOR DISABLE".into(),
            },
            Command::MotorMove { axis, pos, feed } => {
                with_feed(format!("MOTOR {} MOVE {}", axis, fmt_float(*pos)), *feed)
            }
            Command::MotorMoveAbs { axis, pos, feed } => {
                with_feed(format!("MOTOR {} MOVEABS {}", axis, fmt_float(*pos)), *feed)
            }
            Command::MotorHome(axis) => format!("MOTOR {} HOME", axis),
            Command::MotorStop(axis) => format!("MOTOR {} STOP", axis),
            Command::MotorZero(axis) => format!("MOTOR {} ZERO", axis),
            Command::SteerStart => "STEER START".into(),
            Command::SteerStop => "STEER STOP".into(),
            Command::Raw(line) => line.clone(),
        }
    }
}

fn with_feed(base: String, feed: Option<f64>) -> String {
    match feed {
        Some(f) => format!("{} F{}", base, fmt_float(f)),
        None => base,
    }
}

// ============ 遥测数据（协议 §3.2） ============

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TelemetryData {
    pub t: u64,
    /// 数值字段：None 表示 nan（传感器故障 / 未选中侧）
    pub tilt_x: Option<f64>,
    pub tilt_y: Option<f64>,
    pub pedal_a_tilt_x: Option<f64>,
    pub pedal_a_tilt_y: Option<f64>,
    pub pedal_b_tilt_x: Option<f64>,
    pub pedal_b_tilt_y: Option<f64>,
    pub laser_a: Option<f64>,
    pub laser_b: Option<f64>,
    pub pedal_a: Option<f64>,
    pub pedal_b: Option<f64>,
    pub ang_cor_a: Option<f64>,
    pub ang_cor_b: Option<f64>,
    pub steer_x: Option<f64>,
    pub steer_y: Option<f64>,
    pub sensor: String,        // OK | NG
    pub state: String,         // IDLE | PEDAL_RUN | STEER_RUN | FAULT
    pub pedal_select: String,  // NONE | A | B
}

/// 将遥测结构体转回 k=v 行（用于日志显示；None → "nan"）
pub fn telemetry_to_line(t: &TelemetryData) -> String {
    let f = |v: &Option<f64>, digits: usize| match v {
        Some(x) => format!("{:.*}", digits, x),
        None => "nan".to_string(),
    };
    format!(
        "TELEMETRY t={} tilt_x={} tilt_y={} pedal_a_tilt_x={} pedal_a_tilt_y={} pedal_b_tilt_x={} pedal_b_tilt_y={} laser_a={} laser_b={} pedal_a={} pedal_b={} ang_cor_a={} ang_cor_b={} steer_x={} steer_y={} sensor={} state={} pedal_select={}",
        t.t,
        f(&t.tilt_x, 2),
        f(&t.tilt_y, 2),
        f(&t.pedal_a_tilt_x, 3),
        f(&t.pedal_a_tilt_y, 3),
        f(&t.pedal_b_tilt_x, 3),
        f(&t.pedal_b_tilt_y, 3),
        f(&t.laser_a, 1),
        f(&t.laser_b, 1),
        f(&t.pedal_a, 0),
        f(&t.pedal_b, 0),
        f(&t.ang_cor_a, 3),
        f(&t.ang_cor_b, 3),
        f(&t.steer_x, 2),
        f(&t.steer_y, 2),
        t.sensor,
        t.state,
        t.pedal_select,
    )
}

/// 解析 k=v 空格分词；nan → None；未知字段忽略（前向兼容）
pub fn parse_telemetry(line: &str) -> Option<TelemetryData> {
    let mut tokens = line.split_whitespace();
    if tokens.next()?.to_uppercase() != "TELEMETRY" {
        return None;
    }
    let mut kv: HashMap<&str, &str> = HashMap::new();
    for tok in tokens {
        if let Some((k, v)) = tok.split_once('=') {
            kv.insert(k, v);
        }
    }

    let num = |k: &str| -> Option<Option<f64>> {
        kv.get(k).map(|v| {
            if *v == "nan" {
                None
            } else {
                v.parse::<f64>().ok()
            }
        })
    };
    let strv = |k: &str, default: &str| kv.get(k).map(|s| s.to_string()).unwrap_or_else(|| default.to_string());

    let t = kv.get("t")?.parse::<u64>().ok()?;

    Some(TelemetryData {
        t,
        tilt_x: num("tilt_x").flatten(),
        tilt_y: num("tilt_y").flatten(),
        pedal_a_tilt_x: num("pedal_a_tilt_x").flatten(),
        pedal_a_tilt_y: num("pedal_a_tilt_y").flatten(),
        pedal_b_tilt_x: num("pedal_b_tilt_x").flatten(),
        pedal_b_tilt_y: num("pedal_b_tilt_y").flatten(),
        laser_a: num("laser_a").flatten(),
        laser_b: num("laser_b").flatten(),
        pedal_a: num("pedal_a").flatten(),
        pedal_b: num("pedal_b").flatten(),
        ang_cor_a: num("ang_cor_a").flatten(),
        ang_cor_b: num("ang_cor_b").flatten(),
        steer_x: num("steer_x").flatten(),
        steer_y: num("steer_y").flatten(),
        sensor: strv("sensor", "OK"),
        state: strv("state", "IDLE"),
        pedal_select: strv("pedal_select", "NONE"),
    })
}

// ============ DEBUG 事件行（协议 §3.3） ============

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugEvent {
    /// 事件种类: LEVELED | STABLE | PUSH_STOPPED | LEVEL_DONE | LEVEL_ABORT
    pub kind: String,
    /// 侧别 A / B（可能无）
    pub side: Option<char>,
    /// LEVEL DONE 的 comp 值
    pub comp: Option<f64>,
    /// ABORT 原因
    pub reason: Option<String>,
    /// 原始行
    pub raw: String,
}

/// 解析 "DEBUG ..." 事件行；非 DEBUG 行返回 None
pub fn parse_debug_event(line: &str) -> Option<DebugEvent> {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    if tokens.is_empty() || tokens[0].to_uppercase() != "DEBUG" {
        return None;
    }
    let raw = line.to_string();
    let upper = |i: usize| tokens.get(i).map(|s| s.to_uppercase());

    // DEBUG PEDAL <A|B> LEVELED / STABLE / PUSH_STOPPED
    if upper(1).as_deref() == Some("PEDAL") {
        let side = tokens.get(2).and_then(|s| s.chars().next()).filter(|c| *c == 'A' || *c == 'B');
        match upper(3).as_deref() {
            Some("LEVELED") => {
                return Some(DebugEvent { kind: "LEVELED".into(), side, comp: None, reason: None, raw })
            }
            Some("STABLE") => {
                return Some(DebugEvent { kind: "STABLE".into(), side, comp: None, reason: None, raw })
            }
            Some("PUSH_STOPPED") => {
                return Some(DebugEvent { kind: "PUSH_STOPPED".into(), side, comp: None, reason: None, raw })
            }
            _ => {}
        }
    }
    // DEBUG LEVEL <A|B> DONE comp=<deg> | DEBUG LEVEL <A|B> ABORT <reason>
    if upper(1).as_deref() == Some("LEVEL") {
        let side = tokens.get(2).and_then(|s| s.chars().next()).filter(|c| *c == 'A' || *c == 'B');
        match upper(3).as_deref() {
            Some("DONE") => {
                let comp = tokens
                    .get(4)
                    .and_then(|s| s.strip_prefix("comp="))
                    .and_then(|v| v.parse::<f64>().ok());
                return Some(DebugEvent { kind: "LEVEL_DONE".into(), side, comp, reason: None, raw });
            }
            Some("ABORT") => {
                let reason = tokens.get(4).map(|s| s.to_string());
                return Some(DebugEvent { kind: "LEVEL_ABORT".into(), side, comp: None, reason, raw });
            }
            _ => {}
        }
    }
    // 其他 DEBUG 行透传为原始事件
    Some(DebugEvent { kind: "RAW".into(), side: None, comp: None, reason: None, raw })
}

// ============ 应答（设备 → 主机） ============

#[derive(Debug, Clone)]
pub enum Reply {
    Pong,
    HelloOk {
        device_id: String,
        fw: String,
    },
    Info {
        fw: String,
        hw: String,
        uptime: u64,
        ssid: String,
    },
    Netcfg {
        ssid: String,
        pass: String,
    },
    /// OK <head> [info]
    Ok {
        head: String,
        rest: String,
    },
    /// ERR <head> <code> <msg>
    Err {
        head: String,
        code: String,
        msg: String,
    },
    Telemetry(TelemetryData),
    DebugEvent(DebugEvent),
    /// 无法归类的行
    Unknown(#[allow(dead_code)] String),
}

/// 解析一行（已解密/明文）为 Reply
pub fn parse_reply(line: &str) -> Reply {
    let upper_first = line.split_whitespace().next().map(|s| s.to_uppercase());

    match upper_first.as_deref() {
        Some("PONG") => return Reply::Pong,
        Some("TELEMETRY") => {
            return match parse_telemetry(line) {
                Some(t) => Reply::Telemetry(t),
                None => Reply::Unknown(line.to_string()),
            }
        }
        Some("DEBUG") => {
            return match parse_debug_event(line) {
                Some(ev) => Reply::DebugEvent(ev),
                None => Reply::Unknown(line.to_string()),
            }
        }
        _ => {}
    }

    let tokens: Vec<&str> = line.splitn(3, ' ').collect();
    match tokens[0].to_uppercase().as_str() {
        "HELLO" => {
            // HELLO OK <device_id> <fw_version>
            if tokens.len() >= 3 {
                let rest: Vec<&str> = tokens[2].split_whitespace().collect();
                if rest.len() >= 2 {
                    return Reply::HelloOk {
                        device_id: rest[0].to_string(),
                        fw: rest[1].to_string(),
                    };
                }
            }
            Reply::Unknown(line.to_string())
        }
        "INFO" => {
            // INFO fw=<ver> hw=<hw> uptime=<s> ssid=<ssid>
            let kv: HashMap<&str, &str> = line
                .split_whitespace()
                .skip(1)
                .filter_map(|t| t.split_once('='))
                .collect();
            Reply::Info {
                fw: kv.get("fw").unwrap_or(&"").to_string(),
                hw: kv.get("hw").unwrap_or(&"").to_string(),
                uptime: kv.get("uptime").and_then(|s| s.parse().ok()).unwrap_or(0),
                ssid: kv.get("ssid").unwrap_or(&"").to_string(),
            }
        }
        "NETCFG" => {
            let kv: HashMap<&str, &str> = line
                .split_whitespace()
                .skip(1)
                .filter_map(|t| t.split_once('='))
                .collect();
            Reply::Netcfg {
                ssid: kv.get("ssid").unwrap_or(&"").to_string(),
                pass: kv.get("pass").unwrap_or(&"").to_string(),
            }
        }
        "OK" => Reply::Ok {
            head: tokens.get(1).unwrap_or(&"").to_uppercase(),
            rest: tokens.get(2).unwrap_or(&"").to_string(),
        },
        "ERR" => {
            let parts: Vec<&str> = line.splitn(4, ' ').collect();
            Reply::Err {
                head: parts.get(1).unwrap_or(&"").to_uppercase(),
                code: parts.get(2).unwrap_or(&"").to_string(),
                msg: parts.get(3).unwrap_or(&"").to_string(),
            }
        }
        _ => Reply::Unknown(line.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_command_frames() {
        assert_eq!(Command::Hello("xdesin-host".into()).to_frame(), "HELLO xdesin-host");
        assert_eq!(Command::InfoGet.to_frame(), "INFO GET");
        assert_eq!(Command::SetReport(20).to_frame(), "SET REPORT 20");
        assert_eq!(Command::SetPushPulsesPerMm(320.0).to_frame(), "SET PUSH_PULSES_PER_MM 320");
        assert_eq!(Command::SetLevelRatio(1.5).to_frame(), "SET LEVEL_RATIO 1.5");
        assert_eq!(Command::PedalSelect("A".into()).to_frame(), "PEDAL SELECT A");
        assert_eq!(Command::PedalStart('A').to_frame(), "PEDAL A START");
        assert_eq!(Command::PedalPushStop('B').to_frame(), "PEDAL B PUSH STOP");
        assert_eq!(
            Command::PedalSet { side: 'A', key: "PUSH_DIST".into(), value: "25.5".into() }.to_frame(),
            "PEDAL A SET PUSH_DIST 25.5"
        );
        assert_eq!(
            Command::PedalOp { side: None, op: "ZERO".into() }.to_frame(),
            "PEDAL ZERO"
        );
        assert_eq!(
            Command::MotorMove { axis: "PUSH_A".into(), pos: -10.5, feed: Some(60.0) }.to_frame(),
            "MOTOR PUSH_A MOVE -10.5 F60"
        );
        assert_eq!(
            Command::MotorMoveAbs { axis: "PUSH_B".into(), pos: 25.0, feed: None }.to_frame(),
            "MOTOR PUSH_B MOVEABS 25"
        );
        assert_eq!(Command::SteerStart.to_frame(), "STEER START");
        assert_eq!(Command::SteerStop.to_frame(), "STEER STOP");
        assert_eq!(command_head(&Command::SteerStart), "STEER");
        assert_eq!(command_head(&Command::PedalStart('A')), "PEDAL");
        assert_eq!(command_head(&Command::SetReport(10)), "SET");
    }

    #[test]
    fn test_parse_telemetry() {
        let line = "TELEMETRY t=1000 tilt_x=0.12 tilt_y=-0.03 pedal_a_tilt_x=1.5 pedal_a_tilt_y=0.2 pedal_b_tilt_x=nan pedal_b_tilt_y=nan laser_a=120.5 laser_b=nan pedal_a=3200 pedal_b=nan ang_cor_a=1.25 ang_cor_b=0 motor_a=0 motor_b=0 steer_x=0 steer_y=0 steer_free=0 sensor=OK state=PEDAL_RUN pedal_select=A";
        let t = parse_telemetry(line).unwrap();
        assert_eq!(t.t, 1000);
        assert_eq!(t.tilt_x, Some(0.12));
        assert_eq!(t.pedal_b_tilt_x, None); // nan
        assert_eq!(t.laser_b, None);
        assert_eq!(t.pedal_a, Some(3200.0));
        assert_eq!(t.pedal_b, None);
        assert_eq!(t.ang_cor_b, Some(0.0));
        assert_eq!(t.sensor, "OK");
        assert_eq!(t.state, "PEDAL_RUN");
        assert_eq!(t.pedal_select, "A");
    }

    #[test]
    fn test_parse_telemetry_unknown_fields_ok() {
        let line = "TELEMETRY t=5 sensor=NG state=IDLE pedal_select=NONE future_field=1.0";
        let t = parse_telemetry(line).unwrap();
        assert_eq!(t.t, 5);
        assert_eq!(t.sensor, "NG");
        assert_eq!(t.tilt_x, None);
    }

    #[test]
    fn test_parse_debug_events() {
        let ev = parse_debug_event("DEBUG PEDAL A LEVELED").unwrap();
        assert_eq!(ev.kind, "LEVELED");
        assert_eq!(ev.side, Some('A'));

        let ev = parse_debug_event("DEBUG PEDAL B STABLE").unwrap();
        assert_eq!(ev.kind, "STABLE");
        assert_eq!(ev.side, Some('B'));

        let ev = parse_debug_event("DEBUG PEDAL A PUSH_STOPPED").unwrap();
        assert_eq!(ev.kind, "PUSH_STOPPED");

        let ev = parse_debug_event("DEBUG LEVEL A DONE comp=1.234").unwrap();
        assert_eq!(ev.kind, "LEVEL_DONE");
        assert_eq!(ev.side, Some('A'));
        assert_eq!(ev.comp, Some(1.234));

        let ev = parse_debug_event("DEBUG LEVEL B ABORT SELECT_CHANGED").unwrap();
        assert_eq!(ev.kind, "LEVEL_ABORT");
        assert_eq!(ev.reason, Some("SELECT_CHANGED".into()));
    }

    #[test]
    fn test_parse_replies() {
        match parse_reply("HELLO OK xdesin-s3-001 1.0.0") {
            Reply::HelloOk { device_id, fw } => {
                assert_eq!(device_id, "xdesin-s3-001");
                assert_eq!(fw, "1.0.0");
            }
            _ => panic!("expect HelloOk"),
        }
        match parse_reply("INFO fw=1.0.0 hw=esp32-s3 uptime=120 ssid=XDESIN") {
            Reply::Info { fw, hw, uptime, ssid } => {
                assert_eq!(fw, "1.0.0");
                assert_eq!(hw, "esp32-s3");
                assert_eq!(uptime, 120);
                assert_eq!(ssid, "XDESIN");
            }
            _ => panic!("expect Info"),
        }
        match parse_reply("NETCFG ssid=XDESIN pass=********") {
            Reply::Netcfg { ssid, pass } => {
                assert_eq!(ssid, "XDESIN");
                assert_eq!(pass, "********");
            }
            _ => panic!("expect Netcfg"),
        }
        match parse_reply("OK PEDAL A START") {
            Reply::Ok { head, rest } => {
                assert_eq!(head, "PEDAL");
                assert_eq!(rest, "A START");
            }
            _ => panic!("expect Ok"),
        }
        match parse_reply("ERR SET E_RANGE 频率 1-50Hz") {
            Reply::Err { head, code, msg } => {
                assert_eq!(head, "SET");
                assert_eq!(code, "E_RANGE");
                assert_eq!(msg, "频率 1-50Hz");
            }
            _ => panic!("expect Err"),
        }
        assert!(matches!(parse_reply("PONG"), Reply::Pong));
    }
}
