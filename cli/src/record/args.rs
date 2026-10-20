use clap::{Args, Subcommand};
use std::path::PathBuf;

/// Capture locally encoded, silent viewport video. Final video always requires --out.
#[derive(Args, Debug)]
pub struct RecordArgs {
    #[command(subcommand)]
    pub command: Option<Action>,
    #[command(flatten)]
    pub capture: CaptureArgs,
    #[command(flatten)]
    pub export: ExportArgs,
    /// Fixed recording duration (e.g. 5s, 1500ms), maximum 60s.
    #[arg(long, default_value = "5s")]
    pub duration: String,
}
#[derive(Subcommand, Debug)]
pub enum Action {
    Start {
        #[command(flatten)]
        capture: CaptureArgs,
        #[command(flatten)]
        export: ExportArgs,
    },
    Status {
        handle: String,
    },
    Stop {
        handle: String,
        #[command(flatten)]
        export: ExportArgs,
    },
    Export {
        handle: String,
        #[command(flatten)]
        export: ExportArgs,
    },
    Release {
        handle: String,
    },
    Phase {
        handle: String,
        #[arg(long)]
        text: String,
        #[arg(long)]
        operation_id: Option<String>,
    },
    Mark {
        handle: String,
        #[arg(long)]
        text: String,
        #[arg(long, default_value = "2s")]
        duration: String,
        #[arg(long)]
        operation_id: Option<String>,
    },
    /// Add task text to an existing video without altering the input.
    Watermark {
        input: PathBuf,
        /// Matched metadata requires its adjacent timeline (or --timeline).
        #[arg(long)]
        sidecar: Option<PathBuf>,
        #[arg(long, requires = "sidecar")]
        timeline: Option<PathBuf>,
        #[command(flatten)]
        export: ExportArgs,
    },
}
#[derive(Args, Debug, Clone)]
pub struct CaptureArgs {
    #[arg(long, default_value = "60s")]
    pub max_duration: String,
    #[arg(long)]
    pub capture_fps: Option<u32>,
    #[arg(long, default_value_t = 75)]
    pub jpeg_quality: u32,
    /// Fixed CSS viewport rectangle x,y,width,height.
    #[arg(long, conflicts_with = "element")]
    pub region: Option<String>,
    #[arg(long)]
    pub element: Option<String>,
    #[arg(long)]
    pub operation_id: Option<String>,
}
#[derive(Args, Debug, Clone, Default)]
pub struct ExportArgs {
    /// REQUIRED for every video-producing operation; on this CLI machine.
    #[arg(long)]
    pub out: Option<PathBuf>,
    #[arg(long, default_value = "balanced")]
    pub preset: String,
    #[arg(long)]
    pub fps: Option<u32>,
    #[arg(long)]
    pub size: Option<u32>,
    #[arg(long)]
    pub crf: Option<u32>,
    #[arg(long)]
    pub colors: Option<u32>,
    #[arg(long, default_value = "none")]
    pub watermark: String,
    #[arg(long, conflicts_with = "watermark")]
    pub watermark_config: Option<PathBuf>,
    /// CLI-local font file; missing glyphs are errors, including CJK.
    #[arg(long)]
    pub font: Option<PathBuf>,
    #[arg(long = "label")]
    pub labels: Vec<String>,
    #[arg(long)]
    pub run_id: Option<String>,
    /// Explicitly permit interrupted/lower-bound exports.
    #[arg(long)]
    pub partial: bool,
    /// Save hash-bound metadata and presentation timeline, also for clean exports.
    #[arg(long)]
    pub metadata: bool,
}

pub fn duration(s: &str, max: u64) -> anyhow::Result<u64> {
    let (number, multiplier) = if let Some(s) = s.strip_suffix("ms") {
        (s, 1.0)
    } else if let Some(s) = s.strip_suffix('s') {
        (s, 1000.0)
    } else {
        (s, 1000.0)
    };
    let n: f64 = number.parse()?;
    let ms = n * multiplier;
    anyhow::ensure!(
        ms.is_finite() && ms >= 1.0 && ms <= max as f64 && ms.fract() == 0.0,
        "duration must be integral milliseconds in 1..={max}"
    );
    Ok(ms as u64)
}
