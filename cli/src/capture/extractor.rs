//! External site extractor boundary. Keep stdout JSON-only and clips transactional.
use super::*;
use std::path::PathBuf;
use std::process::Command;

struct ClipOutput {
    directory: PathBuf,
    temporary: PathBuf,
    output: PathBuf,
}

impl ClipOutput {
    fn new(out: &str, audio_only: bool) -> Result<Self> {
        let name = if out.is_empty() {
            if audio_only {
                "download.mp3"
            } else {
                "download.mp4"
            }
        } else {
            out
        };
        if name.contains('%') {
            bail!("yt-dlp intervals require a concrete --out file, not an output template");
        }
        let output = std::env::current_dir()?.join(name);
        if output.exists() {
            bail!("output already exists; choose another --out path");
        }
        let extension = output.extension().and_then(|s| s.to_str()).unwrap_or("");
        if (audio_only && extension != "mp3")
            || (!audio_only && !["mp4", "mov", "mkv"].contains(&extension))
        {
            bail!("yt-dlp video clips require .mp4/.mov/.mkv; --audio-only clips require .mp3");
        }
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos();
        let directory = output.with_file_name(format!(
            ".ap-browser-extractor-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir(&directory)
            .context("cannot create clip workspace in the requested directory")?;
        let guard = Self {
            temporary: directory.join(format!("clip.{extension}")),
            directory,
            output,
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&guard.directory, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(guard)
    }

    fn publish(&self, files: &[String], expected: Option<f64>) -> Result<(f64, u64)> {
        if files.len() != 1
            || std::fs::canonicalize(&files[0])? != std::fs::canonicalize(&self.temporary)?
        {
            bail!("extractor did not produce exactly the requested clip file");
        }
        let duration = stream::probe_duration(&self.temporary, expected)?;
        let size = std::fs::metadata(&self.temporary)?.len();
        std::fs::hard_link(&self.temporary, &self.output)
            .context("cannot publish clip (output may already exist)")?;
        Ok((duration, size))
    }
}

impl Drop for ClipOutput {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

pub(super) fn download(url: &str, args: &[String], out: &str) -> Result<()> {
    let range = stream::TimeRange::parse(args)?;
    let audio_only = has_flag(args, "--audio-only");
    if range.is_some() && has_flag(args, "--subtitles") {
        bail!("subtitle sidecars are not supported for interval downloads; use a whole-video --subtitles download");
    }
    let clip = range
        .map(|_| ClipOutput::new(out, audio_only))
        .transpose()?;
    let template = match &clip {
        Some(clip) => clip.temporary.to_string_lossy().into_owned(),
        None if out.is_empty() => "%(title)s.%(ext)s".into(),
        None => out.into(),
    };
    let mut cmd = Command::new("yt-dlp");
    cmd.args([
        "--no-playlist",
        "--quiet",
        "--no-progress",
        "--no-simulate",
        "--no-overwrites",
        "--socket-timeout",
        "15",
        "--retries",
        "3",
        "--fragment-retries",
        "3",
        "--print",
        "after_move:%(filepath)j",
        "--cookies-from-browser",
    ])
    .arg(flag_value(args, "--cookies-from").unwrap_or("chrome".into()))
    .arg("--output")
    .arg(&template)
    .arg("--format")
    .arg(
        flag_value(args, "--format")
            .unwrap_or("bestvideo[height<=1080]+bestaudio/best[height<=1080]".into()),
    );
    if let Some(range) = range {
        let end = range
            .duration
            .map(|d| format!("{:.6}", range.start + d))
            .unwrap_or("inf".into());
        cmd.arg("--download-sections")
            .arg(format!("*{:.6}-{end}", range.start))
            .arg("--force-keyframes-at-cuts");
        if !audio_only {
            let extension = clip
                .as_ref()
                .unwrap()
                .output
                .extension()
                .unwrap()
                .to_string_lossy();
            cmd.arg("--merge-output-format")
                .arg(extension.as_ref())
                .arg("--remux-video")
                .arg(extension.as_ref());
        }
    }
    if audio_only {
        cmd.args(["--extract-audio", "--audio-format", "mp3"]);
    }
    if has_flag(args, "--subtitles") {
        cmd.args(["--write-subs", "--write-auto-subs"]);
    }
    let result = cmd.arg(url).output().context("failed to run yt-dlp")?;
    if !result.status.success() {
        // Extractor errors can contain signed media URLs. Keep the failure useful
        // without copying credentials or arbitrary extractor stdout into JSON.
        let stderr = String::from_utf8_lossy(&result.stderr).to_ascii_lowercase();
        let reason = if stderr.contains("signature solving failed")
            || stderr.contains("challenge solving failed")
        {
            "site challenge/signature solver failed (check yt-dlp JavaScript runtime/EJS support)"
        } else if stderr.contains("unable to extract initial state") {
            "site initial state could not be extracted (extractor drift or site risk control)"
        } else if stderr.contains("this video is unavailable")
            || stderr.contains("video unavailable")
        {
            "video unavailable (check the URL/account access)"
        } else if stderr.contains("cookie") || stderr.contains("keychain") {
            "browser-cookie access failed"
        } else if stderr.contains("sign in")
            || stderr.contains("login")
            || stderr.contains("not a bot")
        {
            "site authentication/bot check"
        } else if stderr.contains("401") {
            "HTTP 401 from site extractor"
        } else if stderr.contains("403") {
            "HTTP 403 from site/CDN"
        } else if stderr.contains("412") {
            "HTTP 412 (site risk control)"
        } else if stderr.contains("timed out") {
            "network timeout"
        } else {
            "site extraction or media transfer failed"
        };
        bail!(
            "yt-dlp failed (exit {:?}): {reason}; check account access and update yt-dlp",
            result.status.code()
        );
    }
    let mut files: Vec<String> = String::from_utf8_lossy(&result.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str::<String>(line).ok())
        .collect();
    if files.is_empty() {
        bail!("yt-dlp reported success without a downloaded file");
    }
    let mut data = json!({"method": "yt-dlp", "url": url, "output": if out.is_empty() { "%(title)s.%(ext)s" } else { out }, "files": files});
    if let Some(clip) = &clip {
        let (duration, size) = clip.publish(&files, range.and_then(|r| r.duration))?;
        files = vec![clip.output.to_string_lossy().into_owned()];
        data["files"] = json!(files);
        data["file"] = json!(clip.output.to_string_lossy());
        data["output"] = json!(clip.output.to_string_lossy());
        data["start"] = json!(range.unwrap().start);
        data["duration"] = json!(duration);
        data["requested_duration"] = json!(range.and_then(|r| r.duration));
        data["size_bytes"] = json!(size);
    }
    print_result(json!({"ok": true, "data": data}), args);
    Ok(())
}
