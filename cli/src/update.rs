//! `ap-browser update` — keep adapters, skill, and the CLI itself current.
//!
//! - adapters: git ls-remote SHA compare + `clone --depth 1` sync into ~/.ap-browser/
//! - skill:    re-run `npx skills add` (the skills CLI owns the skill directory)
//! - CLI:      `npm view` version compare, print the upgrade command (no
//!   auto-run: npm -g may need sudo / nvm switching, the agent should see it)
//!
//! Failure isolation contract: an incompatible adapters checkout must never crash
//! the CLI — parse errors stay per-file/per-site (see sites::load_site_dir), and
//! the only global effect is a stderr warning from warn_if_incompatible().

use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Command;

const ADAPTERS_REPO: &str = "https://github.com/autopoies/ap-browser-connect-adapters.git";
const NPM_PACKAGE: &str = "ap-browser-connect";
const SKILL_SPEC: &str = "autopoies/ap-browser-connect/skill";

// ── Compat handshake ───────────────────────────────────────────────────────

#[derive(Debug, serde::Deserialize)]
pub struct AdaptersVersion {
    // `version` key in the YAML is for humans; the sync truth is .adapters-sha.
    // serde ignores unknown keys, so it's deliberately not in this struct.
    #[serde(default)]
    pub min_cli_version: Option<String>,
}

/// Read `~/.ap-browser/adapters-version.yml`. None = file absent (pre-update
/// layout or manual install) → treated as compatible, no warning noise.
pub fn read_adapters_version(home: Option<&Path>) -> Option<AdaptersVersion> {
    let home = home?;
    let src =
        std::fs::read_to_string(home.join(".ap-browser").join("adapters-version.yml")).ok()?;
    serde_yaml::from_str(&src).ok()
}

/// Semantic-ish compare: "0.1.3" vs "0.2.0". Unparseable → None (never blocks).
fn ver_key(v: &str) -> Option<(u64, u64, u64)> {
    let mut parts = v.trim().split('.');
    let maj: u64 = parts.next()?.parse().ok()?;
    let min: u64 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let pat: u64 = parts
        .next()
        .and_then(|p| p.split('-').next().and_then(|s| s.parse().ok()))
        .unwrap_or(0);
    if parts.next().is_some() {
        return None;
    }
    Some((maj, min, pat))
}

/// True when the installed adapters declare a min_cli_version this CLI can't meet.
pub fn is_incompatible(av: &AdaptersVersion) -> bool {
    match (
        av.min_cli_version.as_deref().and_then(ver_key),
        ver_key(env!("CARGO_PKG_VERSION")),
    ) {
        (Some(min), Some(cur)) => min > cur,
        _ => false,
    }
}

/// One-time startup warning. stderr only, so `--json` stdout stays parseable.
pub fn warn_if_incompatible() {
    let Some(av) = read_adapters_version(dirs::home_dir().as_deref()) else {
        return;
    };
    if is_incompatible(&av) {
        let need = av.min_cli_version.as_deref().unwrap_or("?");
        eprintln!(
            "[warn] installed adapters require ap-browser >= {need}, this CLI is {} — some site commands may fail",
            env!("CARGO_PKG_VERSION")
        );
        eprintln!(
            "[warn] upgrade: npm install -g {NPM_PACKAGE}@latest   (or `ap-browser update` for details)"
        );
    }
}

// ── Command entry ──────────────────────────────────────────────────────────

pub fn run(args: &[String]) -> Result<()> {
    let check_only = args.iter().any(|a| a == "--check");
    let want_adapters = !args.iter().any(|a| a == "skill");
    let want_skill = !args.iter().any(|a| a == "adapters");

    if check_only {
        return run_check(want_adapters);
    }

    let mut failed = false;
    if want_adapters {
        match update_adapters() {
            Ok(true) => println!("adapters updated"),
            Ok(false) => println!("adapters already up to date"),
            Err(e) => {
                eprintln!("[error] adapters update failed: {e:#}");
                failed = true;
            }
        }
        warn_if_incompatible(); // fresh adapters may demand a newer CLI
    }
    if want_skill {
        if let Err(e) = update_skill() {
            eprintln!("[error] skill update failed: {e:#}");
            failed = true;
        }
    }
    report_cli_version()?;

    if failed {
        std::process::exit(2);
    }
    Ok(())
}

/// `ap-browser update --check` — exit 0 = current, 1 = updates available,
/// 2 = could not check (offline / git missing).
fn run_check(want_adapters: bool) -> Result<()> {
    let mut available = false;
    if want_adapters {
        match adapters_update_available() {
            Ok(true) => {
                println!("adapters: update available");
                available = true;
            }
            Ok(false) => println!("adapters: up to date"),
            Err(e) => {
                eprintln!("[error] cannot check adapters: {e:#}");
                std::process::exit(2);
            }
        }
    }
    if let Some(latest) = npm_latest_version() {
        if latest != env!("CARGO_PKG_VERSION") {
            println!("cli: update available ({latest})");
            available = true;
        } else {
            println!("cli: up to date ({latest})");
        }
    }
    println!("skill: not checkable — `ap-browser update skill` reinstalls it");
    std::process::exit(i32::from(available));
}

// ── Adapters sync ──────────────────────────────────────────────────────────

fn git(args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .args(args)
        .output()
        .with_context(|| "git not found — install git (brew install git)")?;
    if !out.status.success() {
        bail!(
            "git {} failed: {}",
            args[0],
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn adapters_root() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ap-browser"))
}

/// True when remote HEAD differs from the last-synced marker.
fn adapters_update_available() -> Result<bool> {
    let remote = remote_head()?;
    let marker = adapters_root()
        .context("cannot resolve home directory")?
        .join(".adapters-sha");
    let local = std::fs::read_to_string(&marker)
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    Ok(local != remote)
}

fn remote_head() -> Result<String> {
    let stdout =
        git(&["ls-remote", ADAPTERS_REPO, "HEAD"]).context("cannot reach github.com (offline?)")?;
    let sha = stdout
        .split_whitespace()
        .next()
        .context("empty ls-remote output")?
        .to_string();
    Ok(sha)
}

fn update_adapters() -> Result<bool> {
    let root = adapters_root().context("cannot resolve home directory")?;
    let remote = remote_head()?;
    let marker = root.join(".adapters-sha");
    if std::fs::read_to_string(&marker)
        .map(|s| s.trim() == remote.as_str())
        .unwrap_or(false)
    {
        return Ok(false);
    }

    let tmp = std::env::temp_dir().join(format!("ap-browser-adapters-{}", std::process::id()));
    if tmp.exists() {
        std::fs::remove_dir_all(&tmp).with_context(|| format!("clean {}", tmp.display()))?;
    }
    git(&[
        "clone",
        "--depth",
        "1",
        ADAPTERS_REPO,
        &tmp.to_string_lossy(),
    ])?;

    std::fs::create_dir_all(&root)?;

    // sites/: replace upstream-known dirs, keep local-only dirs (user adapters).
    let src_sites = tmp.join("sites");
    let dst_sites = root.join("sites");
    std::fs::create_dir_all(&dst_sites)?;
    for entry in std::fs::read_dir(&src_sites)?.flatten() {
        let name = entry.file_name();
        let dst = dst_sites.join(&name);
        if dst.exists() {
            std::fs::remove_dir_all(&dst).with_context(|| format!("replace {}", dst.display()))?;
        }
        copy_dir(&entry.path(), &dst)?;
    }

    // filters/ is managed runtime data: replace wholesale, but back up first so
    // a local policy is recoverable.
    let src_filters = tmp.join("filters");
    let dst_filters = root.join("filters");
    if src_filters.is_dir() {
        if dst_filters.exists() {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let backup = root.join(format!("filters.bak-{ts}"));
            std::fs::rename(&dst_filters, &backup)
                .with_context(|| format!("back up {} → {backup:?}", dst_filters.display()))?;
        }
        copy_dir(&src_filters, &dst_filters)?;
    }

    for file in ["download-config.yml", "adapters-version.yml"] {
        if tmp.join(file).is_file() {
            std::fs::copy(tmp.join(file), root.join(file))?;
        }
    }
    std::fs::write(&marker, &remote)?;

    let sites = std::fs::read_dir(&dst_sites)
        .map(|it| it.flatten().filter(|e| e.path().is_dir()).count())
        .unwrap_or(0);
    println!("adapters synced ({sites} site dirs, commit {remote:.12})");
    std::fs::remove_dir_all(&tmp).ok();
    Ok(true)
}

fn copy_dir(src: &Path, dst: &Path) -> Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)?.flatten() {
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

// ── Skill ──────────────────────────────────────────────────────────────────

fn update_skill() -> Result<()> {
    let status = Command::new("npx")
        .args(["-y", "skills", "add", SKILL_SPEC])
        .status()
        .with_context(|| "npx not found — skill update requires Node (brew install node)")?;
    if !status.success() {
        bail!("`npx skills add {SKILL_SPEC}` exited {status}");
    }
    Ok(())
}

// ── CLI version report ─────────────────────────────────────────────────────

fn npm_latest_version() -> Option<String> {
    let out = Command::new("npm")
        .args(["view", NPM_PACKAGE, "version"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!v.is_empty()).then_some(v)
}

fn report_cli_version() -> Result<()> {
    match npm_latest_version() {
        Some(latest) if latest != env!("CARGO_PKG_VERSION") => {
            println!(
                "cli: update available ({latest} > {})",
                env!("CARGO_PKG_VERSION")
            );
            println!("  npm install -g {NPM_PACKAGE}@latest");
        }
        Some(_) => println!("cli: up to date ({})", env!("CARGO_PKG_VERSION")),
        None => println!(
            "cli: {} (npm unavailable, skipped registry check)",
            env!("CARGO_PKG_VERSION")
        ),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ver_key_orders_correctly() {
        assert!(ver_key("0.1.3") < ver_key("0.1.4"));
        assert!(ver_key("0.1.9") < ver_key("0.2.0"));
        assert!(ver_key("0.9.9") < ver_key("1.0.0"));
        assert_eq!(ver_key("0.1"), Some((0, 1, 0)));
        assert_eq!(ver_key("0.1.0"), Some((0, 1, 0)));
        assert_eq!(ver_key("0.1.3-beta"), Some((0, 1, 3))); // pre-release ≈ release
        assert_eq!(ver_key("latest"), None); // unparseable never blocks
        assert_eq!(ver_key(""), None);
    }

    #[test]
    fn incompatible_only_when_min_exceeds_current() {
        let av = |v: &str| AdaptersVersion {
            min_cli_version: Some(v.into()),
        };
        assert!(!is_incompatible(&av("0.1.0"))); // old adapters, fine
        assert!(!is_incompatible(&av(env!("CARGO_PKG_VERSION")))); // exact match
        assert!(is_incompatible(&av("999.0.0"))); // future adapters
        assert!(!is_incompatible(&av("not-a-version"))); // garbage never blocks
        assert!(!is_incompatible(&AdaptersVersion {
            min_cli_version: None,
        })); // empty file never blocks
    }

    #[test]
    fn read_adapters_version_parses_file() {
        let dir = std::env::temp_dir().join(format!("apb-compat-test-{}", std::process::id()));
        let root = dir.join(".ap-browser");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("adapters-version.yml"),
            "version: 2\nmin_cli_version: \"0.1.3\"\n",
        )
        .unwrap();
        let av = read_adapters_version(Some(&dir)).expect("should parse");
        assert_eq!(av.min_cli_version.as_deref(), Some("0.1.3"));
        assert!(!is_incompatible(&av));
        std::fs::remove_dir_all(&dir).ok();
    }
}
