//! spawner.rs — Spawns isolated terminal windows running CLI agents across macOS, Linux, and Windows.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Deserialize)]
pub struct LaunchParams {
    pub agent_id: String,
    pub custom_cmd: Option<String>,
    pub terminal_id: Option<String>,
    pub prompt: String,
    pub cwd: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LaunchResult {
    pub ok: bool,
    pub prompt_file: String,
    pub runner_script: String,
    pub agent_id: String,
    pub terminal_id: String,
}

pub fn get_run_dir() -> PathBuf {
    if let Some(home) = dirs::home_dir() {
        let run_dir = home.join(".ap-browser").join("run");
        let _ = std::fs::create_dir_all(&run_dir);
        return run_dir;
    }
    std::env::temp_dir()
}

pub fn resolve_cwd(cwd_opt: Option<&str>) -> String {
    if let Some(c) = cwd_opt {
        let trimmed = c.trim();
        if !trimmed.is_empty() {
            if trimmed.starts_with('~') {
                if let Some(home) = dirs::home_dir() {
                    let expanded = trimmed.replacen('~', &home.to_string_lossy(), 1);
                    let path = std::path::PathBuf::from(&expanded);
                    let _ = std::fs::create_dir_all(&path);
                    return path.to_string_lossy().to_string();
                }
            } else {
                let path = std::path::PathBuf::from(trimmed);
                let _ = std::fs::create_dir_all(&path);
                return path.to_string_lossy().to_string();
            }
        }
    }

    if let Some(home) = dirs::home_dir() {
        let ws = home.join(".ap-browser").join("workspace");
        let _ = std::fs::create_dir_all(&ws);
        return ws.to_string_lossy().to_string();
    }
    if let Ok(cwd) = std::env::current_dir() {
        return cwd.to_string_lossy().to_string();
    }
    "/".to_string()
}

pub fn write_temp_prompt(prompt: &str, title: Option<&str>, url: Option<&str>) -> Result<String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let run_dir = get_run_dir();
    let filename = format!("ap-agent-prompt-{millis}.md");
    let file_path = run_dir.join(filename);

    let mut full_prompt = String::new();
    if title.is_some() || url.is_some() {
        full_prompt.push_str("<!-- Source metadata:\n");
        if let Some(t) = title {
            full_prompt.push_str(&format!("  Title: {t}\n"));
        }
        if let Some(u) = url {
            full_prompt.push_str(&format!("  URL: {u}\n"));
        }
        full_prompt.push_str("-->\n\n");
    }
    full_prompt.push_str(prompt);

    std::fs::write(&file_path, full_prompt)
        .with_context(|| format!("failed to write prompt to {:?}", file_path))?;
    Ok(file_path.to_string_lossy().to_string())
}

pub fn build_agent_cmd(agent_id: &str, custom_cmd: Option<&str>, prompt_file: &str) -> String {
    #[cfg(windows)]
    {
        match agent_id {
            "dsh" => format!("dsh --task (Get-Content -Raw -Encoding utf8 '{prompt_file}')"),
            "agent" => format!("agent (Get-Content -Raw -Encoding utf8 '{prompt_file}')"),
            "pi" => format!("pi (Get-Content -Raw -Encoding utf8 '{prompt_file}')"),
            "claude" => format!("claude -p (Get-Content -Raw -Encoding utf8 '{prompt_file}')"),
            "codex" => format!("codex --ask (Get-Content -Raw -Encoding utf8 '{prompt_file}')"),
            "gemini" => format!("gemini (Get-Content -Raw -Encoding utf8 '{prompt_file}')"),
            "aider" => format!("aider --message (Get-Content -Raw -Encoding utf8 '{prompt_file}')"),
            "opencode" => format!("opencode run (Get-Content -Raw -Encoding utf8 '{prompt_file}')"),
            "custom" => {
                if let Some(custom) = custom_cmd {
                    if custom.contains("{prompt_file}") {
                        custom.replace("{prompt_file}", prompt_file)
                    } else {
                        format!("{custom} (Get-Content -Raw -Encoding utf8 '{prompt_file}')")
                    }
                } else {
                    format!("pi (Get-Content -Raw -Encoding utf8 '{prompt_file}')")
                }
            }
            other => format!("{other} (Get-Content -Raw -Encoding utf8 '{prompt_file}')"),
        }
    }

    #[cfg(not(windows))]
    {
        match agent_id {
            "dsh" => format!("dsh --task \"$(cat '{prompt_file}')\""),
            "agent" => format!("agent \"$(cat '{prompt_file}')\""),
            "pi" => format!("pi \"$(cat '{prompt_file}')\""),
            "claude" => format!("claude -p \"$(< '{prompt_file}')\""),
            "codex" => format!("codex --ask \"$(< '{prompt_file}')\""),
            "gemini" => format!("gemini \"$(cat '{prompt_file}')\""),
            "aider" => format!("aider --message \"$(cat '{prompt_file}')\""),
            "opencode" => format!("opencode run \"$(cat '{prompt_file}')\""),
            "custom" => {
                if let Some(custom) = custom_cmd {
                    if custom.contains("{prompt_file}") {
                        custom.replace("{prompt_file}", prompt_file)
                    } else {
                        format!("{custom} \"$(cat '{prompt_file}')\"")
                    }
                } else {
                    format!("pi \"$(cat '{prompt_file}')\"")
                }
            }
            other => format!("{other} \"$(cat '{prompt_file}')\""),
        }
    }
}

pub fn write_runner_script(
    agent_id: &str,
    agent_cmd: &str,
    cwd: &str,
    prompt_file: &str,
) -> Result<String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let run_dir = get_run_dir();

    #[cfg(not(windows))]
    {
        #[cfg(target_os = "macos")]
        let filename = format!("ap-agent-run-{millis}.command");

        #[cfg(not(target_os = "macos"))]
        let filename = format!("ap-agent-run-{millis}.sh");

        let file_path = run_dir.join(filename);

        #[cfg(target_os = "macos")]
        let shebang = "#!/bin/zsh -l";

        #[cfg(not(target_os = "macos"))]
        let shebang = "#!/usr/bin/env bash";

        let script = format!(
            r#"{shebang}
[ -f "$HOME/.profile" ] && . "$HOME/.profile" 2>/dev/null || true
[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc" 2>/dev/null || true
[ -f "$HOME/.zprofile" ] && . "$HOME/.zprofile" 2>/dev/null || true
[ -f "$HOME/.zshrc" ] && . "$HOME/.zshrc" 2>/dev/null || true
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:/snap/bin:$PATH"
cd "{cwd}" 2>/dev/null || cd "$HOME" || exit 1
clear
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " 🚀 AP Browser Connect -> Spawning [{agent_id}]"
echo " 📂 Working Directory: $(pwd)"
echo " 📄 Prompt File: {prompt_file}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
{agent_cmd}
EXIT_CODE=$?
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " 🏁 Session exited with code: $EXIT_CODE."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if command -v zsh >/dev/null 2>&1; then
    exec zsh -i
elif command -v bash >/dev/null 2>&1; then
    exec bash -i
else
    exec sh -i
fi
"#
        );
        std::fs::write(&file_path, script)
            .with_context(|| format!("failed to write runner script to {:?}", file_path))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&file_path)?.permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&file_path, perms)?;
            let _ = Command::new("xattr").args(["-c", &file_path.to_string_lossy()]).output();
        }

        Ok(file_path.to_string_lossy().to_string())
    }

    #[cfg(windows)]
    {
        let filename = format!("ap-agent-run-{millis}.ps1");
        let file_path = run_dir.join(filename);
        let script = format!(
            r#"
$Host.UI.RawUI.WindowTitle = "AP Browser Connect - {agent_id}"
Set-Location "{cwd}"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host " 🚀 AP Browser Connect -> Spawning [{agent_id}]" -ForegroundColor Cyan
Write-Host " 📂 Working Directory: $((Get-Location).Path)" -ForegroundColor Gray
Write-Host " 📄 Prompt File: {prompt_file}" -ForegroundColor Gray
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n" -ForegroundColor Cyan

{agent_cmd}

Write-Host "`n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host " 🏁 Session exited with code: $LASTEXITCODE. Interactive PowerShell active." -ForegroundColor Cyan
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
"#
        );
        std::fs::write(&file_path, script)
            .with_context(|| format!("failed to write runner script to {:?}", file_path))?;
        Ok(file_path.to_string_lossy().to_string())
    }
}

pub fn launch(params: LaunchParams) -> Result<LaunchResult> {
    let prompt_file =
        write_temp_prompt(&params.prompt, params.title.as_deref(), params.url.as_deref())?;
    let cwd = resolve_cwd(params.cwd.as_deref());
    let agent_cmd =
        build_agent_cmd(&params.agent_id, params.custom_cmd.as_deref(), &prompt_file);
    let runner_script = write_runner_script(&params.agent_id, &agent_cmd, &cwd, &prompt_file)?;

    let requested_terminal = params.terminal_id.as_deref().unwrap_or("auto");
    let chosen_terminal = spawn_terminal(requested_terminal, &runner_script, &cwd)?;

    Ok(LaunchResult {
        ok: true,
        prompt_file,
        runner_script,
        agent_id: params.agent_id,
        terminal_id: chosen_terminal,
    })
}

#[cfg(target_os = "macos")]
fn spawn_terminal(terminal_id: &str, runner_script: &str, _cwd: &str) -> Result<String> {
    let target = match terminal_id {
        "auto" => "terminal",
        other => other,
    };

    let spawned = match target {
        "ghostty" => Command::new("open")
            .args(["-a", "Ghostty", runner_script])
            .spawn()
            .or_else(|_| Command::new("ghostty").args(["-e", runner_script]).spawn()),
        "iterm2" => Command::new("open")
            .args(["-a", "iTerm", runner_script])
            .spawn()
            .or_else(|_| Command::new("open").args(["-a", "iTerm2", runner_script]).spawn()),
        "wezterm" => Command::new("wezterm")
            .args(["start", "--", runner_script])
            .spawn()
            .or_else(|_| Command::new("open").args(["-a", "WezTerm", runner_script]).spawn()),
        "kitty" => Command::new("kitty")
            .arg(runner_script)
            .spawn()
            .or_else(|_| Command::new("open").args(["-a", "kitty", runner_script]).spawn()),
        "alacritty" => Command::new("alacritty")
            .args(["-e", runner_script])
            .spawn()
            .or_else(|_| Command::new("open").args(["-a", "Alacritty", runner_script]).spawn()),
        _ => Command::new("open")
            .args(["-a", "Terminal", runner_script])
            .spawn()
            .or_else(|_| Command::new("open").arg(runner_script).spawn()),
    };

    match spawned {
        Ok(_) => Ok(target.to_string()),
        Err(e) => {
            Command::new("open")
                .arg(runner_script)
                .spawn()
                .with_context(|| format!("failed to open runner script {runner_script}: {e:#}"))?;
            Ok("default".to_string())
        }
    }
}

#[cfg(target_os = "linux")]
fn spawn_terminal(terminal_id: &str, runner_script: &str, _cwd: &str) -> Result<String> {
    let target = match terminal_id {
        "auto" => {
            if crate::capabilities::find_binary("x-terminal-emulator").is_some() {
                "x-terminal-emulator"
            } else if crate::capabilities::find_binary("gnome-terminal").is_some() {
                "gnome-terminal"
            } else if crate::capabilities::find_binary("konsole").is_some() {
                "konsole"
            } else if crate::capabilities::find_binary("xfce4-terminal").is_some() {
                "xfce4-terminal"
            } else if crate::capabilities::find_binary("tilix").is_some() {
                "tilix"
            } else if crate::capabilities::find_binary("ghostty").is_some() {
                "ghostty"
            } else if crate::capabilities::find_binary("alacritty").is_some() {
                "alacritty"
            } else if crate::capabilities::find_binary("kitty").is_some() {
                "kitty"
            } else if crate::capabilities::find_binary("wezterm").is_some() {
                "wezterm"
            } else {
                "x-terminal-emulator"
            }
        }
        other => other,
    };

    let spawned = match target {
        "ghostty" => Command::new("ghostty").args(["-e", runner_script]).spawn(),
        "gnome-terminal" => Command::new("gnome-terminal")
            .args(["--", runner_script])
            .spawn(),
        "konsole" => Command::new("konsole").args(["-e", runner_script]).spawn(),
        "xfce4-terminal" => Command::new("xfce4-terminal")
            .args(["-e", runner_script])
            .spawn(),
        "tilix" => Command::new("tilix").args(["-e", runner_script]).spawn(),
        "alacritty" => Command::new("alacritty")
            .args(["-e", runner_script])
            .spawn(),
        "kitty" => Command::new("kitty").arg(runner_script).spawn(),
        "wezterm" => Command::new("wezterm")
            .args(["start", "--", runner_script])
            .spawn(),
        _ => Command::new("x-terminal-emulator")
            .args(["-e", runner_script])
            .spawn(),
    };

    match spawned {
        Ok(_) => Ok(target.to_string()),
        Err(e) => {
            if let Ok(child) = Command::new("xterm").args(["-e", runner_script]).spawn() {
                let _ = child;
                return Ok("xterm".to_string());
            }
            Command::new("sh")
                .arg(runner_script)
                .spawn()
                .with_context(|| format!("spawn failed: {e:#}"))?;
            Ok("default".to_string())
        }
    }
}

#[cfg(target_os = "windows")]
fn spawn_terminal(terminal_id: &str, runner_script: &str, cwd: &str) -> Result<String> {
    let target = match terminal_id {
        "auto" => {
            if crate::capabilities::find_binary("wt").is_some() {
                "wt"
            } else {
                "powershell"
            }
        }
        other => other,
    };

    if target == "wt" {
        Command::new("wt.exe")
            .args([
                "-d",
                cwd,
                "powershell",
                "-NoExit",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                runner_script,
            ])
            .spawn()
            .with_context(|| "spawn Windows Terminal")?;
    } else {
        Command::new("powershell.exe")
            .args([
                "-NoExit",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                runner_script,
            ])
            .spawn()
            .with_context(|| "spawn PowerShell")?;
    }

    Ok(target.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_agent_cmd() {
        #[cfg(not(windows))]
        {
            assert_eq!(
                build_agent_cmd("dsh", None, "/tmp/p.md"),
                "dsh --task \"$(cat '/tmp/p.md')\""
            );
            assert_eq!(
                build_agent_cmd("agent", None, "/tmp/p.md"),
                "agent \"$(cat '/tmp/p.md')\""
            );
            assert_eq!(
                build_agent_cmd("pi", None, "/tmp/p.md"),
                "pi \"$(cat '/tmp/p.md')\""
            );
            assert_eq!(
                build_agent_cmd("claude", None, "/tmp/p.md"),
                "claude -p \"$(< '/tmp/p.md')\""
            );
            assert_eq!(
                build_agent_cmd("codex", None, "/tmp/p.md"),
                "codex --ask \"$(< '/tmp/p.md')\""
            );
            assert_eq!(
                build_agent_cmd("custom", Some("my-cli --run {prompt_file}"), "/tmp/p.md"),
                "my-cli --run /tmp/p.md"
            );
        }
        #[cfg(windows)]
        {
            assert_eq!(
                build_agent_cmd("dsh", None, "C:\\tmp\\p.md"),
                "dsh --task (Get-Content -Raw -Encoding utf8 'C:\\tmp\\p.md')"
            );
        }
    }

    #[test]
    fn test_write_temp_prompt() -> Result<()> {
        let p = write_temp_prompt("test prompt", Some("Example"), Some("https://example.com"))?;
        let content = std::fs::read_to_string(&p)?;
        assert!(content.contains("Title: Example"));
        assert!(content.contains("URL: https://example.com"));
        assert!(content.contains("test prompt"));
        let _ = std::fs::remove_file(p);
        Ok(())
    }

    #[test]
    fn test_write_runner_script() -> Result<()> {
        let script_path = write_runner_script("pi", "pi --help", "/tmp", "/tmp/prompt.md")?;
        assert!(std::path::Path::new(&script_path).exists());
        let content = std::fs::read_to_string(&script_path)?;
        assert!(content.contains("pi --help"));
        let _ = std::fs::remove_file(script_path);
        Ok(())
    }
}
