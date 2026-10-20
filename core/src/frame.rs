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

    fn raw_json_frame(text: &str) -> Vec<u8> {
        let mut bytes = (text.len() as u32).to_le_bytes().to_vec();
        bytes.extend_from_slice(text.as_bytes());
        bytes
    }

    #[test]
    fn precision_captured_js_lexeme_survives_actual_frame_parser_and_serializer() {
        // Actual live JS mark lexeme: default serde_json previously parsed +1 ULP.
        let lexeme = "1106.2999999523163";
        let expected = lexeme.parse::<f64>().unwrap(); // independent std float parser
        let text = format!(r#"{{"t_ms":{lexeme}}}"#);
        let mut framed = raw_json_frame(&text); // intentionally NOT json!/Value first
        for hop in 0..8 {
            let parsed = read_frame(&mut framed.as_slice()).unwrap();
            let actual = parsed["t_ms"].as_f64().unwrap();
            assert_eq!(
                actual.to_bits(),
                expected.to_bits(),
                "parser hop {hop}: {lexeme} -> {actual}"
            );
            framed = encode(&parsed).unwrap();
        }
        // Check the serializer separately, using std to parse its numeric output.
        let encoded = encode(&Value::from(expected)).unwrap();
        let serialized = std::str::from_utf8(&encoded[4..]).unwrap();
        assert_eq!(
            serialized.parse::<f64>().unwrap().to_bits(),
            expected.to_bits()
        );
    }

    #[test]
    fn precision_deterministic_timestamp_corpus_preserves_bits_across_eight_hops() {
        let captured = [
            "1106.2999999523163",
            "1076.1000000953675",
            "1000.1000000238419",
            "29.700000047683716",
            "0.19999999999708962",
            "90.30000000000291",
        ];
        let cases = captured
            .iter()
            .map(|s| s.parse::<f64>().unwrap())
            .chain((0..10_000).map(|n| (100_000.0 + f64::from(n) / 10.0) - 100_000.0));
        let mut mismatches = Vec::new();
        for (index, expected) in cases.enumerate() {
            let lexeme = expected.to_string();
            let mut framed = raw_json_frame(&format!(r#"{{"t_ms":{lexeme}}}"#));
            let mut bad = false;
            for _ in 0..8 {
                let parsed = read_frame(&mut framed.as_slice()).unwrap();
                bad |= parsed["t_ms"].as_f64().unwrap().to_bits() != expected.to_bits();
                framed = encode(&parsed).unwrap();
            }
            if bad {
                mismatches.push((index, lexeme));
            }
            let serialized = serde_json::to_string(&expected).unwrap();
            assert_eq!(
                serialized.parse::<f64>().unwrap().to_bits(),
                expected.to_bits(),
                "serializer case {index}"
            );
        }
        assert!(
            mismatches.is_empty(),
            "{} / 10006 parser/framing mismatches; first: {:?}",
            mismatches.len(),
            &mismatches[..mismatches.len().min(6)]
        );
    }

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
