//! capabilities.rs — Auto-discovery of local terminals and CLI agents.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    pub bin: String,
    pub installed: bool,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalInfo {
    pub id: String,
    pub name: String,
    pub installed: bool,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostCapabilities {
    pub agents: Vec<AgentInfo>,
    pub terminals: Vec<TerminalInfo>,
    pub default_cwd: String,
    pub os: String,
}

pub fn find_binary(bin_name: &str) -> Option<PathBuf> {
    if let Some(paths) = std::env::var_os("PATH") {
        for mut p in std::env::split_paths(&paths) {
            p.push(bin_name);
            if p.is_file() {
                return Some(p);
            }
            #[cfg(windows)]
            {
                let mut exe = p.clone();
                exe.set_extension("exe");
                if exe.is_file() {
                    return Some(exe);
                }
                let mut cmd = p.clone();
                cmd.set_extension("cmd");
                if cmd.is_file() {
                    return Some(cmd);
                }
                let mut ps1 = p.clone();
                ps1.set_extension("ps1");
                if ps1.is_file() {
                    return Some(ps1);
                }
            }
        }
    }

    if let Some(home) = dirs::home_dir() {
        #[allow(unused_mut)]
        let mut candidates = vec![
            home.join(".cargo/bin").join(bin_name),
            home.join(".local/bin").join(bin_name),
            home.join(".npm-global/bin").join(bin_name),
            PathBuf::from("/opt/homebrew/bin").join(bin_name),
            PathBuf::from("/usr/local/bin").join(bin_name),
            PathBuf::from("/usr/bin").join(bin_name),
            PathBuf::from("/snap/bin").join(bin_name),
        ];

        #[cfg(windows)]
        {
            if let Ok(appdata) = std::env::var("APPDATA") {
                candidates.push(PathBuf::from(appdata).join("npm").join(bin_name));
            }
            if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
                candidates.push(
                    PathBuf::from(&localappdata)
                        .join("Microsoft")
                        .join("WindowsApps")
                        .join(bin_name),
                );
                candidates.push(
                    PathBuf::from(&localappdata)
                        .join("Programs")
                        .join(bin_name)
                        .join(bin_name),
                );
            }
        }

        for c in candidates {
            if c.is_file() {
                return Some(c);
            }
            #[cfg(windows)]
            {
                let mut exe = c.clone();
                exe.set_extension("exe");
                if exe.is_file() {
                    return Some(exe);
                }
                let mut cmd = c.clone();
                cmd.set_extension("cmd");
                if cmd.is_file() {
                    return Some(cmd);
                }
            }
        }
    }

    None
}

pub fn detect_agents() -> Vec<AgentInfo> {
    let known = [
        ("dsh", "DeepSeek Harness (dsh)", "dsh"),
        ("agent", "Cursor CLI Agent (agent)", "agent"),
        ("pi", "Pi Agent (pi)", "pi"),
        ("claude", "Claude Code (claude)", "claude"),
        ("codex", "Codex CLI (codex)", "codex"),
        ("gemini", "Gemini CLI (gemini)", "gemini"),
        ("aider", "Aider (aider)", "aider"),
        ("opencode", "OpenCode (opencode)", "opencode"),
    ];

    known
        .into_iter()
        .map(|(id, name, bin)| {
            let found = find_binary(bin);
            let path_str = found.as_ref().map(|p| p.to_string_lossy().to_string());
            AgentInfo {
                id: id.to_string(),
                name: name.to_string(),
                bin: bin.to_string(),
                installed: found.is_some(),
                path: path_str,
            }
        })
        .collect()
}

pub fn detect_terminals() -> Vec<TerminalInfo> {
    let mut out = Vec::new();

    #[cfg(target_os = "macos")]
    {
        let mac_apps = [
            (
                "terminal",
                "Terminal.app (System Default)",
                "/System/Applications/Utilities/Terminal.app",
            ),
            ("iterm2", "iTerm2", "/Applications/iTerm.app"),
            ("ghostty", "Ghostty", "/Applications/Ghostty.app"),
            ("wezterm", "WezTerm", "/Applications/WezTerm.app"),
            ("kitty", "Kitty", "/Applications/kitty.app"),
            ("alacritty", "Alacritty", "/Applications/Alacritty.app"),
        ];

        for (id, name, app_path) in mac_apps {
            let p = std::path::Path::new(app_path);
            let bin_found = find_binary(id);
            let installed = p.exists() || bin_found.is_some();
            out.push(TerminalInfo {
                id: id.to_string(),
                name: name.to_string(),
                installed,
                path: if p.exists() {
                    Some(app_path.to_string())
                } else {
                    bin_found.map(|b| b.to_string_lossy().to_string())
                },
            });
        }
    }

    #[cfg(target_os = "linux")]
    {
        let linux_terms = [
            (
                "x-terminal-emulator",
                "System Default Terminal",
                "x-terminal-emulator",
            ),
            ("gnome-terminal", "GNOME Terminal", "gnome-terminal"),
            ("konsole", "Konsole", "konsole"),
            ("xfce4-terminal", "XFCE Terminal", "xfce4-terminal"),
            ("tilix", "Tilix", "tilix"),
            ("ghostty", "Ghostty", "ghostty"),
            ("alacritty", "Alacritty", "alacritty"),
            ("kitty", "Kitty", "kitty"),
            ("wezterm", "WezTerm", "wezterm"),
            ("xterm", "XTerm", "xterm"),
        ];

        for (id, name, bin) in linux_terms {
            let found = find_binary(bin);
            out.push(TerminalInfo {
                id: id.to_string(),
                name: name.to_string(),
                installed: found.is_some(),
                path: found.map(|b| b.to_string_lossy().to_string()),
            });
        }
    }

    #[cfg(target_os = "windows")]
    {
        let win_terms = [
            ("wt", "Windows Terminal", "wt"),
            ("powershell", "PowerShell (Built-in)", "powershell"),
            ("cmd", "Command Prompt", "cmd"),
        ];

        for (id, name, bin) in win_terms {
            let found = find_binary(bin);
            out.push(TerminalInfo {
                id: id.to_string(),
                name: name.to_string(),
                installed: found.is_some(),
                path: found.map(|b| b.to_string_lossy().to_string()),
            });
        }
    }

    out
}

pub fn get_default_cwd() -> String {
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

pub fn detect_all() -> HostCapabilities {
    HostCapabilities {
        agents: detect_agents(),
        terminals: detect_terminals(),
        default_cwd: get_default_cwd(),
        os: std::env::consts::OS.to_string(),
    }
}
