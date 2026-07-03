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

/// Read a framed JSON response.
///
/// `timeout` is honored via host-side `mpsc::recv_timeout` (30s cap) —
/// the host will always return a response or drop the connection. Per-read
/// timeout on the CLI side isn't uniformly supported across transports
/// (Windows named pipe has no `set_read_timeout`), so we rely on the host
/// to bound the worst case.
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
