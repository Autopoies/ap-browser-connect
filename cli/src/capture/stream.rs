//! Direct HTTP media/HLS/DASH download and frame-accurate, bounded extraction.
use super::*;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct TimeRange {
    pub start: f64,
    pub duration: Option<f64>,
}

fn timestamp(value: &str) -> Result<f64> {
    let parts: Vec<_> = value.split(':').collect();
    if parts.is_empty() || parts.len() > 3 {
        bail!("invalid time '{value}'; use seconds or HH:MM:SS[.mmm]");
    }
    let mut total = 0.0;
    for (index, part) in parts.iter().enumerate() {
        let last = index + 1 == parts.len();
        if part.is_empty()
            || !part
                .chars()
                .all(|c| c.is_ascii_digit() || (last && c == '.'))
        {
            bail!("invalid time '{value}'; use seconds or HH:MM:SS[.mmm]");
        }
        let n: f64 = part
            .parse()
            .map_err(|_| anyhow!("invalid time '{value}'"))?;
        if !n.is_finite() || (parts.len() > 1 && index > 0 && n >= 60.0) {
            bail!("invalid time '{value}'");
        }
        total = total * 60.0 + n;
    }
    if !total.is_finite() || total > 1e9 {
        bail!("time is too large");
    }
    Ok(total)
}

impl TimeRange {
    pub fn parse(args: &[String]) -> Result<Option<Self>> {
        let start = flag_value(args, "--start");
        let duration = flag_value(args, "--duration");
        let end = flag_value(args, "--end");
        if start.is_none() && duration.is_none() && end.is_none() {
            return Ok(None);
        }
        if duration.is_some() && end.is_some() {
            bail!("--duration and --end are mutually exclusive");
        }
        let start = start.as_deref().map(timestamp).transpose()?.unwrap_or(0.0);
        let duration = match (duration, end) {
            (Some(d), _) => Some(timestamp(&d)?),
            (_, Some(end)) => Some(timestamp(&end)? - start),
            _ => None,
        };
        if duration.is_some_and(|d| d <= 0.0) {
            bail!("duration must be positive and --end must be after --start");
        }
        Ok(Some(Self { start, duration }))
    }
}

pub(super) fn validate_url(url: &str) -> Result<()> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"));
    let empty_host = match rest {
        Some(rest) => rest.split(['/', '?', '#']).next().unwrap_or("").is_empty(),
        None => true,
    };
    if empty_host || url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        bail!("stream downloads require an http(s) URL, not a blob, file or local protocol");
    }
    Ok(())
}

pub(super) fn manifest_format(url: &str) -> Option<&'static str> {
    let path = url
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if path.ends_with(".m3u8") {
        Some("hls")
    } else if path.ends_with(".mpd") {
        Some("dash")
    } else {
        None
    }
}

#[derive(Default)]
struct HttpContext {
    referer: String,
    user_agent: String,
    cookies: String,
}

fn http_context(
    url: &str,
    tab: Option<i64>,
    profile: Option<&str>,
    item: Option<&Value>,
) -> Result<HttpContext> {
    let mut context = HttpContext::default();
    if let Some(referer) = item.and_then(|i| i["referer"].as_str()) {
        context.referer = referer.into();
    }
    if let Some(tab) = tab {
        if context.referer.is_empty() {
            context.referer = cdp_eval(Some(tab), profile, "location.href")?
                .as_str()
                .unwrap_or("")
                .into();
        }
        context.user_agent = cdp_eval(Some(tab), profile, "navigator.userAgent")?
            .as_str()
            .unwrap_or("")
            .into();
        let response = cdp(
            Some(tab),
            profile,
            "Network.getCookies",
            json!({"urls": [url]}),
        )?;
        if let Some(cookies) = response["data"]["result"]["cookies"].as_array() {
            for cookie in cookies {
                let get = |key: &str| cookie[key].as_str().unwrap_or("");
                let fields = [get("name"), get("value"), get("domain"), get("path")];
                if fields.iter().any(|s| s.chars().any(char::is_control)) {
                    bail!("invalid browser cookie");
                }
                context.cookies.push_str(&format!(
                    "{}={}; domain={}; path={};\n",
                    fields[0], fields[1], fields[2], fields[3]
                ));
            }
        }
    }
    if [&context.referer, &context.user_agent]
        .iter()
        .any(|s| s.chars().any(char::is_control))
    {
        bail!("invalid media HTTP headers");
    }
    Ok(context)
}

fn ffmpeg_args(
    url: &str,
    output: &Path,
    range: Option<TimeRange>,
    item: Option<&Value>,
    http: &HttpContext,
    audio_only: bool,
    hls_retry: bool,
) -> Vec<String> {
    let mut args: Vec<String> = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-xerror",
        "-protocol_whitelist",
        "http,https,tcp,tls,crypto",
        "-rw_timeout",
        "15000000",
        "-reconnect",
        "1",
        "-reconnect_streamed",
        "1",
        "-reconnect_on_network_error",
        "1",
        "-reconnect_on_http_error",
        "408,429,5xx",
        "-reconnect_delay_max",
        "5",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    if hls_retry {
        args.extend(["-seg_max_retry".into(), "3".into()]);
    }
    for (flag, value) in [
        ("-referer", &http.referer),
        ("-user_agent", &http.user_agent),
        ("-cookies", &http.cookies),
    ] {
        if !value.is_empty() {
            args.extend([flag.into(), value.clone()]);
        }
    }
    if let Some(range) = range {
        args.extend(["-ss".into(), format!("{:.6}", range.start)]);
    }
    args.extend(["-i".into(), url.into()]);
    if let Some(duration) = range.and_then(|r| r.duration) {
        args.extend(["-t".into(), format!("{duration:.6}")]);
    }
    if let Some(index) = item.and_then(|i| i["program_index"].as_u64()) {
        if !audio_only {
            args.extend(["-map".into(), format!("0:p:{index}:v:0")]);
        }
        args.extend(["-map".into(), format!("0:p:{index}:a:0?")]);
    }
    args.extend(["-sn".into(), "-dn".into()]);
    if audio_only {
        args.extend(["-vn".into(), "-c:a".into(), "aac".into()]);
    } else if range.is_some() {
        // Input -ss seeks near the requested point; accurate_seek + re-encoding
        // discards the preroll. Stream-copy/keyframe clipping is not frame-accurate.
        args.extend(
            [
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac",
            ]
            .into_iter()
            .map(String::from),
        );
    } else {
        args.extend(["-c".into(), "copy".into()]);
    }
    if output
        .extension()
        .is_some_and(|s| s == "mp4" || s == "mov" || s == "m4a")
    {
        args.extend(["-movflags".into(), "+faststart".into()]);
    }
    args.push(output.to_string_lossy().into_owned());
    args
}

struct PartialFile(PathBuf);
impl Drop for PartialFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub(super) fn download(
    url: &str,
    out: &str,
    args: &[String],
    tab: Option<i64>,
    profile: Option<&str>,
    item: Option<&Value>,
) -> Result<()> {
    validate_url(url)?;
    let range = TimeRange::parse(args)?;
    if has_flag(args, "--subtitles")
        || flag_value(args, "--format").is_some()
        || flag_value(args, "--cookies-from").is_some()
    {
        bail!("--format/--subtitles/--cookies-from are yt-dlp options; for page streams use --list + --pick <id> and --profile");
    }
    let ffmpeg = Command::new("ffmpeg")
        .arg("-version")
        .output()
        .context("install ffmpeg (brew install ffmpeg, or your system package manager)")?;
    if !ffmpeg.status.success() {
        bail!("ffmpeg is not usable");
    }
    if !Command::new("ffprobe")
        .arg("-version")
        .output()
        .context("ffprobe is required; install the ffmpeg package")?
        .status
        .success()
    {
        bail!("ffprobe is not usable");
    }
    let audio_only = has_flag(args, "--audio-only");
    let output = PathBuf::from(if out.is_empty() {
        if audio_only {
            "download.m4a"
        } else {
            "download.mp4"
        }
    } else {
        out
    });
    if output.exists() {
        bail!("output already exists; choose another --out path");
    }
    let extension = output.extension().and_then(|s| s.to_str()).unwrap_or("mp4");
    if !["mp4", "mov", "mkv", "m4a"].contains(&extension) {
        bail!("stream --out must use .mp4, .mov, .mkv or .m4a");
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos();
    let temp = PartialFile(output.with_file_name(format!(
        ".ap-browser-stream-{}-{nonce}.{extension}",
        std::process::id()
    )));
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp.0)
        .context("cannot create stream output in the requested directory")?;
    let http = http_context(url, tab, profile, item)?;
    let hls = has_flag(args, "--hls")
        || manifest_format(url) == Some("hls")
        || item.is_some_and(|i| i["format"] == "hls");
    let hls_retry = hls
        && Command::new("ffmpeg")
            .args(["-hide_banner", "-h", "demuxer=hls"])
            .output()
            .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains("seg_max_retry"));
    let result = Command::new("ffmpeg")
        .args(ffmpeg_args(
            url, &temp.0, range, item, &http, audio_only, hls_retry,
        ))
        .output()
        .context("could not start ffmpeg")?;
    if !result.status.success() {
        // ffmpeg diagnostics contain signed URLs/cookies. Do not echo them into
        // agent transcripts, and never publish an incomplete output as success.
        let timeout = String::from_utf8_lossy(&result.stderr)
            .to_ascii_lowercase()
            .contains("timed out");
        bail!("ffmpeg stream download failed{} (exit {:?}); refresh --list if the URL expired. No output was published", if timeout { ": network timeout" } else { "" }, result.status.code());
    }
    let duration = probe_duration(&temp.0, range.and_then(|r| r.duration))?;
    let size = std::fs::metadata(&temp.0)?.len();
    // Same-directory hard link is atomic and cannot clobber an existing file.
    std::fs::hard_link(&temp.0, &output)
        .context("could not publish stream output (path may already exist)")?;
    print_result(
        json!({"ok": true, "data": {"method": "ffmpeg", "file": output.to_string_lossy(), "size_bytes": size,
        "start": range.map_or(0.0, |r| r.start), "duration": duration, "requested_duration": range.and_then(|r| r.duration)}}),
        args,
    );
    Ok(())
}

pub(super) fn probe_duration(path: &Path, expected: Option<f64>) -> Result<f64> {
    let probe = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
        ])
        .arg(path)
        .output()
        .context("ffprobe is required to validate the clip; install ffmpeg")?;
    if !probe.status.success() {
        bail!("ffprobe rejected stream output");
    }
    let info: Value = serde_json::from_slice(&probe.stdout)
        .context("ffprobe could not validate stream output")?;
    let duration = info["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|d| d.is_finite() && *d > 0.0)
        .ok_or_else(|| anyhow!("stream output has no valid duration"))?;
    if let Some(expected) = expected {
        if (duration - expected).abs() > 0.15_f64.max(expected * 0.001) {
            bail!("incomplete stream clip: requested {expected:.3}s, got {duration:.3}s; no output was published");
        }
    }
    Ok(duration)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| s.to_string()).collect()
    }
    #[test]
    fn ranges_accept_player_timeline_and_reject_invalid_values() {
        assert_eq!(
            TimeRange::parse(&args(&["--start", "01:29:00", "--duration", "120"])).unwrap(),
            Some(TimeRange {
                start: 5340.0,
                duration: Some(120.0)
            })
        );
        assert_eq!(
            TimeRange::parse(&args(&["--start", "89:00.125", "--end", "01:31:00.125"]))
                .unwrap()
                .unwrap()
                .duration,
            Some(120.0)
        );
        for flags in [
            vec!["--duration", "0"],
            vec!["--start", "NaN"],
            vec!["--start", "-1"],
            vec!["--start", "1:60"],
            vec!["--start", "2", "--end", "1"],
            vec!["--duration", "2", "--end", "3"],
        ] {
            assert!(TimeRange::parse(&args(&flags)).is_err(), "{flags:?}");
        }
    }
    #[test]
    fn bounded_ffmpeg_seeks_before_input_and_preserves_variant_audio() {
        let item = json!({"program_index": 1});
        let a = ffmpeg_args(
            "https://example.invalid/master.m3u8",
            Path::new("out.mp4"),
            Some(TimeRange {
                start: 5340.0,
                duration: Some(120.0),
            }),
            Some(&item),
            &HttpContext::default(),
            false,
            true,
        );
        let find = |s: &str| a.iter().position(|x| x == s).unwrap();
        assert!(find("-ss") < find("-i"));
        assert!(find("-t") > find("-i"));
        for value in [
            "libx264",
            "aac",
            "0:p:1:v:0",
            "0:p:1:a:0?",
            "-reconnect",
            "-reconnect_streamed",
            "-xerror",
            "-seg_max_retry",
        ] {
            assert!(a.iter().any(|x| x == value), "{value}");
        }
        assert!(!a.iter().any(|x| x == "copy"));
    }
    #[test]
    fn refuses_non_http_input_protocols() {
        for url in [
            "file:///etc/passwd",
            "blob:https://vimeo.com/1",
            "concat:https://a|file:///b",
            "https://",
            "https://a\r\nCookie:bad",
        ] {
            assert!(validate_url(url).is_err());
        }
        assert!(validate_url("https://example.invalid/master.m3u8?sig=fixture").is_ok());
    }
}
