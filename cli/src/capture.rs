//! Capture & download: unified download routing (yt-dlp + fetch + browser + CDP), plus pdf/mhtml/har/media/screenshot.

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use std::time::Duration;

mod discovery;
mod extractor;
mod stream;

const VIDEO_DOMAINS: &[&str] = &[
    "youtube.com",
    "youtu.be",
    "bilibili.com",
    "b23.tv",
    "vimeo.com",
    "twitter.com",
    "x.com",
    "tiktok.com",
    "douyin.com",
    "instagram.com",
    "facebook.com",
    "twitch.tv",
    "dailymotion.com",
    "soundcloud.com",
    "udemy.com",
    "coursera.org",
    "nicovideo.jp",
    "youku.com",
    "iqiyi.com",
    "t.co",
];

fn default_extensions() -> Vec<(String, String)> {
    vec![
        (".pdf".into(), "pdf".into()),
        (".zip".into(), "archive".into()),
        (".tar.gz".into(), "archive".into()),
        (".tar".into(), "archive".into()),
        (".doc".into(), "doc".into()),
        (".docx".into(), "doc".into()),
        (".xls".into(), "spreadsheet".into()),
        (".xlsx".into(), "spreadsheet".into()),
        (".ppt".into(), "presentation".into()),
        (".pptx".into(), "presentation".into()),
        (".epub".into(), "ebook".into()),
        (".mobi".into(), "ebook".into()),
        (".csv".into(), "data".into()),
        (".json".into(), "data".into()),
        (".xml".into(), "data".into()),
        (".ipynb".into(), "notebook".into()),
        (".dmg".into(), "installer".into()),
        (".exe".into(), "installer".into()),
        (".deb".into(), "installer".into()),
        (".rpm".into(), "installer".into()),
        (".apk".into(), "installer".into()),
        (".iso".into(), "image".into()),
        (".img".into(), "image".into()),
        (".sql".into(), "data".into()),
        (".rds".into(), "data".into()),
        (".rdata".into(), "data".into()),
        (".parquet".into(), "data".into()),
        (".feather".into(), "data".into()),
        (".h5".into(), "model".into()),
        (".hdf5".into(), "model".into()),
        (".npy".into(), "data".into()),
        (".npz".into(), "data".into()),
        (".ckpt".into(), "model".into()),
        (".safetensors".into(), "model".into()),
        (".pt".into(), "model".into()),
        (".pth".into(), "model".into()),
        (".onnx".into(), "model".into()),
        (".weights".into(), "model".into()),
        (".mp4".into(), "video".into()),
        (".webm".into(), "video".into()),
        (".mov".into(), "video".into()),
        (".m4v".into(), "video".into()),
        (".mp3".into(), "audio".into()),
        (".m4a".into(), "audio".into()),
        (".wav".into(), "audio".into()),
        (".m3u8".into(), "hls".into()),
        (".mpd".into(), "dash".into()),
    ]
}

fn default_url_patterns() -> Vec<(String, String)> {
    vec![
        ("/download/".into(), "download".into()),
        ("/e-print/".into(), "eprint".into()),
        ("/file/".into(), "file".into()),
        ("/attachment/".into(), "attachment".into()),
        ("/releases/download/".into(), "release".into()),
        ("/raw/".into(), "raw".into()),
        ("/export/".into(), "export".into()),
        ("/get/".into(), "get".into()),
        ("/src/".into(), "source".into()),
        ("/pdf/".into(), "pdf".into()),
        ("/doc/".into(), "doc".into()),
        ("/data/".into(), "data".into()),
    ]
}

fn config_path() -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(".ap-browser")
        .join("download-config.yml")
}

struct DownloadConfig {
    extensions: Vec<(String, String)>,
    url_patterns: Vec<(String, String)>,
}

impl DownloadConfig {
    fn load() -> Self {
        let mut extensions = default_extensions();
        let mut url_patterns = default_url_patterns();
        let path = config_path();
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(yaml) = serde_yaml::from_str::<serde_yaml::Value>(&content) {
                if let Some(ext_map) = yaml.get("extensions").and_then(|v| v.as_mapping()) {
                    for (k, v) in ext_map {
                        let ext = k.as_str().unwrap_or("").to_string();
                        let typ = v.as_str().unwrap_or("unknown").to_string();
                        if let Some(pos) = extensions.iter().position(|(e, _)| e == &ext) {
                            extensions[pos].1 = typ;
                        } else {
                            extensions.push((ext, typ));
                        }
                    }
                }
                if let Some(pat_map) = yaml.get("url_patterns").and_then(|v| v.as_mapping()) {
                    for (k, v) in pat_map {
                        let pat = k.as_str().unwrap_or("").to_string();
                        let typ = v.as_str().unwrap_or("unknown").to_string();
                        if let Some(pos) = url_patterns.iter().position(|(p, _)| p == &pat) {
                            url_patterns[pos].1 = typ;
                        } else {
                            url_patterns.push((pat, typ));
                        }
                    }
                }
            }
        }
        DownloadConfig {
            extensions,
            url_patterns,
        }
    }
}

pub fn dispatch(cmd: &str, args: &[String]) -> Result<()> {
    match cmd {
        "download" => download_cmd(args),
        "pdf" => pdf_cmd(args),
        "mhtml" => mhtml_cmd(args),
        "har" => har_cmd(args),
        "media" => media_cmd(args),
        other => bail!("unknown capture command: {other}. Use: download, pdf, mhtml, har, media"),
    }
}

// ── Helpers (shared with dev.rs pattern) ───────────────────────────────────

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

fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.windows(2).find(|w| w[0] == flag).map(|w| w[1].clone())
}

fn has_flag(args: &[String], flag: &str) -> bool {
    args.iter().any(|a| a == flag)
}

fn cdp_eval(tab: Option<i64>, profile: Option<&str>, expression: &str) -> Result<Value> {
    let resp = cdp(
        tab,
        profile,
        "Runtime.evaluate",
        json!({"expression": expression, "returnByValue": true, "awaitPromise": true}),
    )?;
    if resp["ok"] == false {
        bail!(
            "page evaluation failed: {}",
            resp["error"]["message"].as_str().unwrap_or("CDP error")
        );
    }
    if !resp["data"]["result"]["exceptionDetails"].is_null() {
        bail!("page evaluation raised an exception during capture");
    }
    Ok(resp
        .get("data")
        .and_then(|d| d.get("result"))
        .and_then(|r| r.get("result"))
        .and_then(|r| r.get("value"))
        .cloned()
        .unwrap_or(Value::Null))
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

fn rpc(method: &str, params: Value, args: &[String]) -> Result<Value> {
    let mut p = params;
    if let Some(t) = extract_tab(args) {
        if let Some(o) = p.as_object_mut() {
            o.insert("tab_id".into(), json!(t));
        }
    }
    let socket = crate::socket_client::resolve_socket(extract_profile(args).as_deref())?;
    let request = json!({"jsonrpc":"2.0","method":method,"params":p});
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

fn resolve_active_tab(args: &[String]) -> Result<Option<i64>> {
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
    Ok(envelope
        .get("result")
        .and_then(|r| r.get("data"))
        .and_then(|d| d.get("active_tab"))
        .and_then(|t| t.get("id"))
        .and_then(|v| v.as_i64()))
}

fn print_result(resp: Value, args: &[String]) {
    let human = has_flag(args, "--human");
    if human {
        crate::print_human(&resp);
    } else {
        println!("{}", serde_json::to_string(&resp).unwrap_or_default());
    }
}

// ── Download ───────────────────────────────────────────────────────────────

fn is_video_domain(url: &str) -> bool {
    let host = url
        .split("://")
        .nth(1)
        .unwrap_or(url)
        .split('/')
        .next()
        .unwrap_or("");
    VIDEO_DOMAINS
        .iter()
        .any(|d| host == *d || host.ends_with(&format!(".{d}")))
}

fn yt_dlp_installed() -> bool {
    std::process::Command::new("yt-dlp")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// Skip flag values rather than mistaking --tab/--out/--hls values for a URL.
fn download_url(args: &[String]) -> Option<String> {
    let mut values = args.iter();
    while let Some(arg) = values.next() {
        if [
            "--out",
            "--method",
            "--format",
            "--cookies-from",
            "--pick",
            "--tab",
            "--profile",
            "--type",
            "--hls",
            "--start",
            "--end",
            "--duration",
        ]
        .contains(&arg.as_str())
        {
            values.next();
        } else if !arg.starts_with("--") {
            return Some(arg.clone());
        }
    }
    None
}

fn is_vimeo_url(url: &str) -> bool {
    let host = url
        .split("://")
        .nth(1)
        .unwrap_or("")
        .split('/')
        .next()
        .unwrap_or("");
    host == "vimeo.com" || host.ends_with(".vimeo.com")
}

fn download_cmd(args: &[String]) -> Result<()> {
    let range = stream::TimeRange::parse(args)?;
    if let Some(hls) = flag_value(args, "--hls") {
        return stream::download(
            &hls,
            &flag_value(args, "--out").unwrap_or_default(),
            args,
            extract_tab(args),
            extract_profile(args).as_deref(),
            None,
        );
    }
    let want_list = has_flag(args, "--list");
    let want_auto = has_flag(args, "--auto");
    let pick = flag_value(args, "--pick");

    if want_list {
        return download_list_cmd(args);
    }
    if let Some(selector) = pick {
        return download_pick_cmd(&selector, args);
    }
    if want_auto {
        return download_auto_cmd(args);
    }

    let url = download_url(args)
        .ok_or_else(|| anyhow!("usage: ap-browser download <url> [--out FILE] [--auto|--video] [--start TIME --duration SECONDS]"))?;
    let out = flag_value(args, "--out").unwrap_or_default();
    let method = flag_value(args, "--method").unwrap_or("auto".into());
    let want_video = has_flag(args, "--video") || method == "yt-dlp";
    let silence_hint = has_flag(args, "--silence-hint");
    let profile = extract_profile(args);
    if method == "ffmpeg"
        || (method == "auto"
            && (stream::manifest_format(&url).is_some()
                || (range.is_some() && !is_video_domain(&url))))
    {
        return stream::download(
            &url,
            &out,
            args,
            extract_tab(args),
            profile.as_deref(),
            None,
        );
    }
    if is_vimeo_url(&url) && method == "auto" {
        return download_auto_cmd(args);
    }
    if want_video {
        if !yt_dlp_installed() {
            bail!(
                "--video requested but yt-dlp is not installed\n\n\
                 yt-dlp is required for video downloads.\n\n\
                 Options:\n  \
                 1. Install:  pip install yt-dlp\n  \
                 2. Install:  brew install yt-dlp\n  \
                 3. Retry:    ap-browser download {url} --video\n\n\
                 For non-video content:\n  \
                 ap-browser download {url}  (without --video)"
            );
        }
        return yt_dlp_download(&url, args, &out);
    }

    if range.is_some() {
        bail!("time ranges require --video, a direct media URL, --hls, or a page stream selected by --auto/--pick");
    }
    let tab = resolve_active_tab(args)?;
    if !silence_hint && is_video_domain(&url) {
        eprintln!("hint: this looks like a video page. Use --video to download via yt-dlp.");
        eprintln!("      (proceeding with {method}; this hint does not block)");
    }

    route_download(&url, &out, &method, tab, profile.as_deref())?;
    Ok(())
}

fn route_download(
    url: &str,
    out: &str,
    method: &str,
    tab: Option<i64>,
    profile: Option<&str>,
) -> Result<()> {
    let _ = ensure_debugger(tab, profile);
    let size = head_content_length(url, tab, profile);
    match method {
        "auto" | "fetch" => {
            let can_fetch = size.map(|s| s < 5_000_000).unwrap_or(true);
            if can_fetch {
                if fetch_chunked_download(url, out, tab, profile).is_ok() {
                    return Ok(());
                }
                eprintln!("[warn] chunked fetch failed, trying curl");
            }
            if curl_download(url, out, tab, profile).is_ok() {
                return Ok(());
            }
            eprintln!("[warn] curl failed or unavailable, falling back to browser download");
            browser_download(url, out, tab)?;
        }
        "browser" => browser_download(url, out, tab)?,
        "cdp" => browser_download(url, out, tab)?,
        other => bail!("unknown --method '{other}'. Use: auto, yt-dlp, fetch, browser, cdp"),
    }
    Ok(())
}

fn curl_download(url: &str, out: &str, tab: Option<i64>, profile: Option<&str>) -> Result<()> {
    if std::process::Command::new("curl")
        .arg("--version")
        .output()
        .is_err()
    {
        bail!("curl not installed");
    }

    let cookie_jar =
        std::env::temp_dir().join(format!("ap-browser-cookies-{}.txt", std::process::id()));
    let mut has_cookies = false;
    if let Some(t) = tab {
        let _ = ensure_debugger(Some(t), profile);
        let resp = cdp(Some(t), profile, "Network.getCookies", json!({}))?;
        if let Some(cookies) = resp
            .get("data")
            .and_then(|d| d.get("result"))
            .and_then(|r| r.get("cookies"))
            .and_then(|c| c.as_array())
        {
            if !cookies.is_empty() {
                let mut jar = String::from("# Netscape HTTP Cookie File\n");
                for cookie in cookies {
                    let name = cookie.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    let value = cookie.get("value").and_then(|v| v.as_str()).unwrap_or("");
                    let domain = cookie.get("domain").and_then(|v| v.as_str()).unwrap_or("");
                    let path = cookie.get("path").and_then(|v| v.as_str()).unwrap_or("/");
                    let secure = if cookie
                        .get("secure")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                    {
                        "TRUE"
                    } else {
                        "FALSE"
                    };
                    let httponly = if cookie
                        .get("httpOnly")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                    {
                        "TRUE"
                    } else {
                        "FALSE"
                    };
                    let expires = cookie
                        .get("expires")
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.0) as u64;
                    let domain_flag = if domain.starts_with('.') {
                        "TRUE"
                    } else {
                        "FALSE"
                    };
                    jar.push_str(&format!(
                        "{domain}\t{domain_flag}\t{path}\t{secure}\t{expires}\t{name}\t{value}\n"
                    ));
                    let _ = httponly;
                }
                std::fs::write(&cookie_jar, jar)?;
                // Restrict cookie jar to owner. Unix-only; Windows user-profile ACL
                // already isolates %TEMP% files from other users.
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(
                        &cookie_jar,
                        std::fs::Permissions::from_mode(0o600),
                    );
                }
                has_cookies = true;
            }
        }
    }

    let filename = if out.is_empty() {
        url.split('/')
            .next_back()
            .and_then(|s| s.split('?').next())
            .unwrap_or("download")
            .to_string()
    } else {
        out.to_string()
    };

    let mut cmd = std::process::Command::new("curl");
    cmd.arg("-L")
        .arg("-s")
        .arg("--fail")
        .arg("-o")
        .arg(&filename);
    if has_cookies {
        cmd.arg("-b").arg(&cookie_jar);
    }
    cmd.arg(url);

    let status = cmd.status().context("failed to run curl")?;

    let _ = std::fs::remove_file(&cookie_jar);

    if !status.success() {
        let _ = std::fs::remove_file(&filename);
        bail!("curl exited with code {:?}", status.code());
    }

    let metadata = std::fs::metadata(&filename)?;
    if metadata.len() < 100 {
        let _ = std::fs::remove_file(&filename);
        bail!(
            "curl downloaded suspiciously small file ({} bytes)",
            metadata.len()
        );
    }

    // Guard: auth-walled URLs (Canvas LTI, SAML SSO, etc.) serve an HTML
    // login/error page with HTTP 200 when cookies don't satisfy the gate.
    // Bail loudly so route_download cascades to browser_download (which
    // carries Chrome's session cookies). Caller can suppress by passing
    // --out file.html or --method browser explicitly.
    if !expects_html(url, out) {
        let mut probe = [0u8; 512];
        let read = std::fs::File::open(&filename)
            .and_then(|mut f| std::io::Read::read(&mut f, &mut probe))
            .unwrap_or(0);
        if read > 0 && looks_like_html(&probe[..read]) {
            let _ = std::fs::remove_file(&filename);
            bail!(
                "curl returned an HTML page instead of the requested file (likely auth-gated URL).\n\
                 hint: retry with  --method browser   (uses Chrome's authenticated session)\n\
                 or pass  --out <file>.html  if you genuinely want the HTML body."
            );
        }
    }

    print_result(
        json!({"ok": true, "data": {"method": "curl", "url": url, "file": filename, "size_bytes": metadata.len()}}),
        &[],
    );
    Ok(())
}

fn fetch_chunked_download(
    url: &str,
    out: &str,
    tab: Option<i64>,
    profile: Option<&str>,
) -> Result<()> {
    let _ = ensure_debugger(tab, profile);

    let fetch_expr = format!(
        r#"(async () => {{
            try {{
                const r = await fetch({url});
                const blob = await r.blob();
                const buf = await blob.arrayBuffer();
                const u8 = new Uint8Array(buf);
                let bin = '';
                for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
                window.__dlB64 = btoa(bin);
                window.__dlMime = blob.type;
                return JSON.stringify({{size: buf.byteLength, b64_len: window.__dlB64.length}});
            }} catch(e) {{ return JSON.stringify({{error: e.message}}); }}
        }})()"#,
        url = json!(url)
    );
    let fetch_result = cdp_eval(tab, profile, &fetch_expr)?;
    let fetch_info: Value =
        serde_json::from_str(fetch_result.as_str().unwrap_or("{}")).unwrap_or(json!({}));
    if fetch_info.get("error").is_some() {
        bail!("fetch failed: {:?}", fetch_info.get("error"));
    }

    let total_b64 = fetch_info
        .get("b64_len")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if total_b64 == 0 {
        bail!("fetch returned empty data");
    }

    let mut full_b64 = String::with_capacity(total_b64 as usize);
    let chunk_size = 400_000u64;
    let mut offset = 0u64;
    while offset < total_b64 {
        let end = (offset + chunk_size).min(total_b64);
        let chunk_expr = format!("window.__dlB64.slice({}, {})", offset, end);
        let chunk = cdp_eval(tab, profile, &chunk_expr)?;
        let chunk_str = chunk.as_str().unwrap_or("");
        full_b64.push_str(chunk_str);
        offset = end;
    }

    let _ = cdp_eval(
        tab,
        profile,
        "delete window.__dlB64; delete window.__dlMime; 'cleaned'",
    );

    let bytes = base64_decode(&full_b64)?;
    if !expects_html(url, out) && looks_like_html(&bytes) {
        bail!(
            "fetch returned an HTML page instead of the requested file (likely auth-gated or CORS-blocked URL).\n\
             hint: retry with  --method browser   (uses Chrome's authenticated session)\n\
             or pass  --out <file>.html  if you genuinely want the HTML body."
        );
    }
    let filename = if out.is_empty() {
        "download.bin".to_string()
    } else {
        out.to_string()
    };
    std::fs::write(&filename, &bytes)?;
    print_result(
        json!({"ok": true, "data": {"method": "fetch-chunked", "url": url, "file": filename, "size_bytes": bytes.len()}}),
        &[],
    );
    Ok(())
}

fn download_list_cmd(args: &[String]) -> Result<()> {
    let mut page = discovery::Page::new(args)?;
    let data = page.discover("downloads", args)?;
    // Include context with the cache; empty lists must replace stale results too.
    let cached = json!({"items": data["items"], "tab": page.reusable_tab(), "profile": extract_profile(args), "instance": page.profile});
    let tmp = std::env::temp_dir().join("ap-browser-download-list.json");
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        file.write_all(serde_json::to_string(&cached)?.as_bytes())?;
    }
    #[cfg(not(unix))]
    std::fs::write(&tmp, serde_json::to_string(&cached)?)?;
    print_result(
        json!({"ok": true, "data": {"items": data["items"], "page_url": data["page_url"]}}),
        args,
    );
    Ok(())
}

fn download_pick_cmd(selector: &str, args: &[String]) -> Result<()> {
    let tmp = std::env::temp_dir().join("ap-browser-download-list.json");
    let items_raw = std::fs::read_to_string(&tmp).with_context(|| {
        "no --list results to pick from; run `ap-browser download --list` first"
    })?;
    let cache: Value = serde_json::from_str(&items_raw)?;
    let items = cache["items"]
        .as_array()
        .ok_or_else(|| anyhow!("old download cache; run --list again"))?;
    let profile = extract_profile(args);
    let instance = crate::socket_client::resolve_socket(profile.as_deref())?;
    if cache["instance"] != json!(instance)
        || (extract_tab(args).is_some() && cache["tab"] != json!(extract_tab(args)))
    {
        bail!("download list belongs to another tab/profile; run --list again for this target");
    }

    let picked = if let Ok(idx) = selector.parse::<usize>() {
        items.get(idx).cloned()
    } else {
        let by_type = items
            .iter()
            .filter(|i| i.get("type").and_then(|v| v.as_str()) == Some(selector))
            .collect::<Vec<_>>();
        if by_type.len() == 1 {
            Some(by_type[0].clone())
        } else if by_type.len() > 1 {
            bail!(
                "ambiguous: {} items match type '{}'. Use --list + --pick <id>.",
                by_type.len(),
                selector
            );
        } else {
            let by_label = items
                .iter()
                .filter(|i| {
                    let label = i.get("label").and_then(|v| v.as_str()).unwrap_or("");
                    label.to_lowercase().contains(&selector.to_lowercase())
                })
                .collect::<Vec<_>>();
            if by_label.len() == 1 {
                Some(by_label[0].clone())
            } else if by_label.len() > 1 {
                bail!(
                    "ambiguous: {} items match label '{}'. Use --list + --pick <id>.",
                    by_label.len(),
                    selector
                );
            } else {
                None
            }
        }
    };

    let item = picked.ok_or_else(|| {
        anyhow!("no item matching '{selector}' found. Run --list to see available items.")
    })?;
    let tab = extract_tab(args).or_else(|| cache["tab"].as_i64());
    download_item(&item, args, tab, Some(&instance))
}

fn download_auto_cmd(args: &[String]) -> Result<()> {
    let mut page = discovery::Page::new(args)?;
    let data = page.discover("downloads", args)?;
    let items = data["items"]
        .as_array()
        .ok_or_else(|| anyhow!("missing discovery results"))?;
    let video_only = has_flag(args, "--video")
        || download_url(args).is_some_and(|u| is_vimeo_url(&u))
        || stream::TimeRange::parse(args)?.is_some();
    let item = discovery::choose_auto(items, video_only)?;
    download_item(item, args, page.tab, page.profile.as_deref())
}

fn download_item(
    item: &Value,
    args: &[String],
    tab: Option<i64>,
    profile: Option<&str>,
) -> Result<()> {
    let url = item["url"]
        .as_str()
        .ok_or_else(|| anyhow!("download item has no URL"))?;
    let method = flag_value(args, "--method").unwrap_or("auto".into());
    let range = stream::TimeRange::parse(args)?;
    if range.is_some() && !matches!(method.as_str(), "auto" | "ffmpeg") {
        bail!("time ranges require --method auto or ffmpeg");
    }
    let stream = method == "ffmpeg"
        || (method == "auto"
            && (matches!(item["type"].as_str(), Some("hls" | "dash"))
                || stream::manifest_format(url).is_some()
                || range.is_some()));
    let out = flag_value(args, "--out").unwrap_or_else(|| {
        if stream {
            if has_flag(args, "--audio-only") {
                "download.m4a".into()
            } else {
                "download.mp4".into()
            }
        } else {
            let kind = item["type"].as_str().unwrap_or("unknown");
            let file = url
                .split(['?', '#'])
                .next()
                .unwrap_or("")
                .rsplit('/')
                .next()
                .unwrap_or("");
            if matches!(kind, "video" | "audio") && file.contains('.') {
                file.to_string()
            } else if kind == "unknown" {
                "download".into()
            } else {
                format!("download.{kind}")
            }
        }
    });
    if stream {
        stream::download(url, &out, args, tab, profile, Some(item))
    } else {
        route_download(url, &out, &method, tab, profile)
    }
}

fn yt_dlp_download(url: &str, args: &[String], out: &str) -> Result<()> {
    extractor::download(url, args, out)
}

fn head_content_length(url: &str, tab: Option<i64>, profile: Option<&str>) -> Option<u64> {
    let _ = ensure_debugger(tab, profile);
    let expr = format!(
        r#"fetch({url}, {{method: 'HEAD'}}).then(r => parseInt(r.headers.get('content-length') || '0')).catch(() => 0)"#,
        url = json!(url)
    );
    let val = cdp_eval(tab, profile, &expr).ok()?;
    val.as_u64()
}

fn browser_download(url: &str, out: &str, tab: Option<i64>) -> Result<()> {
    let mut params = json!({"url": url});
    let filename = if !out.is_empty() {
        std::path::Path::new(out)
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or("download")
            .to_string()
    } else {
        url.split('/')
            .next_back()
            .and_then(|s| s.split('?').next())
            .unwrap_or("download")
            .to_string()
    };
    params["filename"] = json!(filename);
    if let Some(t) = tab {
        params["tab_id"] = json!(t);
    }
    let resp = rpc("download.browser", params, &[])?;

    let downloads_dir = dirs_download();
    let target_path = if out.is_empty() {
        downloads_dir.join(&filename)
    } else if std::path::Path::new(out).is_absolute() {
        std::path::PathBuf::from(out)
    } else {
        std::env::current_dir()?.join(out)
    };

    let dl_file = downloads_dir.join(&filename);
    for _ in 0..30 {
        if dl_file.exists() {
            if dl_file != target_path {
                std::fs::rename(&dl_file, &target_path)?;
            }
            let mut r = resp.clone();
            if let Some(d) = r.get_mut("data").and_then(|d| d.as_object_mut()) {
                d.insert("file".into(), json!(target_path.to_string_lossy()));
            }
            print_result(r, &[]);
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    print_result(resp, &[]);
    eprintln!(
        "[warn] download may still be in progress; check ~/Downloads/{}",
        filename
    );
    Ok(())
}

fn dirs_download() -> std::path::PathBuf {
    dirs::download_dir().unwrap_or_else(|| {
        dirs::home_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("Downloads")
    })
}

fn ensure_debugger(tab: Option<i64>, profile: Option<&str>) -> Result<()> {
    let t = match tab {
        Some(t) => t,
        None => return Ok(()),
    };
    let _ = cdp(
        Some(t),
        profile,
        "Runtime.evaluate",
        json!({"expression": "1"}),
    );
    Ok(())
}

/// ponytail: detect auth-wall HTML bodies masquerading as binary downloads.
/// Reads up to 512 bytes; false negatives are fine — the route_download
/// cascade just continues to browser_download (which carries Chrome cookies).
fn looks_like_html(buf: &[u8]) -> bool {
    if buf.is_empty() {
        return false;
    }
    let n = buf.len().min(512);
    let s = String::from_utf8_lossy(&buf[..n]).to_lowercase();
    let trimmed = s.trim_start_matches(['\u{feff}', ' ', '\t', '\n', '\r']);
    trimmed.starts_with("<!doctype html")
        || trimmed.starts_with("<html")
        || trimmed.starts_with("<head")
        || trimmed.starts_with("<title")
}

fn expects_html(url: &str, out: &str) -> bool {
    let out_lo = out.to_lowercase();
    let url_lo = url.to_lowercase();
    let u = url_lo.split('?').next().unwrap_or("");
    out_lo.ends_with(".html")
        || out_lo.ends_with(".htm")
        || u.ends_with(".html")
        || u.ends_with(".htm")
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

// ── PDF ────────────────────────────────────────────────────────────────────

fn pdf_cmd(args: &[String]) -> Result<()> {
    let out = flag_value(args, "--out").unwrap_or("page.pdf".into());
    let landscape = has_flag(args, "--landscape");
    let format = flag_value(args, "--format").unwrap_or("A4".into());
    let p = std::path::Path::new(&out);
    let filename = p
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("page.pdf")
        .to_string();
    let download_path = p
        .parent()
        .map(|d| {
            if d.as_os_str().is_empty() {
                std::env::current_dir()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string()
            } else {
                d.to_string_lossy().to_string()
            }
        })
        .unwrap_or_else(|| {
            std::env::current_dir()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        });
    let resp = rpc(
        "capture.pdf",
        json!({
            "filename": filename,
            "landscape": landscape,
            "format": format,
            "download_path": download_path,
        }),
        args,
    )?;
    print_result(resp, args);
    Ok(())
}

// ── MHTML ──────────────────────────────────────────────────────────────────

fn mhtml_cmd(args: &[String]) -> Result<()> {
    let out = flag_value(args, "--out").unwrap_or("page.mhtml".into());
    let p = std::path::Path::new(&out);
    let filename = p
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("page.mhtml")
        .to_string();
    let download_path = p
        .parent()
        .map(|d| {
            if d.as_os_str().is_empty() {
                std::env::current_dir()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string()
            } else {
                d.to_string_lossy().to_string()
            }
        })
        .unwrap_or_else(|| {
            std::env::current_dir()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        });
    let resp = rpc(
        "capture.mhtml",
        json!({
            "filename": filename,
            "download_path": download_path,
        }),
        args,
    )?;
    print_result(resp, args);
    Ok(())
}

// ── HAR ────────────────────────────────────────────────────────────────────

fn har_cmd(args: &[String]) -> Result<()> {
    let out = flag_value(args, "--out").unwrap_or("page.har".into());
    let resp = rpc("dev.network.list", json!({}), args)?;
    let requests = resp
        .get("data")
        .and_then(|d| d.get("requests"))
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default();
    if requests.is_empty() {
        eprintln!("warning: no network requests captured; navigate with debugger attached first");
    }
    let entries: Vec<Value> = requests
        .iter()
        .map(|r| {
            let ts_ms = r.get("ts").and_then(|v| v.as_i64()).unwrap_or(0);
            let iso = chrono_iso(ts_ms);
            let duration = r.get("duration_ms").and_then(|v| v.as_f64()).unwrap_or(0.0);
            json!({
                "request": {
                    "method": r.get("method").cloned().unwrap_or(json!("GET")),
                    "url": r.get("url").cloned().unwrap_or(json!("")),
                    "headers": headers_to_array(r.get("request_headers")),
                },
                "response": {
                    "status": r.get("status").cloned().unwrap_or(json!(0)),
                    "statusText": r.get("status_text").cloned().unwrap_or(json!("")),
                    "headers": headers_to_array(r.get("response_headers")),
                    "content": {
                        "size": r.get("response_size").cloned().unwrap_or(json!(0)),
                        "mimeType": r.get("mime_type").cloned().unwrap_or(json!("")),
                    },
                },
                "startedDateTime": iso,
                "time": duration,
            })
        })
        .collect();
    let har = json!({
        "log": {
            "version": "1.2",
            "creator": {"name": "ap-browser", "version": "0.1.0"},
            "entries": entries,
        }
    });
    std::fs::write(&out, serde_json::to_string_pretty(&har)?)?;
    print_result(
        json!({"ok": true, "data": {"file": out, "entries": entries.len()}}),
        args,
    );
    Ok(())
}

fn headers_to_array(headers: Option<&Value>) -> Value {
    match headers {
        Some(Value::Object(map)) => Value::Array(
            map.iter()
                .map(|(k, v)| json!({"name": k, "value": v}))
                .collect(),
        ),
        _ => json!([]),
    }
}

fn chrono_iso(ts_ms: i64) -> String {
    let secs = ts_ms / 1000;
    let millis = ts_ms % 1000;
    format!("{}{:03}Z", chrono_like(secs), millis)
}

fn chrono_like(secs: i64) -> String {
    let days_from_epoch = secs / 86400;
    let rem_secs = secs % 86400;
    let h = rem_secs / 3600;
    let m = (rem_secs % 3600) / 60;
    let s = rem_secs % 60;
    let (y, mo, d) = days_to_ymd(days_from_epoch);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}.")
}

fn days_to_ymd(days: i64) -> (i64, i64, i64) {
    let mut y = 1970i64;
    let mut d = days;
    loop {
        let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
        let yd = if leap { 366 } else { 365 };
        if d < yd {
            break;
        }
        d -= yd;
        y += 1;
    }
    let months = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut mo = 1i64;
    for &md in &months {
        let md = if mo == 2 && ((y % 4 == 0 && y % 100 != 0) || y % 400 == 0) {
            29
        } else {
            md
        };
        if d < md {
            break;
        }
        d -= md;
        mo += 1;
    }
    (y, mo, d + 1)
}

// ── Media extraction ───────────────────────────────────────────────────────

fn media_cmd(args: &[String]) -> Result<()> {
    let mut page = discovery::Page::new(args)?;
    let data = page.discover("media", args)?;
    print_result(json!({"ok": true, "data": {"media": data["media"]}}), args);
    Ok(())
}

// ── Element screenshot (called from main.rs screenshot command) ────────────

pub fn element_screenshot(
    selector: &str,
    out: &str,
    tab: Option<i64>,
    profile: Option<&str>,
) -> Result<()> {
    let _ = ensure_debugger(tab, profile);
    let expr = format!(
        r#"((el) => {{ if (!el) return null; el.scrollIntoView({{block:'center'}}); const r = el.getBoundingClientRect(); return {{x: r.x, y: r.y, width: r.width, height: r.height}}; }})(document.querySelector({}))"#,
        json!(selector)
    );
    let rect = cdp_eval(tab, profile, &expr)?;
    if rect.is_null() {
        bail!("selector matched nothing: {selector}");
    }
    let clip = json!({
        "x": rect.get("x").cloned().unwrap_or(json!(0)),
        "y": rect.get("y").cloned().unwrap_or(json!(0)),
        "width": rect.get("width").cloned().unwrap_or(json!(0)),
        "height": rect.get("height").cloned().unwrap_or(json!(0)),
        "scale": 1,
    });
    let resp = cdp(
        tab,
        profile,
        "Page.captureScreenshot",
        json!({"clip": clip, "format": "png"}),
    )?;
    let data_b64 = resp
        .get("data")
        .and_then(|d| d.get("result"))
        .and_then(|r| r.get("data"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if data_b64.is_empty() {
        bail!("screenshot returned empty data");
    }
    let bytes = base64_decode(data_b64)?;
    std::fs::write(out, &bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn looks_like_html_catches_auth_wall_signatures() {
        assert!(looks_like_html(
            b"<!DOCTYPE html><html><title>Login</title>"
        ));
        assert!(looks_like_html(b"<html><head>"));
        assert!(looks_like_html(b"  \n\t <head><title>"));
        assert!(looks_like_html(b"\xef\xbb\xbf<!doctype html>"));
        // Real Canvas auth-redirect body shape (compact, lowercase)
        assert!(looks_like_html(
            b"<!doctype html><html><head><title>Redirecting</title>"
        ));
    }

    #[test]
    fn looks_like_html_ignores_binary_and_text() {
        assert!(!looks_like_html(b"%PDF-1.7\n\x00\x01\x02\x03"));
        assert!(!looks_like_html(&{
            let mut v = Vec::new();
            v.extend_from_slice(b"PK\x03\x04");
            v.extend(vec![0u8; 200]);
            v
        }));
        assert!(!looks_like_html(b""));
        assert!(!looks_like_html(b"just plain text, not a web page"));
    }

    #[test]
    fn expects_html_respects_explicit_html_out() {
        assert!(expects_html(
            "https://canvas.edu/files/123/download",
            "page.html"
        ));
        assert!(expects_html(
            "https://canvas.edu/files/123/download",
            "page.HTM"
        ));
        assert!(expects_html("https://site.org/index.html", ""));
        assert!(!expects_html(
            "https://canvas.edu/files/123/download?verifier=abc",
            "report.pdf"
        ));
    }
}
