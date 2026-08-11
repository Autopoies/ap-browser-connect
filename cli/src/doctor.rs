//! `ap-browser doctor` — health check for dependencies, config, extension, adapters.

use anyhow::Result;
use ap_browser_core::transport;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::socket_client;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Critical,
    Warning,
    Hygiene,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Pass,
    Fail,
    Warn,
}

#[derive(Debug, Clone)]
pub struct Check {
    pub id: usize,
    pub name: &'static str,
    pub severity: Severity,
    pub status: Status,
    pub message: String,
    pub fix_hint: Option<String>,
    pub auto_fixed: bool,
}

impl Check {
    fn pass(id: usize, name: &'static str, severity: Severity, message: String) -> Self {
        Self {
            id,
            name,
            severity,
            status: Status::Pass,
            message,
            fix_hint: None,
            auto_fixed: false,
        }
    }
    fn fail(
        id: usize,
        name: &'static str,
        severity: Severity,
        message: String,
        fix_hint: Option<String>,
    ) -> Self {
        Self {
            id,
            name,
            severity,
            status: Status::Fail,
            message,
            fix_hint,
            auto_fixed: false,
        }
    }
    fn warn(
        id: usize,
        name: &'static str,
        severity: Severity,
        message: String,
        fix_hint: Option<String>,
    ) -> Self {
        Self {
            id,
            name,
            severity,
            status: Status::Warn,
            message,
            fix_hint,
            auto_fixed: false,
        }
    }
    fn mark_fixed(mut self) -> Self {
        self.auto_fixed = true;
        self.status = Status::Pass;
        self
    }
}

pub fn run(fix: bool, json_out: bool) -> Result<()> {
    let checks = vec![
        // 🔴 Critical
        check_extension_online(1),
        check_native_messaging_config(2),
        check_host_binary_executable(3),
        check_host_version_match(4),
        check_host_process_running(5),
        // 🟡 Warnings
        check_dep(
            6,
            "yt-dlp",
            &["--version"],
            "video downloads disabled (brew install yt-dlp)",
            Severity::Warning,
        ),
        check_dep(
            7,
            "curl",
            &["--version"],
            "fetch routing disabled",
            Severity::Warning,
        ),
        check_dep(
            8,
            "jq",
            &["--version"],
            "skill examples that pipe to jq will fail (brew install jq)",
            Severity::Warning,
        ),
        check_dep(
            9,
            "ffmpeg",
            &["-version"],
            "yt-dlp merge will fail (brew install ffmpeg)",
            Severity::Warning,
        ),
        check_dep(
            10,
            "npx",
            &["--version"],
            "dev mode (lighthouse/perf trace) disabled (brew install node)",
            Severity::Warning,
        ),
        check_sites_registry(11),
        check_sites_lint(12),
        check_orphan_sockets(13),
        // 🟢 Hygiene
        check_config_dir(14, fix),
        check_history_writable(15, fix),
        check_cli_in_path(16),
        check_skill_sync(17),
        check_download_config(18),
    ];

    if json_out {
        print_json(&checks)?;
    } else {
        print_human(&checks);
    }
    let critical_fails = checks
        .iter()
        .filter(|c| c.severity == Severity::Critical && c.status == Status::Fail)
        .count();
    let warnings = checks
        .iter()
        .filter(|c| {
            c.status == Status::Warn
                || (c.severity != Severity::Critical && c.status == Status::Fail)
        })
        .count();
    if !json_out {
        eprintln!();
        if critical_fails + warnings == 0 {
            println!("✓ all checks pass");
        } else {
            println!(
                "{} blocking issue{}, {} warning{}.",
                critical_fails,
                if critical_fails == 1 { "" } else { "s" },
                warnings,
                if warnings == 1 { "" } else { "s" }
            );
            println!("Run with --json for machine output.");
        }
    }
    if critical_fails > 0 {
        std::process::exit(1);
    }
    Ok(())
}

// ── Critical checks ────────────────────────────────────────────────────────

fn check_extension_online(id: usize) -> Check {
    match socket_client::list_instance_ids() {
        Ok(ids) if ids.is_empty() => Check::fail(
            id,
            "extension online",
            Severity::Critical,
            "no ap-browser instances found".to_string(),
            Some("open Chrome with the ap-browser-connect extension loaded".into()),
        ),
        Ok(ids) => {
            let live: Vec<String> = ids.into_iter().filter(|s| probe_alive(s)).collect();
            if live.is_empty() {
                Check::fail(
                    id,
                    "extension online",
                    Severity::Critical,
                    "stale instance sockets found; no native host responds".to_string(),
                    Some(restart_hint()),
                )
            } else {
                let mut labels = Vec::new();
                for id in &live {
                    if let Ok(info) = socket_client::probe_info(id) {
                        labels.push(format!(
                            "{} ({})",
                            info.label.unwrap_or_default(),
                            info.instance_id
                        ));
                    }
                }
                Check::pass(
                    id,
                    "extension online",
                    Severity::Critical,
                    format!(
                        "{} instance{} online: {}",
                        live.len(),
                        if live.len() == 1 { "" } else { "s" },
                        labels.join(", ")
                    ),
                )
            }
        }
        Err(e) => Check::fail(
            id,
            "extension online",
            Severity::Critical,
            format!("cannot list instances: {e}"),
            None,
        ),
    }
}

fn check_native_messaging_config(id: usize) -> Check {
    // On Unix, manifest lives at a known path. On Windows, Chrome reads a registry
    // key whose (Default) value is the manifest path; we then open that file.
    #[cfg(windows)]
    let path = match resolve_manifest_via_registry() {
        Some(p) => p,
        None => return Check::fail(id, "native messaging host config", Severity::Critical,
            "HKCU\\SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\com.apbrowser.connect registry key missing — run install/install.ps1".to_string(),
            Some(".\\install\\install.ps1".into())),
    };
    #[cfg(not(windows))]
    let path = native_messaging_manifest_path();

    let contents = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => {
            return Check::fail(
                id,
                "native messaging host config",
                Severity::Critical,
                format!("{} missing — run the installer", path.display()),
                Some(installer_hint()),
            )
        }
    };
    let v: Value = match serde_json::from_str(&contents) {
        Ok(v) => v,
        Err(e) => {
            return Check::fail(
                id,
                "native messaging host config",
                Severity::Critical,
                format!("manifest JSON invalid: {e}"),
                None,
            )
        }
    };
    let host_path = v.get("path").and_then(|p| p.as_str()).unwrap_or("");
    let origins = v
        .get("allowed_origins")
        .and_then(|o| o.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    if host_path.is_empty() {
        return Check::fail(
            id,
            "native messaging host config",
            Severity::Critical,
            "manifest has no 'path' field".to_string(),
            None,
        );
    }
    if origins == 0 {
        return Check::fail(
            id,
            "native messaging host config",
            Severity::Critical,
            "manifest has no allowed_origins — Chrome can't connect host".to_string(),
            Some(format!("rerun {} with extension loaded", installer_hint())),
        );
    }
    Check::pass(
        id,
        "native messaging host config",
        Severity::Critical,
        format!("→ {} (origins={})", host_path, origins),
    )
}

fn installer_hint() -> String {
    #[cfg(unix)]
    {
        "./install/install.sh".into()
    }
    #[cfg(windows)]
    {
        ".\\install\\install.ps1".into()
    }
}

fn check_host_binary_executable(id: usize) -> Check {
    let path = native_messaging_manifest_path();
    let contents = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => {
            return Check::fail(
                id,
                "host binary executable",
                Severity::Critical,
                "manifest missing (see prior check)".to_string(),
                None,
            )
        }
    };
    let v: Value = match serde_json::from_str(&contents) {
        Ok(v) => v,
        Err(_) => {
            return Check::fail(
                id,
                "host binary executable",
                Severity::Critical,
                "manifest invalid (see prior check)".to_string(),
                None,
            )
        }
    };
    let host_path = v.get("path").and_then(|p| p.as_str()).unwrap_or("");
    let p = Path::new(host_path);
    if !p.exists() {
        return Check::fail(
            id,
            "host binary executable",
            Severity::Critical,
            format!("{} does not exist", host_path),
            Some("cargo build --release -p ap-browser-host".to_string()),
        );
    }
    // Executable-bit check is Unix-only. Windows decides executability by .exe extension.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = match std::fs::metadata(p) {
            Ok(m) => m.permissions(),
            Err(e) => {
                return Check::fail(
                    id,
                    "host binary executable",
                    Severity::Critical,
                    format!("stat {}: {e}", host_path),
                    None,
                )
            }
        };
        if perms.mode() & 0o111 == 0 {
            return Check::fail(
                id,
                "host binary executable",
                Severity::Critical,
                format!("{} not executable", host_path),
                Some(format!("chmod +x {}", host_path)),
            );
        }
    }
    Check::pass(
        id,
        "host binary executable",
        Severity::Critical,
        host_path.to_string(),
    )
}

fn check_host_version_match(id: usize) -> Check {
    let path = native_messaging_manifest_path();
    let host_path = match std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("path").and_then(|p| p.as_str()).map(String::from))
    {
        Some(p) => p,
        None => {
            return Check::fail(
                id,
                "host version match",
                Severity::Critical,
                "can't resolve host path (see prior checks)".to_string(),
                None,
            )
        }
    };
    let out = match Command::new(&host_path).arg("--version").output() {
        Ok(o) if o.status.success() => o,
        Ok(o) => {
            return Check::fail(
                id,
                "host version match",
                Severity::Critical,
                format!(
                    "host --version exited {}: {}",
                    o.status,
                    String::from_utf8_lossy(&o.stderr).trim()
                ),
                Some("host binary predates --version flag; rebuild".into()),
            )
        }
        Err(e) => {
            return Check::fail(
                id,
                "host version match",
                Severity::Critical,
                format!("spawn {} --version: {e}", host_path),
                None,
            )
        }
    };
    let host_v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let cli_version = env!("CARGO_PKG_VERSION");
    let host_version = host_v.split_whitespace().last().unwrap_or("");
    if host_version != cli_version {
        return Check::fail(
            id,
            "host version match",
            Severity::Critical,
            format!(
                "cli=v{} but host=v{} (mismatch breaks timeout hint protocol)",
                cli_version, host_version
            ),
            Some(
                "cargo build --release -p ap-browser-host && pkill -f ap-browser-host".to_string(),
            ),
        );
    }
    Check::pass(
        id,
        "host version match",
        Severity::Critical,
        format!("cli = host = v{}", cli_version),
    )
}

fn check_host_process_running(id: usize) -> Check {
    let ids = socket_client::list_instance_ids().unwrap_or_default();
    let live = ids.iter().filter(|id| probe_alive(id)).count();
    if live > 0 {
        return Check::pass(
            id,
            "host process running",
            Severity::Critical,
            format!("{live} responding instance(s)"),
        );
    }
    if ids.is_empty() {
        return Check::fail(
            id,
            "host process running",
            Severity::Critical,
            "no instances — Chrome not connected to host".to_string(),
            Some("open Chrome and ensure extension is enabled".into()),
        );
    }
    Check::warn(
        id,
        "host process running",
        Severity::Critical,
        format!("{} stale socket(s); no host process responds", ids.len()),
        Some(restart_hint()),
    )
}

// ── Warning checks ─────────────────────────────────────────────────────────

fn check_dep(
    id: usize,
    name: &'static str,
    args: &[&str],
    missing_hint: &str,
    severity: Severity,
) -> Check {
    match Command::new(name).args(args).output() {
        Ok(o) if o.status.success() => {
            let v = String::from_utf8_lossy(&o.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            Check::pass(id, name, severity, v)
        }
        _ => Check::fail(
            id,
            name,
            severity,
            format!("not installed: {}", missing_hint),
            Some(format!("install {} (see hint)", name)),
        ),
    }
}

fn check_sites_registry(id: usize) -> Check {
    let reg = crate::sites::Registry::load();
    let total = reg.total_adapters();
    if total == 0 {
        return Check::fail(
            id,
            "site adapters loaded",
            Severity::Warning,
            "~/.ap-browser/sites/ has 0 adapters".to_string(),
            Some("drop adapter YAML into ~/.ap-browser/sites/<site>/".into()),
        );
    }
    Check::pass(
        id,
        "site adapters loaded",
        Severity::Warning,
        format!("{} sites, {} adapters", reg.sites.len(), total),
    )
}

fn check_sites_lint(id: usize) -> Check {
    let reg = crate::sites::Registry::load();
    let results = crate::sites::lint::lint_all(&reg);
    let mut errors = 0;
    let mut warnings = 0;
    for cmds in results.values() {
        for lr in cmds.values() {
            errors += lr.errors.len();
            warnings += lr.warnings.len();
        }
    }
    if errors > 0 {
        Check::fail(
            id,
            "sites lint",
            Severity::Warning,
            format!(
                "{} errors, {} warnings — run `ap-browser sites lint` for detail",
                errors, warnings
            ),
            Some("ap-browser sites lint".into()),
        )
    } else if warnings > 0 {
        Check::warn(
            id,
            "sites lint",
            Severity::Warning,
            format!("{} warnings — run `ap-browser sites lint`", warnings),
            None,
        )
    } else {
        Check::pass(
            id,
            "sites lint",
            Severity::Warning,
            "0 errors, 0 warnings".to_string(),
        )
    }
}

fn check_orphan_sockets(id: usize) -> Check {
    let ids = socket_client::list_instance_ids().unwrap_or_default();
    if ids.is_empty() {
        return Check::pass(
            id,
            "orphan instances",
            Severity::Warning,
            "none".to_string(),
        );
    }
    let orphans: Vec<String> = ids.into_iter().filter(|s| !probe_alive(s)).collect();
    if orphans.is_empty() {
        Check::pass(
            id,
            "orphan instances",
            Severity::Warning,
            "all instances alive".to_string(),
        )
    } else {
        Check::warn(
            id,
            "orphan instances",
            Severity::Warning,
            format!(
                "{} dead instance(s): {} — remove manually",
                orphans.len(),
                orphans
                    .iter()
                    .take(3)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            Some(restart_hint()),
        )
    }
}

fn restart_hint() -> String {
    #[cfg(unix)]
    {
        "reload the ap-browser extension; if needed, reopen Chrome".into()
    }
    #[cfg(windows)]
    {
        "reload the ap-browser extension; if needed, reopen Chrome".into()
    }
}

// ── Hygiene checks ─────────────────────────────────────────────────────────

fn check_config_dir(id: usize, fix: bool) -> Check {
    let dir = dirs::home_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(".ap-browser");
    if dir.is_dir() {
        return Check::pass(
            id,
            "~/.ap-browser/ exists",
            Severity::Hygiene,
            "yes".to_string(),
        );
    }
    if fix {
        match std::fs::create_dir_all(&dir) {
            Ok(_) => {
                return Check::pass(
                    id,
                    "~/.ap-browser/ exists",
                    Severity::Hygiene,
                    "auto-created".to_string(),
                )
                .mark_fixed()
            }
            Err(e) => {
                return Check::fail(
                    id,
                    "~/.ap-browser/ exists",
                    Severity::Hygiene,
                    format!("could not create: {e}"),
                    None,
                )
            }
        }
    }
    Check::fail(
        id,
        "~/.ap-browser/ exists",
        Severity::Hygiene,
        "missing — sites/history won't be found".to_string(),
        Some(format!("mkdir -p {}", dir.display())),
    )
}

fn check_history_writable(id: usize, fix: bool) -> Check {
    let path = dirs::home_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(".ap-browser")
        .join("sites.history");
    if path.exists() {
        return Check::pass(
            id,
            "sites.history writable",
            Severity::Hygiene,
            "yes".to_string(),
        );
    }
    if fix {
        if let Err(e) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            return Check::fail(
                id,
                "sites.history writable",
                Severity::Hygiene,
                format!("create failed: {e}"),
                None,
            );
        }
        return Check::pass(
            id,
            "sites.history writable",
            Severity::Hygiene,
            "auto-created".to_string(),
        )
        .mark_fixed();
    }
    Check::fail(
        id,
        "sites.history writable",
        Severity::Hygiene,
        "missing — recent-sites feature disabled".to_string(),
        Some(format!("touch {}", path.display())),
    )
}

fn check_cli_in_path(id: usize) -> Check {
    let path_var = std::env::var("PATH").unwrap_or_default();
    let cwd_binary = std::env::current_exe().ok();
    let bin_name = if cfg!(windows) {
        "ap-browser.exe"
    } else {
        "ap-browser"
    };
    let found = std::env::split_paths(&path_var).find_map(|dir| {
        let candidate = PathBuf::from(&dir).join(bin_name);
        if candidate.exists() {
            Some(candidate)
        } else {
            None
        }
    });
    match (found, cwd_binary) {
        (Some(p), Some(cwd)) if p != cwd => Check::warn(
            id,
            "cli in PATH",
            Severity::Hygiene,
            format!(
                "first ap-browser on PATH={}, this binary={}",
                p.display(),
                cwd.display()
            ),
            Some("ensure PATH matches the binary you intend".into()),
        ),
        (Some(p), _) => Check::pass(
            id,
            "cli in PATH",
            Severity::Hygiene,
            p.display().to_string(),
        ),
        (None, _) => Check::warn(
            id,
            "cli in PATH",
            Severity::Hygiene,
            "ap-browser not on PATH — must invoke with full path".to_string(),
            Some("add to PATH or invoke with full path".into()),
        ),
    }
}

fn check_skill_sync(id: usize) -> Check {
    let host_path = match resolve_host_path() {
        Some(p) => p,
        None => {
            return Check::warn(
                id,
                "skill docs sync",
                Severity::Hygiene,
                "can't infer project root from native messaging config".to_string(),
                None,
            )
        }
    };
    // host_path is <repo>/target/release/ap-browser-host[-.exe] → repo = 4 levels up
    let repo_root = Path::new(&host_path)
        .ancestors()
        .nth(3)
        .map(Path::to_path_buf);
    let repo_root = match repo_root {
        Some(r) if r.join("skill").is_dir() => r,
        _ => {
            return Check::warn(
                id,
                "skill docs sync",
                Severity::Hygiene,
                "inferred repo root doesn't contain skill/ — skipping".to_string(),
                None,
            )
        }
    };
    let src = repo_root.join("skill").join("SKILL.md");
    if !src.exists() {
        return Check::warn(
            id,
            "skill docs sync",
            Severity::Hygiene,
            format!("source skill/SKILL.md missing at {}", src.display()),
            None,
        );
    }
    let home = dirs::home_dir().unwrap_or_else(std::env::temp_dir);
    let candidates = [
        home.join(".claude/skills/ap-browser-connect/SKILL.md"),
        home.join(".codex/skills/ap-browser-connect/SKILL.md"),
    ];
    let mut drifts = Vec::new();
    for inst in &candidates {
        if !inst.exists() {
            continue;
        }
        if hash_file(&src) != hash_file(inst) {
            drifts.push(inst.display().to_string());
        }
    }
    if drifts.is_empty() {
        Check::pass(
            id,
            "skill docs sync",
            Severity::Hygiene,
            "source == installed".to_string(),
        )
    } else {
        Check::warn(
            id,
            "skill docs sync",
            Severity::Hygiene,
            format!("installed skill differs from source: {}", drifts.join(", ")),
            Some(format!(
                "copy {}/skill/ to {}/.claude/skills/ap-browser-connect/",
                repo_root.display(),
                home.display()
            )),
        )
    }
}

fn check_download_config(id: usize) -> Check {
    let path = dirs::home_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(".ap-browser")
        .join("download-config.yml");
    if !path.exists() {
        return Check::warn(
            id,
            "download-config.yml",
            Severity::Hygiene,
            "missing — download routing uses defaults".to_string(),
            None,
        );
    }
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            return Check::warn(
                id,
                "download-config.yml",
                Severity::Hygiene,
                format!("unreadable: {e}"),
                None,
            )
        }
    };
    if serde_yaml::from_str::<serde_yaml::Value>(&raw).is_err() {
        return Check::warn(
            id,
            "download-config.yml",
            Severity::Hygiene,
            "invalid YAML — download routing falls back to defaults".to_string(),
            Some(format!("validate {}", path.display())),
        );
    }
    Check::pass(
        id,
        "download-config.yml",
        Severity::Hygiene,
        "valid YAML".to_string(),
    )
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn probe_alive(id: &str) -> bool {
    transport::connect(&transport::instance_name(id)).is_ok()
        || socket_client::probe_info(id).is_ok()
}

fn native_messaging_manifest_path() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("Library/Application Support/Google/Chrome/NativeMessagingHosts/com.apbrowser.connect.json")
    }
    #[cfg(target_os = "linux")]
    {
        dirs::config_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(std::env::temp_dir)
            .join("google-chrome/NativeMessagingHosts/com.apbrowser.connect.json")
    }
    #[cfg(windows)]
    {
        // Chrome on Windows reads NativeMessagingHosts from a registry key, not a dir.
        // The (Default) value of the key is a path to the manifest JSON file.
        // We don't resolve that here — check_native_messaging_config reads the registry.
        // For the file-existence checks we still need *a* path; use the conventional
        // install location written by install.ps1.
        dirs::data_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(std::env::temp_dir)
            .join("ap-browser-connect")
            .join("com.apbrowser.connect.json")
    }
}

/// On Windows, Chrome reads the manifest path from a registry key, not a file dir.
/// Returns the manifest path the registry points at, or None if the key is missing.
#[cfg(windows)]
fn resolve_manifest_via_registry() -> Option<PathBuf> {
    use winreg::enums::*;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .open_subkey("SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\com.apbrowser.connect")
        .ok()?;
    let path: String = key.get_value("").ok()?;
    Some(PathBuf::from(path))
}

fn resolve_host_path() -> Option<String> {
    let manifest = std::fs::read_to_string(native_messaging_manifest_path()).ok()?;
    let v: Value = serde_json::from_str(&manifest).ok()?;
    v.get("path").and_then(|p| p.as_str()).map(String::from)
}

fn hash_file(p: &Path) -> String {
    use std::io::Read;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    use std::hash::Hasher;
    if let Ok(mut f) = std::fs::File::open(p) {
        let mut buf = [0u8; 8192];
        while let Ok(n) = f.read(&mut buf) {
            if n == 0 {
                break;
            }
            hasher.write(&buf[..n]);
        }
    }
    format!("{:016x}", hasher.finish())
}

fn print_human(checks: &[Check]) {
    let mut crit = Vec::new();
    let mut warn = Vec::new();
    let mut hyg = Vec::new();
    for c in checks {
        match c.severity {
            Severity::Critical => crit.push(c),
            Severity::Warning => warn.push(c),
            Severity::Hygiene => hyg.push(c),
        }
    }
    for c in &crit {
        print_check(c);
    }
    for c in &warn {
        print_check(c);
    }
    for c in &hyg {
        print_check(c);
    }
}

fn print_check(c: &Check) {
    let icon = match c.status {
        Status::Pass => {
            if c.auto_fixed {
                "✓*"
            } else {
                "✓ "
            }
        }
        Status::Fail => "✗ ",
        Status::Warn => "⚠ ",
    };
    eprintln!("{} {:<28} {}", icon, c.name, c.message);
    if let Some(hint) = &c.fix_hint {
        if c.status != Status::Pass {
            eprintln!("    fix: {}", hint);
        }
    }
}

fn print_json(checks: &[Check]) -> Result<()> {
    let arr: Vec<Value> = checks
        .iter()
        .map(|c| {
            let sev = match c.severity {
                Severity::Critical => "critical",
                Severity::Warning => "warning",
                Severity::Hygiene => "hygiene",
            };
            let st = match c.status {
                Status::Pass => "pass",
                Status::Fail => "fail",
                Status::Warn => "warn",
            };
            json!({
                "id": c.id,
                "name": c.name,
                "severity": sev,
                "status": st,
                "message": c.message,
                "fix_hint": c.fix_hint,
                "auto_fixed": c.auto_fixed,
            })
        })
        .collect();
    let critical = checks
        .iter()
        .filter(|c| c.severity == Severity::Critical && c.status == Status::Fail)
        .count();
    let warnings = checks
        .iter()
        .filter(|c| {
            c.status == Status::Warn
                || (c.severity != Severity::Critical && c.status == Status::Fail)
        })
        .count();
    let out = json!({
        "ok": critical == 0,
        "summary": { "critical_fails": critical, "warnings": warnings, "total": checks.len() },
        "checks": arr,
    });
    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(())
}
