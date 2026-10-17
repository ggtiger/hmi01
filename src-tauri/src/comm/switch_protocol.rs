//! 二路开关模块 EE 协议（蓝牙名 YX_***，FFB0/FFB1/FFB2）
//!
//! 帧格式（厂商文档）：
//! - 开：`EE 03 E1 01 FF`（E1 开关指令 | 路数 01/02 | FF 开 / 00 关）
//!   应答：`E0 01 E1 FF 00`
//! - 点动（约 2s）：`EE 03 E3 01 FF`
//! - 延迟开/关：`EE 05 E2 01 [FF|00] [时间 2B 秒]`
//!   应答：`E0 01 E2 FF 00 3C`；到时后主动上报 `E0 01 E1 FF 00`
//! - 查询当前值：`EE 01 E0` → `E0 01 E1 FF 00`（非延迟）或 `E0 01 E2 00 00 06`（延迟中）
//!
//! 应答帧：`E0 [路数] [指令] [值] [时间 2B]`（6 字节）

use serde::{Deserialize, Serialize};

pub const FRAME_HEAD_REQ: u8 = 0xEE;
pub const FRAME_HEAD_RSP: u8 = 0xE0;
const CMD_SWITCH: u8 = 0xE1;
const CMD_DELAY: u8 = 0xE2;
const CMD_MOMENTARY: u8 = 0xE3;
const CMD_QUERY: u8 = 0xE0;

pub const RELAY_1: u8 = 0x01;
pub const RELAY_2: u8 = 0x02;
pub const VALUE_ON: u8 = 0xFF;
pub const VALUE_OFF: u8 = 0x00;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SwitchState {
    /// 第几路
    pub relay: u8,
    /// 非延迟（true）或延迟操作中（false）
    pub immediate: bool,
    /// 当前值：FF=开
    pub on: bool,
    /// 延迟剩余秒数
    pub delay_secs: u16,
}

/// 构建开/关命令：`EE 03 E1 <relay> <FF|00>`
pub fn build_switch(relay: u8, on: bool) -> Vec<u8> {
    vec![
        FRAME_HEAD_REQ,
        0x03,
        CMD_SWITCH,
        relay,
        if on { VALUE_ON } else { VALUE_OFF },
    ]
}

/// 构建点动命令（约 2 秒后自动关）：`EE 03 E3 <relay> FF`
pub fn build_momentary(relay: u8) -> Vec<u8> {
    vec![FRAME_HEAD_REQ, 0x03, CMD_MOMENTARY, relay, VALUE_ON]
}

/// 构建延迟开/关命令：`EE 05 E2 <relay> <FF|00> <secs 2B>`
pub fn build_delayed(relay: u8, on: bool, secs: u16) -> Vec<u8> {
    vec![
        FRAME_HEAD_REQ,
        0x05,
        CMD_DELAY,
        relay,
        if on { VALUE_ON } else { VALUE_OFF },
        (secs >> 8) as u8,
        (secs & 0xFF) as u8,
    ]
}

/// 构建查询当前值命令：`EE 01 E0`
pub fn build_query() -> Vec<u8> {
    vec![FRAME_HEAD_REQ, 0x01, CMD_QUERY]
}

/// 解析开关应答/上报帧（6 字节 E0 开头）。
/// 返回 Ok(Some(state)) / Ok(None)（非本协议帧）/ Err（长度异常）
pub fn parse_switch_frame(data: &[u8]) -> Result<Option<SwitchState>, String> {
    if data.first() != Some(&FRAME_HEAD_RSP) {
        return Ok(None);
    }
    if data.len() < 6 {
        return Err(format!(
            "开关应答长度不足（期望 6 字节，实到 {}）",
            data.len()
        ));
    }
    let relay = data[1];
    let cmd = data[2];
    let value = data[3];
    let delay_secs = u16::from_be_bytes([data[4], data[5]]);
    if relay != RELAY_1 && relay != RELAY_2 {
        return Err(format!("未知路数: 0x{:02X}", relay));
    }
    match cmd {
        CMD_SWITCH | CMD_DELAY => Ok(Some(SwitchState {
            relay,
            immediate: cmd == CMD_SWITCH,
            on: value == VALUE_ON,
            delay_secs,
        })),
        _ => Err(format!("未知开关指令字: 0x{:02X}", cmd)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 文档向量：开第一路 EE 03 E1 01 FF → 应答 E0 01 E1 FF 00
    #[test]
    fn test_switch_on_doc_vector() {
        assert_eq!(build_switch(RELAY_1, true), vec![0xEE, 0x03, 0xE1, 0x01, 0xFF]);
        assert_eq!(build_switch(RELAY_2, false), vec![0xEE, 0x03, 0xE1, 0x02, 0x00]);
        let st = parse_switch_frame(&[0xE0, 0x01, 0xE1, 0xFF, 0x00, 0x00])
            .unwrap()
            .expect("should parse");
        assert_eq!(st.relay, 1);
        assert!(st.immediate);
        assert!(st.on);
    }

    /// 文档向量：延迟开第二路 60 秒 EE 05 E2 02 FF 00 3C
    #[test]
    fn test_delayed_doc_vector() {
        assert_eq!(
            build_delayed(RELAY_2, true, 60),
            vec![0xEE, 0x05, 0xE2, 0x02, 0xFF, 0x00, 0x3C]
        );
        let st = parse_switch_frame(&[0xE0, 0x02, 0xE2, 0x00, 0x00, 0x06])
            .unwrap()
            .expect("should parse");
        assert_eq!(st.relay, 2);
        assert!(!st.immediate);
        assert!(!st.on);
        assert_eq!(st.delay_secs, 6);
    }

    /// 点动 + 查询命令构造
    #[test]
    fn test_momentary_and_query() {
        assert_eq!(build_momentary(RELAY_1), vec![0xEE, 0x03, 0xE3, 0x01, 0xFF]);
        assert_eq!(build_query(), vec![0xEE, 0x01, 0xE0]);
    }

    /// 非 EE 协议帧忽略（透传流可能夹带其他数据）
    #[test]
    fn test_non_protocol_ignored() {
        assert!(parse_switch_frame(&[0x03, 0x03, 0x08]).unwrap().is_none());
        assert!(parse_switch_frame(b"hello").unwrap().is_none());
        // 长度不足但 0xE0 开头 → 报错（等待续传的信号）
        assert!(parse_switch_frame(&[0xE0, 0x01]).is_err());
    }
}
