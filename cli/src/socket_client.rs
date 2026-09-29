//! Socket discovery, profile resolution, dialing.

use crate::cli_frame;
use crate::ProfileInfo;
use anyhow::{anyhow, bail, Context, Result};
use ap_browser_core::transport;
use serde_json::json;
use std::io;
use std::time::Duration;

/// Why instance resolution failed. `NoInstance` and `NoProfileMatch` are
/// transient (extension service worker reconnecting) and worth retrying
/// under `--wait-online`; `Multiple` is a user decision and fails fast.
enum ResolveFailure {
    NoInstance { dir: String },
    NoProfileMatch { want: String, online: String },
    Multiple { online: String },
}

impl ResolveFailure {
    fn retryable(&self) -> bool {
        matches!(
            self,
            ResolveFailure::NoInstance { .. } | ResolveFailure::NoProfileMatch { .. }
        )
    }

    fn into_error(self) -> anyhow::Error {
        match self {
            ResolveFailure::NoInstance { dir } => anyhow!(
                "no extension instance online (looked for ap-browser-* in {dir}). \
                 Is Chrome running with the ap-browser-connect extension loaded?"
            ),
            ResolveFailure::NoProfileMatch { want, online } => anyhow!(
                "no online profile matches `{want}`.\n\
                 Online profiles:\n{online}\n\
                 Run `ap-browser use <id|label>` to switch."
            ),
            ResolveFailure::Multiple { online } => anyhow!(
                "multiple profiles online, none selected.\n\
                 Run `ap-browser profiles` then `ap-browser use <id>`.\n\
                 Online profiles:\n{online}"
            ),
        }
    }
}

/// Resolve which instance the CLI should talk to.
/// Returns the instance id; callers pass it to `dial_with_retry`.
pub fn resolve_socket(profile_override: Option<&str>) -> Result<String> {
    resolve_socket_inner(profile_override).map_err(|f| f.into_error())
}

fn resolve_socket_inner(
    profile_override: Option<&str>,
) -> std::result::Result<String, ResolveFailure> {
    // Remote bridge mode: skip local discovery entirely. The bridge forwards
    // to a single pre-configured instance on the host.
    if transport::remote_endpoint().is_some() {
        let id = profile_override
            .map(String::from)
            .or_else(|| std::env::var("AP_BROWSER_INSTANCE").ok())
            .unwrap_or_else(|| "remote".into());
        return Ok(id);
    }

    let ids = list_instance_ids().map_err(|_| ResolveFailure::NoInstance {
        dir: transport::instance_name("<id>"),
    })?;
    if ids.is_empty() {
        return Err(ResolveFailure::NoInstance {
            dir: transport::instance_name("<id>"),
        });
    }

    let wanted: Option<String> = match profile_override.map(String::from) {
        Some(s) => Some(s),
        None => crate::read_current_profile().ok().flatten(),
    };

    if let Some(want) = wanted {
        for id in &ids {
            let info = match probe_info(id) {
                Ok(i) => i,
                Err(_) => continue,
            };
            if info.instance_id == want
                || info.instance_id.starts_with(&want)
                || info.label.as_deref() == Some(want.as_str())
            {
                return Ok(id.clone());
            }
        }
        return Err(ResolveFailure::NoProfileMatch {
            want,
            online: format_online_profiles(&ids),
        });
    }

    if ids.len() == 1 {
        return Ok(ids[0].clone());
    }

    // Multiple instances, no selection: probe each and show the user.
    Err(ResolveFailure::Multiple {
        online: format_online_profiles(&ids),
    })
}

/// `resolve_socket` with a bounded wait for the extension to (re)appear.
/// During a service-worker/native-host reconnect the discovery socket is
/// briefly absent; instead of failing immediately (forcing agents to poll
/// `ap-browser status` in a loop), retry transient failures with backoff
/// until `wait_secs`. Decision failures (`Multiple`) fail fast.
pub fn resolve_socket_wait(profile_override: Option<&str>, wait_secs: u64) -> Result<String> {
    let wait_secs = wait_secs.min(600);
    if wait_secs == 0 {
        return resolve_socket(profile_override);
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(wait_secs);
    let mut delay = Duration::from_millis(250);
    let mut announced = false;
    loop {
        match resolve_socket_inner(profile_override) {
            Ok(id) => return Ok(id),
            Err(f) if !f.retryable() => return Err(f.into_error()),
            Err(f) => {
                let now = std::time::Instant::now();
                if now >= deadline {
                    return Err(f.into_error());
                }
                if !announced {
                    announced = true;
                    eprintln!(
                        "[ap-browser] extension not online; waiting up to {wait_secs}s (--wait-online / AP_BROWSER_WAIT_ONLINE)"
                    );
                }
                std::thread::sleep(delay.min(deadline - now));
                delay = (delay * 2).min(Duration::from_millis(2_000));
            }
        }
    }
}

/// Wait budget for argv-dispatched paths (sites/dev) that parse their own
/// flags: honor the env var the static CLI documents. Flag values elsewhere
/// take precedence over this.
pub fn wait_online_from_env() -> u64 {
    std::env::var("AP_BROWSER_WAIT_ONLINE")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(0)
        .min(600)
}

fn format_online_profiles(ids: &[String]) -> String {
    ids.iter()
        .map(|id| match probe_info(id) {
            Ok(info) => format!(
                "  {}  {}  {}",
                info.instance_id.get(..8).unwrap_or(&info.instance_id),
                info.label.as_deref().unwrap_or("(no label)"),
                info.active_tab_url.as_deref().unwrap_or("(no tab)")
            ),
            Err(_) => format!("  {} (probe failed)", id),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// List currently-registered instance ids.
pub fn list_instance_ids() -> Result<Vec<String>> {
    transport::list_instance_ids().context("list instances")
}

/// Probe an instance for its info via a short-lived connection.
pub fn probe_info(id: &str) -> Result<ProfileInfo> {
    // Hint the host to bound this probe at 5s, not its 30s default: a dead
    // SW behind a live host must fail the probe fast, not stall resolution.
    let req = json!({ "jsonrpc": "2.0", "method": "info", "params": { "_timeout_hint_secs": 5 } });
    let bytes = cli_frame::encode(&req)?;
    // Retry the dial: during a SW/host reconnect the socket may briefly be
    // absent — a single-shot connect here turned reconnects into spurious
    // "no online profile matches" failures.
    let mut stream = dial_with_retry(id, 3, Duration::from_millis(200))?;
    use std::io::Write;
    stream.write_all(&bytes)?;
    stream.flush()?;
    let resp = cli_frame::read_response(&mut stream, Duration::from_secs(5))?;
    let response = match resp.get("result") {
        Some(r) => r.clone(),
        None => match resp.get("error") {
            Some(e) => return Err(anyhow!("info error: {:?}", e)),
            None => &resp,
        }
        .clone(),
    };
    let data = response
        .get("data")
        .ok_or_else(|| anyhow!("no data field in info response"))?;
    let active_tab = data.get("active_tab");
    Ok(ProfileInfo {
        instance_id: data
            .get("instance_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("no instance_id in info response"))?
            .to_string(),
        label: data.get("label").and_then(|v| v.as_str()).map(String::from),
        active_tab_url: active_tab
            .and_then(|t| t.get("url"))
            .and_then(|v| v.as_str())
            .map(String::from),
        active_tab_title: active_tab
            .and_then(|t| t.get("title"))
            .and_then(|v| v.as_str())
            .map(String::from),
    })
}

/// Connect to an instance with bounded retry. `id` is the instance id.
///
/// Returns a boxed stream that supports Read + Write. On Unix/local mode
/// this is the interprocess LocalSocketStream; in remote-bridge mode it's
/// a TcpStream. Callers don't care — both implement Read + Write.
pub fn dial_with_retry(id: &str, attempts: u32, backoff: Duration) -> Result<Box<dyn ReadWrite>> {
    // Remote bridge mode: dial TCP via the bridge.
    if let Some((addr, token)) = transport::remote_endpoint() {
        let mut last_err: Option<io::Error> = None;
        for _ in 0..attempts {
            match transport::connect_remote(&addr, &token) {
                Ok(s) => return Ok(Box::new(s)),
                Err(e) => {
                    last_err = Some(e);
                    std::thread::sleep(backoff);
                }
            }
        }
        bail!(
            "dial remote {} failed after {attempts} attempts: {}",
            addr,
            last_err
                .map(|e| e.to_string())
                .unwrap_or_else(|| "unknown".into())
        );
    }

    let name = transport::instance_name(id);
    let mut last_err: Option<io::Error> = None;
    for _ in 0..attempts {
        match transport::connect(&name) {
            Ok(s) => return Ok(Box::new(s)),
            Err(e) => {
                last_err = Some(e);
                std::thread::sleep(backoff);
            }
        }
    }
    Err(anyhow!(
        "dial {} failed after {attempts} attempts: {}",
        id,
        last_err
            .map(|e| e.to_string())
            .unwrap_or_else(|| "unknown".into())
    ))
}

pub trait ReadWrite: io::Read + io::Write {}
impl<T: io::Read + io::Write> ReadWrite for T {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_transient_resolve_failures_are_retryable() {
        let no_instance = ResolveFailure::NoInstance {
            dir: "ap-browser-<id>".into(),
        };
        let no_profile = ResolveFailure::NoProfileMatch {
            want: "work".into(),
            online: "  abc  work2".into(),
        };
        let multiple = ResolveFailure::Multiple {
            online: "  abc  def".into(),
        };
        assert!(no_instance.retryable());
        assert!(no_profile.retryable());
        assert!(!multiple.retryable());
    }

    #[test]
    fn no_instance_message_keeps_socket_dir_hint() {
        let e = ResolveFailure::NoInstance {
            dir: "ap-browser-<id>".into(),
        }
        .into_error();
        assert!(e.to_string().contains("ap-browser-<id>"));
        assert!(e.to_string().contains("no extension instance online"));
    }
}
