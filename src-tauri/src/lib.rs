use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, UNIX_EPOCH};

const TRANSCRIBE_SCRIPT: &str = include_str!("../resources/transcribe_video.py");
const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mov", "mkv", "webm"];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DependencyPaths {
    ffmpeg: Option<String>,
    ffprobe: Option<String>,
    python: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptionDefaults {
    model: String,
    language: Option<String>,
    device: String,
    compute_type: String,
    beam_size: u32,
}

impl Default for TranscriptionDefaults {
    fn default() -> Self {
        Self {
            model: "base".to_string(),
            language: None,
            device: "cpu".to_string(),
            compute_type: "auto".to_string(),
            beam_size: 5,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportDefaults {
    video_codec: String,
    audio_codec: String,
    edit_friendly: bool,
    frame_rate: Option<f64>,
}

impl Default for ExportDefaults {
    fn default() -> Self {
        Self {
            video_codec: "libx264".to_string(),
            audio_codec: "aac".to_string(),
            edit_friendly: true,
            frame_rate: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DesktopSettings {
    workspace_path: Option<String>,
    dependency_paths: DependencyPaths,
    transcription: TranscriptionDefaults,
    export: ExportDefaults,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DependencyStatus {
    name: String,
    required_for: String,
    configured_path: Option<String>,
    resolved_path: Option<String>,
    available: bool,
    version: Option<String>,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DependencyReport {
    ffmpeg: DependencyStatus,
    ffprobe: DependencyStatus,
    python: DependencyStatus,
    faster_whisper: DependencyStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
    workspace_path: Option<String>,
    default_input_dir: String,
    transcript_root: Option<String>,
    render_root: Option<String>,
    projects_root: Option<String>,
    settings_path: Option<String>,
    settings: DesktopSettings,
    dependencies: DependencyReport,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowseEntry {
    name: String,
    path: String,
    #[serde(rename = "type")]
    entry_type: String,
    size: Option<u64>,
    size_text: String,
    modified_ms: u128,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowseResult {
    current: String,
    parent: Option<String>,
    roots: Vec<String>,
    entries: Vec<BrowseEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VideoMetadata {
    path: String,
    filename: String,
    duration: f64,
    duration_text: String,
    start_time: f64,
    start_time_text: String,
    width: u32,
    height: u32,
    resolution: String,
    frame_rate: Option<f64>,
    frame_rate_text: String,
    file_size: u64,
    file_size_text: String,
    has_audio: bool,
    modified_ms: u128,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeResponse {
    videos: Vec<VideoMetadata>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptRequest {
    source_path: String,
    force: Option<bool>,
    model: Option<String>,
    language: Option<String>,
    device: Option<String>,
    compute_type: Option<String>,
    beam_size: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct RawTranscript {
    #[serde(default)]
    metadata: Value,
    #[serde(default)]
    transcript: String,
    #[serde(default)]
    segments: Vec<RawSegment>,
}

#[derive(Debug, Deserialize)]
struct RawSegment {
    start: f64,
    end: f64,
    #[serde(default)]
    text: String,
    #[serde(default, rename = "adjustedStart")]
    adjusted_start: Option<f64>,
    #[serde(default, rename = "adjustedEnd")]
    adjusted_end: Option<f64>,
    #[serde(default)]
    selected: bool,
    #[serde(default, rename = "timestampAdjusted")]
    timestamp_adjusted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptSegment {
    id: String,
    source_video: String,
    original_start: f64,
    original_end: f64,
    adjusted_start: f64,
    adjusted_end: f64,
    text: String,
    selected: bool,
    timestamp_adjusted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptResponse {
    reused_existing: bool,
    path: String,
    metadata: Value,
    transcript: String,
    segments: Vec<TranscriptSegment>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PaddingSettings {
    #[serde(default)]
    lead_in: f64,
    #[serde(default)]
    lead_out: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SilenceSettings {
    #[serde(default)]
    enabled: bool,
    #[serde(default = "default_threshold_db")]
    threshold_db: f64,
    #[serde(default = "default_min_silence")]
    min_silence_seconds: f64,
    #[serde(default = "default_min_clip")]
    min_clip_seconds: f64,
    #[serde(default = "default_front_padding")]
    front_padding_seconds: f64,
}

impl Default for SilenceSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            threshold_db: default_threshold_db(),
            min_silence_seconds: default_min_silence(),
            min_clip_seconds: default_min_clip(),
            front_padding_seconds: default_front_padding(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ExportSettings {
    #[serde(default)]
    output_file: String,
    #[serde(default = "default_video_codec")]
    video_codec: String,
    #[serde(default = "default_audio_codec")]
    audio_codec: String,
    #[serde(default)]
    edit_friendly: bool,
    #[serde(default)]
    frame_rate: Option<f64>,
    #[serde(default)]
    format: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PlanSettings {
    #[serde(default)]
    padding: PaddingSettings,
    #[serde(default)]
    silence: SilenceSettings,
    #[serde(default)]
    export: ExportSettings,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnalyzeRequest {
    #[serde(default)]
    source_path: Option<String>,
    #[serde(default)]
    source_videos: Vec<String>,
    #[serde(default)]
    transcript_segments: Vec<TranscriptSegment>,
    #[serde(default)]
    settings: PlanSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Range {
    id: String,
    source_video: String,
    #[serde(default)]
    source_range_id: Option<String>,
    #[serde(default)]
    segment_id: Option<String>,
    #[serde(default)]
    original_start: Option<f64>,
    #[serde(default)]
    original_end: Option<f64>,
    #[serde(default)]
    adjusted_start: Option<f64>,
    #[serde(default)]
    adjusted_end: Option<f64>,
    start: f64,
    end: f64,
    duration: f64,
    source: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    lead_in: Option<f64>,
    #[serde(default)]
    lead_out: Option<f64>,
    #[serde(default)]
    source_range_ids: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisSummary {
    source_duration: f64,
    source_duration_text: String,
    selected_duration: f64,
    selected_duration_text: String,
    detected_silence_duration: f64,
    detected_silence_text: String,
    discarded_too_short_duration: f64,
    discarded_too_short_text: String,
    estimated_output_duration: f64,
    estimated_output_text: String,
    estimated_cut_duration: f64,
    estimated_cut_text: String,
    kept_percent_of_source: f64,
    removed_percent_of_source: f64,
    kept_percent_of_selection: f64,
    removed_percent_of_selection: f64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisReport {
    id: String,
    fingerprint: String,
    fingerprint_input: Value,
    generated_at: String,
    status: String,
    source_videos: Vec<VideoMetadata>,
    selected_transcript_ranges: Vec<Range>,
    merged_selected_ranges: Vec<Range>,
    detected_silence_ranges: Vec<Range>,
    final_keep_ranges: Vec<Range>,
    warnings: Vec<String>,
    blocking_errors: Vec<String>,
    summary: AnalysisSummary,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenderRequest {
    report: Value,
    #[serde(default)]
    output_file: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderResult {
    output_file: String,
    size_text: String,
    log_tail: String,
}

fn default_threshold_db() -> f64 {
    -39.0
}

fn default_min_silence() -> f64 {
    0.6
}

fn default_min_clip() -> f64 {
    0.3
}

fn default_front_padding() -> f64 {
    0.1
}

fn default_video_codec() -> String {
    "libx264".to_string()
}

fn default_audio_codec() -> String {
    "aac".to_string()
}

fn app_config_dir() -> Result<PathBuf, String> {
    dirs_next::config_dir()
        .or_else(|| std::env::current_dir().ok())
        .map(|dir| dir.join("VidVerba"))
        .ok_or_else(|| "Could not determine a configuration directory.".to_string())
}

fn bootstrap_path() -> Result<PathBuf, String> {
    Ok(app_config_dir()?.join("bootstrap.json"))
}

fn home_or_current_dir() -> PathBuf {
    dirs_next::home_dir()
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn canonical_or_absolute(path: impl AsRef<Path>) -> PathBuf {
    let path = path.as_ref();
    fs::canonicalize(path).unwrap_or_else(|_| {
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(path)
        }
    })
}

fn ensure_workspace_dirs(workspace: &Path) -> Result<(), String> {
    for child in ["transcripts", "renders", "projects", "tools"] {
        fs::create_dir_all(workspace.join(child)).map_err(|error| {
            format!(
                "Could not create workspace folder {}: {error}",
                workspace.join(child).display()
            )
        })?;
    }
    Ok(())
}

fn workspace_settings_path(workspace: &Path) -> PathBuf {
    workspace.join("settings.json")
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    }
    let body = serde_json::to_string_pretty(value)
        .map_err(|error| format!("Could not serialize JSON: {error}"))?;
    fs::write(path, body).map_err(|error| format!("Could not write {}: {error}", path.display()))
}

fn load_settings() -> DesktopSettings {
    let mut settings = bootstrap_path()
        .ok()
        .as_deref()
        .and_then(read_json::<DesktopSettings>)
        .unwrap_or_default();

    if let Some(workspace) = settings.workspace_path.clone() {
        let workspace_path = PathBuf::from(workspace);
        if let Some(workspace_settings) =
            read_json::<DesktopSettings>(&workspace_settings_path(&workspace_path))
        {
            settings = workspace_settings;
        }
    }

    settings
}

fn save_all_settings(settings: &DesktopSettings) -> Result<(), String> {
    write_json(&bootstrap_path()?, settings)?;
    if let Some(workspace) = &settings.workspace_path {
        let workspace_path = PathBuf::from(workspace);
        ensure_workspace_dirs(&workspace_path)?;
        write_json(&workspace_settings_path(&workspace_path), settings)?;
    }
    Ok(())
}

fn workspace_path(settings: &DesktopSettings) -> Result<PathBuf, String> {
    settings
        .workspace_path
        .as_ref()
        .map(PathBuf::from)
        .ok_or_else(|| "Choose a VidVerba workspace folder before using this action.".to_string())
}

fn resolve_executable(configured: &Option<String>, names: &[&str]) -> Option<PathBuf> {
    if let Some(path) = configured {
        let candidate = PathBuf::from(path);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    for name in names {
        if let Ok(path) = which::which(name) {
            return Some(path);
        }
    }
    None
}

fn command_first_line(executable: &Path, args: &[&str]) -> Option<String> {
    Command::new(executable)
        .args(args)
        .output()
        .ok()
        .and_then(|output| {
            let combined = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            combined.lines().next().map(|line| line.trim().to_string())
        })
}

fn status_for_tool(
    name: &str,
    required_for: &str,
    configured: Option<String>,
    names: &[&str],
    args: &[&str],
    missing_message: &str,
) -> DependencyStatus {
    let resolved = resolve_executable(&configured, names);
    let version = resolved
        .as_deref()
        .and_then(|path| command_first_line(path, args));
    DependencyStatus {
        name: name.to_string(),
        required_for: required_for.to_string(),
        configured_path: configured,
        resolved_path: resolved.as_deref().map(path_to_string),
        available: resolved.is_some(),
        version,
        message: if resolved.is_some() {
            "Ready.".to_string()
        } else {
            missing_message.to_string()
        },
    }
}

fn dependency_report(settings: &DesktopSettings) -> DependencyReport {
    let ffmpeg = status_for_tool(
        "ffmpeg",
        "Analyze silence and render video",
        settings.dependency_paths.ffmpeg.clone(),
        &["ffmpeg"],
        &["-version"],
        "Install ffmpeg or set its path in VidVerba settings.",
    );
    let ffprobe = status_for_tool(
        "ffprobe",
        "Read source video metadata",
        settings.dependency_paths.ffprobe.clone(),
        &["ffprobe"],
        &["-version"],
        "Install ffprobe or set its path in VidVerba settings.",
    );
    let python = status_for_tool(
        "python",
        "Generate transcripts",
        settings.dependency_paths.python.clone(),
        if cfg!(windows) {
            &["python", "py"]
        } else {
            &["python3", "python"]
        },
        &["--version"],
        "Install Python 3 or set its path in VidVerba settings.",
    );

    let faster_whisper = if let Some(python_path) = python.resolved_path.as_ref().map(PathBuf::from)
    {
        let output = Command::new(&python_path)
            .args([
                "-c",
                "import faster_whisper; print(getattr(faster_whisper, '__version__', 'installed'))",
            ])
            .output();
        match output {
            Ok(result) if result.status.success() => {
                let version = String::from_utf8_lossy(&result.stdout).trim().to_string();
                DependencyStatus {
                    name: "faster-whisper".to_string(),
                    required_for: "Generate transcripts".to_string(),
                    configured_path: None,
                    resolved_path: Some(path_to_string(&python_path)),
                    available: true,
                    version: Some(if version.is_empty() {
                        "installed".to_string()
                    } else {
                        version
                    }),
                    message: "Ready.".to_string(),
                }
            }
            Ok(result) => DependencyStatus {
                name: "faster-whisper".to_string(),
                required_for: "Generate transcripts".to_string(),
                configured_path: None,
                resolved_path: Some(path_to_string(&python_path)),
                available: false,
                version: None,
                message: String::from_utf8_lossy(&result.stderr).trim().to_string(),
            },
            Err(error) => DependencyStatus {
                name: "faster-whisper".to_string(),
                required_for: "Generate transcripts".to_string(),
                configured_path: None,
                resolved_path: Some(path_to_string(&python_path)),
                available: false,
                version: None,
                message: format!("Could not run Python import check: {error}"),
            },
        }
    } else {
        DependencyStatus {
            name: "faster-whisper".to_string(),
            required_for: "Generate transcripts".to_string(),
            configured_path: None,
            resolved_path: None,
            available: false,
            version: None,
            message: "Python is required before faster-whisper can be checked.".to_string(),
        }
    };

    DependencyReport {
        ffmpeg,
        ffprobe,
        python,
        faster_whisper,
    }
}

fn executable_or_error(status: &DependencyStatus) -> Result<PathBuf, String> {
    status
        .resolved_path
        .as_ref()
        .map(PathBuf::from)
        .ok_or_else(|| status.message.clone())
}

fn config_from_settings(settings: DesktopSettings) -> AppConfig {
    let workspace = settings.workspace_path.as_ref().map(PathBuf::from);
    let default_input_dir = workspace.clone().unwrap_or_else(home_or_current_dir);
    let dependencies = dependency_report(&settings);
    AppConfig {
        workspace_path: settings.workspace_path.clone(),
        default_input_dir: path_to_string(&default_input_dir),
        transcript_root: workspace.as_ref().map(|path| path_to_string(&path.join("transcripts"))),
        render_root: workspace.as_ref().map(|path| path_to_string(&path.join("renders"))),
        projects_root: workspace.as_ref().map(|path| path_to_string(&path.join("projects"))),
        settings_path: workspace.as_ref().map(|path| path_to_string(&workspace_settings_path(path))),
        settings,
        dependencies,
    }
}

#[tauri::command]
fn get_config() -> Result<AppConfig, String> {
    let settings = load_settings();
    if let Some(workspace) = settings.workspace_path.as_ref() {
        ensure_workspace_dirs(&PathBuf::from(workspace))?;
    }
    Ok(config_from_settings(settings))
}

#[tauri::command]
fn check_dependencies() -> DependencyReport {
    dependency_report(&load_settings())
}

#[tauri::command]
fn set_workspace(path: String) -> Result<AppConfig, String> {
    let workspace = canonical_or_absolute(PathBuf::from(path));
    fs::create_dir_all(&workspace)
        .map_err(|error| format!("Could not create workspace {}: {error}", workspace.display()))?;
    ensure_workspace_dirs(&workspace)?;
    let mut settings = load_settings();
    settings.workspace_path = Some(path_to_string(&workspace));
    save_all_settings(&settings)?;
    Ok(config_from_settings(settings))
}

#[tauri::command]
fn save_settings(settings: DesktopSettings) -> Result<AppConfig, String> {
    if let Some(workspace) = &settings.workspace_path {
        ensure_workspace_dirs(&PathBuf::from(workspace))?;
    }
    save_all_settings(&settings)?;
    Ok(config_from_settings(settings))
}

#[tauri::command]
fn browse_directory(requested_dir: Option<String>) -> Result<BrowseResult, String> {
    let settings = load_settings();
    let fallback = settings
        .workspace_path
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(home_or_current_dir);
    let current = canonical_or_absolute(requested_dir.unwrap_or_else(|| path_to_string(&fallback)));
    if !current.is_dir() {
        return Err(format!("Folder was not found: {}", current.display()));
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(&current)
        .map_err(|error| format!("Could not read {}: {error}", current.display()))?
    {
        let entry = entry.map_err(|error| format!("Could not read directory entry: {error}"))?;
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.starts_with('.') && file_name != "." {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
        let is_dir = metadata.is_dir();
        let ext = path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase());
        if !is_dir && !ext.as_deref().is_some_and(|value| VIDEO_EXTENSIONS.contains(&value)) {
            continue;
        }
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .unwrap_or(Duration::ZERO)
            .as_millis();
        entries.push(BrowseEntry {
            name: file_name,
            path: path_to_string(&path),
            entry_type: if is_dir { "folder" } else { "video" }.to_string(),
            size: if is_dir { None } else { Some(metadata.len()) },
            size_text: if is_dir {
                String::new()
            } else {
                format_bytes(metadata.len())
            },
            modified_ms,
        });
    }
    entries.sort_by(|a, b| {
        a.entry_type
            .cmp(&b.entry_type)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    let mut roots = vec![path_to_string(&home_or_current_dir())];
    if let Some(workspace) = settings.workspace_path {
        roots.insert(0, workspace);
    }
    #[cfg(windows)]
    {
        for letter in b'A'..=b'Z' {
            let drive = format!("{}:\\", letter as char);
            if Path::new(&drive).exists() {
                roots.push(drive);
            }
        }
    }
    #[cfg(not(windows))]
    roots.push("/".to_string());

    let parent = current.parent().map(path_to_string);
    Ok(BrowseResult {
        current: path_to_string(&current),
        parent,
        roots,
        entries,
    })
}

#[tauri::command]
fn probe_videos(paths: Vec<String>) -> Result<ProbeResponse, String> {
    let deps = dependency_report(&load_settings());
    let ffprobe = executable_or_error(&deps.ffprobe)?;
    let mut videos = Vec::new();
    for input_path in paths {
        videos.push(probe_video(&ffprobe, &PathBuf::from(input_path))?);
    }
    Ok(ProbeResponse { videos })
}

#[tauri::command]
fn load_or_run_transcript(request: TranscriptRequest) -> Result<TranscriptResponse, String> {
    let settings = load_settings();
    let workspace = workspace_path(&settings)?;
    ensure_workspace_dirs(&workspace)?;
    let source_path = canonical_or_absolute(&request.source_path);
    if !source_path.is_file() {
        return Err("Select a source video before transcribing.".to_string());
    }

    if !request.force.unwrap_or(false) {
        if let Some(existing) = transcript_candidates(&workspace, &source_path)
            .into_iter()
            .find(|candidate| candidate.is_file())
        {
            return read_transcript_response(&source_path, &existing, true);
        }
    }

    let deps = dependency_report(&settings);
    let python = executable_or_error(&deps.python)?;
    if !deps.faster_whisper.available {
        return Err(deps.faster_whisper.message);
    }

    let script_path = workspace.join("tools").join("transcribe_video.py");
    fs::create_dir_all(script_path.parent().unwrap())
        .map_err(|error| format!("Could not create transcription helper folder: {error}"))?;
    fs::write(&script_path, TRANSCRIBE_SCRIPT)
        .map_err(|error| format!("Could not write transcription helper: {error}"))?;

    let transcript_root = workspace.join("transcripts");
    let mut args: Vec<OsString> = vec![
        script_path.into_os_string(),
        source_path.clone().into_os_string(),
        "--output-dir".into(),
        transcript_root.clone().into_os_string(),
        "--model".into(),
        request
            .model
            .unwrap_or(settings.transcription.model)
            .into(),
        "--device".into(),
        request
            .device
            .unwrap_or(settings.transcription.device)
            .into(),
        "--compute-type".into(),
        request
            .compute_type
            .unwrap_or(settings.transcription.compute_type)
            .into(),
        "--beam-size".into(),
        request
            .beam_size
            .unwrap_or(settings.transcription.beam_size)
            .to_string()
            .into(),
    ];
    if let Some(language) = request.language.or(settings.transcription.language) {
        if !language.trim().is_empty() {
            args.push("--language".into());
            args.push(language.into());
        }
    }

    let output = Command::new(&python)
        .args(args)
        .output()
        .map_err(|error| format!("Could not run transcription: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Transcript generation failed.\n{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let generated = transcript_candidates(&workspace, &source_path)
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| "Transcription finished, but no transcript JSON was found.".to_string())?;
    read_transcript_response(&source_path, &generated, false)
}

#[tauri::command]
fn analyze_plan(request: AnalyzeRequest) -> Result<AnalysisReport, String> {
    let settings = load_settings();
    let workspace = workspace_path(&settings)?;
    ensure_workspace_dirs(&workspace)?;
    let deps = dependency_report(&settings);
    let ffprobe = executable_or_error(&deps.ffprobe)?;
    let ffmpeg = executable_or_error(&deps.ffmpeg)?;

    let mut warnings = Vec::new();
    let mut blocking_errors = Vec::new();
    let mut source_paths: BTreeSet<String> = request
        .source_videos
        .iter()
        .chain(request.source_path.iter())
        .filter(|path| !path.trim().is_empty())
        .map(|path| path_to_string(&canonical_or_absolute(path)))
        .collect();
    if source_paths.is_empty() {
        blocking_errors.push("No source video is selected.".to_string());
    }
    for segment in &request.transcript_segments {
        if segment.selected {
            source_paths.insert(path_to_string(&canonical_or_absolute(&segment.source_video)));
        }
    }

    let mut source_metadata = Vec::new();
    for source in &source_paths {
        match probe_video(&ffprobe, &PathBuf::from(source)) {
            Ok(metadata) => source_metadata.push(metadata),
            Err(error) => blocking_errors.push(error),
        }
    }
    let metadata_by_path: HashMap<String, VideoMetadata> = source_metadata
        .iter()
        .map(|item| (normalize_path_for_identity(&item.path), item.clone()))
        .collect();

    let selected_ranges = build_selected_ranges(&request, &metadata_by_path, &mut blocking_errors);
    if selected_ranges.is_empty() {
        blocking_errors.push("No transcript ranges are selected.".to_string());
    }
    let (merged_selected_ranges, had_overlap) = merge_ranges(&selected_ranges);
    if had_overlap {
        warnings.push("Selected ranges overlap and will be merged before analysis.".to_string());
    }

    if request.settings.silence.enabled {
        for metadata in &source_metadata {
            if !metadata.has_audio {
                blocking_errors
                    .push("No audio stream was detected, so silence trimming cannot run.".to_string());
            }
        }
    }

    let mut detected_silence_ranges = Vec::new();
    let mut final_keep_ranges = Vec::new();
    let mut discarded_too_short_duration = 0.0;

    if blocking_errors.is_empty() {
        if request.settings.silence.enabled {
            for selected_range in &merged_selected_ranges {
                let silences = detect_silence(
                    &ffmpeg,
                    &selected_range.source_video,
                    selected_range.start,
                    selected_range.end,
                    &request.settings.silence,
                )?;
                let base_count = detected_silence_ranges.len();
                for (index, silence) in silences.iter().enumerate() {
                    detected_silence_ranges.push(Range {
                        id: format!("silence_{}", base_count + index + 1),
                        source_video: selected_range.source_video.clone(),
                        source_range_id: Some(selected_range.id.clone()),
                        segment_id: None,
                        original_start: None,
                        original_end: None,
                        adjusted_start: None,
                        adjusted_end: None,
                        start: round_seconds(silence.0),
                        end: round_seconds(silence.1),
                        duration: round_seconds(silence.1 - silence.0),
                        source: "detected-silence".to_string(),
                        text: None,
                        lead_in: None,
                        lead_out: None,
                        source_range_ids: vec![],
                    });
                }
                let (keep, discarded) =
                    silence_to_keep_ranges(selected_range, &silences, &request.settings.silence);
                discarded_too_short_duration += discarded;
                final_keep_ranges.extend(keep);
            }
        } else {
            final_keep_ranges = merged_selected_ranges
                .iter()
                .enumerate()
                .map(|(index, range)| Range {
                    id: format!("keep_{:06}", index + 1),
                    source_video: range.source_video.clone(),
                    source_range_id: Some(range.id.clone()),
                    segment_id: range.segment_id.clone(),
                    original_start: range.original_start,
                    original_end: range.original_end,
                    adjusted_start: range.adjusted_start,
                    adjusted_end: range.adjusted_end,
                    start: range.start,
                    end: range.end,
                    duration: round_seconds(range.end - range.start),
                    source: "transcript-selection".to_string(),
                    text: range.text.clone(),
                    lead_in: range.lead_in,
                    lead_out: range.lead_out,
                    source_range_ids: vec![],
                })
                .collect();
        }

        final_keep_ranges = final_keep_ranges
            .into_iter()
            .filter(|range| range.end > range.start)
            .enumerate()
            .map(|(index, mut range)| {
                range.id = format!("keep_{:06}", index + 1);
                range.duration = round_seconds(range.end - range.start);
                range
            })
            .collect();

        if final_keep_ranges.is_empty() {
            blocking_errors.push(
                "These settings would produce an empty export, so rendering is blocked.".to_string(),
            );
        }
    }

    let source_duration = source_metadata.iter().map(|item| item.duration).sum::<f64>();
    let selected_duration = sum_durations(&merged_selected_ranges);
    let detected_silence_duration = sum_durations(&detected_silence_ranges);
    let estimated_output_duration = sum_durations(&final_keep_ranges);
    let estimated_cut_duration = (source_duration - estimated_output_duration).max(0.0);
    if estimated_output_duration > 0.0 && estimated_output_duration < 5.0 {
        warnings.push("The estimated output is very short.".to_string());
    }
    let kept_percent_of_source = if source_duration > 0.0 {
        estimated_output_duration / source_duration * 100.0
    } else {
        0.0
    };
    let kept_percent_of_selection = if selected_duration > 0.0 {
        estimated_output_duration / selected_duration * 100.0
    } else {
        0.0
    };

    let mut export_settings = serde_json::to_value(&request.settings.export)
        .map_err(|error| format!("Could not serialize export settings: {error}"))?;
    if export_settings
        .get("outputFile")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        export_settings["outputFile"] = Value::String(default_output_file(&workspace));
    }

    let fingerprint_input = json!({
        "sources": source_metadata.iter().map(file_identity_from_metadata).collect::<Vec<_>>(),
        "selectedTranscriptRanges": selected_ranges.iter().map(|range| json!({
            "id": range.id,
            "sourceVideo": normalize_path_for_identity(&range.source_video),
            "originalStart": range.original_start,
            "originalEnd": range.original_end,
            "adjustedStart": range.adjusted_start,
            "adjustedEnd": range.adjusted_end,
            "start": range.start,
            "end": range.end,
            "leadIn": range.lead_in,
            "leadOut": range.lead_out
        })).collect::<Vec<_>>(),
        "settings": {
            "padding": request.settings.padding,
            "silence": request.settings.silence,
            "export": export_settings
        }
    });
    let fingerprint = sha256_canonical(&fingerprint_input);
    let generated_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let status = if blocking_errors.is_empty() {
        "readyToReview"
    } else {
        "blocked"
    }
    .to_string();

    Ok(AnalysisReport {
        id: format!("analysis_{}", generated_at.replace(':', "-").replace(".000Z", "Z")),
        fingerprint,
        fingerprint_input,
        generated_at,
        status,
        source_videos: source_metadata,
        selected_transcript_ranges: selected_ranges
            .iter()
            .cloned()
            .map(strip_source_range_ids)
            .collect(),
        merged_selected_ranges: merged_selected_ranges
            .iter()
            .cloned()
            .map(strip_source_range_ids)
            .collect(),
        detected_silence_ranges,
        final_keep_ranges,
        warnings,
        blocking_errors,
        summary: AnalysisSummary {
            source_duration,
            source_duration_text: format_duration(source_duration),
            selected_duration,
            selected_duration_text: format_duration(selected_duration),
            detected_silence_duration,
            detected_silence_text: format_duration(detected_silence_duration),
            discarded_too_short_duration,
            discarded_too_short_text: format_duration(discarded_too_short_duration),
            estimated_output_duration,
            estimated_output_text: format_duration(estimated_output_duration),
            estimated_cut_duration,
            estimated_cut_text: format_duration(estimated_cut_duration),
            kept_percent_of_source: one_decimal(kept_percent_of_source),
            removed_percent_of_source: one_decimal(100.0 - kept_percent_of_source),
            kept_percent_of_selection: one_decimal(kept_percent_of_selection),
            removed_percent_of_selection: one_decimal(100.0 - kept_percent_of_selection),
        },
    })
}

#[tauri::command]
fn render_report(request: RenderRequest) -> Result<RenderResult, String> {
    let settings = load_settings();
    let workspace = workspace_path(&settings)?;
    ensure_workspace_dirs(&workspace)?;
    let deps = dependency_report(&settings);
    let ffmpeg = executable_or_error(&deps.ffmpeg)?;

    let report = request.report;
    if report.get("status").and_then(Value::as_str) != Some("approved") {
        return Err("Approve a current Analyze report before rendering.".to_string());
    }
    let fingerprint_input = report
        .get("fingerprintInput")
        .or_else(|| report.get("fingerprint_input"))
        .ok_or_else(|| "Approved report is missing its fingerprint input.".to_string())?;
    let expected_fingerprint = report
        .get("fingerprint")
        .and_then(Value::as_str)
        .ok_or_else(|| "Approved report is missing its fingerprint.".to_string())?;
    if sha256_canonical(fingerprint_input) != expected_fingerprint {
        return Err("The approved Analyze report fingerprint is invalid.".to_string());
    }
    validate_report_sources_current(fingerprint_input)?;

    let keep_ranges: Vec<Range> = serde_json::from_value(
        report
            .get("finalKeepRanges")
            .cloned()
            .ok_or_else(|| "The approved report does not contain keep ranges.".to_string())?,
    )
    .map_err(|error| format!("Could not parse keep ranges: {error}"))?;
    if keep_ranges.is_empty() {
        return Err("The approved report does not contain any keep ranges.".to_string());
    }

    let approved_output = fingerprint_input
        .pointer("/settings/export/outputFile")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(default_output_file(&workspace)));
    if let Some(output_file) = request.output_file.as_deref().filter(|value| !value.trim().is_empty())
    {
        if canonical_or_absolute(output_file) != canonical_or_absolute(&approved_output) {
            return Err("Output file changed after approval. Run Analyze again before rendering.".to_string());
        }
    }
    let output_file = canonical_or_absolute(&approved_output);
    if let Some(parent) = output_file.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create output folder {}: {error}", parent.display()))?;
    }

    let source_paths: Vec<String> = keep_ranges
        .iter()
        .map(|range| path_to_string(&canonical_or_absolute(&range.source_video)))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let input_index: HashMap<String, usize> = source_paths
        .iter()
        .enumerate()
        .map(|(index, path)| (normalize_path_for_identity(path), index))
        .collect();

    let source_videos: Vec<VideoMetadata> = serde_json::from_value(
        report
            .get("sourceVideos")
            .cloned()
            .unwrap_or_else(|| Value::Array(vec![])),
    )
    .map_err(|error| format!("Could not parse source metadata: {error}"))?;
    let metadata_by_path: HashMap<String, VideoMetadata> = source_videos
        .into_iter()
        .map(|metadata| (normalize_path_for_identity(&metadata.path), metadata))
        .collect();
    let all_have_audio = source_paths.iter().all(|source| {
        metadata_by_path
            .get(&normalize_path_for_identity(source))
            .is_some_and(|metadata| metadata.has_audio)
    });

    let mut filter_parts = Vec::new();
    let mut concat_labels = Vec::new();
    for (index, range) in keep_ranges.iter().enumerate() {
        let source_index = input_index
            .get(&normalize_path_for_identity(&range.source_video))
            .ok_or_else(|| format!("Missing source input for {}", range.source_video))?;
        filter_parts.push(format!(
            "[{source_index}:v]setpts=PTS-STARTPTS,trim=start={}:end={},setpts=PTS-STARTPTS[v{index}]",
            range.start, range.end
        ));
        concat_labels.push(format!("[v{index}]"));
        if all_have_audio {
            filter_parts.push(format!(
                "[{source_index}:a]asetpts=PTS-STARTPTS,atrim=start={}:end={},asetpts=PTS-STARTPTS[a{index}]",
                range.start, range.end
            ));
            concat_labels.push(format!("[a{index}]"));
        }
    }
    filter_parts.push(format!(
        "{}concat=n={}:v=1:a={}[vout]{}",
        concat_labels.join(""),
        keep_ranges.len(),
        if all_have_audio { 1 } else { 0 },
        if all_have_audio { "[aout]" } else { "" }
    ));

    let export_settings = fingerprint_input
        .pointer("/settings/export")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let video_codec = export_settings
        .get("videoCodec")
        .and_then(Value::as_str)
        .unwrap_or("libx264");
    let audio_codec = export_settings
        .get("audioCodec")
        .and_then(Value::as_str)
        .unwrap_or("aac");

    let mut args: Vec<OsString> = vec!["-hide_banner".into(), "-y".into()];
    for source in &source_paths {
        args.push("-i".into());
        args.push(source.into());
    }
    args.push("-filter_complex".into());
    args.push(filter_parts.join(";").into());
    args.push("-map".into());
    args.push("[vout]".into());
    if all_have_audio {
        args.push("-map".into());
        args.push("[aout]".into());
    }
    args.push("-c:v".into());
    args.push(video_codec.into());
    if all_have_audio {
        args.push("-c:a".into());
        args.push(audio_codec.into());
    }
    if export_settings
        .get("editFriendly")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        args.push("-pix_fmt".into());
        args.push("yuv420p".into());
        args.push("-movflags".into());
        args.push("+faststart".into());
        if let Some(frame_rate) = export_settings.get("frameRate").and_then(Value::as_f64) {
            args.push("-r".into());
            args.push(frame_rate.to_string().into());
        }
    }
    args.push(output_file.clone().into_os_string());

    let output = Command::new(&ffmpeg)
        .args(args)
        .output()
        .map_err(|error| format!("Could not run ffmpeg: {error}"))?;
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        return Err(format!("ffmpeg render failed.\n{stderr}"));
    }

    let size_text = fs::metadata(&output_file)
        .map(|metadata| format_bytes(metadata.len()))
        .unwrap_or_default();
    let lines: Vec<&str> = stderr.lines().collect();
    let log_tail = lines
        .iter()
        .skip(lines.len().saturating_sub(16))
        .copied()
        .collect::<Vec<_>>()
        .join("\n");
    Ok(RenderResult {
        output_file: path_to_string(&output_file),
        size_text,
        log_tail,
    })
}

fn probe_video(ffprobe: &Path, input_path: &Path) -> Result<VideoMetadata, String> {
    let resolved = canonical_or_absolute(input_path);
    if !resolved.is_file() {
        return Err(format!("Video file was not found: {}", resolved.display()));
    }
    let output = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(&resolved)
        .output()
        .map_err(|error| format!("Could not run ffprobe: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "ffprobe failed for {}.\n{}",
            resolved.display(),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let raw: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Could not parse ffprobe output: {error}"))?;
    let streams = raw
        .get("streams")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let video_stream = streams
        .iter()
        .find(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("video"));
    let audio_stream = streams
        .iter()
        .find(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("audio"));
    let format = raw.get("format").unwrap_or(&Value::Null);
    let metadata = fs::metadata(&resolved)
        .map_err(|error| format!("Could not read {}: {error}", resolved.display()))?;
    let duration = format
        .get("duration")
        .and_then(Value::as_str)
        .and_then(|value| value.parse().ok())
        .or_else(|| {
            video_stream
                .and_then(|stream| stream.get("duration"))
                .and_then(Value::as_str)
                .and_then(|value| value.parse().ok())
        })
        .unwrap_or(0.0);
    let start_time = video_stream
        .and_then(|stream| stream.get("start_time"))
        .and_then(Value::as_str)
        .and_then(|value| value.parse().ok())
        .or_else(|| {
            format
                .get("start_time")
                .and_then(Value::as_str)
                .and_then(|value| value.parse().ok())
        })
        .unwrap_or(0.0);
    let width = video_stream
        .and_then(|stream| stream.get("width"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    let height = video_stream
        .and_then(|stream| stream.get("height"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    let frame_rate = video_stream.and_then(|stream| {
        stream
            .get("avg_frame_rate")
            .or_else(|| stream.get("r_frame_rate"))
            .and_then(Value::as_str)
            .and_then(parse_frame_rate)
    });
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .unwrap_or(Duration::ZERO)
        .as_millis();
    Ok(VideoMetadata {
        path: path_to_string(&resolved),
        filename: resolved
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| path_to_string(&resolved)),
        duration,
        duration_text: format_duration(duration),
        start_time,
        start_time_text: format_timestamp(start_time),
        width,
        height,
        resolution: if width > 0 || height > 0 {
            format!("{width} x {height}")
        } else {
            "unknown".to_string()
        },
        frame_rate,
        frame_rate_text: frame_rate
            .map(|value| format!("{value} fps"))
            .unwrap_or_else(|| "unknown".to_string()),
        file_size: metadata.len(),
        file_size_text: format_bytes(metadata.len()),
        has_audio: audio_stream.is_some(),
        modified_ms,
    })
}

fn parse_frame_rate(rate: &str) -> Option<f64> {
    if rate.is_empty() || rate == "0/0" {
        return None;
    }
    if let Some((num, den)) = rate.split_once('/') {
        let num: f64 = num.parse().ok()?;
        let den: f64 = den.parse().ok()?;
        if den == 0.0 {
            return None;
        }
        return Some((num / den * 1000.0).round() / 1000.0);
    }
    rate.parse().ok()
}

fn transcript_candidates(workspace: &Path, source_path: &Path) -> Vec<PathBuf> {
    let stem = source_path
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    vec![workspace.join("transcripts").join(format!("{stem}.json"))]
}

fn read_transcript_response(
    source_path: &Path,
    transcript_path: &Path,
    reused_existing: bool,
) -> Result<TranscriptResponse, String> {
    let raw: RawTranscript = serde_json::from_str(
        &fs::read_to_string(transcript_path)
            .map_err(|error| format!("Could not read {}: {error}", transcript_path.display()))?,
    )
    .map_err(|error| format!("Could not parse {}: {error}", transcript_path.display()))?;
    let source = path_to_string(&canonical_or_absolute(source_path));
    let segments = raw
        .segments
        .into_iter()
        .enumerate()
        .map(|(index, segment)| TranscriptSegment {
            id: format!("seg_{:06}", index + 1),
            source_video: source.clone(),
            original_start: round_seconds(segment.start),
            original_end: round_seconds(segment.end),
            adjusted_start: round_seconds(segment.adjusted_start.unwrap_or(segment.start)),
            adjusted_end: round_seconds(segment.adjusted_end.unwrap_or(segment.end)),
            text: segment.text.trim().to_string(),
            selected: segment.selected,
            timestamp_adjusted: segment.timestamp_adjusted,
        })
        .collect();
    Ok(TranscriptResponse {
        reused_existing,
        path: path_to_string(transcript_path),
        metadata: raw.metadata,
        transcript: raw.transcript,
        segments,
    })
}

fn build_selected_ranges(
    request: &AnalyzeRequest,
    metadata_by_path: &HashMap<String, VideoMetadata>,
    blocking_errors: &mut Vec<String>,
) -> Vec<Range> {
    request
        .transcript_segments
        .iter()
        .filter(|segment| segment.selected)
        .enumerate()
        .filter_map(|(index, segment)| {
            let source_video = path_to_string(&canonical_or_absolute(&segment.source_video));
            let source_key = normalize_path_for_identity(&source_video);
            let source_duration = metadata_by_path
                .get(&source_key)
                .map(|metadata| metadata.duration)
                .unwrap_or(f64::MAX);
            let start = (round_seconds(segment.adjusted_start - request.settings.padding.lead_in))
                .max(0.0);
            let end = round_seconds(segment.adjusted_end + request.settings.padding.lead_out)
                .min(source_duration);
            if !metadata_by_path.contains_key(&source_key) {
                blocking_errors.push(format!(
                    "Selected range references an unknown source video: {source_video}"
                ));
                return None;
            }
            if segment.adjusted_start < 0.0 || segment.adjusted_end < 0.0 {
                blocking_errors.push("One or more selected ranges has a negative timestamp.".to_string());
            }
            if segment.adjusted_start >= segment.adjusted_end {
                blocking_errors.push(
                    "One or more selected ranges has a start time greater than or equal to its end time."
                        .to_string(),
                );
            }
            if segment.adjusted_end > source_duration + 0.001 {
                blocking_errors
                    .push("One or more selected ranges extends beyond the source duration.".to_string());
            }
            let id = format!("range_{:06}", index + 1);
            Some(Range {
                id: id.clone(),
                source_video,
                source_range_id: None,
                segment_id: Some(segment.id.clone()),
                original_start: Some(round_seconds(segment.original_start)),
                original_end: Some(round_seconds(segment.original_end)),
                adjusted_start: Some(round_seconds(segment.adjusted_start)),
                adjusted_end: Some(round_seconds(segment.adjusted_end)),
                start,
                end,
                duration: round_seconds(end - start),
                source: if segment.timestamp_adjusted {
                    "transcript-selection-with-adjusted-timestamps"
                } else {
                    "transcript-selection"
                }
                .to_string(),
                text: Some(segment.text.clone()),
                lead_in: Some(request.settings.padding.lead_in),
                lead_out: Some(request.settings.padding.lead_out),
                source_range_ids: vec![id],
            })
        })
        .collect()
}

fn merge_ranges(ranges: &[Range]) -> (Vec<Range>, bool) {
    let mut sorted = ranges.to_vec();
    sorted.sort_by(|a, b| {
        a.source_video
            .cmp(&b.source_video)
            .then_with(|| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal))
    });
    let mut merged: Vec<Range> = Vec::new();
    let mut had_overlap = false;
    for range in sorted {
        if let Some(previous) = merged.last_mut() {
            if previous.source_video == range.source_video && range.start <= previous.end + 0.001 {
                previous.end = previous.end.max(range.end);
                previous.duration = round_seconds(previous.end - previous.start);
                previous.source_range_ids.extend(range.source_range_ids);
                had_overlap = true;
                continue;
            }
        }
        merged.push(range);
    }
    (merged, had_overlap)
}

fn detect_silence(
    ffmpeg: &Path,
    source_video: &str,
    start: f64,
    end: f64,
    settings: &SilenceSettings,
) -> Result<Vec<(f64, f64)>, String> {
    let duration = (end - start).max(0.0);
    if duration <= 0.0 {
        return Ok(vec![]);
    }
    let duration_text = duration.to_string();
    let start_text = start.to_string();
    let silence_filter = format!(
        "silencedetect=noise={}dB:d={}",
        settings.threshold_db, settings.min_silence_seconds
    );
    let args: Vec<OsString> = vec![
        "-hide_banner".into(),
        "-nostats".into(),
        "-ss".into(),
        start_text.into(),
        "-t".into(),
        duration_text.into(),
        "-i".into(),
        source_video.into(),
        "-vn".into(),
        "-af".into(),
        silence_filter.into(),
        "-f".into(),
        "null".into(),
        "-".into(),
    ];
    let output = Command::new(ffmpeg)
        .args(args)
        .output()
        .map_err(|error| format!("Could not run ffmpeg silence analysis: {error}"))?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        return Err(format!("ffmpeg silence analysis failed.\n{stderr}"));
    }

    let mut silences = Vec::new();
    let mut open_start: Option<f64> = None;
    for line in stderr.lines() {
        if let Some(value) = parse_after(line, "silence_start:") {
            open_start = Some(if value < start - 0.1 { value + start } else { value });
        }
        if let Some(value) = parse_after(line, "silence_end:") {
            if let Some(raw_start) = open_start.take() {
                let silence_end = if value < start - 0.1 { value + start } else { value };
                silences.push((raw_start.max(start), silence_end.min(end)));
            }
        }
    }
    if let Some(raw_start) = open_start {
        silences.push((raw_start.max(start), end));
    }
    Ok(silences
        .into_iter()
        .filter(|(silence_start, silence_end)| silence_end > silence_start)
        .collect())
}

fn parse_after(line: &str, label: &str) -> Option<f64> {
    line.split_once(label)
        .and_then(|(_, rest)| rest.trim().split_whitespace().next())
        .and_then(|value| value.parse().ok())
}

fn silence_to_keep_ranges(selected_range: &Range, silences: &[(f64, f64)], settings: &SilenceSettings) -> (Vec<Range>, f64) {
    let mut keep = Vec::new();
    let mut cursor = selected_range.start;
    let mut sorted_silences = silences.to_vec();
    sorted_silences.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    for (silence_start, silence_end) in sorted_silences {
        if silence_start > cursor {
            keep.push((
                (cursor - settings.front_padding_seconds).max(selected_range.start),
                silence_start,
            ));
        }
        cursor = cursor.max(silence_end);
    }
    if cursor < selected_range.end {
        keep.push((
            (cursor - settings.front_padding_seconds).max(selected_range.start),
            selected_range.end,
        ));
    }

    let mut discarded = 0.0;
    let mut ranges = Vec::new();
    for (index, (start, end)) in keep.into_iter().enumerate() {
        let duration = end - start;
        if duration < settings.min_clip_seconds {
            discarded += duration;
            continue;
        }
        ranges.push(Range {
            id: format!("keep_raw_{}", index + 1),
            source_video: selected_range.source_video.clone(),
            source_range_id: Some(selected_range.id.clone()),
            segment_id: selected_range.segment_id.clone(),
            original_start: selected_range.original_start,
            original_end: selected_range.original_end,
            adjusted_start: selected_range.adjusted_start,
            adjusted_end: selected_range.adjusted_end,
            start: round_seconds(start),
            end: round_seconds(end),
            duration: round_seconds(duration),
            source: "silence-trim-within-transcript-selection".to_string(),
            text: selected_range.text.clone(),
            lead_in: selected_range.lead_in,
            lead_out: selected_range.lead_out,
            source_range_ids: vec![selected_range.id.clone()],
        });
    }
    let (merged, _) = merge_ranges(&ranges);
    (merged, discarded)
}

fn validate_report_sources_current(fingerprint_input: &Value) -> Result<(), String> {
    let sources = fingerprint_input
        .get("sources")
        .and_then(Value::as_array)
        .ok_or_else(|| "Approved report is missing source identities.".to_string())?;
    for identity in sources {
        let path = identity
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| "Approved report contains a source without a path.".to_string())?;
        let current = file_identity(path)?;
        let expected_size = identity.get("size").and_then(Value::as_u64);
        let expected_modified = identity.get("modifiedMs").and_then(Value::as_u64);
        if current.get("path").and_then(Value::as_str) != Some(path)
            || current.get("size").and_then(Value::as_u64) != expected_size
            || current.get("modifiedMs").and_then(Value::as_u64) != expected_modified
        {
            return Err(
                "A source video changed after analysis. Run Analyze again before rendering."
                    .to_string(),
            );
        }
    }
    Ok(())
}

fn file_identity_from_metadata(metadata: &VideoMetadata) -> Value {
    json!({
        "path": normalize_path_for_identity(&metadata.path),
        "size": metadata.file_size,
        "modifiedMs": metadata.modified_ms
    })
}

fn file_identity(input_path: &str) -> Result<Value, String> {
    let resolved = canonical_or_absolute(input_path);
    let metadata = fs::metadata(&resolved)
        .map_err(|error| format!("Could not read {}: {error}", resolved.display()))?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .unwrap_or(Duration::ZERO)
        .as_millis() as u64;
    Ok(json!({
        "path": normalize_path_for_identity(&path_to_string(&resolved)),
        "size": metadata.len(),
        "modifiedMs": modified_ms
    }))
}

fn strip_source_range_ids(mut range: Range) -> Range {
    range.source_range_ids = vec![];
    range
}

fn default_output_file(workspace: &Path) -> String {
    let stamp = Utc::now()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        .replace(':', "-")
        .replace(".000Z", "");
    path_to_string(&workspace.join("renders").join(format!("VidVerba-export-{stamp}.mp4")))
}

fn sum_durations(ranges: &[Range]) -> f64 {
    ranges
        .iter()
        .map(|range| (range.end - range.start).max(0.0))
        .sum()
}

fn normalize_path_for_identity(path: &str) -> String {
    let normalized = path_to_string(&canonical_or_absolute(path)).replace('\\', "/");
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

fn round_seconds(value: f64) -> f64 {
    (value.max(0.0) * 1000.0).round() / 1000.0
}

fn one_decimal(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn format_timestamp(seconds: f64) -> String {
    let total_ms = (seconds.max(0.0) * 1000.0).round() as u64;
    let hours = total_ms / 3_600_000;
    let minutes = (total_ms % 3_600_000) / 60_000;
    let whole_seconds = (total_ms % 60_000) / 1000;
    let ms = total_ms % 1000;
    format!("{hours:02}:{minutes:02}:{whole_seconds:02}.{ms:03}")
}

fn format_duration(seconds: f64) -> String {
    let value = seconds.max(0.0);
    let hours = (value / 3600.0).floor() as u64;
    let minutes = ((value % 3600.0) / 60.0).floor() as u64;
    let sec = value % 60.0;
    if hours > 0 {
        format!("{hours}h {minutes}m {sec:.1}s")
    } else if minutes > 0 {
        format!("{minutes}m {sec:.1}s")
    } else {
        format!("{sec:.1}s")
    }
}

fn format_bytes(bytes: u64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut index = 0;
    while value >= 1024.0 && index < units.len() - 1 {
        value /= 1024.0;
        index += 1;
    }
    if index == 0 {
        format!("{} {}", value.round() as u64, units[index])
    } else {
        format!("{value:.1} {}", units[index])
    }
}

fn stable_value(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(stable_value).collect()),
        Value::Object(map) => {
            let sorted: BTreeMap<String, Value> = map
                .iter()
                .filter_map(|(key, value)| {
                    if value.is_null() {
                        None
                    } else {
                        Some((key.clone(), stable_value(value)))
                    }
                })
                .collect();
            Value::Object(sorted.into_iter().collect())
        }
        Value::Number(number) => number
            .as_f64()
            .map(round_seconds)
            .and_then(serde_json::Number::from_f64)
            .map(Value::Number)
            .unwrap_or_else(|| value.clone()),
        _ => value.clone(),
    }
}

fn sha256_canonical(value: &Value) -> String {
    let canonical = serde_json::to_string(&stable_value(value)).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    format!("{:x}", hasher.finalize())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            check_dependencies,
            get_config,
            set_workspace,
            browse_directory,
            probe_videos,
            load_or_run_transcript,
            analyze_plan,
            render_report,
            save_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running VidVerba");
}
