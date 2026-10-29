//! Frame codec for the CLI side.

use anyhow::{bail, Context, Result};
use serde_json::Value;
use std::io::Read;
use std::time::Duration;

pub fn encode(value: &Value) -> Result<Vec<u8>> {
    let payload = serde_json::to_vec(value)?;
    let mut buf = Vec::with_capacity(4 + payload.len());
    buf.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    buf.extend_from_slice(&payload);
    Ok(buf)
}

/// Decode one frame (also used by in-process fixture servers).
/// Production clients use `read_response_owned` to enforce their own deadline.
pub fn read_response<R: Read>(stream: &mut R, _timeout: Duration) -> Result<Value> {
    let mut header = [0u8; 4];
    stream.read_exact(&mut header).context("read header")?;
    let len = u32::from_le_bytes(header) as usize;
    if len > 64 * 1024 * 1024 {
        bail!("frame too large: {len}");
    }
    let mut payload = vec![0u8; len];
    stream.read_exact(&mut payload).context("read payload")?;
    Ok(serde_json::from_slice(&payload)?)
}

/// Own the single-response connection so a blocked read cannot outlive the CLI
/// deadline. Works for local sockets, Windows pipes and remote TCP alike; do
/// not rely on the peer honoring `_timeout_hint_secs`. A late response is
/// discarded, never retried (an interaction may already have executed).
pub fn read_response_owned<R: Read + Send + 'static>(
    mut stream: R,
    timeout: Duration,
) -> Result<Value> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let _ = tx.send(read_response(&mut stream, timeout));
    });
    rx.recv_timeout(timeout).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            format!("response deadline exceeded after {}s; the command may have executed — inspect state before retrying", timeout.as_secs_f64()),
        )
    })?
}

/// Normalize both JSON-RPC and direct-host failures. Never emit bare ok:false.
pub fn response(envelope: Value) -> Value {
    let mut response = if let Some(result) = envelope.get("result") {
        result.clone()
    } else if let Some(error) = envelope.get("error") {
        serde_json::json!({"ok": false, "error": error})
    } else {
        envelope
    };
    if response.get("ok").and_then(Value::as_bool) == Some(false) {
        let mut error = response.get("error").cloned().unwrap_or_default();
        if !error.is_object() {
            error = serde_json::json!({"message": error.as_str().unwrap_or("Extension returned ok:false without an error reason")});
        }
        if error
            .get("code")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .is_none()
        {
            error["code"] = serde_json::json!("INTERNAL");
        }
        if error
            .get("message")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .is_none()
        {
            error["message"] = serde_json::json!("Extension returned ok:false without an error reason; inspect state before retrying");
        }
        response["error"] = error;
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silent_reader_is_bounded_independently_of_host() {
        struct Slow;
        impl Read for Slow {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                std::thread::sleep(Duration::from_millis(200));
                Ok(0)
            }
        }
        let start = std::time::Instant::now();
        let error = read_response_owned(Slow, Duration::from_millis(10)).unwrap_err();
        assert_eq!(
            error.downcast_ref::<std::io::Error>().unwrap().kind(),
            std::io::ErrorKind::TimedOut
        );
        assert!(start.elapsed() < Duration::from_millis(150));
    }

    #[test]
    fn error_envelopes_always_have_a_reason() {
        for value in [
            serde_json::json!({"result": {"ok": false}}),
            serde_json::json!({"ok": false}),
            serde_json::json!({"ok": false, "error": "failed"}),
        ] {
            let value = response(value);
            assert_eq!(value["error"]["code"], "INTERNAL");
            assert!(!value["error"]["message"].as_str().unwrap().is_empty());
        }
        assert_eq!(
            response(serde_json::json!({"error": {"code": "STALE_REF", "message": "changed"}}))
                ["error"]["code"],
            "STALE_REF"
        );
    }
}
