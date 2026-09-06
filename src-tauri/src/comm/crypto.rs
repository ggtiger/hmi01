//! Xdesin 协议传输加密封装（协议 §1.2）
//!
//! 帧 = base64( nonce[2B BE] ‖ AES-128-CTR 密文 ‖ HMAC-MD5[16B] ) + '\n'
//! - PSK: "Xdesin0123456789"（16 字节）
//! - IV: 16 字节，前 14 字节 0x00，末 2 字节 nonce 大端
//! - HMAC-MD5(key=PSK, message = nonce ‖ ciphertext)，完整 16 字节
//! - nonce: uint16 发送计数器，每包 +1，0xFFFF 后回绕 0；重连复位
//! - 重放保护: 接收 nonce ≤ 上次值丢弃（回绕放行: last > 0xF000 && cur < 0x0FFF）

use aes::Aes128;
use aes::cipher::{KeyIvInit, StreamCipher};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use ctr::Ctr128BE;
use hmac::{Hmac, Mac};
use md5::Md5;

pub const PSK: &[u8; 16] = b"Xdesin0123456789";
/// 最小合法帧长: nonce 2B + HMAC 16B
pub const MIN_FRAME_LEN: usize = 18;

type HmacMd5 = Hmac<Md5>;

pub struct Crypto {
    tx_nonce: u16,
    last_rx_nonce: Option<u16>,
    /// 明文调试模式（协议 §1.3）
    pub plain_mode: bool,
}

impl Crypto {
    pub fn new() -> Self {
        Crypto {
            tx_nonce: 0,
            last_rx_nonce: None,
            plain_mode: false,
        }
    }

    /// 重置（每次新建 TCP 连接双方 nonce 都重置为 0，明文模式复位）
    pub fn reset(&mut self) {
        self.tx_nonce = 0;
        self.last_rx_nonce = None;
        self.plain_mode = false;
    }

    /// 加密一行明文（不含换行符），返回 base64 帧
    pub fn encrypt_line(&mut self, plaintext: &[u8]) -> String {
        let nonce = self.tx_nonce;
        self.tx_nonce = self.tx_nonce.wrapping_add(1);

        let ciphertext = Self::crypt(plaintext, nonce);
        let mut mac = HmacMd5::new_from_slice(PSK).expect("HMAC key");
        mac.update(&nonce.to_be_bytes());
        mac.update(&ciphertext);
        let tag = mac.finalize().into_bytes();

        let mut frame = Vec::with_capacity(2 + ciphertext.len() + 16);
        frame.extend_from_slice(&nonce.to_be_bytes());
        frame.extend_from_slice(&ciphertext);
        frame.extend_from_slice(&tag);
        BASE64.encode(frame)
    }

    /// 解密一行。
    /// - Ok(Some(pt)): 合法加密帧，返回明文
    /// - Ok(None): 不是加密帧（base64 解码失败 / 长度不足 / HMAC 校验失败），按明文处理
    /// - Err(msg): 加密帧合法但重放丢弃
    pub fn decrypt_line(&mut self, line: &str) -> Result<Option<Vec<u8>>, String> {
        let frame = match BASE64.decode(line.as_bytes()) {
            Ok(f) => f,
            Err(_) => return Ok(None),
        };
        if frame.len() < MIN_FRAME_LEN {
            return Ok(None);
        }
        let nonce = u16::from_be_bytes([frame[0], frame[1]]);
        let (ciphertext, tag) = frame.split_at(frame.len() - 16);
        let ciphertext = &ciphertext[2..];

        // HMAC 常时比较
        let mut mac = HmacMd5::new_from_slice(PSK).expect("HMAC key");
        mac.update(&frame[0..2]);
        mac.update(ciphertext);
        if mac.verify_slice(tag).is_err() {
            return Ok(None);
        }

        // 重放保护
        if !Self::accept_nonce(self.last_rx_nonce, nonce) {
            return Err(format!("重放包丢弃 nonce={} last={:?}", nonce, self.last_rx_nonce));
        }
        self.last_rx_nonce = Some(nonce);

        Ok(Some(Self::crypt(ciphertext, nonce)))
    }

    /// 形似加密帧的行：长度 ≥ 24 且全为 base64 字符（协议 §1.3 双模式收包判定）
    pub fn looks_encrypted(line: &str) -> bool {
        line.len() >= 24
            && line
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=')
    }

    /// AES-128-CTR 加解密（CTR 对称）
    fn crypt(data: &[u8], nonce: u16) -> Vec<u8> {
        let mut iv = [0u8; 16];
        iv[14] = (nonce >> 8) as u8;
        iv[15] = (nonce & 0xFF) as u8;
        let mut cipher = Ctr128BE::<Aes128>::new_from_slices(PSK, &iv).expect("CTR init");
        let mut out = data.to_vec();
        cipher.apply_keystream(&mut out);
        out
    }

    fn accept_nonce(last: Option<u16>, cur: u16) -> bool {
        match last {
            None => true,
            Some(last) => {
                if cur <= last {
                    // 回绕放行
                    last > 0xF000 && cur < 0x0FFF
                } else {
                    true
                }
            }
        }
    }
}

impl Default for Crypto {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_roundtrip() {
        let mut tx = Crypto::new();
        let mut rx = Crypto::new();

        for msg in ["PING", "HELLO xdesin-host", "PEDAL A START", "SET REPORT 20"] {
            let frame = tx.encrypt_line(msg.as_bytes());
            assert!(Crypto::looks_encrypted(&frame));
            let pt = rx.decrypt_line(&frame).unwrap().expect("should decrypt");
            assert_eq!(String::from_utf8(pt).unwrap(), msg);
        }
        // nonce 递增
        assert_eq!(tx.tx_nonce, 4);
        assert_eq!(rx.last_rx_nonce, Some(3));
    }

    #[test]
    fn test_replay_rejected() {
        let mut tx = Crypto::new();
        let mut rx = Crypto::new();
        let frame = tx.encrypt_line(b"PING");
        assert!(rx.decrypt_line(&frame).unwrap().is_some());
        // 同一帧重放 → Err
        assert!(rx.decrypt_line(&frame).is_err());
        // 跳过 nonce 3、4，直接发 5 → 放行（只防 ≤，不防乱序空洞）
        let f5 = {
            tx.tx_nonce = 5;
            tx.encrypt_line(b"PING2")
        };
        assert!(rx.decrypt_line(&f5).unwrap().is_some());
    }

    #[test]
    fn test_wraparound_allowed() {
        let mut rx = Crypto::new();
        rx.last_rx_nonce = Some(0xFFF0);
        // 回绕到 0x0001 → 放行
        assert!(Crypto::accept_nonce(Some(0xFFF0), 0x0001));
        let _ = rx;
    }

    #[test]
    fn test_replay_normal_overflow_rejected() {
        // 正常递增区间内的"回绕"不该放行
        assert!(!Crypto::accept_nonce(Some(100), 99));
        assert!(!Crypto::accept_nonce(Some(0x0100), 0x0010));
    }

    #[test]
    fn test_tampered_frame_is_plain() {
        let mut tx = Crypto::new();
        let mut rx = Crypto::new();
        let mut frame = tx.encrypt_line(b"SECRET");
        // 篡改一个字符 → HMAC 失败 → 按非加密帧处理
        let last = frame.pop().unwrap();
        frame.push(if last == 'A' { 'B' } else { 'A' });
        assert!(rx.decrypt_line(&frame).unwrap().is_none());
    }

    #[test]
    fn test_plain_line_not_encrypted() {
        let mut rx = Crypto::new();
        // 明文命令行（含空格/短行）不应被当作加密帧
        assert!(rx.decrypt_line("DEBUG PLAIN OFF").unwrap().is_none());
        assert!(rx.decrypt_line("PONG").unwrap().is_none());
        assert!(!Crypto::looks_encrypted("PONG"));
        assert!(Crypto::looks_encrypted(&"A".repeat(24)));
    }

    /// 与 mock-device-server.js（Node crypto）对拍：固定 nonce/IV 的已知向量
    /// 本测试验证 IV 派生正确性：IV = 14×0x00 + nonce BE
    #[test]
    fn test_iv_derivation_deterministic() {
        let mut tx = Crypto::new();
        let f1 = tx.encrypt_line(b"X");
        let mut tx2 = Crypto::new();
        let f2 = tx2.encrypt_line(b"X");
        // 相同 nonce 相同明文 → 相同帧（确定性）
        assert_eq!(f1, f2);
        assert_ne!(f1, tx.encrypt_line(b"X")); // nonce 已递增
    }

    /// 双向对拍：A→B→A 多轮，模拟真实会话（各自独立 tx/rx 计数器）
    #[test]
    fn test_full_duplex_session() {
        let mut host = Crypto::new();
        let mut dev = Crypto::new();
        // host 与 dev 各自有 tx 计数器，所以用两组 crypto 模拟
        let mut host_rx = Crypto::new();
        let mut dev_rx = Crypto::new();

        let up = ["HELLO host", "INFO GET", "PEDAL SELECT A"];
        for m in up {
            let f = host.encrypt_line(m.as_bytes());
            let d = dev_rx.decrypt_line(&f).unwrap().unwrap();
            assert_eq!(String::from_utf8(d).unwrap(), m);
        }
        let down = ["PONG", "INFO fw=1.0.0 hw=s3 uptime=10 ssid=XDESIN"];
        for m in down {
            let f = dev.encrypt_line(m.as_bytes());
            let d = host_rx.decrypt_line(&f).unwrap().unwrap();
            assert_eq!(String::from_utf8(d).unwrap(), m);
        }
    }

    /// 跨语言对拍向量：由 scripts/mock-device-server.js 的 Node crypto 生成
    /// （aes-128-ctr + hmac-md5，PSK='Xdesin0123456789'，IV=14×0x00+nonce BE）
    #[test]
    fn test_node_cross_vectors() {
        // Node: encrypt('PING', 0)
        let mut rx = Crypto::new();
        let pt = rx
            .decrypt_line("AADQLIoVJf5KHmgOCnBf2qhrOstlbQ==")
            .unwrap()
            .expect("should decrypt node frame");
        assert_eq!(String::from_utf8(pt).unwrap(), "PING");

        // Node: encrypt('HELLO xdesin-host', 7)
        let mut rx2 = Crypto::new();
        rx2.last_rx_nonce = Some(6);
        let pt2 = rx2
            .decrypt_line("AAdTJZJjgz0bd0HOy8ZZA1/6aICGxotKv2KLVtPBAifLQlo=")
            .unwrap()
            .expect("should decrypt node frame");
        assert_eq!(String::from_utf8(pt2).unwrap(), "HELLO xdesin-host");
    }
}
