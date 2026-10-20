use anyhow::{bail, Context, Result};
use ap_browser_core::recording::*;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub const SCRATCH_CAP: u64 = 512 * 1024 * 1024;
pub fn id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!(
        "r_{}_{:x}_{:x}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}
pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn hash_file(p: &Path) -> Result<HashedFile> {
    let mut f = fs::File::open(p)?;
    let mut h = Sha256::new();
    let mut n = 0;
    let mut buf = [0; 65536];
    loop {
        let k = f.read(&mut buf)?;
        if k == 0 {
            break;
        }
        h.update(&buf[..k]);
        n += k as u64;
    }
    Ok(HashedFile {
        sha256: format!("{:x}", h.finalize()),
        bytes: n,
    })
}
pub fn read_bounded(p: &Path, cap: usize) -> Result<Vec<u8>> {
    anyhow::ensure!(
        fs::metadata(p)?.is_file(),
        "input must be a regular file: {}",
        p.display()
    );
    let f = fs::File::open(p).with_context(|| format!("open {}", p.display()))?;
    anyhow::ensure!(
        f.metadata()?.len() <= cap as u64,
        "file exceeds {cap} bytes"
    );
    let mut bytes = Vec::new();
    f.take(cap as u64 + 1).read_to_end(&mut bytes)?;
    anyhow::ensure!(bytes.len() <= cap, "file exceeds {cap} bytes");
    Ok(bytes)
}
/// Own an immutable bounded input snapshot before probing/decoding. Sidecar
/// hashes thus bind exactly the bytes decoded, even if caller input later changes.
pub fn copy_snapshot(source: &Path, dest: &Path) -> Result<HashedFile> {
    let metadata = fs::metadata(source)?;
    anyhow::ensure!(
        metadata.is_file() && metadata.len() <= SCRATCH_CAP,
        "offline input must be a regular file <=512 MiB"
    );
    let input = fs::File::open(source)?;
    write_new(dest, b"")?;
    let mut output = OpenOptions::new().write(true).open(dest)?;
    let bytes = std::io::copy(&mut input.take(SCRATCH_CAP + 1), &mut output)?;
    anyhow::ensure!(
        bytes <= SCRATCH_CAP,
        "offline input snapshot exceeds 512 MiB"
    );
    output.sync_all()?;
    hash_file(dest)
}

pub struct Temp(pub PathBuf);
impl Temp {
    pub fn new(parent: &Path) -> Result<Self> {
        let p = parent.join(format!(".ap-record-{}", id()));
        let mut b = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            b.mode(0o700);
        }
        b.create(&p)?;
        Ok(Self(p))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
pub fn write_new(p: &Path, bytes: &[u8]) -> Result<()> {
    let mut o = OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    let mut f = o.open(p)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    Ok(())
}

/// Bounded process lifetime AND bounded pipes. Reader threads drain even after cap,
/// while the parent kills and waits immediately on overflow/timeout.
pub fn process(cmd: &mut Command, timeout: Duration, cap: usize) -> Result<Vec<u8>> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().with_context(|| {
        format!(
            "cannot start {:?}; install local ffmpeg/ffprobe explicitly",
            cmd.get_program()
        )
    })?;
    let over = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    fn reader<R: Read + Send + 'static>(
        mut r: R,
        cap: usize,
        over: std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> std::sync::mpsc::Receiver<std::io::Result<Vec<u8>>> {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let result = (|| {
                let mut out = Vec::new();
                let mut buf = [0; 8192];
                loop {
                    let n = r.read(&mut buf)?;
                    if n == 0 {
                        break;
                    }
                    let remaining = cap.saturating_sub(out.len());
                    out.extend_from_slice(&buf[..n.min(remaining)]);
                    if n > remaining {
                        over.store(true, Ordering::Relaxed);
                    }
                }
                Ok(out)
            })();
            let _ = tx.send(result);
        });
        rx
    }
    let stdout = reader(child.stdout.take().unwrap(), cap, over.clone());
    let stderr = reader(child.stderr.take().unwrap(), 65536, over.clone());
    let start = Instant::now();
    let mut failure = None;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if start.elapsed() >= timeout || over.load(Ordering::Relaxed) {
            failure = Some(if start.elapsed() >= timeout {
                "process timeout"
            } else {
                "process output limit"
            });
            let _ = child.kill();
            break child.wait()?;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    if let Some(f) = failure {
        bail!("{f}");
    }
    // Do not unconditionally join: an invalid local executable can leave a
    // descendant holding an inherited pipe after its direct child exits.
    let drain_deadline = Instant::now() + Duration::from_millis(250);
    let out = stdout
        .recv_timeout(drain_deadline.saturating_duration_since(Instant::now()))
        .context("process stdout did not close after exit")??;
    let err = stderr
        .recv_timeout(drain_deadline.saturating_duration_since(Instant::now()))
        .context("process stderr did not close after exit")??;
    anyhow::ensure!(!over.load(Ordering::Relaxed), "process output limit");
    anyhow::ensure!(
        status.success(),
        "process failed ({status}): {}",
        String::from_utf8_lossy(&err)
    );
    Ok(out)
}
pub fn ffmpeg() -> Command {
    let mut c = Command::new("ffmpeg");
    c.args(["-hide_banner", "-loglevel", "error", "-nostdin"]);
    c
}
pub fn preflight() -> Result<()> {
    process(
        Command::new("ffprobe").arg("-version"),
        Duration::from_secs(5),
        65536,
    )?;
    let enc = process(
        ffmpeg().arg("-encoders"),
        Duration::from_secs(5),
        1024 * 1024,
    )?;
    for name in ["libx264", "gif", "png"] {
        anyhow::ensure!(
            String::from_utf8_lossy(&enc).contains(name),
            "ffmpeg missing {name} encoder"
        );
    }
    let filters = process(
        ffmpeg().arg("-filters"),
        Duration::from_secs(5),
        1024 * 1024,
    )?;
    for name in ["palettegen", "paletteuse", "scale"] {
        anyhow::ensure!(
            String::from_utf8_lossy(&filters).contains(name),
            "ffmpeg missing {name} filter"
        );
    }
    Ok(())
}

pub struct Output {
    pub video: PathBuf,
    pub metadata: PathBuf,
    pub timeline: PathBuf,
    pub temp: Temp,
    pub sidecars: bool,
}
impl Output {
    pub fn new(out: Option<&Path>, sidecars: bool, input: Option<&Path>) -> Result<Self> {
        let out = out.context("explicit --out PATH is required for final video generation")?;
        anyhow::ensure!(out.file_name().is_some(), "--out needs a filename");
        let out = if out.is_absolute() {
            out.to_path_buf()
        } else {
            std::env::current_dir()?.join(out)
        };
        let parent = out
            .parent()
            .context("output parent")?
            .canonicalize()
            .context("output parent must exist and be writable")?;
        let video = parent.join(out.file_name().unwrap());
        anyhow::ensure!(
            video.to_str().is_some(),
            "output path must be valid Unicode for JSON path reporting"
        );
        let stem = video
            .file_stem()
            .context("output basename")?
            .to_string_lossy();
        let metadata = parent.join(format!("{stem}.metadata.json"));
        let timeline = parent.join(format!("{stem}.timeline.jsonl"));
        for p in [&video, &metadata, &timeline] {
            anyhow::ensure!(
                fs::symlink_metadata(p).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound),
                "output already exists or is inaccessible: {} (no overwrite)",
                p.display()
            );
        }
        if let Some(input) = input {
            anyhow::ensure!(
                input.canonicalize()? != video,
                "output must not replace input"
            );
        }
        let temp = Temp::new(&parent).context("output directory is not writable")?;
        Ok(Self {
            video,
            metadata,
            timeline,
            temp,
            sidecars,
        })
    }
    pub fn publish(&self) -> Result<()> {
        let mut pairs = vec![(self.temp.0.join("video"), &self.video)];
        if self.sidecars {
            pairs.push((self.temp.0.join("timeline"), &self.timeline));
            pairs.push((self.temp.0.join("metadata"), &self.metadata));
        }
        let mut created = Vec::new();
        let result = (|| -> Result<()> {
            for (source, dest) in pairs {
                fs::File::open(&source)?.sync_all()?;
                fs::hard_link(&source, dest)?;
                created.push(dest.clone());
            }
            #[cfg(unix)]
            fs::File::open(self.video.parent().unwrap())?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            for p in created.iter().rev() {
                let _ = fs::remove_file(p);
            }
        }
        result.context("atomic no-clobber artifact publication failed")
    }
}
