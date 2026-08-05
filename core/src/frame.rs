//! Frame codec: 4-byte LE length prefix + UTF-8 JSON payload.
//!
//! Identical framing on both transports (Chrome native messaging stdin/stdout,
//! and Unix domain socket between CLI and host). The cap bounds runaway
//! responses (a screenshot data_url + annotation can reach several MB on
//! heavy pages); 64 MiB matches the CLI's read side. Chrome's native messaging
//! spec itself does not impose a 1 MiB frame limit.

use serde_json::Value;
use std::io::Read;
use thiserror::Error;

/// Upper bound for a single frame (screenshots are the big ones).
pub const MAX_FRAME_SIZE: usize = 64 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum FrameError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("frame too large: {0} bytes (max {MAX_FRAME_SIZE})")]
    TooLarge(usize),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
}

/// Encode a JSON value into a framed byte buffer.
pub fn encode(value: &Value) -> Result<Vec<u8>, FrameError> {
    let payload = serde_json::to_vec(value)?;
    if payload.len() > MAX_FRAME_SIZE {
        return Err(FrameError::TooLarge(payload.len()));
    }
    let mut buf = Vec::with_capacity(4 + payload.len());
    buf.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    buf.extend_from_slice(&payload);
    Ok(buf)
}

/// Read a single framed JSON value from a reader. Blocks until a full frame
/// is available or EOF.
pub fn read_frame<R: Read>(r: &mut R) -> Result<Value, FrameError> {
    let mut header = [0u8; 4];
    r.read_exact(&mut header)?;
    let len = u32::from_le_bytes(header) as usize;
    if len > MAX_FRAME_SIZE {
        return Err(FrameError::TooLarge(len));
    }
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload)?;
    Ok(serde_json::from_slice(&payload)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_simple() {
        let val = serde_json::json!({"hello": "world", "n": 42});
        let bytes = encode(&val).unwrap();
        let mut cursor = std::io::Cursor::new(bytes);
        let back = read_frame(&mut cursor).unwrap();
        assert_eq!(val, back);
    }

    #[test]
    fn rejects_oversized() {
        // Force a payload larger than MAX_FRAME_SIZE by crafting bytes directly.
        let huge = vec![b' '; MAX_FRAME_SIZE + 1];
        let mut buf = Vec::with_capacity(4 + huge.len());
        buf.extend_from_slice(&((huge.len()) as u32).to_le_bytes());
        buf.extend_from_slice(&huge);
        let mut cursor = std::io::Cursor::new(buf);
        let err = read_frame(&mut cursor).unwrap_err();
        assert!(matches!(err, FrameError::TooLarge(_)));
    }

    #[test]
    fn empty_payload() {
        // Smallest valid JSON: empty object {} = 2 bytes.
        let val = serde_json::json!({});
        let bytes = encode(&val).unwrap();
        // Header should be 4-byte LE length = 2
        assert_eq!(&bytes[..4], &[2, 0, 0, 0]);
        let mut cursor = std::io::Cursor::new(bytes);
        let back = read_frame(&mut cursor).unwrap();
        assert_eq!(val, back);
    }
}
