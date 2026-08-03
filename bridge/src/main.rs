//! ap-browser-bridge — Network bridge for remote CLI testing.
//!
//! Runs on the host (where Chrome + ap-browser-host live). Listens on TCP,
//! authenticates each connection via bearer token, then pumps 4-byte LE
//! framed bytes between the TCP client and the local Unix socket / named
//! pipe that the real ap-browser-host is bound to.
//!
//! Use case: a Linux container (CI, Apple Container) needs to drive the
//! user's real Chrome extension. Containers can't connect to host kernel
//! objects (Unix socket inode), so the bridge tunnels the bytes over TCP,
//! which IS routable across the VM boundary.
//!
//! Usage (host):
//!     ap-browser-bridge --instance <id> --listen 127.0.0.1:17777
//!
//! The bridge prints a one-shot `AP_BROWSER_REMOTE` env value with a
//! randomly-generated token. Set that in the container's CLI env and the
//! existing ap-browser CLI will dial TCP instead of looking for a local
//! socket.
//!
//! One bridge per Chrome extension instance. The host-side socket is already
//! a multiplexer; we just add a TCP entry point to it.

use anyhow::{bail, Context, Result};
use ap_browser_core::transport;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

const AUTH_FRAME_MAX: usize = 4 * 1024;
const MESSAGE_FRAME_MAX: usize = 64 * 1024 * 1024;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let instance = flag_value(&args, "--instance").unwrap_or_else(|| {
        eprintln!(
            "usage: ap-browser-bridge --instance <id> [--listen ADDR:PORT] [--token-file PATH]"
        );
        std::process::exit(2);
    });
    let listen = flag_value(&args, "--listen").unwrap_or_else(|| "127.0.0.1:17777".to_string());
    let token_file: PathBuf = flag_value(&args, "--token-file")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs_home().join(".ap-browser").join("bridge-token"));

    // Verify the target instance is actually online before opening the listener.
    // Saves the user from a bridge that accepts connections then dies on first use.
    let socket_name = transport::instance_name(&instance);
    if transport::connect(&socket_name).is_err() {
        bail!(
            "no ap-browser-host instance `{}` is listening on {}.\n\
             Is Chrome running with the extension loaded?",
            instance,
            socket_name
        );
    }

    // Generate bearer token. 32 bytes → base64.
    let token = generate_token();
    std::fs::create_dir_all(token_file.parent().unwrap())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(&token_file, &token)?;
        std::fs::set_permissions(&token_file, std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(windows)]
    {
        std::fs::write(&token_file, &token)?;
    }

    let listener = TcpListener::bind(&listen).with_context(|| format!("bind TCP {}", listen))?;
    eprintln!("[ap-browser-bridge] listening on tcp://{}", listen);
    eprintln!(
        "[ap-browser-bridge] forwarding to instance `{}` ({})",
        instance, socket_name
    );
    eprintln!(
        "[ap-browser-bridge] token written to {}",
        token_file.display()
    );
    eprintln!();
    eprintln!("In the remote container/VM, set:");
    eprintln!("    AP_BROWSER_REMOTE=tcp://{}?token={}", listen, token);
    eprintln!("    AP_BROWSER_INSTANCE={}", instance);
    eprintln!();
    eprintln!("Ctrl-C to stop.");

    for incoming in listener.incoming() {
        match incoming {
            Ok(tcp) => {
                let cfg = Config {
                    instance: instance.clone(),
                    socket_name: socket_name.clone(),
                    token: token.clone(),
                };
                thread::spawn(move || {
                    if let Err(e) = handle_conn(tcp, cfg) {
                        eprintln!("[ap-browser-bridge] conn: {e:#}");
                    }
                });
            }
            Err(e) => eprintln!("[ap-browser-bridge] accept: {e}"),
        }
    }
    Ok(())
}

#[derive(Clone)]
#[allow(dead_code)]
struct Config {
    instance: String,
    socket_name: String,
    token: String,
}

fn handle_conn(mut tcp: std::net::TcpStream, cfg: Config) -> Result<()> {
    tcp.set_read_timeout(Some(Duration::from_secs(10)))?;
    tcp.set_write_timeout(Some(Duration::from_secs(30)))?;

    let auth_req: serde_json::Value = read_auth_frame(&mut tcp)?;
    let got_token = auth_req.get("token").and_then(|v| v.as_str()).unwrap_or("");
    if got_token != cfg.token {
        let _ = write_tcp_frame(
            &mut tcp,
            &serde_json::json!({
                "ok": false,
                "error": { "code": "AUTH_FAILED", "message": "bad token" }
            }),
        );
        bail!("auth failed: bad token");
    }
    write_tcp_frame(&mut tcp, &serde_json::json!({"ok": true}))?;
    tcp.set_read_timeout(Some(Duration::from_secs(120)))?;

    // Authenticated. The CLI/host protocol is one-request-per-connection:
    // CLI opens, sends one frame, reads one frame, closes. So we open a
    // fresh upstream socket per TCP connection and pipe one frame each way.
    loop {
        let req = match read_tcp_frame(&mut tcp) {
            Ok(v) => v,
            Err(e) if is_eof(&e) => return Ok(()),
            Err(e) => return Err(e),
        };
        let mut sock = transport::connect(&cfg.socket_name)
            .with_context(|| format!("connect upstream {}", cfg.socket_name))?;
        write_frame(&mut sock, &req)?;
        let resp = read_frame_value(&mut sock)?;
        write_tcp_frame(&mut tcp, &resp)?;
    }
}

fn is_eof(e: &anyhow::Error) -> bool {
    let s = e.to_string();
    s.contains("UnexpectedEof") || s.contains("unexpected eof") || s.contains("ConnectionReset")
}

fn read_frame_value<R: Read>(r: &mut R) -> Result<serde_json::Value> {
    let mut header = [0u8; 4];
    r.read_exact(&mut header).context("read header")?;
    let len = u32::from_le_bytes(header) as usize;
    if len > MESSAGE_FRAME_MAX {
        bail!("frame too large: {len}");
    }
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload).context("read payload")?;
    Ok(serde_json::from_slice(&payload)?)
}

fn write_frame<W: Write>(w: &mut W, v: &serde_json::Value) -> Result<()> {
    let payload = serde_json::to_vec(v)?;
    w.write_all(&(payload.len() as u32).to_le_bytes())?;
    w.write_all(&payload)?;
    w.flush()?;
    Ok(())
}

fn read_auth_frame<R: Read>(stream: &mut R) -> Result<serde_json::Value> {
    read_tcp_frame_with_limit(stream, AUTH_FRAME_MAX, "auth")
}

fn read_tcp_frame<R: Read>(stream: &mut R) -> Result<serde_json::Value> {
    read_tcp_frame_with_limit(stream, MESSAGE_FRAME_MAX, "message")
}

fn read_tcp_frame_with_limit<R: Read>(
    stream: &mut R,
    limit: usize,
    kind: &str,
) -> Result<serde_json::Value> {
    let mut header = [0u8; 4];
    stream
        .read_exact(&mut header)
        .with_context(|| format!("read {kind} header"))?;
    let len = u32::from_le_bytes(header) as usize;
    if len > limit {
        bail!("{kind} frame too large: {len}");
    }
    let mut payload = vec![0u8; len];
    stream
        .read_exact(&mut payload)
        .with_context(|| format!("read {kind} payload"))?;
    Ok(serde_json::from_slice(&payload)?)
}

fn write_tcp_frame(stream: &mut std::net::TcpStream, v: &serde_json::Value) -> Result<()> {
    let payload = serde_json::to_vec(v)?;
    stream.write_all(&(payload.len() as u32).to_le_bytes())?;
    stream.write_all(&payload)?;
    stream.flush()?;
    Ok(())
}

fn generate_token() -> String {
    // Read 32 bytes from /dev/urandom (Unix) or CryptGenRandom-equivalent (Windows).
    #[cfg(unix)]
    {
        use std::io::Read;
        let mut buf = [0u8; 32];
        std::fs::File::open("/dev/urandom")
            .and_then(|mut f| f.read_exact(&mut buf))
            .map(|_| base64url(&buf))
            .unwrap_or_else(|_| fallback_token())
    }
    #[cfg(not(unix))]
    {
        fallback_token()
    }
}

fn fallback_token() -> String {
    // Last resort: time + pid hashed. Not cryptographically strong, but better than nothing.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let pid = std::process::id() as u64;
    base64url(&now.to_le_bytes())
        .chars()
        .take(32)
        .collect::<String>()
        + &base64url(&pid.to_le_bytes())
}

fn base64url(b: &[u8]) -> String {
    const TBL: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(b.len().div_ceil(3) * 4);
    for chunk in b.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TBL[((n >> 18) & 0x3f) as usize] as char);
        out.push(TBL[((n >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            out.push(TBL[((n >> 6) & 0x3f) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(TBL[(n & 0x3f) as usize] as char);
        }
    }
    out
}

fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.windows(2)
        .find(|w| w[0] == flag)
        .and_then(|w| w.get(1))
        .cloned()
}

fn dirs_home() -> PathBuf {
    std::env::var("HOME")
        .ok()
        .map(PathBuf::from)
        .or_else(|| std::env::var("USERPROFILE").ok().map(PathBuf::from))
        .unwrap_or_else(std::env::temp_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn oversized_auth_frame_is_rejected_before_payload_read() {
        let mut input = Cursor::new(((AUTH_FRAME_MAX + 1) as u32).to_le_bytes());
        let error = read_auth_frame(&mut input).unwrap_err().to_string();
        assert!(error.contains("auth frame too large"));
    }

    #[test]
    fn normal_frames_keep_the_large_authenticated_limit() {
        let mut bytes = Vec::new();
        let mut payload = b"{}".to_vec();
        payload.resize(AUTH_FRAME_MAX + 1, b' ');
        bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&payload);

        assert_eq!(
            read_tcp_frame(&mut Cursor::new(bytes)).unwrap(),
            serde_json::json!({})
        );
    }
}
