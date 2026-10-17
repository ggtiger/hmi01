//! 倾角传感器 Modbus RTU 协议（转向角模块，经 WCH BLE 串口透传）
//!
//! 读 X/Y 轴角度（厂商文档）：
//! - 发送：`01 03 00 01 00 04 15 C9`
//!   地址码(1) 功能码 0x03 读保持寄存器 寄存器地址 0x0001 数量 0x0004 CRC16(低前高后)
//! - 应答：`01 03 08 [X Angle 4B] [Y Angle 4B] [CRC16 L] [CRC16 H]`
//!   角度为 IEEE754 32 位浮点，大端（高字节在前）
//!   文档向量：0xC0054FDF = -2.083000°，0x3FBE147B = +1.485000°

use serde::{Deserialize, Serialize};

pub const MODBUS_ADDR: u8 = 0x01;
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

/// 构建读 X/Y 轴角度命令（文档向量）：`01 03 00 01 00 04 15 C9`
pub fn build_read_angle_command() -> Vec<u8> {
    let mut frame = vec![
        MODBUS_ADDR,
        FUNC_READ,
        (REG_ADDR >> 8) as u8,
        (REG_ADDR & 0xFF) as u8,
        (REG_COUNT >> 8) as u8,
        (REG_COUNT & 0xFF) as u8,
    ];
    let crc = crc16_modbus(&frame);
    frame.push((crc & 0xFF) as u8); // CRC16 L
    frame.push((crc >> 8) as u8); // CRC16 H
    frame
}

/// 从缓冲解析一帧读角度应答。
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
        // CRC：低字节在前
        let calc = crc16_modbus(&frame[..ANGLE_REPLY_LEN - 2]);
        let recv = u16::from_le_bytes([frame[ANGLE_REPLY_LEN - 2], frame[ANGLE_REPLY_LEN - 1]]);
        if calc != recv {
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

    /// 厂商文档向量：发送命令 01 03 00 01 00 04 15 C9
    #[test]
    fn test_build_command_doc_vector() {
        assert_eq!(
            build_read_angle_command(),
            vec![0x01, 0x03, 0x00, 0x01, 0x00, 0x04, 0x15, 0xC9]
        );
    }

    /// 厂商文档向量：应答 01 03 08 C0 05 4F DF 3F BE 14 7B 74 78
    /// X = 0xC0054FDF = -2.083°，Y = 0x3FBE147B = +1.485°
    #[test]
    fn test_parse_reply_doc_vector() {
        let reply = [
            0x01u8, 0x03, 0x08, 0xC0, 0x05, 0x4F, 0xDF, 0x3F, 0xBE, 0x14, 0x7B, 0x74, 0x78,
        ];
        let (angle, consumed) = parse_angle_stream(&reply).unwrap().expect("should parse");
        assert_eq!(consumed, 13);
        assert!((angle.angle_x - (-2.083)).abs() < 1e-6, "X={}", angle.angle_x);
        assert!((angle.angle_y - 1.485).abs() < 1e-6, "Y={}", angle.angle_y);
    }

    /// 分包到达：先到 6 字节（不足），续传后完整解析
    #[test]
    fn test_fragmented_frame() {
        let reply = [
            0x01u8, 0x03, 0x08, 0xC0, 0x05, 0x4F, 0xDF, 0x3F, 0xBE, 0x14, 0x7B, 0x74, 0x78,
        ];
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
        buf.extend_from_slice(&[
            0x01u8, 0x03, 0x08, 0xC0, 0x05, 0x4F, 0xDF, 0x3F, 0xBE, 0x14, 0x7B, 0x74, 0x78,
        ]);
        let (angle, consumed) = parse_angle_stream(&buf).unwrap().expect("should parse");
        assert_eq!(consumed, buf.len());
        assert!((angle.angle_x - (-2.083)).abs() < 1e-6);
    }

    /// CRC 错误的帧不解析
    #[test]
    fn test_reject_bad_crc() {
        let mut reply = vec![
            0x01u8, 0x03, 0x08, 0xC0, 0x05, 0x4F, 0xDF, 0x3F, 0xBE, 0x14, 0x7B, 0x74, 0x79, // CRC 错
        ];
        // 头唯一且 CRC 错 → 报错丢弃
        match parse_angle_stream(&reply.clone()) {
            Err((dropped, _)) => assert!(dropped >= 1),
            Ok(_) => panic!("bad CRC should not parse"),
        }
        reply[12] = 0x78;
        assert!(parse_angle_stream(&reply).unwrap().is_some());
    }

    /// 零角度帧：00 00 00 00 / 00 00 00 00
    #[test]
    fn test_zero_angles() {
        let mut frame = vec![0x01, 0x03, 0x08, 0, 0, 0, 0, 0, 0, 0, 0];
        let crc = crc16_modbus(&frame);
        frame.push((crc & 0xFF) as u8);
        frame.push((crc >> 8) as u8);
        let (angle, _) = parse_angle_stream(&frame).unwrap().expect("should parse");
        assert_eq!(angle.angle_x, 0.0);
        assert_eq!(angle.angle_y, 0.0);
    }
}
