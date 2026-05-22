# VidVerba

VidVerba is a local Tauri desktop app for transcript-guided video clip selection, analysis, and export.

There is no supported web app, website preview, browser fallback, HTTP API, localhost workflow, or dev-server path. Builders and testers should run the desktop shell exclusively.

## Desktop Runtime

- Run the app with `npm start`, `npm run dev`, or `npm run desktop`.
- Build the desktop app with `npm run desktop:build`.
- Check frontend syntax with `npm run check`.
- Check the desktop/Tauri environment with `npm run check:desktop`.

## Launch-Time Config

VidVerba reads a human-editable TOML file before the desktop UI initializes. The repo includes `config.toml`; edit it before launch, or use the sidebar gear panel in the app, to change defaults such as range padding or whether Silence Trim starts enabled.

Config lookup order:

1. `VIDVERBA_CONFIG`, when set to a TOML file path.
2. `config.toml` in the current working directory.
3. `config.toml` next to the desktop executable.
4. The OS app config directory, such as `%APPDATA%\VidVerba\config.toml` on Windows.

Values present in `config.toml` act as runtime overrides. Omitted or commented values fall back to saved in-app JSON settings or built-in defaults.

## Transcription Runtime

VidVerba shells out to the user's configured Python runtime for transcription. Public builds should treat these as user-managed dependencies:

- Required for transcription: Python 3 with `faster-whisper` installed.
- Required for video probing/rendering: `ffmpeg` and `ffprobe`.
- Optional for faster transcription: NVIDIA GPU runtime support available to that Python process, including CUDA/cuBLAS/cuDNN libraries compatible with the installed `ctranslate2`/`faster-whisper` stack.

CUDA is a performance recommendation, not a hard requirement. VidVerba does not bundle or install NVIDIA runtime libraries for public users. If `auto` or `cuda` is selected and CUDA model loading or transcription fails, the helper retries with CPU `int8` and records the CPU fallback reason in the transcript metadata. CPU transcription remains the supported fallback path.

For local development only, the project `.venv` can satisfy CUDA DLL lookup with NVIDIA's Python runtime packages:

```powershell
.\.venv\Scripts\python.exe -m pip install nvidia-cublas-cu12 nvidia-cuda-runtime-cu12 nvidia-cudnn-cu12
```

The frontend in `public/` is bundled by Tauri through `src-tauri/tauri.conf.json`. App behavior must go through `window.__TAURI__` commands handled by `src-tauri/src/lib.rs`. If `window.__TAURI__` is missing, that is a failed launch path, not a cue to add a browser workaround.

## Hard Boundary

Do not add or restore:

- `server.js` or any Node HTTP server.
- Express, Vite dev server, static website preview, or browser API mode.
- `fetch` or XHR fallbacks for app behavior.
- `localhost` or `127.0.0.1` test links.
- npm scripts that launch or validate a web/server runtime.
- alternate data-shape compatibility work whose purpose is to keep a removed server path alive.

## Product Goal

VidVerba helps a user turn recorded video into reviewed, transcript-selected clips without writing shell commands. The app is not a visual video editor. It should work from source metadata, transcripts, timestamp ranges, silence analysis, and export settings.

Do not build embedded video playback, frame extraction, timestamp thumbnails, still-frame inspection, or visual timeline editing based on frames.

## Core Workflow

1. Select one or more source video files from the desktop app.
2. Probe metadata such as duration, resolution, frame rate, file size, and audio presence.
3. Load or generate a transcript with timestamped segments.
4. Review transcript segments and optionally correct timestamps.
5. Select contiguous or non-contiguous transcript ranges.
6. Configure padding, optional silence trim, and export settings.
7. Run Analyze to compute the exact plan.
8. Review and approve the Analyze report.
9. Render only from the approved report.

## Analyze Gate

Analyze is mandatory before every operation that encodes video. Rendering must stay disabled until the app has a fresh report for the exact current source files, transcript selections, timestamp edits, trim settings, padding, output settings, and export order.

Any output-affecting change must mark the report stale and hide or disable render controls. When rendering starts, the backend must use the approved report's final keep ranges. It must not rerun analysis and silently produce a different plan.

The report should include:

- report id and SHA-256 fingerprint
- generated timestamp
- source video metadata
- selected transcript ranges
- detected silence ranges
- final keep ranges
- warnings and blocking errors
- source-relative and selection-relative duration percentages

## Backend Ownership

`src-tauri/src/lib.rs` owns desktop backend behavior:

- workspace and settings persistence
- dependency discovery for ffmpeg, ffprobe, Python, and faster-whisper
- source browsing and video probing
- transcript loading and transcription orchestration
- analysis report generation and fingerprinting
- rendering from approved reports

`src-tauri/resources/transcribe_video.py` is an embedded helper for local transcription. It is not a service endpoint.

## Implementation Notes

- Keep FFmpeg and ffprobe operations centralized in Rust backend helpers.
- Represent transcript segments, selected ranges, analysis reports, and render plans as structured JSON-compatible data.
- Preserve original transcript timestamps separately from user-adjusted timestamps.
- Use adjusted timestamps for selection, analysis, fingerprinting, and rendering.
- Block empty or invalid outputs with human-readable errors before invoking FFmpeg.
- Treat saved approval as invalid if reopened sources or settings no longer match the stored fingerprint.

## Acceptance Checks

- The repo exposes only Tauri desktop run/build commands.
- A builder cannot start a supported local website path from npm scripts.
- Source selection, transcription, timestamp editing, range selection, Analyze, approval, and render all operate inside the desktop app.
- Rendering is impossible before Analyze approval and after any output-affecting stale change.
- No UI requirement depends on frame images, thumbnails, embedded playback, or a browser runtime.
