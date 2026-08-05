//! Dev mode: structured debugging commands wrapping CDP.

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use std::time::Duration;

pub fn dispatch(args: &[String]) -> Result<()> {
    let sub = args.first().map(|s| s.as_str()).unwrap_or("");
    let rest = &args[1..];
    match sub {
        "console" => console_cmd(rest),
        "network" => network_cmd(rest),
        "errors" => errors_cmd(rest),
        "snapshot" => snapshot_cmd(rest),
        "dom" => dom_cmd(rest),
        "heap" => heap_cmd(rest),
        "perf" => perf_cmd(rest),
        "lighthouse" => lighthouse_cmd(rest),
        "emulate" => emulate_cmd(rest),
        "hover" => hover_cmd(rest),
        "drag" => drag_cmd(rest),
        "fill-form" => fill_form_cmd(rest),
        "upload" => upload_cmd(rest),
        "dialog" => dialog_cmd(rest),
        "extension" => extension_cmd(rest),
        "api" => api_cmd(rest),
        "cookies" => cookies_cmd(rest),
        "storage" => storage_cmd(rest),
        "sw" => sw_cmd(rest),
        "" => {
            eprintln!("Usage: ap-browser dev <console|network|errors|snapshot|dom|heap|perf|lighthouse|emulate|hover|drag|fill-form|upload|dialog|extension|api|cookies|storage> [...]");
            std::process::exit(1);
        }
        other => {
            eprintln!("unknown dev subcommand: {other}\navailable: console, network, errors, snapshot, dom, heap, perf, lighthouse, emulate, hover, drag, fill-form, upload, dialog, extension, api, cookies, storage");
            std::process::exit(1);
        }
    }
}

// ── Shared helpers ─────────────────────────────────────────────────────────

fn extract_tab(args: &[String]) -> Option<i64> {
    args.windows(2)
        .find(|w| w[0] == "--tab")
        .and_then(|w| w[1].parse().ok())
}

fn extract_profile(args: &[String]) -> Option<String> {
    args.windows(2)
        .find(|w| w[0] == "--profile")
        .map(|w| w[1].clone())
}

fn extract_timeout(args: &[String]) -> Option<u64> {
    args.windows(2)
        .find(|w| w[0] == "--timeout")
        .and_then(|w| w[1].parse().ok())
        .filter(|&t| t > 0)
}

fn rpc(method: &str, params: Value, args: &[String]) -> Result<Value> {
    let mut p = params;
    if let Some(t) = extract_tab(args) {
        if let Some(o) = p.as_object_mut() {
            o.insert("tab_id".into(), json!(t));
        }
    }
    // Agent --timeout overrides the host's 30s default (host caps at 3600).
    let timeout_hint = extract_timeout(args).map(|t| t.min(3_600));
    if let Some(h) = timeout_hint {
        if let Some(o) = p.as_object_mut() {
            o.insert("_timeout_hint_secs".into(), json!(h));
        }
    }
    let socket = crate::socket_client::resolve_socket(extract_profile(args).as_deref())?;
    let request = json!({"jsonrpc":"2.0","method":method,"params":p});
    let bytes = crate::cli_frame::encode(&request)?;
    let mut stream = crate::socket_client::dial_with_retry(&socket, 3, Duration::from_millis(200))?;
    use std::io::Write;
    stream.write_all(&bytes)?;
    stream.flush()?;
    let envelope = crate::cli_frame::read_response(
        &mut stream,
        Duration::from_secs(timeout_hint.unwrap_or(60)),
    )?;
    let resp = match envelope.get("result") {
        Some(r) => r.clone(),
        None => match envelope.get("error") {
            Some(e) => json!({"ok": false, "error": e}),
            None => envelope,
        },
    };
    Ok(resp)
}

fn cdp(tab: Option<i64>, profile: Option<&str>, cdp_method: &str, params: Value) -> Result<Value> {
    let mut p = json!({"method": cdp_method, "params": params});
    if let Some(t) = tab {
        if let Some(o) = p.as_object_mut() {
            o.insert("tab_id".into(), json!(t));
        }
    }
    let socket = crate::socket_client::resolve_socket(profile)?;
    let request = json!({"jsonrpc":"2.0","method":"cdp","params":p});
    let bytes = crate::cli_frame::encode(&request)?;
    let mut stream = crate::socket_client::dial_with_retry(&socket, 3, Duration::from_millis(200))?;
    use std::io::Write;
    stream.write_all(&bytes)?;
    stream.flush()?;
    let envelope = crate::cli_frame::read_response(&mut stream, Duration::from_secs(60))?;
    let resp = match envelope.get("result") {
        Some(r) => r.clone(),
        None => match envelope.get("error") {
            Some(e) => json!({"ok": false, "error": e}),
            None => envelope,
        },
    };
    Ok(resp)
}

fn cdp_eval(tab: Option<i64>, profile: Option<&str>, expression: &str) -> Result<Value> {
    let resp = cdp(
        tab,
        profile,
        "Runtime.evaluate",
        json!({"expression": expression, "returnByValue": true, "awaitPromise": true}),
    )?;
    Ok(resp
        .get("data")
        .and_then(|d| d.get("result"))
        .and_then(|r| r.get("result"))
        .and_then(|r| r.get("value"))
        .cloned()
        .unwrap_or(Value::Null))
}

fn resolve_active_tab_or(args: &[String]) -> Result<Option<i64>> {
    if let Some(t) = extract_tab(args) {
        return Ok(Some(t));
    }
    let socket = crate::socket_client::resolve_socket(extract_profile(args).as_deref())?;
    let request = json!({"jsonrpc":"2.0","method":"info","params":{}});
    let bytes = crate::cli_frame::encode(&request)?;
    let mut stream = crate::socket_client::dial_with_retry(&socket, 3, Duration::from_millis(200))?;
    use std::io::Write;
    stream.write_all(&bytes)?;
    stream.flush()?;
    let envelope = crate::cli_frame::read_response(&mut stream, Duration::from_secs(10))?;
    let at = envelope
        .get("result")
        .and_then(|r| r.get("data"))
        .and_then(|d| d.get("active_tab"));
    Ok(at.and_then(|t| t.get("id")).and_then(|v| v.as_i64()))
}

fn ensure_debugger_attached(tab: Option<i64>, profile: Option<&str>) -> Result<Option<i64>> {
    let tab = match tab {
        Some(t) => t,
        None => match resolve_active_tab_or(&[])? {
            Some(t) => t,
            None => bail!("no active tab; pass --tab <ID>"),
        },
    };
    // Trigger attach via a no-op eval — the SW attaches on any operated command.
    let _ = cdp(
        Some(tab),
        profile,
        "Runtime.evaluate",
        json!({"expression": "1"}),
    );
    Ok(Some(tab))
}

fn print_or_emit(resp: Value, args: &[String]) {
    let want_ndjson = args
        .windows(2)
        .any(|w| w[0] == "--format" && w[1] == "ndjson");
    let human = args.iter().any(|a| a == "--human");
    if human {
        crate::print_human(&resp);
        return;
    }
    if want_ndjson {
        if let Some(data) = resp.get("data") {
            if let Some(arr) = data.as_array() {
                for item in arr {
                    println!("{}", serde_json::to_string(item).unwrap_or_default());
                }
            } else if let Some(items) = data
                .get("messages")
                .and_then(|v| v.as_array())
                .or_else(|| data.get("requests").and_then(|v| v.as_array()))
                .or_else(|| data.get("errors").and_then(|v| v.as_array()))
            {
                for item in items {
                    println!("{}", serde_json::to_string(item).unwrap_or_default());
                }
            } else {
                println!("{}", serde_json::to_string(data).unwrap_or_default());
            }
        } else {
            println!("{}", serde_json::to_string(&resp).unwrap_or_default());
        }
    } else {
        println!("{}", serde_json::to_string(&resp).unwrap_or_default());
    }
}

// ── T1: console / network / errors ─────────────────────────────────────────

fn console_cmd(args: &[String]) -> Result<()> {
    let sub = args.first().map(|s| s.as_str()).unwrap_or("list");
    match sub {
        "list" => {
            let mut params = json!({});
            if let Some(t) = flag_value(args, "--type") {
                params["type"] = json!(t);
            }
            if let Some(s) = flag_value(args, "--since") {
                params["since"] = json!(s);
            }
            let resp = rpc("dev.console.list", params, args)?;
            print_or_emit(resp, args);
        }
        "clear" => {
            let resp = rpc("dev.console.clear", json!({}), args)?;
            print_or_emit(resp, args);
        }
        other => bail!("dev console: unknown subcommand '{other}'. Use: list, clear"),
    }
    Ok(())
}

fn network_cmd(args: &[String]) -> Result<()> {
    let sub = args.first().map(|s| s.as_str()).unwrap_or("list");
    match sub {
        "list" => {
            let mut params = json!({});
            if let Some(f) = flag_value(args, "--filter") {
                params["filter"] = json!(f);
            }
            if let Some(t) = flag_value(args, "--type") {
                params["type"] = json!(t);
            }
            if args.iter().any(|a| a == "--status") {
                if let Some(v) = flag_value(args, "--status") {
                    if v == "failed" {
                        params["failed"] = json!(true);
                    }
                }
            }
            let resp = rpc("dev.network.list", params, args)?;
            print_or_emit(resp, args);
        }
        "get" => {
            let rid = args
                .get(1)
                .ok_or_else(|| anyhow!("usage: dev network get <request_id>"))?;
            let resp = rpc("dev.network.get", json!({"request_id": rid}), args)?;
            print_or_emit(resp, args);
        }
        other => bail!("dev network: unknown subcommand '{other}'. Use: list, get <id>"),
    }
    Ok(())
}

fn errors_cmd(args: &[String]) -> Result<()> {
    let resp = rpc("dev.errors", json!({}), args)?;
    print_or_emit(resp, args);
    Ok(())
}

// ── T2: snapshot / dom / heap ──────────────────────────────────────────────

fn snapshot_cmd(args: &[String]) -> Result<()> {
    let tab = resolve_active_tab_or(args)?;
    let profile = extract_profile(args);
    ensure_debugger_attached(tab, profile.as_deref())?;
    let verbose = args.iter().any(|a| a == "--verbose");
    let limit = flag_value(args, "--limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(200);
    let expr = format!(
        r#"(() => {{
  const INTERACTIVE = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [role="menuitem"], [role="combobox"], [onclick], details > summary';
  const els = document.querySelectorAll(INTERACTIVE);
  const out = [];
  let i = 0;
  for (const el of els) {{
    if (i >= {limit}) break;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const role = el.getAttribute('role') || {{
      A: 'link', BUTTON: 'button', INPUT: el.type || 'textbox',
      SELECT: 'listbox', TEXTAREA: 'textbox', SUMMARY: 'summary',
    }}[el.tagName] || el.tagName.toLowerCase();
    let name = (el.textContent || '').trim().slice(0, 80) || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('alt') || '';
    out.push({{
      uid: 'snap-' + i,
      role,
      name,
      tag: el.tagName.toLowerCase(),
      href: el.href || null,
      focused: el === document.activeElement,
    }});
    i++;
  }}
  return JSON.stringify(out);
}})()"#,
        limit = limit
    );
    let resp = cdp_eval(tab, profile.as_deref(), &expr)?;
    let raw = resp.as_str().unwrap_or("[]");
    let nodes: Vec<Value> = serde_json::from_str(raw).unwrap_or_default();
    let mut out_nodes = nodes;
    if verbose {
        let verbose_expr = r#"(() => {
  const out = [];
  document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],main,nav,aside,header,footer,form').forEach((el, i) => {
    if (i >= 50) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    out.push({
      uid: 'lm-' + i,
      role: el.tagName.toLowerCase().replace(/^h(\d)$/, 'heading'),
      name: (el.textContent || '').trim().slice(0, 80),
      tag: el.tagName.toLowerCase(),
    });
  });
  return JSON.stringify(out);
})()"#;
        let vresp = cdp_eval(tab, profile.as_deref(), verbose_expr)?;
        let vraw = vresp.as_str().unwrap_or("[]");
        let vnodes: Vec<Value> = serde_json::from_str(vraw).unwrap_or_default();
        out_nodes.extend(vnodes);
    }
    let out = json!({"ok": true, "data": {"nodes": out_nodes}});
    print_or_emit(out, args);
    Ok(())
}

fn dom_cmd(args: &[String]) -> Result<()> {
    let selector = args
        .first()
        .filter(|a| !a.starts_with("--"))
        .ok_or_else(|| {
            anyhow!("usage: dev dom <selector> [--computed] [--listeners] [--box-model]")
        })?
        .clone();
    let tab = resolve_active_tab_or(args)?;
    let profile = extract_profile(args);
    ensure_debugger_attached(tab, profile.as_deref())?;
    // Get document + find node by selector
    let doc = cdp(
        tab,
        profile.as_deref(),
        "DOM.getDocument",
        json!({"depth": 0}),
    )?;
    let root_node_id = doc
        .get("data")
        .and_then(|d| d.get("result"))
        .and_then(|r| r.get("root"))
        .and_then(|r| r.get("nodeId"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let sel = cdp(
        tab,
        profile.as_deref(),
        "DOM.querySelector",
        json!({"nodeId": root_node_id, "selector": &selector}),
    )?;
    let node_id = sel
        .get("data")
        .and_then(|d| d.get("result"))
        .and_then(|r| r.get("nodeId"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    if node_id == 0 {
        bail!("selector matched nothing: {selector}");
    }
    let mut out = json!({"selector": selector, "node_id": node_id});
    // Outer HTML
    let outer = cdp(
        tab,
        profile.as_deref(),
        "DOM.getOuterHTML",
        json!({"nodeId": node_id}),
    )?;
    if let Some(html) = outer
        .get("data")
        .and_then(|d| d.get("result"))
        .and_then(|r| r.as_str())
    {
        let truncated = if html.len() > 500 {
            format!("{}...(truncated)", &html[..500])
        } else {
            html.to_string()
        };
        out["outerHTML"] = json!(truncated);
    }
    // Box model
    if args.iter().any(|a| a == "--box-model") {
        if let Ok(bm) = cdp(
            tab,
            profile.as_deref(),
            "DOM.getBoxModel",
            json!({"nodeId": node_id}),
        ) {
            out["box_model"] = bm
                .get("data")
                .and_then(|d| d.get("result"))
                .cloned()
                .unwrap_or(json!({}));
        }
    }
    // Event listeners
    if args.iter().any(|a| a == "--listeners") {
        if let Ok(ls) = cdp(
            tab,
            profile.as_deref(),
            "DOMDebugger.getEventListeners",
            json!({"objectId": node_id}),
        ) {
            out["listeners"] = ls
                .get("data")
                .and_then(|d| d.get("result"))
                .cloned()
                .unwrap_or(json!([]));
        }
    }
    // Computed styles
    if args.iter().any(|a| a == "--computed") {
        if let Ok(rs) = cdp(tab, profile.as_deref(), "CSS.enable", json!({})) {
            let _ = rs;
        }
        if let Ok(cs) = cdp(
            tab,
            profile.as_deref(),
            "CSS.getComputedStyleForNode",
            json!({"nodeId": node_id}),
        ) {
            out["computed"] = cs
                .get("data")
                .and_then(|d| d.get("result"))
                .and_then(|r| r.get("computedStyle"))
                .cloned()
                .unwrap_or(json!([]));
        }
    }
    print_or_emit(json!({"ok": true, "data": out}), args);
    Ok(())
}

fn heap_cmd(args: &[String]) -> Result<()> {
    let sub = args.first().map(|s| s.as_str()).unwrap_or("stats");
    let rest = &args[1..];
    match sub {
        "stats" | "" => heap_stats_cmd(rest),
        other => {
            eprintln!("unknown heap subcommand: {other}");
            eprintln!("available: stats");
            eprintln!("\nNote: full heap snapshot/diff/query not available — chrome.debugger API does not expose HeapProfiler domain.");
            eprintln!(
                "Use `dev heap stats` for memory overview, or `dev perf trace` for CPU profiling."
            );
            std::process::exit(1);
        }
    }
}

fn heap_stats_cmd(args: &[String]) -> Result<()> {
    let tab = match extract_tab(args) {
        Some(t) => Some(t),
        None => resolve_active_tab_or(args)?,
    };
    let profile = extract_profile(args);
    ensure_debugger_attached(tab, profile.as_deref())?;
    let out_file = flag_value(args, "--out");
    let _ = cdp(tab, profile.as_deref(), "Performance.enable", json!({}));
    let metrics_resp = cdp(tab, profile.as_deref(), "Performance.getMetrics", json!({}))?;
    let metrics = metrics_resp
        .get("data")
        .and_then(|d| d.get("result"))
        .and_then(|r| r.get("metrics"))
        .and_then(|m| m.as_array())
        .cloned()
        .unwrap_or_default();
    let get_metric = |name: &str| -> Option<i64> {
        metrics
            .iter()
            .find(|m| m.get("name").and_then(|v| v.as_str()) == Some(name))
            .and_then(|m| m.get("value"))
            .and_then(|v| v.as_f64())
            .map(|f| f as i64)
    };
    let mut out = json!({
        "used_js_heap_bytes": get_metric("JSHeapUsedSize"),
        "total_js_heap_bytes": get_metric("JSHeapTotalSize"),
        "nodes": get_metric("Nodes"),
        "js_event_listeners": get_metric("JSEventListeners"),
        "documents": get_metric("Documents"),
        "script_duration_ms": get_metric("ScriptDuration").map(|v| ((v as f64) * 1000.0) as i64),
    });
    if let Some(path) = out_file {
        std::fs::write(path, serde_json::to_string_pretty(&out)?)?;
        out["file"] = json!(path);
    }
    print_or_emit(json!({"ok": true, "data": out}), args);
    Ok(())
}

// ── T2: perf / lighthouse ──────────────────────────────────────────────────

fn perf_cmd(args: &[String]) -> Result<()> {
    let sub = args.first().map(|s| s.as_str()).unwrap_or("metrics");
    match sub {
        "metrics" => {
            let tab = resolve_active_tab_or(args)?;
            ensure_debugger_attached(tab, extract_profile(args).as_deref())?;
            let resp = cdp(
                tab,
                extract_profile(args).as_deref(),
                "Performance.getMetrics",
                json!({}),
            )?;
            let metrics = resp
                .get("data")
                .and_then(|d| d.get("result"))
                .and_then(|r| r.get("metrics"))
                .cloned()
                .unwrap_or(json!([]));
            print_or_emit(json!({"ok": true, "data": {"metrics": metrics}}), args);
        }
        "trace" => {
            let tab = resolve_active_tab_or(args)?;
            let profile = extract_profile(args);
            ensure_debugger_attached(tab, profile.as_deref())?;
            let want_reload = args.iter().any(|a| a == "--reload");
            if want_reload {
                let _ = cdp(tab, profile.as_deref(), "Page.enable", json!({}));
                let _ = cdp(tab, profile.as_deref(), "Page.reload", json!({}));
                std::thread::sleep(Duration::from_millis(1500));
            }
            // Use Performance domain + observe long tasks via JS
            let _ = cdp(tab, profile.as_deref(), "Performance.enable", json!({}));
            let dur_s: u64 = flag_value(args, "--duration")
                .and_then(|s| s.parse().ok())
                .unwrap_or(3);
            std::thread::sleep(Duration::from_secs(dur_s));
            // Collect web vitals via JS
            let vitals_expr = r#"(()=>{
                const obs = performance.getEntriesByType('navigation')[0] || {};
                const paintEntries = performance.getEntriesByType('paint');
                const fcp = paintEntries.find(p => p.name === 'first-contentful-paint')?.startTime || null;
                return JSON.stringify({
                    domContentLoaded: obs.domContentLoadedEventEnd || null,
                    loadEvent: obs.loadEventEnd || null,
                    responseStart: obs.responseStart || null,
                    fcp_ms: fcp,
                    ttfb_ms: obs.responseStart || null,
                });
            })()"#;
            let v = cdp_eval(tab, profile.as_deref(), vitals_expr)?;
            let v_str = v.as_str().unwrap_or("{}");
            let vitals: Value = serde_json::from_str(v_str).unwrap_or(json!({}));
            let metrics_resp = cdp(tab, profile.as_deref(), "Performance.getMetrics", json!({}))?;
            let metrics = metrics_resp
                .get("data")
                .and_then(|d| d.get("result"))
                .and_then(|r| r.get("metrics"))
                .cloned()
                .unwrap_or(json!([]));
            print_or_emit(
                json!({"ok": true, "data": {"vitals": vitals, "metrics": metrics}}),
                args,
            );
        }
        other => bail!("dev perf: unknown subcommand '{other}'. Use: metrics, trace"),
    }
    Ok(())
}

fn lighthouse_cmd(args: &[String]) -> Result<()> {
    let url_from_flag = flag_value(args, "--url").map(String::from);
    let categories = flag_value(args, "--categories").unwrap_or("accessibility,best-practices,seo");
    let url = match url_from_flag {
        Some(u) => u,
        None => {
            let socket = crate::socket_client::resolve_socket(extract_profile(args).as_deref())?;
            let request = json!({"jsonrpc":"2.0","method":"info","params":{}});
            let bytes = crate::cli_frame::encode(&request)?;
            let mut stream =
                crate::socket_client::dial_with_retry(&socket, 3, Duration::from_millis(200))?;
            use std::io::Write;
            stream.write_all(&bytes)?;
            stream.flush()?;
            let env = crate::cli_frame::read_response(&mut stream, Duration::from_secs(10))?;
            env.get("result")
                .and_then(|r| r.get("data"))
                .and_then(|d| d.get("active_tab"))
                .and_then(|t| t.get("url"))
                .and_then(|u| u.as_str())
                .map(String::from)
                .ok_or_else(|| anyhow!("no --url given and no active tab URL available"))?
        }
    };
    let out = std::process::Command::new("npx")
        .arg("--yes")
        .arg("lighthouse")
        .arg(&url)
        .arg("--output")
        .arg("json")
        .arg("--only-categories")
        .arg(categories)
        .arg("--chrome-flags=--headless=new --no-sandbox")
        .arg("--quiet")
        .output()
        .context("failed to run `npx lighthouse`; install with `npm install -g lighthouse`")?;
    if !out.status.success() {
        bail!(
            "lighthouse failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    let lh_json: Value =
        serde_json::from_slice(&out.stdout).context("lighthouse did not produce JSON output")?;
    let categories_top = lh_json.get("categories").cloned().unwrap_or(json!({}));
    let mut cat_scores = serde_json::Map::new();
    if let Some(obj) = categories_top.as_object() {
        for (k, v) in obj {
            let audit_refs = v.get("auditRefs").and_then(|a| a.as_array());
            let mut total_score: f64 = 0.0;
            let mut count: f64 = 0.0;
            if let Some(audits) = lh_json.get("audits").and_then(|a| a.as_object()) {
                if let Some(refs) = audit_refs {
                    for r in refs {
                        if let (Some(weight), Some(aid)) = (
                            r.get("weight").and_then(|w| w.as_f64()),
                            r.get("id").and_then(|i| i.as_str()),
                        ) {
                            if let Some(audit) = audits.get(aid) {
                                if let Some(s) = audit.get("score").and_then(|s| s.as_f64()) {
                                    total_score += s * weight;
                                    count += weight;
                                }
                            }
                        }
                    }
                }
            }
            let normalized = if count > 0.0 {
                total_score / count
            } else {
                0.0
            };
            cat_scores.insert(
                k.clone(),
                json!({
                    "title": v.get("title").and_then(|t| t.as_str()).unwrap_or(k),
                    "score": (normalized * 100.0).round() as u64,
                }),
            );
        }
    }
    print_or_emit(
        json!({
            "ok": true,
            "data": {
                "url": url,
                "categories_requested": categories,
                "scores": cat_scores,
                "raw": lh_json,
            }
        }),
        args,
    );
    Ok(())
}

// ── T3: emulate ────────────────────────────────────────────────────────────

fn emulate_cmd(args: &[String]) -> Result<()> {
    let sub = args.first().map(|s| s.as_str()).unwrap_or("");
    let rest = &args[1..];
    let tab = resolve_active_tab_or(args)?;
    let profile = extract_profile(args);
    ensure_debugger_attached(tab, profile.as_deref())?;
    match sub {
        "dark" => {
            let r = cdp(tab, profile.as_deref(), "Emulation.setEmulatedMedia", json!({"features": [{"name": "prefers-color-scheme", "value": "dark"}]}))?;
            print_or_emit(r, args);
        }
        "light" => {
            let r = cdp(tab, profile.as_deref(), "Emulation.setEmulatedMedia", json!({"features": [{"name": "prefers-color-scheme", "value": "light"}]}))?;
            print_or_emit(r, args);
        }
        "auto" => {
            let r = cdp(tab, profile.as_deref(), "Emulation.setEmulatedMedia", json!({"features": []}))?;
            print_or_emit(r, args);
        }
        "viewport" => {
            let dims = rest.first().ok_or_else(|| anyhow!("usage: dev emulate viewport <W>x<H> [--device-pixel-ratio <r>] [--mobile]"))?;
            let parts: Vec<&str> = dims.split('x').collect();
            if parts.len() != 2 { bail!("viewport format: WxH, e.g. 375x667"); }
            let w: u32 = parts[0].parse().context("invalid width")?;
            let h: u32 = parts[1].parse().context("invalid height")?;
            let dpr: f64 = flag_value(args, "--device-pixel-ratio").and_then(|s| s.parse().ok()).unwrap_or(1.0);
            let mobile = args.iter().any(|a| a == "--mobile");
            let mut params = json!({
                "width": w, "height": h, "deviceScaleFactor": dpr,
                "mobile": mobile,
            });
            if mobile { params["touch"] = json!(true); }
            let r = cdp(tab, profile.as_deref(), "Emulation.setDeviceMetricsOverride", params)?;
            print_or_emit(r, args);
        }
        "geo" => {
            let coords = rest.first().ok_or_else(|| anyhow!("usage: dev emulate geo <lat>,<lng>"))?;
            let parts: Vec<&str> = coords.split(',').collect();
            if parts.len() != 2 { bail!("format: lat,lng, e.g. 40.7128,-74.0060"); }
            let lat: f64 = parts[0].parse()?;
            let lng: f64 = parts[1].parse()?;
            let r = cdp(tab, profile.as_deref(), "Emulation.setGeolocationOverride", json!({"latitude": lat, "longitude": lng, "accuracy": 1}))?;
            print_or_emit(r, args);
        }
        "network" => {
            let preset = rest.first().map(|s| s.as_str()).unwrap_or("");
            let (offline, dl, ul, lat) = match preset {
                "offline" => (true, 0, 0, 0),
                "slow3g" => (false, 400_000, 400_000, 400),
                "fast3g" => (false, 1_500_000, 750_000, 150),
                "slow4g" => (false, 4_000_000, 3_000_000, 100),
                "fast4g" => (false, 10_000_000, 5_000_000, 40),
                other => bail!("unknown network preset '{other}'. Use: offline, slow3g, fast3g, slow4g, fast4g"),
            };
            let r = cdp(tab, profile.as_deref(), "Network.emulateNetworkConditions", json!({
                "offline": offline, "downloadThroughput": dl, "uploadThroughput": ul, "latency": lat
            }))?;
            print_or_emit(r, args);
        }
        "cpu" => {
            let rate: f64 = rest.first().ok_or_else(|| anyhow!("usage: dev emulate cpu <rate>"))?.parse()?;
            if rate < 1.0 { bail!("cpu rate must be >= 1.0"); }
            let r = cdp(tab, profile.as_deref(), "Emulation.setCPUThrottlingRate", json!({"rate": rate}))?;
            print_or_emit(r, args);
        }
        "ua" => {
            let ua = rest.first().ok_or_else(|| anyhow!("usage: dev emulate ua <string>"))?;
            let r = cdp(tab, profile.as_deref(), "Emulation.setUserAgentOverride", json!({"userAgent": ua}))?;
            print_or_emit(r, args);
        }
        "headers" => {
            let json_str = rest.first().ok_or_else(|| anyhow!("usage: dev emulate headers '<json>'"))?;
            let headers: Value = serde_json::from_str(json_str).context("invalid JSON headers")?;
            let r = cdp(tab, profile.as_deref(), "Network.setExtraHTTPHeaders", json!({"headers": headers}))?;
            print_or_emit(r, args);
        }
        "reset" => {
            let _ = cdp(tab, profile.as_deref(), "Emulation.setEmulatedMedia", json!({"features": []}));
            let _ = cdp(tab, profile.as_deref(), "Emulation.clearDeviceMetricsOverride", json!({}));
            let _ = cdp(tab, profile.as_deref(), "Emulation.clearGeolocationOverride", json!({}));
            let _ = cdp(tab, profile.as_deref(), "Network.emulateNetworkConditions", json!({"offline": false, "downloadThroughput": -1, "uploadThroughput": -1, "latency": 0}));
            let _ = cdp(tab, profile.as_deref(), "Emulation.setCPUThrottlingRate", json!({"rate": 1}));
            let _ = cdp(tab, profile.as_deref(), "Emulation.setUserAgentOverride", json!({"userAgent": ""}));
            let _ = cdp(tab, profile.as_deref(), "Network.setExtraHTTPHeaders", json!({"headers": {}}));
            print_or_emit(json!({"ok": true, "data": {"reset": true}}), args);
        }
        other => bail!("dev emulate: unknown subcommand '{other}'. Use: dark, light, auto, viewport, geo, network, cpu, ua, headers, reset"),
    }
    Ok(())
}

// ── T4: hover / drag / fill-form / upload / dialog ─────────────────────────

fn hover_cmd(args: &[String]) -> Result<()> {
    let selector = args
        .first()
        .filter(|a| !a.starts_with("--"))
        .ok_or_else(|| anyhow!("usage: dev hover <selector>"))?;
    let tab = resolve_active_tab_or(args)?;
    let profile = extract_profile(args);
    ensure_debugger_attached(tab, profile.as_deref())?;
    // scrollIntoView + getBoundingClientRect via eval
    let rect_expr = format!("((el)=>{{if(!el)return null;el.scrollIntoView({{block:'center'}});const r=el.getBoundingClientRect();return{{x:r.x+r.width/2,y:r.y+r.height/2}}}})(document.querySelector({}))", json!(selector));
    let rect = cdp_eval(tab, profile.as_deref(), &rect_expr)?;
    let x = rect.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let y = rect.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let _ = cdp(
        tab,
        profile.as_deref(),
        "Input.dispatchMouseEvent",
        json!({"type": "mouseMoved", "x": x, "y": y}),
    );
    print_or_emit(
        json!({"ok": true, "data": {"hovered": selector, "at": { "x": x, "y": y }}}),
        args,
    );
    Ok(())
}

fn drag_cmd(args: &[String]) -> Result<()> {
    let pos: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
    if pos.len() < 2 {
        bail!("usage: dev drag <from_selector> <to_selector>");
    }
    let from_sel = pos[0];
    let to_sel = pos[1];
    let tab = resolve_active_tab_or(args)?;
    let profile = extract_profile(args);
    ensure_debugger_attached(tab, profile.as_deref())?;
    let mk_expr = |sel: &str| {
        format!("((el)=>{{if(!el)return null;el.scrollIntoView({{block:'center'}});const r=el.getBoundingClientRect();return{{x:r.x+r.width/2,y:r.y+r.height/2}}}})(document.querySelector({}))", json!(sel))
    };
    let fr = cdp_eval(tab, profile.as_deref(), &mk_expr(from_sel))?;
    let tr = cdp_eval(tab, profile.as_deref(), &mk_expr(to_sel))?;
    let fx = fr.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let fy = fr.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let tx = tr.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let ty = tr.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let _ = cdp(
        tab,
        profile.as_deref(),
        "Input.dispatchMouseEvent",
        json!({"type": "mousePressed", "x": fx, "y": fy, "button": "left", "clickCount": 1}),
    );
    // Interpolate a few move events
    for i in 1..=5 {
        let t = i as f64 / 5.0;
        let _ = cdp(
            tab,
            profile.as_deref(),
            "Input.dispatchMouseEvent",
            json!({"type": "mouseMoved", "x": fx + (tx - fx) * t, "y": fy + (ty - fy) * t}),
        );
    }
    let _ = cdp(
        tab,
        profile.as_deref(),
        "Input.dispatchMouseEvent",
        json!({"type": "mouseReleased", "x": tx, "y": ty, "button": "left", "clickCount": 1}),
    );
    print_or_emit(
        json!({"ok": true, "data": {"dragged": {"from": from_sel, "to": to_sel}}}),
        args,
    );
    Ok(())
}

fn fill_form_cmd(args: &[String]) -> Result<()> {
    let json_str = args
        .first()
        .filter(|a| !a.starts_with("--"))
        .ok_or_else(|| anyhow!("usage: dev fill-form '<json>'"))?;
    let map: Value = serde_json::from_str(json_str).context("invalid JSON for fill-form")?;
    let obj = map
        .as_object()
        .ok_or_else(|| anyhow!("fill-form JSON must be an object of selector to value"))?;
    let tab = resolve_active_tab_or(args)?;
    let profile = extract_profile(args);
    ensure_debugger_attached(tab, profile.as_deref())?;
    let mut filled = Vec::new();
    for (sel, val) in obj {
        let value_str = match val {
            Value::Bool(b) => b.to_string(),
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        let is_checkbox = matches!(val, Value::Bool(_));
        let expr = if is_checkbox {
            format!("((el,v)=>{{if(!el)return false;if(v)el.checked=true;else el.checked=false;el.dispatchEvent(new Event('change',{{bubbles:true}}));return true}})(document.querySelector({}),{})", json!(sel), val)
        } else {
            format!("((el,v)=>{{if(!el)return false;el.focus();el.value=v;el.dispatchEvent(new Event('input',{{bubbles:true}}));el.dispatchEvent(new Event('change',{{bubbles:true}}));return true}})(document.querySelector({}),{})", json!(sel), json!(value_str))
        };
        let r = cdp_eval(tab, profile.as_deref(), &expr)?;
        let ok = r.as_bool().unwrap_or(false);
        filled.push(json!({"selector": sel, "ok": ok}));
    }
    print_or_emit(json!({"ok": true, "data": {"filled": filled}}), args);
    Ok(())
}

fn upload_cmd(args: &[String]) -> Result<()> {
    let pos: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
    if pos.len() < 2 {
        bail!("usage: dev upload <selector> <filepath>");
    }
    let selector = pos[0];
    let filepath =
        std::fs::canonicalize(pos[1]).with_context(|| format!("file not found: {}", pos[1]))?;
    let tab = resolve_active_tab_or(args)?;
    let profile = extract_profile(args);
    ensure_debugger_attached(tab, profile.as_deref())?;
    // Resolve selector to backend nodeId
    let doc = cdp(
        tab,
        profile.as_deref(),
        "DOM.getDocument",
        json!({"depth": 0}),
    )?;
    let root_node_id = doc
        .get("data")
        .and_then(|d| d.get("result"))
        .and_then(|r| r.get("root"))
        .and_then(|r| r.get("nodeId"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let sel = cdp(
        tab,
        profile.as_deref(),
        "DOM.querySelector",
        json!({"nodeId": root_node_id, "selector": selector}),
    )?;
    let node_id = sel
        .get("data")
        .and_then(|d| d.get("result"))
        .and_then(|r| r.get("nodeId"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    if node_id == 0 {
        bail!("selector matched nothing: {selector}");
    }
    let r = cdp(
        tab,
        profile.as_deref(),
        "DOM.setFileInputFiles",
        json!({"nodeId": node_id, "files": [filepath.to_string_lossy()]}),
    )?;
    print_or_emit(r, args);
    Ok(())
}

fn dialog_cmd(args: &[String]) -> Result<()> {
    let action = args.first().map(|s| s.as_str()).unwrap_or("accept");
    let profile = extract_profile(args);
    let tab = resolve_active_tab_or(args)?;
    ensure_debugger_attached(tab, profile.as_deref())?;
    let accept = match action {
        "accept" => true,
        "dismiss" => false,
        other => bail!("dev dialog: unknown action '{other}'. Use: accept, dismiss"),
    };
    let mut params = json!({"accept": accept});
    if let Some(text) = args.get(1).filter(|a| !a.starts_with("--")) {
        params["promptText"] = json!(text);
    }
    let r = cdp(
        tab,
        profile.as_deref(),
        "Page.handleJavaScriptDialog",
        params,
    )?;
    print_or_emit(r, args);
    Ok(())
}

fn flag_value<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.windows(2)
        .find(|w| w[0] == flag)
        .and_then(|w| w[1].as_str().into())
        .map(|s: &str| s)
}

fn extension_cmd(args: &[String]) -> Result<()> {
    let sub = args.first().map(|s| s.as_str()).unwrap_or("");
    let rest = &args[1..];
    match sub {
        "list" => {
            let r = rpc("dev.extension.list", json!({}), rest)?;
            print_or_emit(r, args);
            Ok(())
        }
        "get" => {
            let id = rest
                .iter()
                .find(|a| !a.starts_with("--"))
                .ok_or_else(|| anyhow!("usage: dev extension get <id>"))?;
            let r = rpc("dev.extension.get", json!({"id": id}), rest)?;
            print_or_emit(r, args);
            Ok(())
        }
        "reload" => {
            let id = rest.iter().find(|a| !a.starts_with("--"));
            let params = match id {
                Some(i) => json!({"id": i}),
                None => json!({}),
            };
            let r = rpc("dev.extension.reload", params, rest)?;
            print_or_emit(r, args);
            Ok(())
        }
        "enable" => {
            let id = rest
                .iter()
                .find(|a| !a.starts_with("--"))
                .ok_or_else(|| anyhow!("usage: dev extension enable <id>"))?;
            let r = rpc("dev.extension.enable", json!({"id": id}), rest)?;
            print_or_emit(r, args);
            Ok(())
        }
        "disable" => {
            let id = rest
                .iter()
                .find(|a| !a.starts_with("--"))
                .ok_or_else(|| anyhow!("usage: dev extension disable <id>"))?;
            let r = rpc("dev.extension.disable", json!({"id": id}), rest)?;
            print_or_emit(r, args);
            Ok(())
        }
        "uninstall" => {
            let id = rest
                .iter()
                .find(|a| !a.starts_with("--"))
                .ok_or_else(|| anyhow!("usage: dev extension uninstall <id>"))?;
            let r = rpc("dev.extension.uninstall", json!({"id": id}), rest)?;
            print_or_emit(r, args);
            Ok(())
        }
        "" => {
            eprintln!("Usage: ap-browser dev extension <list|get <id>|reload [id]|enable <id>|disable <id>|uninstall <id>>");
            std::process::exit(1);
        }
        other => {
            eprintln!("unknown extension subcommand: {other}\navailable: list, get, reload, enable, disable, uninstall");
            std::process::exit(1);
        }
    }
}

fn api_cmd(args: &[String]) -> Result<()> {
    let positionals: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
    if positionals.len() < 2 {
        eprintln!("Usage: ap-browser dev api <METHOD> <URL> [--body '<json>'] [--header 'K: V']... [--expect-status N] [--tab T]");
        eprintln!("\nExamples:");
        eprintln!("  ap-browser dev api GET /api/profile --tab 123");
        eprintln!("  ap-browser dev api POST /api/login --body '{{\"email\":\"a@b.c\"}}' --expect-status 201");
        eprintln!("  ap-browser dev api GET https://api.github.com/user --header 'Accept: application/json'");
        std::process::exit(1);
    }
    let method = positionals[0].to_uppercase();
    let url = positionals[1].clone();
    let body = flag_value(args, "--body");
    let expect_status = flag_value(args, "--expect-status").and_then(|s| s.parse::<u16>().ok());
    let human = args.iter().any(|a| a == "--human");

    // Collect headers (may repeat; scan manually for multi-value)
    let mut headers: Vec<(String, String)> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--header" || args[i] == "-H" {
            if let Some(val) = args.get(i + 1) {
                if let Some(idx) = val.find(':') {
                    let k = val[..idx].trim().to_string();
                    let v = val[idx + 1..].trim().to_string();
                    headers.push((k, v));
                }
            }
            i += 2;
        } else {
            i += 1;
        }
    }

    // Build fetch() JS template. new URL(url, location.origin) resolves relative paths against the tab's origin.
    let has_body = body.is_some();
    let body_js = match body {
        Some(b) => json_escape_as_js_string(b).to_string(),
        None => "undefined".to_string(),
    };
    let headers_js = {
        let pairs: Vec<String> = headers
            .iter()
            .map(|(k, v)| {
                format!(
                    "{}: {}",
                    json_escape_as_js_string(k),
                    json_escape_as_js_string(v)
                )
            })
            .collect();
        format!("{{{}}}", pairs.join(", "))
    };

    let js = format!(
        r#"
(async () => {{
  const url = new URL({url_expr}, location.origin);
  const opts = {{ method: {method_expr}, headers: {headers_js}, credentials: 'include' }};
  if ({has_body_expr}) opts.body = {body_js};
  let resp;
  const timing = {{ start: performance.now() }};
  try {{
    resp = await fetch(url.href, opts);
  }} catch (e) {{
    return {{ error: 'fetch_failed', message: e.message, url: url.href }};
  }}
  timing.end = performance.now();
  const text = await resp.text();
  let json = null;
  try {{ json = JSON.parse(text); }} catch (_) {{}}
  const respHeaders = {{}};
  resp.headers.forEach((v, k) => {{ respHeaders[k] = v }});
  return {{
    status: resp.status,
    statusText: resp.statusText,
    ok: resp.ok,
    url: resp.url,
    headers: respHeaders,
    body: text.slice(0, 10000),
    bodyTruncated: text.length > 10000,
    bodyLength: text.length,
    json: json,
    timingMs: Math.round(timing.end - timing.start),
  }};
}})()
"#,
        url_expr = json_escape_as_js_string(&url),
        method_expr = json_escape_as_js_string(&method),
        headers_js = headers_js,
        has_body_expr = if has_body { "true" } else { "false" },
        body_js = body_js,
    );

    let tab = extract_tab(args);
    let profile = extract_profile(args);
    let actual_tab = ensure_debugger_attached(tab, profile.as_deref())?;
    let result = cdp_eval(actual_tab, profile.as_deref(), &js)?;

    let want_json = !human;
    if let Some(err) = result.get("error").and_then(|e| e.as_str()) {
        if err == "fetch_failed" {
            let msg = result
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("unknown");
            eprintln!("✗ fetch failed: {}", msg);
            if let Some(u) = result.get("url").and_then(|u| u.as_str()) {
                eprintln!("  url: {}", u);
            }
            std::process::exit(1);
        }
    }

    let status = result.get("status").and_then(|s| s.as_u64()).unwrap_or(0) as u16;
    let timing = result.get("timingMs").and_then(|t| t.as_u64()).unwrap_or(0);
    let status_pass = match expect_status {
        Some(exp) => status == exp,
        None => true,
    };

    if want_json {
        let mut out = result.clone();
        if let Some(obj) = out.as_object_mut() {
            if let Some(exp) = expect_status {
                obj.insert("expect_status".into(), json!(exp));
                obj.insert("expect_pass".into(), json!(status_pass));
            }
        }
        println!("{}", serde_json::to_string(&out)?);
    } else {
        let st = if (200..300).contains(&status) {
            "✓"
        } else if status >= 400 {
            "✗"
        } else {
            "·"
        };
        println!(
            "{} HTTP {} {} ({}ms, {} bytes)",
            st,
            status,
            result
                .get("statusText")
                .and_then(|s| s.as_str())
                .unwrap_or(""),
            timing,
            result
                .get("bodyLength")
                .and_then(|l| l.as_u64())
                .unwrap_or(0)
        );
        if let Some(h) = result.get("headers").and_then(|h| h.as_object()) {
            for (k, v) in h.iter().take(15) {
                println!("  {}: {}", k, v.as_str().unwrap_or(""));
            }
        }
        println!();
        if let Some(j) = result.get("json").filter(|j| !j.is_null()) {
            println!("{}", serde_json::to_string_pretty(j)?);
        } else if let Some(t) = result.get("body").and_then(|b| b.as_str()) {
            println!("{}", t);
        }
        if let Some(exp) = expect_status {
            println!();
            if status_pass {
                println!("✓ expect-status {}: PASS", exp);
            } else {
                println!("✗ expect-status {}: FAIL (got {})", exp, status);
            }
        }
    }
    if !status_pass {
        std::process::exit(1);
    }
    Ok(())
}

fn json_escape_as_js_string(s: &str) -> String {
    let json =
        serde_json::to_string(s).unwrap_or_else(|_| format!("\"{}\"", s.replace('"', "\\\"")));
    json
}

fn cookies_cmd(args: &[String]) -> Result<()> {
    let sub = args.first().map(|s| s.as_str()).unwrap_or("");
    let rest = &args[1..];
    match sub {
        "list" => {
            let mut params = json!({});
            if let Some(d) = flag_value(rest, "--domain") {
                params["domain"] = json!(d);
            }
            if let Some(u) = flag_value(rest, "--url") {
                params["url"] = json!(u);
            }
            if let Some(n) = flag_value(rest, "--name") {
                params["name"] = json!(n);
            }
            let r = rpc("dev.cookies.list", params, rest)?;
            print_or_emit(r, args);
            Ok(())
        }
        "get" => {
            let url = flag_value(rest, "--url")
                .ok_or_else(|| anyhow!("usage: dev cookies get --url <url> --name <name>"))?;
            let name = flag_value(rest, "--name")
                .ok_or_else(|| anyhow!("usage: dev cookies get --url <url> --name <name>"))?;
            let r = rpc("dev.cookies.get", json!({"url": url, "name": name}), rest)?;
            print_or_emit(r, args);
            Ok(())
        }
        "set" => {
            let url = flag_value(rest, "--url").ok_or_else(|| anyhow!("usage: dev cookies set --url <url> --name <n> --value <v> [--domain D] [--path P] [--secure] [--httpOnly] [--sameSite Lax|Strict|None] [--expirationDate TS]"))?;
            let name = flag_value(rest, "--name").ok_or_else(|| anyhow!("--name required"))?;
            let value = flag_value(rest, "--value").ok_or_else(|| anyhow!("--value required"))?;
            let mut params = json!({"url": url, "name": name, "value": value});
            if let Some(d) = flag_value(rest, "--domain") {
                params["domain"] = json!(d);
            }
            if let Some(p) = flag_value(rest, "--path") {
                params["path"] = json!(p);
            }
            if rest.iter().any(|a| a == "--secure") {
                params["secure"] = json!(true);
            }
            if rest.iter().any(|a| a == "--httpOnly") {
                params["httpOnly"] = json!(true);
            }
            if let Some(s) = flag_value(rest, "--sameSite") {
                params["sameSite"] = json!(s);
            }
            if let Some(e) =
                flag_value(rest, "--expirationDate").and_then(|s| s.parse::<f64>().ok())
            {
                params["expirationDate"] = json!(e);
            }
            let r = rpc("dev.cookies.set", params, rest)?;
            print_or_emit(r, args);
            Ok(())
        }
        "delete" => {
            let url = flag_value(rest, "--url")
                .ok_or_else(|| anyhow!("usage: dev cookies delete --url <url> --name <name>"))?;
            let name = flag_value(rest, "--name").ok_or_else(|| anyhow!("--name required"))?;
            let r = rpc(
                "dev.cookies.delete",
                json!({"url": url, "name": name}),
                rest,
            )?;
            print_or_emit(r, args);
            Ok(())
        }
        "" => {
            eprintln!("Usage: ap-browser dev cookies <list|get|set|delete>");
            eprintln!("  list [--domain D|--url U|--name N]");
            eprintln!("  get --url U --name N");
            eprintln!("  set --url U --name N --value V [--domain D] [--path P] [--secure] [--httpOnly] [--sameSite Lax|Strict|None] [--expirationDate TS]");
            eprintln!("  delete --url U --name N");
            std::process::exit(1);
        }
        other => {
            eprintln!("unknown cookies subcommand: {other}\navailable: list, get, set, delete");
            std::process::exit(1);
        }
    }
}

fn storage_cmd(args: &[String]) -> Result<()> {
    let sub = args.first().map(|s| s.as_str()).unwrap_or("");
    let rest = &args[1..];
    match sub {
        "list" | "" => {
            let store = flag_value(rest, "--type")
                .or_else(|| flag_value(rest, "--store"))
                .unwrap_or("local");
            let js = match store {
                "local" => r#"(() => {
                    const out = {};
                    for (let i = 0; i < localStorage.length; i++) {
                        const k = localStorage.key(i);
                        const v = localStorage.getItem(k);
                        out[k] = v.length > 500 ? v.slice(0, 500) + '...[truncated]' : v;
                    }
                    return { store: 'local', entries: out, count: Object.keys(out).length };
                })()"#.to_string(),
                "session" => r#"(() => {
                    const out = {};
                    for (let i = 0; i < sessionStorage.length; i++) {
                        const k = sessionStorage.key(i);
                        const v = sessionStorage.getItem(k);
                        out[k] = v.length > 500 ? v.slice(0, 500) + '...[truncated]' : v;
                    }
                    return { store: 'session', entries: out, count: Object.keys(out).length };
                })()"#.to_string(),
                "indexed" | "indexeddb" => r#"(async () => {
                    if (!indexedDB.databases) return { store: 'indexed', databases: [], note: 'indexedDB.databases() not supported in this context' };
                    const dbs = await indexedDB.databases();
                    return { store: 'indexed', databases: dbs.map(d => ({ name: d.name, version: d.version })), count: dbs.length };
                })()"#.to_string(),
                other => return Err(anyhow!("unknown --type: {} (use local|session|indexed)", other)),
            };
            let tab = match extract_tab(args) {
                Some(t) => Some(t),
                None => resolve_active_tab_or(rest)?,
            };
            let profile = extract_profile(args).or_else(|| extract_profile(rest));
            let result = cdp_eval(tab, profile.as_deref(), &js)?;
            println!("{}", serde_json::to_string(&result)?);
            Ok(())
        }
        "get" => {
            let key = rest
                .iter()
                .find(|a| !a.starts_with("--"))
                .ok_or_else(|| anyhow!("usage: dev storage get <key> [--type local|session]"))?;
            let store = flag_value(rest, "--type")
                .or_else(|| flag_value(rest, "--store"))
                .unwrap_or("local");
            let js = match store {
                "local" => format!(
                    r#"(() => {{ const v = localStorage.getItem({}); return {{ key: {}, value: v, exists: v !== null }}; }})()"#,
                    json_escape_as_js_string(key),
                    json_escape_as_js_string(key)
                ),
                "session" => format!(
                    r#"(() => {{ const v = sessionStorage.getItem({}); return {{ key: {}, value: v, exists: v !== null }}; }})()"#,
                    json_escape_as_js_string(key),
                    json_escape_as_js_string(key)
                ),
                other => {
                    return Err(anyhow!(
                        "get not supported for store type: {} (use local|session)",
                        other
                    ))
                }
            };
            let tab = match extract_tab(args) {
                Some(t) => Some(t),
                None => resolve_active_tab_or(rest)?,
            };
            let profile = extract_profile(args).or_else(|| extract_profile(rest));
            let result = cdp_eval(tab, profile.as_deref(), &js)?;
            println!("{}", serde_json::to_string(&result)?);
            Ok(())
        }
        "set" => {
            let key = rest.iter().find(|a| !a.starts_with("--")).ok_or_else(|| {
                anyhow!("usage: dev storage set <key> --value <v> [--type local|session]")
            })?;
            let value = flag_value(rest, "--value").ok_or_else(|| anyhow!("--value required"))?;
            let store = flag_value(rest, "--type")
                .or_else(|| flag_value(rest, "--store"))
                .unwrap_or("local");
            let js = match store {
                "local" => format!(
                    r#"(() => {{ localStorage.setItem({}, {}); return {{ set: true, key: {} }}; }})()"#,
                    json_escape_as_js_string(key),
                    json_escape_as_js_string(value),
                    json_escape_as_js_string(key)
                ),
                "session" => format!(
                    r#"(() => {{ sessionStorage.setItem({}, {}); return {{ set: true, key: {} }}; }})()"#,
                    json_escape_as_js_string(key),
                    json_escape_as_js_string(value),
                    json_escape_as_js_string(key)
                ),
                other => return Err(anyhow!("set not supported for store type: {}", other)),
            };
            let tab = match extract_tab(args) {
                Some(t) => Some(t),
                None => resolve_active_tab_or(rest)?,
            };
            let profile = extract_profile(args).or_else(|| extract_profile(rest));
            let result = cdp_eval(tab, profile.as_deref(), &js)?;
            println!("{}", serde_json::to_string(&result)?);
            Ok(())
        }
        "remove" | "delete" => {
            let key = rest
                .iter()
                .find(|a| !a.starts_with("--"))
                .ok_or_else(|| anyhow!("usage: dev storage remove <key> [--type local|session]"))?;
            let store = flag_value(rest, "--type")
                .or_else(|| flag_value(rest, "--store"))
                .unwrap_or("local");
            let js = match store {
                "local" => format!(
                    r#"(() => {{ localStorage.removeItem({}); return {{ removed: true, key: {} }}; }})()"#,
                    json_escape_as_js_string(key),
                    json_escape_as_js_string(key)
                ),
                "session" => format!(
                    r#"(() => {{ sessionStorage.removeItem({}); return {{ removed: true, key: {} }}; }})()"#,
                    json_escape_as_js_string(key),
                    json_escape_as_js_string(key)
                ),
                other => return Err(anyhow!("remove not supported for store type: {}", other)),
            };
            let tab = match extract_tab(args) {
                Some(t) => Some(t),
                None => resolve_active_tab_or(rest)?,
            };
            let profile = extract_profile(args).or_else(|| extract_profile(rest));
            let result = cdp_eval(tab, profile.as_deref(), &js)?;
            println!("{}", serde_json::to_string(&result)?);
            Ok(())
        }
        "clear" => {
            let store = flag_value(rest, "--type")
                .or_else(|| flag_value(rest, "--store"))
                .unwrap_or("local");
            let js = match store {
                "local" => r#"(() => { localStorage.clear(); return { cleared: true, store: 'local' }; })()"#.to_string(),
                "session" => r#"(() => { sessionStorage.clear(); return { cleared: true, store: 'session' }; })()"#.to_string(),
                other => return Err(anyhow!("clear not supported for store type: {}", other)),
            };
            let tab = match extract_tab(args) {
                Some(t) => Some(t),
                None => resolve_active_tab_or(rest)?,
            };
            let profile = extract_profile(args).or_else(|| extract_profile(rest));
            let result = cdp_eval(tab, profile.as_deref(), &js)?;
            println!("{}", serde_json::to_string(&result)?);
            Ok(())
        }
        other => {
            eprintln!(
                "unknown storage subcommand: {other}\navailable: list, get, set, remove, clear"
            );
            std::process::exit(1);
        }
    }
}

fn sw_cmd(args: &[String]) -> Result<()> {
    let sub = args.first().map(|s| s.as_str()).unwrap_or("list");
    let rest = &args[1..];
    match sub {
        "list" | "" => {
            let tab = match extract_tab(args) {
                Some(t) => Some(t),
                None => resolve_active_tab_or(rest)?,
            };
            let profile = extract_profile(args);
            let js = r#"(async () => {
                if (!('serviceWorker' in navigator)) return { supported: false, registrations: [] };
                const regs = await navigator.serviceWorker.getRegistrations();
                return {
                    supported: true,
                    count: regs.length,
                    registrations: regs.map(r => ({
                        scope: r.scope,
                        scriptURL: r.active ? r.active.scriptURL : (r.installing ? r.installing.scriptURL : (r.waiting ? r.waiting.scriptURL : null)),
                        state: r.active ? r.active.state : (r.installing ? 'installing' : (r.waiting ? 'waiting' : 'redundant')),
                        updateViaCache: r.updateViaCache,
                    })),
                };
            })()"#;
            let result = cdp_eval(tab, profile.as_deref(), js)?;
            println!("{}", serde_json::to_string(&result)?);
            Ok(())
        }
        "inspect" => {
            let tab = match extract_tab(args) {
                Some(t) => Some(t),
                None => resolve_active_tab_or(rest)?,
            };
            let profile = extract_profile(args);
            let js = r#"(async () => {
                const out = { supported: 'serviceWorker' in navigator };
                if (!out.supported) return out;
                const regs = await navigator.serviceWorker.getRegistrations();
                out.registrations = [];
                for (const reg of regs) {
                    const info = {
                        scope: reg.scope,
                        scriptURL: reg.active ? reg.active.scriptURL : null,
                        state: reg.active ? reg.active.state : null,
                    };
                    if (reg.pushManager) {
                        try {
                            const sub = await reg.pushManager.getSubscription();
                            info.pushSubscription = sub ? {
                                endpoint: sub.endpoint.slice(0, 100),
                                expirationTime: sub.expirationTime,
                            } : null;
                        } catch (e) { info.pushError = e.message; }
                    }
                    if (reg.sync) {
                        try { info.syncRegistered = true; } catch (_) {}
                    }
                    if ('caches' in window) {
                        try {
                            const keys = await caches.keys();
                            info.cacheKeys = keys;
                            info.cacheCount = keys.length;
                        } catch (_) {}
                    }
                    out.registrations.push(info);
                }
                out.controller = navigator.serviceWorker.controller ? {
                    scriptURL: navigator.serviceWorker.controller.scriptURL,
                    state: navigator.serviceWorker.controller.state,
                } : null;
                return out;
            })()"#;
            let result = cdp_eval(tab, profile.as_deref(), js)?;
            println!("{}", serde_json::to_string(&result)?);
            Ok(())
        }
        "unregister" => {
            let scope = rest
                .iter()
                .find(|a| !a.starts_with("--"))
                .ok_or_else(|| anyhow!("usage: dev sw unregister <scope-url> [--tab T]"))?;
            let tab = match extract_tab(args) {
                Some(t) => Some(t),
                None => resolve_active_tab_or(rest)?,
            };
            let profile = extract_profile(args);
            let js = format!(
                r#"(async () => {{
                const regs = await navigator.serviceWorker.getRegistrations();
                let match = null;
                for (const r of regs) {{ if (r.scope === {scope_expr}) match = r; }}
                if (!match) return {{ found: false }};
                const ok = await match.unregister();
                return {{ found: true, unregistered: ok, scope: match.scope }};
            }})()"#,
                scope_expr = json_escape_as_js_string(scope)
            );
            let result = cdp_eval(tab, profile.as_deref(), &js)?;
            println!("{}", serde_json::to_string(&result)?);
            Ok(())
        }
        other => {
            eprintln!("unknown sw subcommand: {other}\navailable: list, inspect, unregister");
            std::process::exit(1);
        }
    }
}
