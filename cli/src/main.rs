//! ap-browser — operator-level CLI. Drives the user's logged-in Chrome from any agent.

mod capture;
mod cli_frame;
mod dev;
mod doctor;
mod sites;
mod socket_client;

use anyhow::{anyhow, Context, Result};
use ap_browser_core::transport;
use clap::{CommandFactory, Parser, Subcommand};
use serde_json::{json, Value};
use std::io::{IsTerminal, Read};
use std::path::PathBuf;
use std::time::Duration;

use crate::socket_client::{dial_with_retry, resolve_socket};

#[derive(Parser, Debug)]
#[command(name = "ap-browser", version, about = "Drive Chrome from any agent")]
struct Cli {
    #[arg(long, global = true)]
    profile: Option<String>,
    #[arg(long, global = true)]
    tab: Option<i64>,
    #[arg(long, global = true)]
    window: Option<i64>,
    #[arg(long, global = true)]
    human: bool,
    #[arg(long, global = true, default_value = "30")]
    timeout: u64,
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    Ping,
    Status,
    Profiles,
    Use { id_or_label: String },
    Current,
    Info,
    #[command(subcommand)]
    Tabs(TabsCmd),
    Goto { url: String },
    Back,
    Forward,
    Reload,
    Screenshot { #[arg(long, default_value = "screenshot.png")] out: String, #[arg(long)] full: bool, #[arg(long)] element: Option<String> },
    Text { #[arg(long, default_value = "body")] selector: String, #[arg(long)] full: bool, #[arg(long)] range: Option<String> },
    Html { #[arg(long, default_value = "html")] selector: String, #[arg(long)] full: bool, #[arg(long)] range: Option<String> },
    Click { selector: String },
    Fill { selector: String, value: String },
    Press { keys: String },
    Wait { selector: String, #[arg(long, default_value = "5000")] timeout_ms: u64 },
    Eval { expression: String },
    Cdp { method: String, #[arg(long)] params: Option<String> },
    Batch { #[arg(long)] file: Option<String> },
    Download { url: Option<String>, #[arg(long)] out: Option<String>, #[arg(long)] method: Option<String>, #[arg(long)] video: bool, #[arg(long, requires = "video")] audio_only: bool, #[arg(long, requires = "video")] subtitles: bool, #[arg(long)] format: Option<String>, #[arg(long)] cookies_from: Option<String>, #[arg(long)] silence_hint: bool, #[arg(long = "list")] list: bool, #[arg(long = "auto")] auto_pick: bool, #[arg(long)] pick: Option<String> },
    Pdf { #[arg(long, default_value = "page.pdf")] out: String, #[arg(long)] landscape: bool, #[arg(long, default_value = "A4")] format: String },
    Mhtml { #[arg(long, default_value = "page.mhtml")] out: String },
    Har { #[arg(long, default_value = "page.har")] out: String },
    Media { #[arg(long = "type", default_value = "all")] media_type: Option<String> },
}

#[derive(Subcommand, Debug)]
enum TabsCmd {
    List { #[arg(long)] filter: Option<String>, #[arg(long)] group: Option<String>, #[arg(long)] grouped: bool },
    New { url: Option<String>, #[arg(long)] silent: bool },
    Close { id: i64 },
    Activate { id: i64 },
    Get { id: i64 },
}

const ENV_OVERRIDE: &str = "AP_BROWSER_PROFILE";
const CURRENT_FILE: &str = ".ap-browser/current";

fn main() -> Result<()> {
    let raw_args: Vec<String> = std::env::args().skip(1).collect();

    // Append runtime-discovered site/dev adapters to --help. They're argv[1]-dispatched,
    // not in the static clap enum, so the default help renders them invisible.
    let wants_top_help = match raw_args.first().map(|s| s.as_str()) {
        Some("--help") | Some("-h") => true,
        Some("help") if raw_args.len() == 1 => true,
        _ => false,
    };
    if wants_top_help {
        Cli::command().print_help()?;
        println!();
        println!("Dynamic dispatch (discovered at runtime, not in the static list above):");
        println!("  sites      adapter management — run `ap-browser sites list` (summary) or `sites search <q>`");
        println!("  dev        devtools — run `ap-browser dev --help`");
        println!("  doctor     health check — run `ap-browser doctor [--fix|--json]`");
        println!();
        let registry = sites::Registry::load();
        let total_adapters: usize = registry.sites.values().map(|e| e.adapters.len()).sum();
        if registry.sites.is_empty() {
            println!("(No site adapters installed. Drop YAML adapters into ~/.ap-browser/sites/<site>/)");
        } else {
            println!("Site adapters ({} sites, {} commands — run `ap-browser <site> <cmd>`):",
                registry.sites.len(), total_adapters);
            println!();
            let mut names: Vec<&String> = registry.sites.keys().collect();
            names.sort();
            for name in names {
                let entry = &registry.sites[name];
                let desc = entry.meta.as_ref()
                    .and_then(|m| m.description.as_deref())
                    .unwrap_or("");
                let mut cmds: Vec<&str> = entry.adapters.keys().map(String::as_str).collect();
                cmds.sort();
                println!("  {name:<16} {desc}");
                println!("                   cmds: {}", cmds.join(", "));
            }
        }
        println!();
        println!("Tip: prefer a matching site adapter over generic `tabs new` / `goto` / `text`.");
        std::process::exit(0);
    }

    if let Some(first) = raw_args.first() {
        if first == "sites" {
            return run_sites_command(&raw_args[1..]);
        }
        if first == "dev" {
            return dev::dispatch(&raw_args[1..]);
        }
        if first == "doctor" {
            let fix = raw_args.iter().any(|a| a == "--fix");
            let json = raw_args.iter().any(|a| a == "--json");
            return doctor::run(fix, json);
        }
        if !sites::RESERVED.contains(&first.as_str()) {
            let registry = sites::Registry::load();
            if registry.match_site(first).is_some() {
                let cmd = raw_args.get(1).cloned().unwrap_or_else(|| {
                    eprintln!("Usage: ap-browser {} <command> [args]", first);
                    std::process::exit(1);
                });
                return sites::dispatch_site(&registry, first, &cmd, &raw_args[2..]);
            }
        }
    }

    let cli = Cli::parse();
    let human = cli.human || atty_is_tty();

    match &cli.command {
        Cmd::Ping => rpc(&cli, "ping", json!({}), human, |_| {})?,
        Cmd::Info => rpc(&cli, "info", json!({}), human, |_| {})?,
        Cmd::Status => run_status(&cli, human)?,
        Cmd::Profiles => run_profiles(&cli, human)?,
        Cmd::Current => run_current(human)?,
        Cmd::Use { id_or_label } => run_use(id_or_label, human)?,
        Cmd::Tabs(cmd) => match cmd {
            TabsCmd::List { filter, group, grouped: _ } => {
                let mut params = json!({});
                if let Some(f) = filter { params["filter"] = json!(f); }
                if let Some(g) = group { params["group"] = json!(g); }
                rpc(&cli, "tabs.list", params, human, |_| {})?
            }
            TabsCmd::New { url, silent } => {
                let mut params = json!({});
                if let Some(u) = url { params["url"] = json!(u); }
                if *silent { params["active"] = json!(false); }
                rpc(&cli, "tabs.new", params, human, |_| {})?
            }
            TabsCmd::Close { id } => rpc(&cli, "tabs.close", json!({"tab_id": id}), human, |_| {})?,
            TabsCmd::Activate { id } => rpc(&cli, "tabs.activate", json!({"tab_id": id}), human, |_| {})?,
            TabsCmd::Get { id } => rpc(&cli, "tabs.get", json!({"tab_id": id}), human, |_| {})?,
        },
        Cmd::Goto { url } => rpc(&cli, "goto", json!({"url": url}), human, |_| {})?,
        Cmd::Back => rpc(&cli, "back", json!({}), human, |_| {})?,
        Cmd::Forward => rpc(&cli, "forward", json!({}), human, |_| {})?,
        Cmd::Reload => rpc(&cli, "reload", json!({}), human, |_| {})?,
        Cmd::Text { selector, full, range } => {
            let mut params = json!({"selector": selector});
            if *full { params["full"] = json!(true); }
            if let Some(r) = range { params["range"] = parse_range(r)?; }
            rpc(&cli, "text", params, human, |_| {})?
        }
        Cmd::Html { selector, full, range } => {
            let mut params = json!({"selector": selector});
            if *full { params["full"] = json!(true); }
            if let Some(r) = range { params["range"] = parse_range(r)?; }
            rpc(&cli, "html", params, human, |_| {})?
        }
        Cmd::Screenshot { out, full, element } => {
            if let Some(sel) = element {
                capture::element_screenshot(sel, out, cli.tab, cli.profile.as_deref())?;
                eprintln!("[screenshot saved: {out} (element: {sel})]");
            } else {
                let mut params = json!({});
                if *full { params["full"] = json!(true); }
                rpc(&cli, "screenshot", params, human, |resp| { save_screenshot(resp, out); })?
            }
        }
        Cmd::Click { selector } => rpc(&cli, "click", json!({"selector": selector}), human, |_| {})?,
        Cmd::Fill { selector, value } => rpc(&cli, "fill", json!({"selector": selector, "value": value}), human, |_| {})?,
        Cmd::Press { keys } => rpc(&cli, "press", json!({"keys": keys}), human, |_| {})?,
        Cmd::Wait { selector, timeout_ms } => rpc(&cli, "wait", json!({"selector": selector, "timeout_ms": timeout_ms}), human, |_| {})?,
        Cmd::Eval { expression } => rpc(&cli, "eval", json!({"expression": expression}), human, |_| {})?,
        Cmd::Cdp { method, params } => {
            let p = match params {
                Some(s) => serde_json::from_str(s).unwrap_or(json!({})),
                None => json!({}),
            };
            rpc(&cli, "cdp", json!({"method": method, "params": p}), human, |_| {})?
        }
        Cmd::Batch { file } => {
            let input = match file {
                Some(f) => std::fs::read_to_string(f)?,
                None => {
                    use std::io::Read;
                    let mut s = String::new();
                    std::io::stdin().read_to_string(&mut s)?;
                    s
                }
            };
            let steps: Value = serde_json::from_str(&input)?;
            rpc(&cli, "batch", json!({"steps": steps}), human, |_| {})?
        }
        Cmd::Download { url, out, method, video, audio_only, subtitles, format, cookies_from, silence_hint, list, auto_pick, pick } => {
            let mut dargs: Vec<String> = Vec::new();
            if let Some(u) = url { dargs.push(u.clone()); }
            if let Some(o) = out { dargs.push("--out".into()); dargs.push(o.clone()); }
            if let Some(m) = method { dargs.push("--method".into()); dargs.push(m.clone()); }
            if *video { dargs.push("--video".into()); }
            if *audio_only { dargs.push("--audio-only".into()); }
            if *subtitles { dargs.push("--subtitles".into()); }
            if let Some(f) = format { dargs.push("--format".into()); dargs.push(f.clone()); }
            if let Some(c) = cookies_from { dargs.push("--cookies-from".into()); dargs.push(c.clone()); }
            if *silence_hint { dargs.push("--silence-hint".into()); }
            if *list { dargs.push("--list".into()); }
            if *auto_pick { dargs.push("--auto".into()); }
            if let Some(p) = pick { dargs.push("--pick".into()); dargs.push(p.clone()); }
            if let Some(t) = cli.tab { dargs.push("--tab".into()); dargs.push(t.to_string()); }
            capture::dispatch("download", &dargs)?
        }
        Cmd::Pdf { out, landscape, format } => {
            let mut dargs: Vec<String> = vec!["--out".into(), out.clone()];
            if *landscape { dargs.push("--landscape".into()); }
            dargs.push("--format".into()); dargs.push(format.clone());
            if let Some(t) = cli.tab { dargs.push("--tab".into()); dargs.push(t.to_string()); }
            capture::dispatch("pdf", &dargs)?
        }
        Cmd::Mhtml { out } => {
            let mut dargs: Vec<String> = vec!["--out".into(), out.clone()];
            if let Some(t) = cli.tab { dargs.push("--tab".into()); dargs.push(t.to_string()); }
            capture::dispatch("mhtml", &dargs)?
        }
        Cmd::Har { out } => {
            let mut dargs: Vec<String> = vec!["--out".into(), out.clone()];
            if let Some(t) = cli.tab { dargs.push("--tab".into()); dargs.push(t.to_string()); }
            capture::dispatch("har", &dargs)?
        }
        Cmd::Media { media_type } => {
            let mt = media_type.clone().unwrap_or("all".into());
            let mut dargs: Vec<String> = vec!["--type".into(), mt];
            if let Some(t) = cli.tab { dargs.push("--tab".into()); dargs.push(t.to_string()); }
            capture::dispatch("media", &dargs)?
        }
    }
    Ok(())
}

fn rpc(cli: &Cli, method: &str, params: Value, human: bool, post: impl Fn(&Value)) -> Result<()> {
    let mut p = params;
    if let Some(t) = cli.tab { p.as_object_mut().map(|o| o.insert("tab_id".into(), json!(t))); }
    if let Some(w) = cli.window { p.as_object_mut().map(|o| o.insert("window_id".into(), json!(w))); }

    let socket = resolve_socket(cli.profile.as_deref())?;
    let request = json!({"jsonrpc":"2.0","method":method,"params":p});
    let bytes = cli_frame::encode(&request)?;
    let mut stream = dial_with_retry(&socket, 3, Duration::from_millis(200))?;
    std::io::Write::write_all(&mut stream, &bytes)?;
    std::io::Write::flush(&mut stream)?;
    let envelope = cli_frame::read_response(&mut stream, Duration::from_secs(cli.timeout))?;

    let response = match envelope.get("result") {
        Some(r) => r.clone(),
        None => match envelope.get("error") {
            Some(e) => json!({"ok": false, "error": e}),
            None => envelope,
        },
    };

    if response.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        post(&response);
    }

    if human { print_human(&response); }
    else { println!("{}", serde_json::to_string(&response)?); }

    if response.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        std::process::exit(error_to_exit_code(&response));
    }
    Ok(())
}

fn save_screenshot(resp: &Value, out: &str) {
    if let Some(data_url) = resp.get("data").and_then(|d| d.get("data_url")).and_then(|v| v.as_str()) {
        let b64 = data_url.trim_start_matches("data:image/png;base64,");
        if let Ok(raw) = base64_decode(b64) {
            let _ = std::fs::write(out, &raw);
            eprintln!("[screenshot saved: {out} ({} bytes)]", raw.len());
        }
    }
}

fn run_status(_cli: &Cli, human: bool) -> Result<()> {
    let profiles = discover_profiles()?;
    if human {
        println!("ap-browser status: {} socket(s) online", profiles.len());
        for p in &profiles {
            println!("  {}  {}  {}", truncate_id(&p.instance_id),
                p.label.as_deref().unwrap_or(""),
                p.active_tab_url.as_deref().unwrap_or("(no tab)"));
        }
    } else {
        println!("{}", serde_json::to_string(&json!({"online": profiles}))?);
    }
    Ok(())
}

fn run_profiles(_cli: &Cli, human: bool) -> Result<()> {
    let profiles = discover_profiles()?;
    if human {
        if profiles.is_empty() { println!("(no extension instances online)"); }
        for p in &profiles {
            println!("{}  label={}  active={}", truncate_id(&p.instance_id),
                p.label.as_deref().unwrap_or(""),
                p.active_tab_url.as_deref().unwrap_or("(none)"));
        }
    } else {
        println!("{}", serde_json::to_string(&profiles)?);
    }
    Ok(())
}

fn run_current(human: bool) -> Result<()> {
    match read_current_profile()? {
        Some(s) => { if human { println!("{s}"); } else { println!("{}", json!({"current": s})); } }
        None => { if human { println!("(no profile selected)"); } else { println!("{}", json!({"current": null})); } }
    }
    Ok(())
}

fn run_use(id_or_label: &str, human: bool) -> Result<()> {
    let profiles = discover_profiles()?;
    let matched = profiles.iter()
        .find(|p| p.instance_id == id_or_label || p.label.as_deref() == Some(id_or_label))
        .ok_or_else(|| anyhow!("no online profile matches `{id_or_label}`"))?;
    write_current_profile(&matched.instance_id)?;
    if human {
        println!("set default: {} ({})", truncate_id(&matched.instance_id),
            matched.label.as_deref().unwrap_or("(no label)"));
    } else {
        println!("{}", json!({"ok": true, "current": matched.instance_id, "label": matched.label}));
    }
    Ok(())
}

// ── helpers ──────────────────────────────────────────────────────────────

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
struct ProfileInfo {
    instance_id: String,
    label: Option<String>,
    active_tab_url: Option<String>,
    active_tab_title: Option<String>,
}

fn discover_profiles() -> Result<Vec<ProfileInfo>> {
    let mut out = Vec::new();
    for id in transport::list_instance_ids().context("list instances")? {
        match socket_client::probe_info(&id) {
            Ok(info) => out.push(info),
            Err(e) => eprintln!("[warn] probe {}: {e}", id),
        }
    }
    Ok(out)
}

fn read_current_profile() -> Result<Option<String>> {
    if let Ok(v) = std::env::var(ENV_OVERRIDE) { return Ok(Some(v)); }
    let home = dirs::home_dir().context("could not resolve home directory")?;
    let p = home.join(CURRENT_FILE);
    if !p.exists() { return Ok(None); }
    let mut s = String::new();
    std::fs::File::open(p)?.read_to_string(&mut s)?;
    let t = s.trim().to_string();
    Ok(if t.is_empty() { None } else { Some(t) })
}

fn write_current_profile(id: &str) -> Result<()> {
    let home = dirs::home_dir().context("could not resolve home directory")?;
    let dir = home.join(".ap-browser");
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("current"), id)?;
    Ok(())
}

pub fn print_human(resp: &Value) {
    if resp.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        let err = resp.get("error").cloned().unwrap_or(json!({}));
        println!("error: {}", err.get("code").and_then(|v| v.as_str()).unwrap_or("?"));
        if let Some(msg) = err.get("message").and_then(|v| v.as_str()) { println!("       {msg}"); }
        return;
    }
    if let Some(data) = resp.get("data") {
        println!("{}", serde_json::to_string(data).unwrap_or_default());
    } else {
        println!("{}", serde_json::to_string(resp).unwrap_or_default());
    }
}

fn error_to_exit_code(resp: &Value) -> i32 {
    match resp.get("error").and_then(|e| e.get("code")).and_then(|v| v.as_str()).unwrap_or("") {
        "TAB_NOT_FOUND" => 3,
        "DEBUGGER_ATTACH_FAILED" | "CDP_ERROR" | "JS_EXCEPTION" | "SELECTOR_NO_MATCH" | "INTERNAL" => 4,
        "TIMEOUT" => 5,
        "MULTIPLE_PROFILES" => 6,
        _ => 1,
    }
}

fn truncate_id(id: &str) -> String {
    if id.len() <= 8 { id.to_string() } else { format!("{}…", &id[..8]) }
}

fn parse_range(s: &str) -> Result<Value> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 2 { return Err(anyhow!("range format: START:END")); }
    Ok(json!([parts[0].parse::<i64>()?, parts[1].parse::<i64>()?]))
}

fn base64_decode(s: &str) -> Result<Vec<u8>> {
    const TBL: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut tbl = [255u8; 256];
    for (i, &c) in TBL.iter().enumerate() { tbl[c as usize] = i as u8; }
    tbl[b'=' as usize] = 0;
    let s: Vec<u8> = s.bytes().filter(|&b| !b.is_ascii_whitespace()).collect();
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    for chunk in s.chunks(4) {
        if chunk.len() < 4 { break; }
        let n = (tbl[chunk[0] as usize] as u32) << 18
            | (tbl[chunk[1] as usize] as u32) << 12
            | (tbl[chunk[2] as usize] as u32) << 6
            | (tbl[chunk[3] as usize] as u32);
        out.push((n >> 16) as u8);
        if chunk[2] != b'=' { out.push((n >> 8) as u8); }
        if chunk[3] != b'=' { out.push(n as u8); }
    }
    Ok(out)
}

fn atty_is_tty() -> bool {
    std::io::stdout().is_terminal()
}

fn run_sites_command(args: &[String]) -> Result<()> {
    let registry = sites::Registry::load();
    let human = args.iter().any(|a| a == "--human");
    match args.first().map(|s| s.as_str()) {
        Some("list") => {
            let want_full = args.iter().any(|a| a == "--full");
            if want_full {
                let mut adapters = Vec::new();
                for (site, entry) in &registry.sites {
                    for (name, adapter) in &entry.adapters {
                        adapters.push(json!({
                            "site": site,
                            "name": name,
                            "description": adapter.description.clone().unwrap_or_default(),
                        }));
                    }
                }
                let resp = json!({"ok": true, "data": {"adapters": adapters}});
                if human {
                    for a in adapters {
                        println!("{}.{}  {}", a["site"], a["name"], a["description"]);
                    }
                } else {
                    println!("{}", serde_json::to_string(&resp)?);
                }
                return Ok(());
            }
            let mut site_names: Vec<&String> = registry.sites.keys().collect();
            site_names.sort();
            let sites_brief: Vec<Value> = site_names.iter().map(|s| {
                let e = &registry.sites[*s];
                json!({
                    "site": s,
                    "commands": e.adapters.len(),
                    "description": e.meta.as_ref().and_then(|m| m.description.clone()).unwrap_or_default(),
                })
            }).collect();
            let recent: Vec<Value> = registry.recent_sites(5).into_iter()
                .map(|(s, c)| json!({"site": s, "commands": c}))
                .collect();
            let resp = json!({
                "ok": true,
                "data": {
                    "total_sites": registry.sites.len(),
                    "total_adapters": registry.total_adapters(),
                    "recent": recent,
                    "sites": sites_brief,
                },
                "hints": {
                    "search": "ap-browser sites search <query>",
                    "full":  "ap-browser sites list --full",
                }
            });
            if human {
                println!("Total: {} sites, {} adapters", registry.sites.len(), registry.total_adapters());
                if !recent.is_empty() {
                    println!("\nRecent:");
                    for r in &recent { println!("  {} ({} cmds)", r["site"], r["commands"]); }
                }
                println!("\nAll sites:");
                for s in &sites_brief { println!("  {} [{} cmds]  {}", s["site"], s["commands"], s["description"]); }
                println!("\nTip: `ap-browser sites search <query>` to find a site/command.");
            } else {
                println!("{}", serde_json::to_string(&resp)?);
            }
            Ok(())
        }
        Some("search") => {
            let query = args.iter().skip(1).find(|a| !a.starts_with("--"))
                .ok_or_else(|| anyhow!("usage: sites search <query>"))?;
            let hits = registry.search(query);
            let mut site_out: Vec<Value> = Vec::new();
            for (site, cmds) in &hits {
                let entry = &registry.sites[site];
                let site_desc = entry.meta.as_ref()
                    .and_then(|m| m.description.clone())
                    .unwrap_or_default();
                let cmd_arr: Vec<Value> = cmds.iter().map(|(c, d)| json!({"cmd": c, "description": d})).collect();
                site_out.push(json!({"site": site, "site_description": site_desc, "matched_commands": cmd_arr}));
            }
            let resp = json!({
                "ok": true,
                "data": {
                    "query": query,
                    "matches": site_out.len(),
                    "sites": site_out,
                }
            });
            if human {
                if site_out.is_empty() {
                    println!("No matches for '{}'.", query);
                } else {
                    println!("Matches for '{}' ({} sites):", query, site_out.len());
                    for s in &site_out {
                        let desc = if s["site_description"].as_str().unwrap_or("").is_empty() { String::new() }
                                   else { format!(" — {}", s["site_description"]) };
                        println!("\n  {}{}", s["site"], desc);
                        for cmd in s["matched_commands"].as_array().unwrap() {
                            println!("    {}  {}", cmd["cmd"], cmd["description"]);
                        }
                    }
                }
            } else {
                println!("{}", serde_json::to_string(&resp)?);
            }
            Ok(())
        }
        Some("lint") => {
            let target_site = args.get(1).filter(|s| !s.starts_with("--"));
            let results = sites::lint::lint_all(&registry);
            let mut has_errors = false;
            for (site, cmds) in &results {
                if let Some(t) = target_site { if site != t { continue; } }
                for (cmd, lr) in cmds {
                    println!("{}::{}", site, cmd);
                    for e in &lr.errors { println!("  ✗ {}", e); has_errors = true; }
                    for w in &lr.warnings { println!("  ⚠ {}", w); }
                    if lr.is_ok() && lr.warnings.is_empty() { println!("  ✓ ok"); }
                }
            }
            if has_errors { std::process::exit(4); }
            Ok(())
        }
        Some("verify") => {
            let site = args.get(1).ok_or_else(|| anyhow!("usage: sites verify <site> <cmd> --test-args '<json>'"))?;
            let cmd = args.get(2).ok_or_else(|| anyhow!("usage: sites verify <site> <cmd> --test-args '<json>'"))?;
            let test_args_idx = args.iter().position(|a| a == "--test-args");
            let test_args_str = test_args_idx.and_then(|i| args.get(i + 1))
                .ok_or_else(|| anyhow!("verify requires --test-args '<json>' to run the adapter with real values"))?;
            let test_args: Value = serde_json::from_str(test_args_str)
                .with_context(|| format!("invalid JSON in --test-args: {}", test_args_str))?;
            sites::lint::verify_adapter(&registry, site, cmd, &test_args)
        }
        Some("doc") => {
            let site = args.get(1).ok_or_else(|| anyhow!("usage: sites doc <site>"))?;
            let doc_path = format!("skill/references/sites/{}.md", site);
            match std::fs::read_to_string(&doc_path) {
                Ok(contents) => {
                    println!("doc: {}", std::fs::canonicalize(&doc_path).unwrap_or_else(|_| PathBuf::from(&doc_path)).display());
                    println!("\n{}", contents);
                    Ok(())
                }
                Err(_) => {
                    println!("no knowledge doc for '{}' yet. See skill/references/create-site.md to create one.", site);
                    Ok(())
                }
            }
        }
        _ => {
            eprintln!("Usage: ap-browser sites <list [--full]|search <q>|lint|verify|doc> [...]");
            std::process::exit(1);
        }
    }
}
