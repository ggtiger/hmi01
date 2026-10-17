//! 倾角传感器 Modbus RTU 协议（转向角模块 SCT726T-M，经 WCH BLE 串口透传）
//!
//! 读 X/Y 轴角度（厂商文档 + 调试工具实测）：
//! - 发送（本设备，从站地址 0x03）：`03 03 00 01 00 04 15 C9`
//!   ⚠️ 固件特性：CRC 固定按地址 0x01 计算（15 C9 = `01 03 00 01 00 04` 的
//!   标准 CRC），不随实际从站地址变化——实测工具验证，标准 CRC（14 2B）传感器不响应
//! - 应答：`03 03 08 [X Angle 4B] [Y Angle 4B] [CRC16 L] [CRC16 H]`
//!   角度为 IEEE754 32 位浮点，大端（高字节在前）
//!   文档向量（地址 01）：0xC0054FDF = -2.083000°，0x3FBE147B = +1.485000°

use serde::{Deserialize, Serialize};

pub const MODBUS_ADDR: u8 = 0x03;
/// 本批传感器固件 CRC 计算时固定使用的地址（不随从站地址变化）
const CRC_CALC_ADDR: u8 = 0x01;
const FUNC_READ: u8 = 0x03;
const REG_ADDR: u16 = 0x0001;
const REG_COUNT: u16 = 0x0004;
/// 应答帧总长：地址(1) + 功能码(1) + 字节数(1) + 8 数据 + CRC(2)
pub const ANGLE_REPLY_LEN: usize = 13;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AngleData {
    pub angle_x: f64,
    pub angle_y: f64,
}

/// Modbus RTU CRC16（初始 0xFFFF，多项式 0xA001，低字节在前传输）
pub fn crc16_modbus(data: &[u8]) -> u16 {
    let mut crc: u16 = 0xFFFF;
    for &b in data {
        crc ^= b as u16;
        for _ in 0..8 {
            if crc & 0x0001 != 0 {
                crc = (crc >> 1) ^ 0xA001;
            } else {
                crc >>= 1;
            }
        }
    }
    crc
}

/// 按本批固件的 CRC 约定计算：地址字节视为 CRC_CALC_ADDR（0x01）
fn crc16_fw(frame_with_addr: &[u8]) -> u16 {
    let mut data = frame_with_addr.to_vec();
    data[0] = CRC_CALC_ADDR;
    crc16_modbus(&data)
}

/// 构建 WCH 透传模块 UART 配置帧（发往 FFF3 配置特征，WCHBLEWxJsLib 约定）
///
/// 帧格式（12 字节）：`06 00 09 00 [波特率 u32 LE] [数据位] [停止位] [校验位] [累加和]`
/// - 累加和 = index 3 起至数据位/停止位/校验位共 8 字节之和（u8 截断）
/// - 校验位：0=无校验
///
/// 例：115200 8N1 → `06 00 09 00 00 C2 01 00 08 01 00 CC`
pub fn build_wch_uart_config(baud: u32, data_bits: u8, stop_bits: u8, parity: u8) -> Vec<u8> {
    let mut frame = vec![
        0x06,
        0x00,
        0x09,
        0x00,
        (baud & 0xFF) as u8,
        ((baud >> 8) & 0xFF) as u8,
        ((baud >> 16) & 0xFF) as u8,
        ((baud >> 24) & 0xFF) as u8,
        data_bits,
        stop_bits,
        parity,
    ];
    // 累加和：从 index 3 到校验位前（共 8 字节）
    let sum: u8 = frame[3..11].iter().fold(0u8, |acc, &b| acc.wrapping_add(b));
    frame.push(sum);
    frame
}

/// 构建读 X/Y 轴角度命令（调试工具实测向量）：`03 03 00 01 00 04 15 C9`
/// CRC 按固件约定（地址视为 0x01）计算
pub fn build_read_angle_command() -> Vec<u8> {
    let mut frame = vec![
        MODBUS_ADDR,
        FUNC_READ,
        (REG_ADDR >> 8) as u8,
        (REG_ADDR & 0xFF) as u8,
        (REG_COUNT >> 8) as u8,
        (REG_COUNT & 0xFF) as u8,
    ];
    let crc = crc16_fw(&frame);
    frame.push((crc & 0xFF) as u8); // CRC16 L
    frame.push((crc >> 8) as u8); // CRC16 H
    frame
}

/// 从缓冲解析一帧读角度应答。
///
/// CRC 兼容两种（本批固件按地址 0x01 计算 / 标准 Modbus 覆盖实际地址）。
///
/// 返回：
/// - `Ok(None)`：缓冲不足一帧（等待更多数据）
/// - `Ok(Some(AngleData), consumed)`：解析成功，consumed = 消耗的字节数
/// - `Err(msg)`：CRC/格式错误（缓冲应丢弃到该位置之后）
///
/// 帧定位：查找 [addr, 0x03, byte_count=0x08] 特征头（透传流中可能夹带
/// WCH 模块自身的配置帧）。
pub fn parse_angle_stream(buf: &[u8]) -> Result<Option<(AngleData, usize)>, (usize, String)> {
    if buf.len() < ANGLE_REPLY_LEN {
        return Ok(None);
    }
    // 滑动查找特征头
    for start in 0..=(buf.len() - ANGLE_REPLY_LEN) {
        let f = &buf[start..];
        if f[0] != MODBUS_ADDR || f[1] != FUNC_READ || f[2] != 0x08 {
            continue;
        }
        let frame = &f[..ANGLE_REPLY_LEN];
        // CRC：低字节在前，仅覆盖 CRC 前的字节；兼容固件约定（地址视为 01）与标准算法
        let payload = &frame[..ANGLE_REPLY_LEN - 2];
        let calc_fw = crc16_fw(payload);
        let calc_std = crc16_modbus(payload);
        let recv = u16::from_le_bytes([frame[ANGLE_REPLY_LEN - 2], frame[ANGLE_REPLY_LEN - 1]]);
        if calc_fw != recv && calc_std != recv {
            // 头匹配但 CRC 不对：跳过该位置继续找
            continue;
        }
        // X = 字节 1-4，Y = 字节 5-8（IEEE754 大端）
        let x = f32::from_be_bytes([frame[3], frame[4], frame[5], frame[6]]);
        let y = f32::from_be_bytes([frame[7], frame[8], frame[9], frame[10]]);
        if !x.is_finite() || !y.is_finite() {
            continue;
        }
        return Ok(Some((
            AngleData {
                angle_x: x as f64,
                angle_y: y as f64,
            },
            start + ANGLE_REPLY_LEN,
        )));
    }
    // 未找到合法帧：保留末尾 ANGLE_REPLY_LEN-1 字节等待续传，其余丢弃
    let keep = ANGLE_REPLY_LEN - 1;
    if buf.len() > keep {
        Err((buf.len() - keep, "缓冲中无合法角度帧".to_string()))
    } else {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试辅助：按当前 MODBUS_ADDR 构造读角度应答帧（固件 CRC：地址视为 01）
    fn make_reply(x: f32, y: f32) -> Vec<u8> {
        let mut frame = vec![MODBUS_ADDR, FUNC_READ, 0x08];
        frame.extend_from_slice(&x.to_be_bytes());
        frame.extend_from_slice(&y.to_be_bytes());
        let crc = crc16_fw(&frame);
        frame.push((crc & 0xFF) as u8);
        frame.push((crc >> 8) as u8);
        frame
    }

    /// 命令构造：调试工具实测向量 `03 03 00 01 00 04 15 C9`
    /// （地址 03 + 固件 CRC 按地址 01 计算）
    #[test]
    fn test_build_command_measured_vector() {
        assert_eq!(
            build_read_angle_command(),
            vec![0x03, 0x03, 0x00, 0x01, 0x00, 0x04, 0x15, 0xC9]
        );
    }

    /// 应答解析（文档数据向量 + 固件 CRC）：X = 0xC0054FDF = -2.083°，Y = 0x3FBE147B = +1.485°
    #[test]
    fn test_parse_reply_doc_vector() {
        let reply = make_reply(-2.083, 1.485);
        let (angle, consumed) = parse_angle_stream(&reply).unwrap().expect("should parse");
        assert_eq!(consumed, 13);
        assert!((angle.angle_x - (-2.083)).abs() < 1e-6, "X={}", angle.angle_x);
        assert!((angle.angle_y - 1.485).abs() < 1e-6, "Y={}", angle.angle_y);
    }

    /// 兼容标准 CRC 的应答（部分固件可能按标准算法）
    #[test]
    fn test_parse_reply_standard_crc() {
        let mut frame = vec![MODBUS_ADDR, FUNC_READ, 0x08];
        frame.extend_from_slice(&(-2.083f32).to_be_bytes());
        frame.extend_from_slice(&1.485f32.to_be_bytes());
        let crc = crc16_modbus(&frame);
        frame.push((crc & 0xFF) as u8);
        frame.push((crc >> 8) as u8);
        let (angle, _) = parse_angle_stream(&frame).unwrap().expect("should parse");
        assert!((angle.angle_x - (-2.083)).abs() < 1e-6);
    }

    /// 地址不符的帧不解析（从站地址 03，帧头 01 应跳过）
    #[test]
    fn test_wrong_addr_ignored() {
        let mut reply = vec![0x01u8, 0x03, 0x08];
        reply.extend_from_slice(&(-2.083f32).to_be_bytes());
        reply.extend_from_slice(&1.485f32.to_be_bytes());
        let crc = crc16_fw(&reply);
        reply.push((crc & 0xFF) as u8);
        reply.push((crc >> 8) as u8);
        // 缓冲里只有地址不符的帧 → 无合法帧，报错丢弃
        assert!(matches!(parse_angle_stream(&reply), Err((n, _)) if n >= 1));
    }

    /// 分包到达：先到 6 字节（不足），续传后完整解析
    #[test]
    fn test_fragmented_frame() {
        let reply = make_reply(-2.083, 1.485);
        let (first, rest) = reply.split_at(6);
        assert!(parse_angle_stream(first).unwrap().is_none());
        let mut buf = first.to_vec();
        buf.extend_from_slice(rest);
        let (angle, _) = parse_angle_stream(&buf).unwrap().expect("should parse");
        assert!((angle.angle_x - (-2.083)).abs() < 1e-6);
    }

    /// 透传流中夹带 WCH 模块配置帧（88 07 ...）后再接角度帧
    #[test]
    fn test_prefix_noise_before_frame() {
        let mut buf = vec![0x88, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x55];
        buf.extend_from_slice(&make_reply(-2.083, 1.485));
        let (angle, consumed) = parse_angle_stream(&buf).unwrap().expect("should parse");
        assert_eq!(consumed, buf.len());
        assert!((angle.angle_x - (-2.083)).abs() < 1e-6);
    }

    /// CRC 错误的帧不解析
    #[test]
    fn test_reject_bad_crc() {
        let mut reply = make_reply(-2.083, 1.485);
        *reply.last_mut().unwrap() ^= 0xFF; // 破坏 CRC
        match parse_angle_stream(&reply.clone()) {
            Err((dropped, _)) => assert!(dropped >= 1),
            Ok(_) => panic!("bad CRC should not parse"),
        }
        // 恢复后可解析
        let good = make_reply(-2.083, 1.485);
        assert!(parse_angle_stream(&good).unwrap().is_some());
    }

    /// 零角度帧
    #[test]
    fn test_zero_angles() {
        let frame = make_reply(0.0, 0.0);
        let (angle, _) = parse_angle_stream(&frame).unwrap().expect("should parse");
        assert_eq!(angle.angle_x, 0.0);
        assert_eq!(angle.angle_y, 0.0);
    }

    /// WCH 透传 UART 配置帧：115200 8N1
    #[test]
    fn test_wch_uart_config_115200_8n1() {
        let frame = build_wch_uart_config(115200, 8, 1, 0);
        assert_eq!(
            frame,
            vec![0x06, 0x00, 0x09, 0x00, 0x00, 0xC2, 0x01, 0x00, 0x08, 0x01, 0x00, 0xCC]
        );
        // 累加和自洽
        assert_eq!(frame[11], frame[3..11].iter().fold(0u8, |a, &b| a.wrapping_add(b)));
    }
}
