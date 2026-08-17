//! ap-browser — operator-level CLI. Drives the user's logged-in Chrome from any agent.

mod annotate;
mod capture;
mod cli_frame;
mod dev;
mod doctor;
mod filters;
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
    State,
    Status,
    Profiles,
    Use {
        id_or_label: String,
    },
    Current,
    Info,
    #[command(subcommand)]
    Tabs(TabsCmd),
    Goto {
        url: String,
    },
    Back,
    Forward,
    Reload,
    Screenshot {
        #[arg(long, default_value = "screenshot.png")]
        out: String,
        #[arg(long)]
        full: bool,
        #[arg(long)]
        element: Option<String>,
        #[arg(long)]
        annotate: bool,
    },
    Text {
        #[arg(long, default_value = "body")]
        selector: String,
        #[arg(long)]
        full: bool,
        #[arg(long)]
        range: Option<String>,
    },
    Html {
        #[arg(long, default_value = "html")]
        selector: String,
        #[arg(long)]
        full: bool,
        #[arg(long)]
        range: Option<String>,
    },
    Click {
        target: String,
    },
    Fill {
        target: String,
        value: String,
    },
    Select {
        target: String,
        option: String,
    },
    Scroll {
        #[arg(long)]
        count: Option<u64>,
        #[arg(long)]
        pause_ms: Option<u64>,
        #[arg(long)]
        selector: Option<String>,
    },
    Press {
        keys: String,
    },
    Wait {
        selector: Option<String>,
        #[arg(long)]
        url_change_from: Option<String>,
        #[arg(long)]
        xhr: Option<String>,
        #[arg(long)]
        media_ended: bool,
        #[arg(long)]
        until_eval: Option<String>,
        #[arg(long)]
        gone: Option<String>,
        #[arg(long, default_value = "1000")]
        interval_ms: u64,
        #[arg(long, default_value = "5000")]
        timeout_ms: u64,
    },
    Eval {
        expression: String,
    },
    Cdp {
        method: String,
        #[arg(long)]
        params: Option<String>,
    },
    Batch {
        #[arg(long)]
        file: Option<String>,
    },
    Download {
        url: Option<String>,
        #[arg(long)]
        out: Option<String>,
        #[arg(long)]
        method: Option<String>,
        #[arg(long)]
        video: bool,
        #[arg(long, requires = "video")]
        audio_only: bool,
        #[arg(long, requires = "video")]
        subtitles: bool,
        #[arg(long)]
        format: Option<String>,
        #[arg(long)]
        cookies_from: Option<String>,
        #[arg(long)]
        silence_hint: bool,
        #[arg(long = "list")]
        list: bool,
        #[arg(long = "auto")]
        auto_pick: bool,
        #[arg(long)]
        pick: Option<String>,
    },
    Pdf {
        #[arg(long, default_value = "page.pdf")]
        out: String,
        #[arg(long)]
        landscape: bool,
        #[arg(long, default_value = "A4")]
        format: String,
    },
    Mhtml {
        #[arg(long, default_value = "page.mhtml")]
        out: String,
    },
    Har {
        #[arg(long, default_value = "page.har")]
        out: String,
    },
    Media {
        #[arg(long = "type", default_value = "all")]
        media_type: Option<String>,
    },
}

#[derive(Subcommand, Debug)]
enum TabsCmd {
    List {
        #[arg(long)]
        filter: Option<String>,
        #[arg(long)]
        group: Option<String>,
        #[arg(long)]
        grouped: bool,
    },
    New {
        url: Option<String>,
        #[arg(long)]
        silent: bool,
    },
    Close {
        id: i64,
    },
    Activate {
        id: i64,
    },
    Get {
        id: i64,
    },
}

const ENV_OVERRIDE: &str = "AP_BROWSER_PROFILE";
const CURRENT_FILE: &str = ".ap-browser/current";
const MAX_RPC_TIMEOUT_SECS: u64 = 3_600;
const WAIT_OVERHEAD_SECS: u64 = 15;
const MAX_WAIT_TIMEOUT_MS: u64 = (MAX_RPC_TIMEOUT_SECS - WAIT_OVERHEAD_SECS) * 1_000;

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
            println!(
                "(No site adapters installed. Drop YAML adapters into ~/.ap-browser/sites/<site>/)"
            );
        } else {
            println!(
                "Site adapters ({} sites, {} commands — run `ap-browser <site> <cmd>`):",
                registry.sites.len(),
                total_adapters
            );
            println!();
            let mut names: Vec<&String> = registry.sites.keys().collect();
            names.sort();
            for name in names {
                let entry = &registry.sites[name];
                let desc = entry
                    .meta
                    .as_ref()
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
        // `ap-browser --tab 5 hackernews top ...` — agents put global flags
        // first (the static CLI accepts both orders), but adapter commands are
        // argv[1]-dispatched and only see flags after the subcommand. Rewrite
        // leading global flags to the tail when argv[1] is a known site or a
        // reserved (manually-dispatched) command.
        if let Some(reordered) = reorder_leading_flags(&raw_args) {
            if reordered[0] == "sites" {
                return run_sites_command(&reordered[1..]);
            }
            if reordered[0] == "dev" {
                return dev::dispatch(&reordered[1..]);
            }
            if reordered[0] == "doctor" {
                let fix = reordered.iter().any(|a| a == "--fix");
                let json = reordered.iter().any(|a| a == "--json");
                return doctor::run(fix, json);
            }
            let registry = sites::Registry::load();
            let site = &reordered[0];
            // `ap-browser --profile X tabs close N`: a static clap command, not
            // an adapter site. Parse the rewritten argv with clap instead of
            // misrouting it to dispatch_site ("unknown site: tabs").
            if sites::RESERVED.contains(&site.as_str()) && registry.match_site(site).is_none() {
                let argv = std::iter::once("ap-browser".to_string())
                    .chain(reordered.iter().cloned())
                    .collect::<Vec<String>>();
                let cli = Cli::parse_from(argv);
                let human = cli.human || atty_is_tty();
                return run_static_match(&cli, human);
            }
            let cmd = reordered.get(1).cloned().unwrap_or_else(|| {
                eprintln!("Usage: ap-browser {} <command> [args]", site);
                std::process::exit(1);
            });
            return sites::dispatch_site(&registry, site, &cmd, &reordered[2..]);
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
    run_static_match(&cli, human)
}

/// The static (clap-defined) command surface, shared by direct dispatch and
/// by the leading-global-flag rewrite path (`--profile X tabs close N`).
fn run_static_match(cli: &Cli, human: bool) -> Result<()> {
    match &cli.command {
        Cmd::Ping => rpc(cli, "ping", json!({}), human, |_| {})?,
        Cmd::Info => rpc(cli, "info", json!({}), human, |_| {})?,
        Cmd::Status => run_status(cli, human)?,
        Cmd::Profiles => run_profiles(cli, human)?,
        Cmd::Current => run_current(human)?,
        Cmd::Use { id_or_label } => run_use(id_or_label, human)?,
        Cmd::Tabs(cmd) => match cmd {
            TabsCmd::List {
                filter,
                group,
                grouped: _,
            } => {
                let mut params = json!({});
                if let Some(f) = filter {
                    params["filter"] = json!(f);
                }
                if let Some(g) = group {
                    params["group"] = json!(g);
                }
                rpc(cli, "tabs.list", params, human, |_| {})?
            }
            TabsCmd::New { url, silent } => {
                let mut params = json!({});
                if let Some(u) = url {
                    params["url"] = json!(u);
                }
                if *silent {
                    params["active"] = json!(false);
                }
                rpc(cli, "tabs.new", params, human, |_| {})?
            }
            TabsCmd::Close { id } => rpc(cli, "tabs.close", json!({"tab_id": id}), human, |_| {})?,
            TabsCmd::Activate { id } => {
                rpc(cli, "tabs.activate", json!({"tab_id": id}), human, |_| {})?
            }
            TabsCmd::Get { id } => rpc(cli, "tabs.get", json!({"tab_id": id}), human, |_| {})?,
        },
        Cmd::Goto { url } => rpc(cli, "goto", json!({"url": url}), human, |_| {})?,
        Cmd::Back => rpc(cli, "back", json!({}), human, |_| {})?,
        Cmd::Forward => rpc(cli, "forward", json!({}), human, |_| {})?,
        Cmd::Reload => rpc(cli, "reload", json!({}), human, |_| {})?,
        Cmd::Text {
            selector,
            full,
            range,
        } => {
            let mut params = json!({"selector": selector});
            if *full {
                params["full"] = json!(true);
            }
            if let Some(r) = range {
                params["range"] = parse_range(r)?;
            }
            rpc(cli, "text", params, human, |_| {})?
        }
        Cmd::Html {
            selector,
            full,
            range,
        } => {
            let mut params = json!({"selector": selector});
            if *full {
                params["full"] = json!(true);
            }
            if let Some(r) = range {
                params["range"] = parse_range(r)?;
            }
            rpc(cli, "html", params, human, |_| {})?
        }
        Cmd::Screenshot {
            out,
            full,
            element,
            annotate,
        } => {
            if let Some(sel) = element {
                capture::element_screenshot(sel, out, cli.tab, cli.profile.as_deref())?;
                eprintln!("[screenshot saved: {out} (element: {sel})]");
            } else {
                let mut params = json!({});
                if *full {
                    params["full"] = json!(true);
                }
                if *annotate {
                    params["annotate"] = json!(true);
                }
                rpc(cli, "screenshot", params, human, |resp| {
                    save_screenshot(resp, out, *annotate, *full);
                })?
            }
        }
        Cmd::Click { target } => rpc(
            cli,
            "click",
            target_params(target, json!({})),
            human,
            |_| {},
        )?,
        Cmd::Fill { target, value } => rpc(
            cli,
            "fill",
            target_params(target, json!({"value": value})),
            human,
            |_| {},
        )?,
        Cmd::Select { target, option } => rpc(
            cli,
            "select",
            target_params(target, json!({"option": option})),
            human,
            |_| {},
        )?,
        Cmd::Scroll {
            count,
            pause_ms,
            selector,
        } => {
            let mut params = json!({});
            if let Some(c) = count {
                params["count"] = json!(c);
            }
            if let Some(p) = pause_ms {
                params["pause_ms"] = json!(p);
            }
            if let Some(s) = selector {
                params["selector"] = json!(s);
            }
            rpc(cli, "scroll", params, human, |_| {})?
        }
        Cmd::State => rpc(cli, "state.snapshot", json!({}), human, |resp| {
            if human {
                render_state_tree(resp);
            }
        })?,
        Cmd::Press { keys } => rpc(cli, "press", json!({"keys": keys}), human, |_| {})?,
        Cmd::Wait {
            selector,
            url_change_from,
            xhr,
            media_ended,
            until_eval,
            gone,
            interval_ms,
            timeout_ms,
        } => {
            let params = wait_params(WaitOptions {
                selector: selector.as_deref(),
                url: url_change_from.as_deref(),
                xhr: xhr.as_deref(),
                media: *media_ended,
                until_eval: until_eval.as_deref(),
                gone: gone.as_deref(),
                interval_ms: *interval_ms,
                timeout_ms: *timeout_ms,
            })?;
            rpc(cli, "wait", params, human, |_| {})?
        }
        Cmd::Eval { expression } => rpc(
            cli,
            "eval",
            json!({"expression": expression}),
            human,
            |_| {},
        )?,
        Cmd::Cdp { method, params } => {
            let p = match params {
                Some(s) => serde_json::from_str(s).unwrap_or(json!({})),
                None => json!({}),
            };
            rpc(
                cli,
                "cdp",
                json!({"method": method, "params": p}),
                human,
                |_| {},
            )?
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
            rpc(cli, "batch", json!({"steps": steps}), human, |_| {})?
        }
        Cmd::Download {
            url,
            out,
            method,
            video,
            audio_only,
            subtitles,
            format,
            cookies_from,
            silence_hint,
            list,
            auto_pick,
            pick,
        } => {
            let mut dargs: Vec<String> = Vec::new();
            if let Some(u) = url {
                dargs.push(u.clone());
            }
            if let Some(o) = out {
                dargs.push("--out".into());
                dargs.push(o.clone());
            }
            if let Some(m) = method {
                dargs.push("--method".into());
                dargs.push(m.clone());
            }
            if *video {
                dargs.push("--video".into());
            }
            if *audio_only {
                dargs.push("--audio-only".into());
            }
            if *subtitles {
                dargs.push("--subtitles".into());
            }
            if let Some(f) = format {
                dargs.push("--format".into());
                dargs.push(f.clone());
            }
            if let Some(c) = cookies_from {
                dargs.push("--cookies-from".into());
                dargs.push(c.clone());
            }
            if *silence_hint {
                dargs.push("--silence-hint".into());
            }
            if *list {
                dargs.push("--list".into());
            }
            if *auto_pick {
                dargs.push("--auto".into());
            }
            if let Some(p) = pick {
                dargs.push("--pick".into());
                dargs.push(p.clone());
            }
            if let Some(t) = cli.tab {
                dargs.push("--tab".into());
                dargs.push(t.to_string());
            }
            capture::dispatch("download", &dargs)?
        }
        Cmd::Pdf {
            out,
            landscape,
            format,
        } => {
            let mut dargs: Vec<String> = vec!["--out".into(), out.clone()];
            if *landscape {
                dargs.push("--landscape".into());
            }
            dargs.push("--format".into());
            dargs.push(format.clone());
            if let Some(t) = cli.tab {
                dargs.push("--tab".into());
                dargs.push(t.to_string());
            }
            capture::dispatch("pdf", &dargs)?
        }
        Cmd::Mhtml { out } => {
            let mut dargs: Vec<String> = vec!["--out".into(), out.clone()];
            if let Some(t) = cli.tab {
                dargs.push("--tab".into());
                dargs.push(t.to_string());
            }
            capture::dispatch("mhtml", &dargs)?
        }
        Cmd::Har { out } => {
            let mut dargs: Vec<String> = vec!["--out".into(), out.clone()];
            if let Some(t) = cli.tab {
                dargs.push("--tab".into());
                dargs.push(t.to_string());
            }
            capture::dispatch("har", &dargs)?
        }
        Cmd::Media { media_type } => {
            let mt = media_type.clone().unwrap_or("all".into());
            let mut dargs: Vec<String> = vec!["--type".into(), mt];
            if let Some(t) = cli.tab {
                dargs.push("--tab".into());
                dargs.push(t.to_string());
            }
            capture::dispatch("media", &dargs)?
        }
    }
    Ok(())
}

fn rpc(
    cli: &Cli,
    method: &str,
    params: Value,
    human: bool,
    post: impl Fn(&mut Value),
) -> Result<()> {
    let mut p = params;
    if let Some(t) = cli.tab {
        p.as_object_mut()
            .map(|o| o.insert("tab_id".into(), json!(t)));
    }
    if let Some(w) = cli.window {
        p.as_object_mut()
            .map(|o| o.insert("window_id".into(), json!(w)));
    }
    apply_timeout_hint(&mut p, cli.timeout)?;
    filters::Registry::load().attach_to(&mut p);

    let socket = resolve_socket(cli.profile.as_deref())?;
    let request = json!({"jsonrpc":"2.0","method":method,"params":p});
    let bytes = cli_frame::encode(&request)?;
    let mut stream = dial_with_retry(&socket, 3, Duration::from_millis(200))?;
    std::io::Write::write_all(&mut stream, &bytes)?;
    std::io::Write::flush(&mut stream)?;
    let envelope = cli_frame::read_response(&mut stream, Duration::from_secs(cli.timeout))?;

    let mut response = match envelope.get("result") {
        Some(r) => r.clone(),
        None => match envelope.get("error") {
            Some(e) => json!({"ok": false, "error": e}),
            None => envelope,
        },
    };

    if response.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        post(&mut response);
    }

    if matches!(method, "text" | "html") {
        tag_untrusted(&mut response);
    }
    sites::enhance_chrome_error(&mut response);

    if human {
        print_human(&response);
    } else {
        println!("{}", serde_json::to_string(&response)?);
    }

    if response.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        std::process::exit(error_to_exit_code(&response));
    }
    Ok(())
}

fn apply_timeout_hint(params: &mut Value, timeout_secs: u64) -> Result<()> {
    let wait_ms = requested_timeout_ms(params);
    if wait_ms > MAX_WAIT_TIMEOUT_MS {
        return Err(anyhow!(
            "combined wait timeout exceeds {}ms",
            MAX_WAIT_TIMEOUT_MS
        ));
    }
    let wait_secs = if wait_ms == 0 {
        0
    } else {
        wait_ms.saturating_add(999) / 1_000 + WAIT_OVERHEAD_SECS
    };
    if let Some(object) = params.as_object_mut() {
        object.insert(
            "_timeout_hint_secs".into(),
            json!(timeout_secs.max(wait_secs).min(MAX_RPC_TIMEOUT_SECS)),
        );
    }
    Ok(())
}

fn requested_timeout_ms(params: &Value) -> u64 {
    let direct = params
        .get("timeout_ms")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let batch = params
        .get("steps")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|step| {
            step.get("timeout_ms")
                .or_else(|| step.get("params")?.get("timeout_ms"))
        })
        .filter_map(Value::as_u64)
        .fold(0u64, |sum, ms| sum.saturating_add(ms));
    direct.max(batch)
}

/// opencli-style target contract: a pure-integer target is a `state` ref,
/// anything else is a CSS selector. (A bare number is never valid CSS, so
/// the interpretation is unambiguous.)
fn target_params(target: &str, mut extra: Value) -> Value {
    if let Ok(n) = target.parse::<u64>() {
        extra["ref"] = json!(n);
    } else {
        extra["selector"] = json!(target);
    }
    extra
}

fn render_state_tree(resp: &mut Value) {
    if resp.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return;
    }
    let Some(elements) = resp
        .get_mut("data")
        .and_then(|d| d.get_mut("elements"))
        .and_then(|e| e.as_array_mut())
    else {
        return;
    };
    let lines: Vec<String> = elements
        .iter()
        .filter_map(|e| {
            let ref_n = e.get("ref")?.as_u64()?;
            let tag = e.get("tag").and_then(|v| v.as_str()).unwrap_or("?");
            let name = e.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let y = e.get("y").and_then(|v| v.as_i64()).unwrap_or(0);
            Some(format!("[{ref_n}] {tag:<8} {name}  (y={y})"))
        })
        .collect();
    let tree = if lines.is_empty() {
        "(no interactive elements in viewport)".to_string()
    } else {
        lines.join("\n")
    };
    if let Some(data) = resp.get_mut("data") {
        *data = json!(tree);
    }
}

struct WaitOptions<'a> {
    selector: Option<&'a str>,
    url: Option<&'a str>,
    xhr: Option<&'a str>,
    media: bool,
    until_eval: Option<&'a str>,
    gone: Option<&'a str>,
    interval_ms: u64,
    timeout_ms: u64,
}

fn wait_params(opts: WaitOptions<'_>) -> Result<Value> {
    let mode_count = [
        opts.url.is_some(),
        opts.xhr.is_some(),
        opts.media,
        opts.until_eval.is_some(),
        opts.gone.is_some(),
        opts.selector.is_some() && !opts.media,
    ]
    .iter()
    .filter(|&&b| b)
    .count();

    if mode_count > 1 {
        return Err(anyhow!(
            "wait accepts only one target mode (selector, --url-change-from, --xhr, --media-ended, --until-eval, or --gone)"
        ));
    }
    if let Some(from) = opts.url {
        return Ok(json!({"url_change_from": from, "timeout_ms": opts.timeout_ms}));
    }
    if let Some(sub) = opts.xhr {
        return Ok(json!({"xhr": sub, "timeout_ms": opts.timeout_ms}));
    }
    if opts.media {
        return Ok(
            json!({"media_ended": true, "selector": opts.selector.unwrap_or("video"), "timeout_ms": opts.timeout_ms}),
        );
    }
    if let Some(expr) = opts.until_eval {
        return Ok(
            json!({"until_eval": expr, "interval_ms": opts.interval_ms, "timeout_ms": opts.timeout_ms}),
        );
    }
    if let Some(g) = opts.gone {
        return Ok(
            json!({"gone": g, "interval_ms": opts.interval_ms, "timeout_ms": opts.timeout_ms}),
        );
    }
    let selector = opts.selector.ok_or_else(|| {
        anyhow!("wait requires a selector, --url-change-from, --xhr, --media-ended, --until-eval, or --gone")
    })?;
    if let Ok(n) = selector.parse::<u64>() {
        // Numeric target = state ref (opencli target contract).
        return Ok(json!({"ref": n, "timeout_ms": opts.timeout_ms}));
    }
    Ok(json!({"selector": selector, "timeout_ms": opts.timeout_ms}))
}

fn save_screenshot(resp: &mut Value, out: &str, annotate: bool, full: bool) {
    let data_url = resp
        .get("data")
        .and_then(|d| d.get("data_url"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let decoded = base64_decode(data_url.trim_start_matches("data:image/png;base64,"));
    let result = decoded.and_then(|raw| {
        let raw = if annotate {
            match resp
                .get("data")
                .and_then(|d| d.get("annotation"))
                .and_then(Value::as_object)
            {
                Some(annotation) => crate::annotate::apply_annotation(
                    &raw,
                    &Value::Object(annotation.clone()),
                    full,
                )?,
                None => raw,
            }
        } else {
            raw
        };
        std::fs::write(out, &raw)?;
        Ok(raw.len())
    });
    if let Some(data) = resp.get_mut("data").and_then(Value::as_object_mut) {
        data.remove("data_url");
        data.insert("file".into(), json!(out));
    }
    match result {
        Ok(bytes) => {
            resp["data"]["bytes"] = json!(bytes);
            eprintln!("[screenshot saved: {out} ({bytes} bytes)]");
        }
        Err(error) => {
            resp["ok"] = json!(false);
            resp["error"] = json!({"code": "SCREENSHOT_SAVE_FAILED", "message": error.to_string()});
        }
    }
}

fn run_status(_cli: &Cli, human: bool) -> Result<()> {
    let profiles = discover_profiles()?;
    let current = read_current_profile().ok().flatten();
    if human {
        println!(
            "ap-browser status: {} socket(s) online (* = current)",
            profiles.len()
        );
        for p in &profiles {
            println!(
                "  {}{}  {}  {}",
                if current.as_deref() == Some(&p.instance_id) {
                    "*"
                } else {
                    " "
                },
                truncate_id(&p.instance_id),
                p.label.as_deref().unwrap_or(""),
                p.active_tab_url.as_deref().unwrap_or("(no tab)")
            );
        }
    } else {
        println!(
            "{}",
            serde_json::to_string(&json!({"online": decorate_current(profiles, current)}))?
        );
    }
    Ok(())
}

fn run_profiles(_cli: &Cli, human: bool) -> Result<()> {
    let profiles = discover_profiles()?;
    let current = read_current_profile().ok().flatten();
    if human {
        if profiles.is_empty() {
            println!("(no extension instances online)");
        }
        for p in &profiles {
            println!(
                "{}{}  label={}  active={}",
                if current.as_deref() == Some(&p.instance_id) {
                    "*"
                } else {
                    " "
                },
                truncate_id(&p.instance_id),
                p.label.as_deref().unwrap_or(""),
                p.active_tab_url.as_deref().unwrap_or("(none)")
            );
        }
    } else {
        println!(
            "{}",
            serde_json::to_string(&decorate_current(profiles, current))?
        );
    }
    Ok(())
}

/// Additive `current: true` marker on the profile the CLI routes to by
/// default, so multi-profile JSON consumers don't have to cross-reference
/// `~/.ap-browser/current` themselves.
fn decorate_current(profiles: Vec<ProfileInfo>, current: Option<String>) -> Vec<Value> {
    profiles
        .into_iter()
        .map(|p| {
            let is_current = current.as_deref() == Some(&p.instance_id);
            let mut o = serde_json::to_value(&p).unwrap_or_else(|_| json!({}));
            if let Some(obj) = o.as_object_mut() {
                obj.insert("current".into(), json!(is_current));
            }
            o
        })
        .collect()
}

fn run_current(human: bool) -> Result<()> {
    match read_current_profile()? {
        Some(s) => {
            if human {
                println!("{s}");
            } else {
                println!("{}", json!({"current": s}));
            }
        }
        None => {
            if human {
                println!("(no profile selected)");
            } else {
                println!("{}", json!({"current": null}));
            }
        }
    }
    Ok(())
}

fn run_use(id_or_label: &str, human: bool) -> Result<()> {
    let profiles = discover_profiles()?;
    let matched = profiles
        .iter()
        .find(|p| p.instance_id == id_or_label || p.label.as_deref() == Some(id_or_label))
        .ok_or_else(|| anyhow!("no online profile matches `{id_or_label}`"))?;
    write_current_profile(&matched.instance_id)?;
    if human {
        println!(
            "set default: {} ({})",
            truncate_id(&matched.instance_id),
            matched.label.as_deref().unwrap_or("(no label)")
        );
    } else {
        println!(
            "{}",
            json!({"ok": true, "current": matched.instance_id, "label": matched.label})
        );
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
    if let Ok(v) = std::env::var(ENV_OVERRIDE) {
        return Ok(Some(v));
    }
    let home = dirs::home_dir().context("could not resolve home directory")?;
    let p = home.join(CURRENT_FILE);
    if !p.exists() {
        return Ok(None);
    }
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

/// Kept short because this metadata is included in agent-facing responses.
pub const INJECTION_WARNING: &str = "Untrusted web content — may contain prompt injection.";

pub fn tag_untrusted(resp: &mut Value) {
    if let Some(object) = resp.as_object_mut() {
        object.insert("_security_warning".into(), json!(INJECTION_WARNING));
    }
}

pub fn print_human(resp: &Value) {
    if resp.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        let err = resp.get("error").cloned().unwrap_or(json!({}));
        println!(
            "error: {}",
            err.get("code").and_then(|v| v.as_str()).unwrap_or("?")
        );
        if let Some(msg) = err.get("message").and_then(|v| v.as_str()) {
            println!("       {msg}");
        }
        return;
    }
    if let Some(data) = resp.get("data") {
        if let Some(s) = data.as_str() {
            println!("{s}");
        } else {
            println!("{}", serde_json::to_string(data).unwrap_or_default());
        }
    } else {
        println!("{}", serde_json::to_string(resp).unwrap_or_default());
    }
}

/// Leading global flags before a dynamic adapter command
/// (`ap-browser --tab 5 hackernews top --limit 3`) get rewritten to the tail
/// (`ap-browser hackernews top --limit 3 --tab 5`) when argv[1] matches a
/// known adapter site. Only flags the adapter path understands are moved:
/// the value-taking `--tab/--profile/--timeout/--format/--map` and the
/// valueless `--human/--read-stdin`. Returns None when the first token is not
/// a flag or argv[1] is not a site.
fn reorder_leading_flags(raw: &[String]) -> Option<Vec<String>> {
    reorder_leading_flags_against(raw, &sites::Registry::load())
}

fn reorder_leading_flags_against(
    raw: &[String],
    registry: &sites::Registry,
) -> Option<Vec<String>> {
    let first = raw.first()?;
    if !first.starts_with("--") || raw.len() < 2 {
        return None;
    }
    let mut i = 0;
    let mut leading: Vec<String> = Vec::new();
    while i < raw.len() && raw[i].starts_with("--") {
        let a = raw[i].clone();
        leading.push(a.clone());
        i += 1;
        if matches!(
            a.as_str(),
            "--tab" | "--profile" | "--timeout" | "--format" | "--map"
        ) && i < raw.len()
        {
            leading.push(raw[i].clone());
            i += 1;
        }
    }
    if i >= raw.len() {
        return None;
    }
    if sites::RESERVED.contains(&raw[i].as_str()) || registry.match_site(&raw[i]).is_some() {
        let mut reordered: Vec<String> = raw[i..].to_vec();
        reordered.extend(leading);
        Some(reordered)
    } else {
        None
    }
}

#[cfg(test)]
mod flag_reorder_tests {
    use super::reorder_leading_flags;
    use super::reorder_leading_flags_against;
    use crate::sites::{Registry, SiteEntry};
    use clap::Parser;
    use std::collections::HashMap;

    fn registry_with_site(name: &str) -> Registry {
        let mut sites = HashMap::new();
        sites.insert(
            name.to_string(),
            SiteEntry {
                meta: None,
                adapters: HashMap::new(),
            },
        );
        Registry { sites }
    }

    #[test]
    fn moves_leading_global_flags_to_tail_for_site_commands() {
        // Must not depend on ~/.ap-browser/sites (absent on CI runners).
        let registry = registry_with_site("hackernews");
        let reordered = reorder_leading_flags_against(
            &[
                "--tab".into(),
                "5".into(),
                "hackernews".into(),
                "top".into(),
                "--limit".into(),
                "3".into(),
            ],
            &registry,
        )
        .expect("reorder should match hackernews");
        assert_eq!(
            reordered,
            vec![
                "hackernews".to_string(),
                "top".to_string(),
                "--limit".to_string(),
                "3".to_string(),
                "--tab".to_string(),
                "5".to_string()
            ]
        );
    }

    #[test]
    fn moves_leading_global_flags_to_tail_for_reserved_commands() {
        let reordered = reorder_leading_flags(&[
            "--profile".into(),
            "Study".into(),
            "dev".into(),
            "extension".into(),
            "reload".into(),
        ])
        .expect("reorder should match dev");
        assert_eq!(
            reordered,
            vec![
                "dev".to_string(),
                "extension".to_string(),
                "reload".to_string(),
                "--profile".to_string(),
                "Study".to_string()
            ]
        );
    }

    #[test]
    fn leading_profile_before_static_tabs_command_parses_with_clap() {
        // `ap-browser --profile X tabs close N` used to die with
        // "unknown site: tabs". Now the reorder yields the tail-flag form and
        // clap accepts it — the same path run_static_match takes.
        let registry = registry_with_site("hackernews");
        let reordered = reorder_leading_flags_against(
            &[
                "--profile".into(),
                "tonyhe379".into(),
                "tabs".into(),
                "close".into(),
                "663382210".into(),
            ],
            &registry,
        )
        .expect("tabs is RESERVED and should be reordered");
        assert_eq!(
            reordered,
            vec![
                "tabs".to_string(),
                "close".to_string(),
                "663382210".to_string(),
                "--profile".to_string(),
                "tonyhe379".to_string()
            ]
        );
        let argv = std::iter::once("ap-browser".to_string())
            .chain(reordered.iter().cloned())
            .collect::<Vec<String>>();
        let cli = super::Cli::try_parse_from(argv).expect("clap must accept tail flags");
        assert!(matches!(
            cli.command,
            super::Cmd::Tabs(super::TabsCmd::Close { id: 663382210 })
        ));
        assert_eq!(cli.profile.as_deref(), Some("tonyhe379"));
    }

    #[test]
    fn leaves_normal_commands_untouched() {
        assert!(reorder_leading_flags(&["goto".into(), "https://x".into()]).is_none());
        assert!(reorder_leading_flags(&["--tab".into(), "5".into()]).is_none());
        // RESERVED commands with leading flags are reordered too:
        let reordered = reorder_leading_flags(&["--tab".into(), "5".into(), "goto".into()])
            .expect("goto is reserved and should be reordered");
        assert_eq!(
            reordered,
            vec!["goto".to_string(), "--tab".to_string(), "5".to_string()]
        );
        // Unknown site name without local adapters must not reorder.
        assert!(reorder_leading_flags_against(
            &[
                "--tab".into(),
                "5".into(),
                "not-a-real-site".into(),
                "top".into()
            ],
            &Registry {
                sites: HashMap::new()
            },
        )
        .is_none());
    }
}

fn error_to_exit_code(resp: &Value) -> i32 {
    match resp
        .get("error")
        .and_then(|e| e.get("code"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
    {
        "TAB_NOT_FOUND" => 3,
        "DEBUGGER_ATTACH_FAILED"
        | "CDP_ERROR"
        | "JS_EXCEPTION"
        | "SELECTOR_NO_MATCH"
        | "OPTION_NOT_FOUND"
        | "NOT_A_SELECT"
        | "FILTER_DENIED"
        | "INTERNAL" => 4,
        "TIMEOUT" => 5,
        "MULTIPLE_PROFILES" => 6,
        _ => 1,
    }
}

fn truncate_id(id: &str) -> String {
    if id.len() <= 8 {
        id.to_string()
    } else {
        format!("{}…", &id[..8])
    }
}

fn parse_range(s: &str) -> Result<Value> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 2 {
        return Err(anyhow!("range format: START:END"));
    }
    Ok(json!([parts[0].parse::<i64>()?, parts[1].parse::<i64>()?]))
}

fn base64_decode(s: &str) -> Result<Vec<u8>> {
    const TBL: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut tbl = [255u8; 256];
    for (i, &c) in TBL.iter().enumerate() {
        tbl[c as usize] = i as u8;
    }
    tbl[b'=' as usize] = 0;
    let s: Vec<u8> = s.bytes().filter(|&b| !b.is_ascii_whitespace()).collect();
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    for chunk in s.chunks(4) {
        if chunk.len() < 4 {
            break;
        }
        let n = (tbl[chunk[0] as usize] as u32) << 18
            | (tbl[chunk[1] as usize] as u32) << 12
            | (tbl[chunk[2] as usize] as u32) << 6
            | (tbl[chunk[3] as usize] as u32);
        out.push((n >> 16) as u8);
        if chunk[2] != b'=' {
            out.push((n >> 8) as u8);
        }
        if chunk[3] != b'=' {
            out.push(n as u8);
        }
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
            let recent: Vec<Value> = registry
                .recent_sites(5)
                .into_iter()
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
                println!(
                    "Total: {} sites, {} adapters",
                    registry.sites.len(),
                    registry.total_adapters()
                );
                if !recent.is_empty() {
                    println!("\nRecent:");
                    for r in &recent {
                        println!("  {} ({} cmds)", r["site"], r["commands"]);
                    }
                }
                println!("\nAll sites:");
                for s in &sites_brief {
                    println!(
                        "  {} [{} cmds]  {}",
                        s["site"], s["commands"], s["description"]
                    );
                }
                println!("\nTip: `ap-browser sites search <query>` to find a site/command.");
            } else {
                println!("{}", serde_json::to_string(&resp)?);
            }
            Ok(())
        }
        Some("search") => {
            let query = args
                .iter()
                .skip(1)
                .find(|a| !a.starts_with("--"))
                .ok_or_else(|| anyhow!("usage: sites search <query>"))?;
            let hits = registry.search(query);
            let mut site_out: Vec<Value> = Vec::new();
            for (site, cmds) in &hits {
                let entry = &registry.sites[site];
                let site_desc = entry
                    .meta
                    .as_ref()
                    .and_then(|m| m.description.clone())
                    .unwrap_or_default();
                let cmd_arr: Vec<Value> = cmds
                    .iter()
                    .map(|(c, d)| json!({"cmd": c, "description": d}))
                    .collect();
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
                        let desc = if s["site_description"].as_str().unwrap_or("").is_empty() {
                            String::new()
                        } else {
                            format!(" — {}", s["site_description"])
                        };
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
                if let Some(t) = target_site {
                    if site != t {
                        continue;
                    }
                }
                for (cmd, lr) in cmds {
                    println!("{}::{}", site, cmd);
                    for e in &lr.errors {
                        println!("  ✗ {}", e);
                        has_errors = true;
                    }
                    for w in &lr.warnings {
                        println!("  ⚠ {}", w);
                    }
                    if lr.is_ok() && lr.warnings.is_empty() {
                        println!("  ✓ ok");
                    }
                }
            }
            if has_errors {
                std::process::exit(4);
            }
            Ok(())
        }
        Some("verify") => {
            let site = args
                .get(1)
                .ok_or_else(|| anyhow!("usage: sites verify <site> <cmd> --test-args '<json>'"))?;
            let cmd = args
                .get(2)
                .ok_or_else(|| anyhow!("usage: sites verify <site> <cmd> --test-args '<json>'"))?;
            let test_args_idx = args.iter().position(|a| a == "--test-args");
            let test_args_str = test_args_idx.and_then(|i| args.get(i + 1)).ok_or_else(|| {
                anyhow!("verify requires --test-args '<json>' to run the adapter with real values")
            })?;
            let test_args: Value = serde_json::from_str(test_args_str)
                .with_context(|| format!("invalid JSON in --test-args: {}", test_args_str))?;
            sites::lint::verify_adapter(&registry, site, cmd, &test_args)
        }
        Some("doc") => {
            let site = args
                .get(1)
                .ok_or_else(|| anyhow!("usage: sites doc <site>"))?;
            let doc_path = format!("skill/references/sites/{}.md", site);
            match std::fs::read_to_string(&doc_path) {
                Ok(contents) => {
                    println!(
                        "doc: {}",
                        std::fs::canonicalize(&doc_path)
                            .unwrap_or_else(|_| PathBuf::from(&doc_path))
                            .display()
                    );
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tag_untrusted_stamps_response_envelope() {
        let mut response = json!({"ok": true, "data": {"text": "hello"}});
        tag_untrusted(&mut response);
        assert_eq!(
            response["_security_warning"].as_str(),
            Some(INJECTION_WARNING)
        );
        assert_eq!(response["data"], json!({"text": "hello"}));
    }

    #[test]
    fn tag_untrusted_ignores_non_object_values() {
        let mut response = json!("plain text");
        tag_untrusted(&mut response);
        assert!(response.get("_security_warning").is_none());
    }

    #[test]
    fn filter_denial_uses_runtime_error_exit_code() {
        let response = json!({"error": {"code": "FILTER_DENIED"}});
        assert_eq!(error_to_exit_code(&response), 4);
    }

    #[test]
    fn rpc_params_include_cli_timeout_hint() {
        let mut params = json!({});
        apply_timeout_hint(&mut params, 90).unwrap();
        assert_eq!(params["_timeout_hint_secs"], 90);
    }

    #[test]
    fn long_wait_extends_rpc_timeout_hint() {
        let mut params = json!({"timeout_ms": 180_000});
        apply_timeout_hint(&mut params, 30).unwrap();
        assert_eq!(params["_timeout_hint_secs"], 195);
    }

    #[test]
    fn batch_waits_sum_rpc_timeout_hint() {
        let mut params = json!({"steps": [
            {"method": "wait", "params": {"timeout_ms": 40_000}},
            {"method": "wait", "timeout_ms": 40_000}
        ]});
        apply_timeout_hint(&mut params, 30).unwrap();
        assert_eq!(params["_timeout_hint_secs"], 95);
    }

    #[test]
    fn long_cli_timeout_is_not_clamped_to_five_minutes() {
        let mut params = json!({});
        apply_timeout_hint(&mut params, 1_800).unwrap();
        assert_eq!(params["_timeout_hint_secs"], 1_800);
    }

    #[test]
    fn wait_longer_than_the_host_limit_is_rejected() {
        let mut params = json!({"timeout_ms": 3_585_001});
        assert!(apply_timeout_hint(&mut params, 30).is_err());
    }

    #[test]
    fn wait_modes_build_distinct_rpc_params() {
        assert_eq!(
            wait_params(WaitOptions {
                selector: Some(".done"),
                url: None,
                xhr: None,
                media: false,
                until_eval: None,
                gone: None,
                interval_ms: 1000,
                timeout_ms: 5_000,
            })
            .unwrap(),
            json!({
                "selector": ".done", "timeout_ms": 5_000
            })
        );
        assert_eq!(
            wait_params(WaitOptions {
                selector: None,
                url: Some("https://old.example/"),
                xhr: None,
                media: false,
                until_eval: None,
                gone: None,
                interval_ms: 1000,
                timeout_ms: 180_000,
            })
            .unwrap(),
            json!({
                "url_change_from": "https://old.example/", "timeout_ms": 180_000
            })
        );
        assert_eq!(
            wait_params(WaitOptions {
                selector: Some("audio.preview"),
                url: None,
                xhr: None,
                media: true,
                until_eval: None,
                gone: None,
                interval_ms: 1000,
                timeout_ms: 60_000,
            })
            .unwrap(),
            json!({
                "media_ended": true, "selector": "audio.preview", "timeout_ms": 60_000
            })
        );
        assert_eq!(
            wait_params(WaitOptions {
                selector: None,
                url: None,
                xhr: None,
                media: false,
                until_eval: Some("!isGenerating"),
                gone: None,
                interval_ms: 500,
                timeout_ms: 60_000,
            })
            .unwrap(),
            json!({
                "until_eval": "!isGenerating", "interval_ms": 500, "timeout_ms": 60_000
            })
        );
        assert_eq!(
            wait_params(WaitOptions {
                selector: None,
                url: None,
                xhr: None,
                media: false,
                until_eval: None,
                gone: Some(".spinner"),
                interval_ms: 500,
                timeout_ms: 60_000,
            })
            .unwrap(),
            json!({
                "gone": ".spinner", "interval_ms": 500, "timeout_ms": 60_000
            })
        );
        assert!(wait_params(WaitOptions {
            selector: None,
            url: None,
            xhr: None,
            media: false,
            until_eval: None,
            gone: None,
            interval_ms: 1000,
            timeout_ms: 5_000,
        })
        .is_err());
    }

    #[test]
    fn saved_screenshot_stdout_metadata_excludes_base64() {
        let path = std::env::temp_dir().join(format!("ap-browser-{}.png", std::process::id()));
        let mut response = json!({
            "ok": true,
            "data": {"tab_id": 7, "data_url": "data:image/png;base64,AQID", "bytes": 4}
        });

        save_screenshot(&mut response, path.to_str().unwrap(), false, false);

        assert_eq!(std::fs::read(&path).unwrap(), [1, 2, 3]);
        assert!(response["data"].get("data_url").is_none());
        assert_eq!(response["data"]["file"], path.to_str().unwrap());
        assert_eq!(response["data"]["bytes"], 3);
        let _ = std::fs::remove_file(path);
    }
}
