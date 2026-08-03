//! Cross-platform IPC transport: Unix domain socket on Unix,
//! Windows named pipe on Windows. Both wrapped behind one API via
//! `interprocess::local_socket`.
//!
//! Address naming convention:
//! - Unix: filesystem path in `$TMPDIR` (or `/tmp`) → `ap-browser-<id>.sock`
//! - Windows: bare name → interprocess maps to `\\.\pipe\ap-browser-<id>`
//!
//! Discovery:
//! - Unix: scan `$TMPDIR` for `ap-browser-*.sock` files
//! - Windows: named pipes aren't enumerable; host writes an instance
//!   registry file under `%TEMP%\ap-browser-instances\<id>` on bind,
//!   CLI scans that dir

use std::io;
#[cfg(windows)]
use std::path::PathBuf;
use std::time::Duration;

// prelude brings in name-conversion + listener/stream trait methods (anonymously).
use interprocess::local_socket::prelude::*;
use interprocess::local_socket::{GenericFilePath, ListenerOptions, Name};

pub use interprocess::local_socket::Listener;
pub use interprocess::local_socket::Stream;

const REMOTE_RESPONSE_TIMEOUT_SECS: u64 = 3_615;

pub fn bind(name: &str) -> io::Result<Listener> {
    let listener = ListenerOptions::new().name(make_name(name)).create_sync()?;
    #[cfg(unix)]
    if let Err(error) = owner_only(name) {
        drop(listener);
        let _ = std::fs::remove_file(name);
        return Err(error);
    }
    Ok(listener)
}

#[cfg(unix)]
fn owner_only(path: &str) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

pub fn connect(name: &str) -> io::Result<Stream> {
    Stream::connect(make_name(name))
}

fn make_name(name: &str) -> Name<'_> {
    name.to_fs_name::<GenericFilePath>()
        .expect("invalid local socket path")
}

/// Build the local-socket address for an instance id.
pub fn instance_name(id: &str) -> String {
    #[cfg(unix)]
    {
        let mut p = std::env::temp_dir();
        p.push(format!("ap-browser-{}.sock", id));
        p.to_string_lossy().into_owned()
    }
    #[cfg(windows)]
    {
        // GenericFilePath requires the \\.\pipe\ prefix on Windows.
        format!("\\\\.\\pipe\\ap-browser-{}", id)
    }
}

/// Return all currently registered instance ids.
pub fn list_instance_ids() -> io::Result<Vec<String>> {
    #[cfg(unix)]
    {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(std::env::temp_dir())? {
            let entry = entry?;
            let name = entry.file_name();
            let s = name.to_string_lossy();
            if let Some(mid) = s
                .strip_prefix("ap-browser-")
                .and_then(|s| s.strip_suffix(".sock"))
            {
                out.push(mid.to_string());
            }
        }
        Ok(out)
    }
    #[cfg(windows)]
    {
        let dir = registry_dir();
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            if let Some(s) = entry.file_name().to_str() {
                out.push(s.to_string());
            }
        }
        Ok(out)
    }
}

/// Registry dir for instance files (Windows-only mechanism).
#[cfg(windows)]
pub fn registry_dir() -> PathBuf {
    std::env::temp_dir().join("ap-browser-instances")
}

/// Announce an instance is live. No-op on Unix (the .sock file is the registry).
/// Writes a marker file on Windows so CLI discovery can enumerate.
pub fn register_instance(id: &str) -> io::Result<()> {
    #[cfg(windows)]
    {
        let dir = registry_dir();
        std::fs::create_dir_all(&dir)?;
        let _ = std::fs::File::create(dir.join(id));
    }
    #[cfg(unix)]
    {
        let _ = id;
    }
    Ok(())
}

/// Remove an instance announcement.
pub fn unregister_instance(id: &str) -> io::Result<()> {
    #[cfg(windows)]
    {
        let _ = std::fs::remove_file(registry_dir().join(id));
    }
    #[cfg(unix)]
    {
        let _ = std::fs::remove_file(instance_name(id));
    }
    Ok(())
}

/// Best-effort read timeout on the stream.
///
/// interprocess LocalSocketStream doesn't expose set_read_timeout on Windows
/// named pipes. Host-side `mpsc::recv_timeout(30s)` already bounds worst-case
/// CLI wait, so this is a hint, not a guarantee.
pub fn set_read_timeout(_s: &mut Stream, _dur: Option<Duration>) -> io::Result<()> {
    Ok(())
}

/// Default timeout used when callers don't specify one (matches host mpsc cap).
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

// ── Remote TCP bridge support ─────────────────────────────────────────────
// Opt-in: only active when AP_BROWSER_REMOTE is set. See bridge/src/main.rs.
//
// Format: tcp://HOST:PORT?token=TOKEN
// On connect, CLI sends {"token": TOKEN} as the first frame, expects {"ok":true}.

/// Returns Some(addr, token) if AP_BROWSER_REMOTE is set, else None.
pub fn remote_endpoint() -> Option<(String, String)> {
    let s = std::env::var("AP_BROWSER_REMOTE").ok()?;
    let s = s.strip_prefix("tcp://")?;
    let (addr, token) = s.split_once('?').unwrap_or((s, ""));
    let token = token.strip_prefix("token=").unwrap_or("");
    Some((addr.to_string(), token.to_string()))
}

/// Dial the bridge. Performs the auth handshake. Returns a TcpStream that
/// the rest of the CLI can treat like a local socket: send one request frame,
/// read one response frame, drop.
pub fn connect_remote(addr: &str, token: &str) -> io::Result<std::net::TcpStream> {
    use std::io::{Read, Write};
    let mut s = std::net::TcpStream::connect(addr)?;
    s.set_read_timeout(Some(Duration::from_secs(10)))?;
    let auth = serde_json::json!({"token": token});
    let payload =
        serde_json::to_vec(&auth).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    s.write_all(&(payload.len() as u32).to_le_bytes())?;
    s.write_all(&payload)?;
    s.flush()?;
    let mut header = [0u8; 4];
    s.read_exact(&mut header)?;
    let len = u32::from_le_bytes(header) as usize;
    if len > 64 * 1024 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "frame too large",
        ));
    }
    let mut buf = vec![0u8; len];
    s.read_exact(&mut buf)?;
    let resp: serde_json::Value =
        serde_json::from_slice(&buf).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    if resp.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("bridge auth failed: {:?}", resp.get("error")),
        ));
    }
    s.set_read_timeout(Some(Duration::from_secs(REMOTE_RESPONSE_TIMEOUT_SECS)))?;
    Ok(s)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn bound_socket_is_owner_only() {
        let path = std::path::Path::new("/tmp").join(format!(
            "ap-browser-permission-test-{}-{}.sock",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let name = path.to_string_lossy().into_owned();
        let listener = bind(&name).unwrap();

        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );

        drop(listener);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn remote_socket_allows_long_host_response_timeout() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut header = [0u8; 4];
            stream.read_exact(&mut header).unwrap();
            let mut auth = vec![0u8; u32::from_le_bytes(header) as usize];
            stream.read_exact(&mut auth).unwrap();
            let response = serde_json::to_vec(&serde_json::json!({"ok": true})).unwrap();
            stream
                .write_all(&(response.len() as u32).to_le_bytes())
                .unwrap();
            stream.write_all(&response).unwrap();
        });

        let stream = connect_remote(&address.to_string(), "token").unwrap();

        assert_eq!(
            stream.read_timeout().unwrap(),
            Some(Duration::from_secs(3_615))
        );
        server.join().unwrap();
    }
}
