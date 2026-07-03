//! Site-adapter system: load YAML adapters from ~/.ap-browser/sites/, expand templates,
//! dispatch as batch RPC. Pipe composition via NDJSON.

pub mod lint;

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::IsTerminal;
use std::path::{Path, PathBuf};

// ── Reserved names that can never be site folders ─────────────────────────
pub const RESERVED: &[&str] = &[
    "ping", "info", "status", "profiles", "use", "current", "tabs", "goto", "text",
    "screenshot", "click", "fill", "back", "forward", "reload", "html", "press",
    "wait", "cdp", "eval", "batch", "sites", "dev",
];

// ── YAML schemas ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct SiteMeta {
    pub site: String,
    pub domain: Option<String>,
    pub login_url: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Adapter {
    pub site: String,
    pub name: String,
    pub description: Option<String>,
    pub domain: Option<String>,
    #[serde(default)]
    pub args: HashMap<String, ArgDef>,
    pub input: Option<InputDef>,
    pub output: Option<OutputDef>,
    pub columns: Option<Vec<String>>,
    pub steps: Vec<HashMap<String, Value>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ArgDef {
    #[serde(rename = "type")]
    pub arg_type: String,
    #[serde(default)]
    pub required: bool,
    pub default: Option<Value>,
    pub desc: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct InputDef {
    pub field: Option<String>, // None = raw line mode
}

#[derive(Debug, Clone, Deserialize)]
pub struct OutputDef {
    #[serde(rename = "type", default = "default_object")]
    pub out_type: String,
    #[serde(default)]
    pub fields: Vec<String>,
}

fn default_object() -> String { "object".into() }

// ── Registry ───────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct Registry {
    pub sites: HashMap<String, SiteEntry>,
}

#[derive(Debug)]
pub struct SiteEntry {
    pub meta: Option<SiteMeta>,
    pub adapters: HashMap<String, Adapter>,
    pub dir: PathBuf,
}

impl Registry {
    pub fn load() -> Self {
        let root = dirs::home_dir()
            .unwrap_or_else(|| std::env::temp_dir())
            .join(".ap-browser")
            .join("sites");
        let mut sites = HashMap::new();
        if root.is_dir() {
            for entry in std::fs::read_dir(&root).into_iter().flatten().flatten() {
                if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
                let site_name = entry.file_name().to_string_lossy().to_string();
                if RESERVED.contains(&site_name.as_str()) {
                    eprintln!("[warn] site folder '{}' is a reserved name, skipping", site_name);
                    continue;
                }
                let dir = entry.path();
                let (meta, adapters) = load_site_dir(&dir, &site_name);
                sites.insert(site_name, SiteEntry { meta, adapters, dir });
            }
        }
        Registry { sites }
    }

    pub fn match_site(&self, name: &str) -> Option<&SiteEntry> {
        self.sites.get(name)
    }

    pub fn total_adapters(&self) -> usize {
        self.sites.values().map(|e| e.adapters.len()).sum()
    }

    pub fn recent_sites(&self, n: usize) -> Vec<(String, usize)> {
        let hist_path = dirs::home_dir()
            .unwrap_or_else(|| std::env::temp_dir())
            .join(".ap-browser")
            .join("sites.history");
        let mut seen = std::collections::HashSet::new();
        let mut out: Vec<(String, usize)> = Vec::new();
        if let Ok(content) = std::fs::read_to_string(&hist_path) {
            for line in content.lines().rev() {
                let name = line.split_whitespace().last().unwrap_or("").trim();
                if name.is_empty() || seen.contains(name) || !self.sites.contains_key(name) { continue; }
                seen.insert(name.to_string());
                let count = self.sites[name].adapters.len();
                out.push((name.to_string(), count));
                if out.len() >= n { break; }
            }
        }
        out
    }

    pub fn record_use(&self, site: &str) {
        let dir = dirs::home_dir()
            .unwrap_or_else(|| std::env::temp_dir())
            .join(".ap-browser");
        let _ = std::fs::create_dir_all(&dir);
        let hist_path = dir.join("sites.history");
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&hist_path) {
            use std::io::Write;
            let _ = writeln!(f, "{} {}", ts, site);
        }
    }

    pub fn search(&self, query: &str) -> Vec<(String, Vec<(String, String)>)> {
        let q = query.to_lowercase();
        let mut hits: Vec<(String, Vec<(String, String)>)> = Vec::new();
        let mut site_names: Vec<&String> = self.sites.keys().collect();
        site_names.sort();
        for site in site_names {
            let entry = &self.sites[site];
            let site_desc = entry.meta.as_ref()
                .and_then(|m| m.description.as_deref())
                .unwrap_or("");
            let site_matches = site.to_lowercase().contains(&q) || site_desc.to_lowercase().contains(&q);
            let mut cmd_hits: Vec<(String, String)> = Vec::new();
            let mut cmd_names: Vec<&String> = entry.adapters.keys().collect();
            cmd_names.sort();
            for cmd in cmd_names {
                let adapter = &entry.adapters[cmd];
                let desc = adapter.description.clone().unwrap_or_default();
                if site_matches || cmd.to_lowercase().contains(&q) || desc.to_lowercase().contains(&q) {
                    cmd_hits.push((cmd.clone(), desc));
                }
            }
            if site_matches || !cmd_hits.is_empty() {
                hits.push((site.clone(), cmd_hits));
            }
        }
        hits
    }
}

fn load_site_dir(dir: &Path, site_name: &str) -> (Option<SiteMeta>, HashMap<String, Adapter>) {
    // Load site.yml
    let meta = ["site.yml", "site.yaml"]
        .iter()
        .find_map(|f| {
            let p = dir.join(f);
            std::fs::read_to_string(&p).ok().and_then(|s| {
                match serde_yaml::from_str::<SiteMeta>(&s) {
                    Ok(m) => Some(m),
                    Err(e) => { eprintln!("[warn] parse {}: {}", p.display(), e); None }
                }
            })
        });
    // Load adapters
    let mut adapters = HashMap::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let fname = entry.file_name().to_string_lossy().to_string();
            if fname.starts_with("site.") { continue; }
            let stem = match fname.strip_suffix(".yaml").or_else(|| fname.strip_suffix(".yml")) {
                Some(s) => s.to_string(),
                None => continue,
            };
            let path = entry.path();
            let src = match std::fs::read_to_string(&path) {
                Ok(s) => s,
                Err(_) => continue,
            };
            match serde_yaml::from_str::<Adapter>(&src) {
                Ok(mut a) => {
                    if let Err(e) = resolve_js_refs(&mut a, dir) {
                        eprintln!("[warn] {}: {}", path.display(), e);
                    }
                    adapters.insert(stem, a);
                }
                Err(e) => eprintln!("[warn] parse {}: {}", path.display(), e),
            }
        }
    }
    let _ = site_name;
    (meta, adapters)
}

fn resolve_js_refs(adapter: &mut Adapter, site_dir: &Path) -> Result<()> {
    for step in &mut adapter.steps {
        if let Some(val) = step.get_mut("eval") {
            if let Some(s) = val.as_str() {
                if s.ends_with(".js") && !s.contains('\n') && s.len() < 200 {
                    let p = site_dir.join(s);
                    let content = std::fs::read_to_string(&p)
                        .with_context(|| format!("eval references .js file not found: {}", p.display()))?;
                    *val = Value::String(content);
                }
            }
        }
    }
    Ok(())
}

// ── Dispatch: the main entry point for `ap-browser <site> <cmd> [args]` ────

pub fn dispatch_site(
    registry: &Registry,
    site: &str,
    cmd: &str,
    raw_args: &[String],
) -> Result<()> {
    let entry = registry.match_site(site)
        .ok_or_else(|| anyhow!("unknown site: {}", site))?;
    let adapter = entry.adapters.get(cmd)
        .ok_or_else(|| anyhow!("unknown command: {} {}", site, cmd))?;

    registry.record_use(site);

    // Parse CLI args
    let parsed = parse_args(adapter, raw_args)?;
    let human = raw_args.iter().any(|a| a == "--human");
    let format_ndjson = raw_args.iter().any(|a| a == "--format" )
        && raw_args.windows(2).any(|w| w[0] == "--format" && w[1] == "ndjson");
    let pipe_detected = !atty_is_tty();
    let want_ndjson = format_ndjson || (pipe_detected && !raw_args.iter().any(|a| a == "--format"));
    let read_stdin = raw_args.iter().any(|a| a == "--read-stdin");
    let tab_override = extract_flag(raw_args, "--tab").and_then(|s| s.parse::<i64>().ok());
    let profile_override = extract_flag(raw_args, "profile").or_else(|| extract_flag(raw_args, "--profile"));

    if read_stdin && adapter.input.is_none() {
        bail!("adapter '{}::{}' has no `input` declaration; cannot receive piped input", site, cmd);
    }

    if read_stdin {
        let lines = pipe::read_stdin_ndjson();
        let input_field = adapter.input.as_ref().and_then(|i| i.field.as_deref());
        for (i, line_data) in lines.iter().enumerate() {
            let mut iter_args = parsed.clone();
            match input_field {
                Some(f) => {
                    if let Some(v) = line_data.get(f) {
                        iter_args.insert(f.to_string(), v.clone());
                    } else {
                        eprintln!("[warn] stdin line {}: no field '{}', skipped", i + 1, f);
                        continue;
                    }
                }
                None => { iter_args.insert("_input".into(), line_data.clone()); }
            }
            let resp = send_adapter_batch(adapter, &iter_args, tab_override, profile_override.as_deref())?;
            print_response(&resp, want_ndjson, human);
        }
        Ok(())
    } else {
        let resp = send_adapter_batch(adapter, &parsed, tab_override, profile_override.as_deref())?;
        print_response(&resp, want_ndjson, human);
        Ok(())
    }
}

fn estimate_batch_timeout(steps: &[Value]) -> std::time::Duration {
    let mut secs: u64 = 10;
    for step in steps {
        let method = step.get("method").and_then(|v| v.as_str()).unwrap_or("");
        let params = step.get("params").unwrap_or(&Value::Null);
        match method {
            "goto" => secs += 10,
            "wait" => secs += params.get("timeout_ms").and_then(|v| v.as_u64()).unwrap_or(5000) / 1000 + 1,
            "scroll" => {
                let count = params.get("count").and_then(|v| v.as_u64()).unwrap_or(1);
                let pause = params.get("pause_ms").and_then(|v| v.as_u64()).unwrap_or(1000);
                secs += count * (pause / 1000 + 1);
            }
            "eval" => secs += 5,
            _ => secs += 3,
        }
    }
    std::time::Duration::from_secs(secs.max(30))
}

fn send_adapter_batch(
    adapter: &Adapter,
    args: &HashMap<String, Value>,
    tab: Option<i64>,
    profile: Option<&str>,
) -> Result<Value> {
    let steps = expand_steps(&adapter.steps, args)?;
    let timeout = estimate_batch_timeout(&steps);
    let timeout_secs = timeout.as_secs();
    let mut params = json!({"steps": steps, "stop_on_error": true, "_timeout_hint_secs": timeout_secs});
    if let Some(t) = tab {
        params["tab_id"] = json!(t);
    }
    let socket = crate::socket_client::resolve_socket(profile)?;
    let request = json!({"jsonrpc":"2.0","method":"batch","params":params});
    let bytes = crate::cli_frame::encode(&request)?;
    let mut stream = crate::socket_client::dial_with_retry(&socket, 3, std::time::Duration::from_millis(200))?;
    use std::io::Write;
    stream.write_all(&bytes)?;
    stream.flush()?;
    let envelope = crate::cli_frame::read_response(&mut stream, timeout)?;
    let resp = match envelope.get("result") {
        Some(r) => r.clone(),
        None => match envelope.get("error") {
            Some(e) => json!({"ok": false, "error": e}),
            None => envelope,
        },
    };
    Ok(extract_adapter_output(resp))
}

fn extract_adapter_output(resp: Value) -> Value {
    let results = resp.get("data").and_then(|d| d.get("results")).and_then(|r| r.as_array());
    if let Some(results) = results {
        if let Some(last) = results.last() {
            if last.get("ok").and_then(|v| v.as_bool()) == Some(true) {
                if let Some(eval_result) = last.get("data").and_then(|d| d.get("result")) {
                    return json!({"ok": true, "data": eval_result});
                }
                if let Some(step_data) = last.get("data") {
                    return json!({"ok": true, "data": step_data});
                }
            } else {
                return json!({"ok": false, "error": last.get("error").cloned().unwrap_or(json!({}))});
            }
        }
    }
    resp
}

// ── Template expansion ─────────────────────────────────────────────────────

fn expand_steps(steps: &[HashMap<String, Value>], args: &HashMap<String, Value>) -> Result<Vec<Value>> {
    let mut out = Vec::with_capacity(steps.len());
    for step in steps {
        // Each step is {method: value} — exactly one key
        let (method, value) = step.iter().next()
            .ok_or_else(|| anyhow!("step has no method"))?;
        if !["goto", "wait", "eval", "text", "click", "fill", "press", "scroll"].contains(&method.as_str()) {
            bail!("unknown step method '{}'; allowed: goto, wait, eval, text, click, fill, press, scroll", method);
        }
        let expanded = expand_value(value, method, args)?;
        let step_obj = build_step_obj(method, &expanded)?;
        out.push(step_obj);
    }
    Ok(out)
}

fn expand_value(value: &Value, method: &str, args: &HashMap<String, Value>) -> Result<Value> {
    // Determine context: URL methods (goto) use encodeURIComponent; JS methods (eval) use JSON.stringify
    let is_url_context = method == "goto";
    match value {
        Value::String(s) => {
            let expanded = expand_template(s, args, is_url_context)?;
            Ok(Value::String(expanded))
        }
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                let ev = match v {
                    Value::String(s) => Value::String(expand_template(s, args, is_url_context)?),
                    other => other.clone(),
                };
                out.insert(k.clone(), ev);
            }
            Ok(Value::Object(out))
        }
        other => Ok(other.clone()),
    }
}

fn expand_template(s: &str, args: &HashMap<String, Value>, url_context: bool) -> Result<String> {
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    let bytes = s.as_bytes();
    while i < bytes.len() {
        if bytes[i] == b'{' && i + 1 < bytes.len() && bytes[i + 1] == b'{' {
            // Find closing }}
            if let Some(end) = s[i + 2..].find("}}") {
                let expr = &s[i + 2..i + 2 + end];
                let val = resolve_template_expr(expr, args)?;
                let replaced = match &val {
                    Value::String(s) => {
                        if url_context { format!("encodeURIComponent({:?})", s) }
                        else { s.clone() }
                    }
                    other => {
                        if url_context { other.to_string() }
                        else { other.to_string() }
                    }
                };
                // For URL context, we can't call encodeURIComponent from Rust.
                // Instead, manually percent-encode.
                let replaced = if url_context {
                    match &val {
                        Value::String(s) => percent_encode(s),
                        other => percent_encode(&other.to_string()),
                    }
                } else {
                    match &val {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    }
                };
                out.push_str(&replaced);
                i = i + 2 + end + 2;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    Ok(out)
}

fn resolve_template_expr(expr: &str, args: &HashMap<String, Value>) -> Result<Value> {
    let trimmed = expr.trim();
    if let Some(arith) = trimmed.strip_prefix("eval ") {
        return Ok(Value::String(eval_arith(arith, args)?.to_string()));
    }
    let key = trimmed.strip_prefix("args.")
        .unwrap_or(trimmed);
    Ok(args.get(key).cloned().unwrap_or(Value::String(String::new())))
}

fn eval_arith(expr: &str, args: &HashMap<String, Value>) -> Result<i64> {
    let tokens: Vec<&str> = expr.split_whitespace().collect();
    if tokens.is_empty() {
        bail!("eval expr empty");
    }
    let first = tokens[0].strip_prefix("args.").unwrap_or(tokens[0]);
    let mut acc = args.get(first)
        .and_then(|v| v.as_i64())
        .ok_or_else(|| anyhow!("eval: '{}' not an int arg", tokens[0]))?;
    let mut i = 1;
    while i + 1 < tokens.len() {
        let op = tokens[i];
        let rhs: i64 = tokens[i + 1].parse()
            .with_context(|| format!("eval: '{}' not an int", tokens[i + 1]))?;
        acc = match op {
            "+" => acc + rhs,
            "-" => acc - rhs,
            "*" => acc * rhs,
            "/" => if rhs == 0 { bail!("eval: divide by zero") } else { acc / rhs },
            _ => bail!("eval: unknown op '{}'; allowed: + - * /", op),
        };
        i += 2;
    }
    if i != tokens.len() {
        bail!("eval expr malformed: tokens not in <arg> (<op> <int>)* form");
    }
    Ok(acc)
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => out.push(b as char),
            _ => { out.push('%'); out.push_str(&format!("{:02X}", b)); }
        }
    }
    out
}

fn build_step_obj(method: &str, expanded: &Value) -> Result<Value> {
    // Map adapter step to batch step {method, params}
    match method {
        "goto" => {
            let url = expanded.as_str().or_else(|| expanded.get("url").and_then(|v| v.as_str()))
                .ok_or_else(|| anyhow!("goto step needs a URL string or {{url: ...}}"))?;
            Ok(json!({"method": "goto", "params": {"url": url}}))
        }
        "wait" => {
            let selector = expanded.as_str().or_else(|| expanded.get("selector").and_then(|v| v.as_str()))
                .ok_or_else(|| anyhow!("wait step needs a selector"))?;
            let timeout = expanded.get("timeout_ms").and_then(|v| v.as_u64()).unwrap_or(5000);
            Ok(json!({"method": "wait", "params": {"selector": selector, "timeout_ms": timeout}}))
        }
        "eval" => {
            let expr = expanded.as_str().or_else(|| expanded.get("expression").and_then(|v| v.as_str()))
                .ok_or_else(|| anyhow!("eval step needs an expression"))?;
            Ok(json!({"method": "eval", "params": {"expression": expr}}))
        }
        "text" => {
            let selector = expanded.as_str().or_else(|| expanded.get("selector").and_then(|v| v.as_str()))
                .unwrap_or("body");
            Ok(json!({"method": "text", "params": {"selector": selector}}))
        }
        "click" => {
            let selector = expanded.as_str().or_else(|| expanded.get("selector").and_then(|v| v.as_str()))
                .ok_or_else(|| anyhow!("click step needs a selector"))?;
            Ok(json!({"method": "click", "params": {"selector": selector}}))
        }
        "fill" => {
            let selector = expanded.as_str().or_else(|| expanded.get("selector").and_then(|v| v.as_str()))
                .ok_or_else(|| anyhow!("fill step needs a selector"))?;
            let value = expanded.get("value").and_then(|v| v.as_str())
                .ok_or_else(|| anyhow!("fill step needs a value"))?;
            Ok(json!({"method": "fill", "params": {"selector": selector, "value": value}}))
        }
        "press" => {
            let keys = expanded.as_str().or_else(|| expanded.get("keys").and_then(|v| v.as_str()))
                .ok_or_else(|| anyhow!("press step needs keys"))?;
            Ok(json!({"method": "press", "params": {"keys": keys}}))
        }
        "scroll" => {
            let coerce_int = |key: &str| -> Option<i64> {
                let v = expanded.get(key)?;
                v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
            };
            let count = coerce_int("count").unwrap_or(1);
            let pause_ms = coerce_int("pause_ms").unwrap_or(800);
            let selector = expanded.get("selector").and_then(|v| v.as_str());
            let mut params = json!({"count": count, "pause_ms": pause_ms});
            if let Some(s) = selector { params["selector"] = json!(s); }
            Ok(json!({"method": "scroll", "params": params}))
        }
        _ => bail!("unknown method"),
    }
}

// ── CLI arg parsing for adapters ───────────────────────────────────────────

fn parse_args(adapter: &Adapter, raw: &[String]) -> Result<HashMap<String, Value>> {
    let mut out = HashMap::new();
    // Set defaults
    for (name, def) in &adapter.args {
        if let Some(d) = &def.default {
            out.insert(name.clone(), d.clone());
        }
    }
    // Parse positional and --flag
    let mut positional: Vec<&String> = Vec::new();
    let mut skip = false;
    for (i, arg) in raw.iter().enumerate() {
        if skip { skip = false; continue; }
        // Skip our own global flags
        if arg.starts_with("--format") || arg == "--read-stdin" || arg == "--human"
            || arg == "--tab" || arg == "--profile" || arg == "--map" {
            if (arg == "--format" || arg == "--tab" || arg == "--profile" || arg == "--map")
                && i + 1 < raw.len() { skip = true; }
            continue;
        }
        if arg.starts_with("--") {
            let key = arg.trim_start_matches("--").to_string();
            if let Some(val) = raw.get(i + 1) {
                if let Some(def) = adapter.args.get(&key) {
                    out.insert(key, coerce_value(&def.arg_type, val)?);
                    skip = true;
                }
            }
        } else {
            positional.push(arg);
        }
    }
    // Assign positionals to required args in order
    let required_order: Vec<&String> = adapter.args.iter()
        .filter(|(_, d)| d.required)
        .map(|(k, _)| k)
        .collect();
    for (i, key) in required_order.iter().enumerate() {
        if let Some(val) = positional.get(i) {
            let def = &adapter.args[*key];
            out.insert((*key).clone(), coerce_value(&def.arg_type, val)?);
        }
    }
    // Check required args are present
    for (name, def) in &adapter.args {
        if def.required && !out.contains_key(name) {
            bail!("missing required argument: {} (--{} <{}>)", name, name, def.arg_type);
        }
    }
    Ok(out)
}

fn coerce_value(ty: &str, s: &str) -> Result<Value> {
    match ty {
        "string" => Ok(Value::String(s.to_string())),
        "int" => Ok(json!(s.parse::<i64>().with_context(|| format!("expected int, got '{}'", s))?)),
        "bool" => Ok(json!(matches!(s.to_lowercase().as_str(), "true" | "1" | "yes"))),
        other => bail!("unknown arg type '{}'", other),
    }
}

// ── Output ─────────────────────────────────────────────────────────────────

fn print_response(resp: &Value, ndjson: bool, human: bool) {
    if human {
        super::print_human(resp);
        return;
    }
    if ndjson {
        // Extract data and emit one object per line
        if let Some(data) = resp.get("data") {
            if let Some(arr) = data.as_array() {
                for item in arr {
                    println!("{}", serde_json::to_string(item).unwrap_or_default());
                }
            } else {
                println!("{}", serde_json::to_string(data).unwrap_or_default());
            }
        } else {
            println!("{}", serde_json::to_string(resp).unwrap_or_default());
        }
    } else {
        println!("{}", serde_json::to_string(resp).unwrap_or_default());
    }
}

// ── Pipe module (inline — too small for its own file) ─────────────────────

mod pipe {
    use serde_json::Value;
    use std::io::Read;

    pub fn read_stdin_ndjson() -> Vec<Value> {
        let mut input = String::new();
        let _ = std::io::stdin().read_to_string(&mut input);
        let mut out = Vec::new();
        for (i, line) in input.lines().enumerate() {
            let trimmed = line.trim();
            if trimmed.is_empty() { continue; }
            match serde_json::from_str::<Value>(trimmed) {
                Ok(v) => out.push(v),
                Err(_) => eprintln!("[warn] stdin line {}: invalid JSON, skipped", i + 1),
            }
        }
        out
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn extract_flag(args: &[String], flag: &str) -> Option<String> {
    let flag_with = if flag.starts_with("--") { flag.to_string() } else { format!("--{}", flag) };
    args.windows(2)
        .find(|w| w[0] == flag_with)
        .and_then(|w| w.get(1))
        .cloned()
}

fn atty_is_tty() -> bool {
    std::io::stdout().is_terminal()
}

// ── Helpers for live verify (used by lint module) ──────────────────────────

pub fn expand_steps_for_verify(steps: &[HashMap<String, Value>], args: &HashMap<String, Value>) -> Result<Vec<Value>> {
    expand_steps(steps, args)
}

pub fn send_single_step(step: &Value) -> Result<Value> {
    let params = json!({"steps": [step], "stop_on_error": true});
    let socket = crate::socket_client::resolve_socket(None)?;
    let request = json!({"jsonrpc":"2.0","method":"batch","params":params});
    let bytes = crate::cli_frame::encode(&request)?;
    let mut stream = crate::socket_client::dial_with_retry(&socket, 3, std::time::Duration::from_millis(200))?;
    use std::io::Write;
    stream.write_all(&bytes)?;
    stream.flush()?;
    let envelope = crate::cli_frame::read_response(&mut stream, std::time::Duration::from_secs(30))?;
    let resp = match envelope.get("result") {
        Some(r) => r.clone(),
        None => match envelope.get("error") {
            Some(e) => json!({"ok": false, "error": e}),
            None => envelope,
        },
    };
    if let Some(results) = resp.get("data").and_then(|d| d.get("results")).and_then(|r| r.as_array()) {
        if let Some(first) = results.first() {
            return Ok(first.clone());
        }
    }
    Ok(resp)
}
