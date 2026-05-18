# Objective: Rebuild VidVerba into a Human-Friendly Clip Selection UI

VidVerba should become a human-usable local desktop or local web interface for reviewing, selecting, analyzing, and exporting video clips.

The future UI is the product target. Existing PowerShell and command-line scripts can be reused as implementation references or backend helpers, but their current user-facing workflows do not need to remain compatible for this rebuild.

The core requirement for the rebuild is that Analyze Mode is mandatory before any video encoding takes place. Users must see and approve a fresh analysis report for the exact current settings before the app renders video.

## Product Boundary

VidVerba is not a visual video editor. The UI should work from source file metadata, transcripts, timestamp ranges, silence analysis, and export settings.

Do not build:

- embedded video playback
- frame extraction
- timestamp-based thumbnails
- filmstrip previews
- still-frame inspection
- visual timeline editing based on frame images

The app does not need access to actual frame images to support the intended workflow.

## Current Stack Verdict

OBS + NVENC + CQP is appropriate for capture. The RTX 4080 SUPER supports modern NVIDIA hardware encoding, and AV1 is a good option for future YouTube-style recordings when compatibility is acceptable. Keep H.264 when maximum editor/tool compatibility matters.

FFmpeg / ffprobe remains the right backend for trimming, concatenation, timestamp slicing, audio extraction, CFR conversion, and metadata. Do not rebuild the media backend first; rebuild the user experience around it.

faster-whisper remains a good local transcription choice, especially with NVIDIA GPU acceleration when CUDA/cuDNN setup is stable. The UI should treat transcription as its own first-class pipeline step: extract audio from video, transcribe it, store JSON/SRT/Markdown, then map transcript selections back to video timestamps.

Recommended stack:

- Capture: OBS using NVENC H.264 or NVENC AV1
- Processing backend: FFmpeg + ffprobe
- Transcription: faster-whisper, GPU-enabled when stable
- Editing-friendly export: H.264/AAC CFR MP4
- UI: VidVerba as a local desktop app or local web UI wrapping reusable backend operations

## Core Workflow

### 1. Select Source Video

After recording in OBS, the user should be able to open the toolkit UI and select one or more video files.

Requirements:

- Provide a file picker for navigating Windows folders.
- Support a configurable default input folder, such as the OBS recording folder.
- Display basic metadata after selection:
  - filename
  - duration
  - resolution
  - frame rate
  - file size
  - audio stream presence

### 2. Choose Workflow

The UI should expose available toolkit actions as clear workflow options.

Initial primary workflow:

- Transcribe video
- Review clickable transcript timestamps
- Optionally edit transcript timestamps
- Select transcript ranges
- Configure export settings
- Optionally configure silence trim settings
- Run final Analyze preflight
- Review and approve the Analyze report
- Render the approved plan

Other actions can remain available as workflows, but every action that encodes video must pass through the same mandatory Analyze gate:

- Silence trim
- Transcript-range rendering
- Transcript-based concatenation
- Final MP4 export
- Edit-friendly CFR conversion

The Analyze gate does not apply to transcription, metadata probing, project save/load, or analysis itself.

### 3. Generate and Review Transcript

The transcription workflow should:

- Run the existing MP4 transcription process or its backend equivalent.
- Generate timestamped transcript data.
- Display results inside the UI.

The transcript view should show:

- segment text
- start timestamp
- end timestamp
- optional confidence/metadata if available
- clickable timestamps for review/navigation

No transcript interaction should require an embedded video player. Clickable timestamps are for navigating transcript context, opening the timestamp-editing step, and selecting ranges.

### 4. Edit Transcript Timestamps

After reviewing clickable transcript timestamps, the user should be able to optionally correct transcript timing before selecting final ranges.

Requirements:

- Allow editing a segment start timestamp.
- Allow editing a segment end timestamp.
- Use auto-formatted timestamp inputs, such as `HH:MM:SS.mmm`.
- Accept forgiving typed input where practical, then normalize it into the canonical timestamp format.
- Validate that timestamps are non-negative, within the source duration, and have `start < end`.
- Preserve the original transcript-provided timestamps separately from user-corrected timestamps.
- Clearly show when a timestamp has been manually adjusted.
- Use adjusted timestamps for selection, analysis, fingerprinting, and export planning.

This step exists to let the user force a transcript segment to a different time than the transcription backend originally provided.

### 5. Manual Timestamp Selection

The user must be able to manually select transcript segments that are relevant.

Requirements:

- Allow selecting any number of transcript timestamp segments.
- Allow deselecting segments.
- Support contiguous and non-contiguous selections.
- Show selected ranges clearly.
- Provide a summary of selected duration.
- Preserve both original transcript timestamps and adjusted user timestamps.

Example:

```text
[ ] 00:01:12 -> 00:01:25  Discussion of patch notes
[x] 00:03:40 -> 00:04:10  Important build explanation
[x] 00:07:22 -> 00:08:05  Boss fight commentary
```

### 6. Configure Export Plan

After timestamp selection, the user should be able to configure downstream video operations only against the selected transcript ranges.

Initial downstream action:

- Optional SilenceTrim against selected timestamp ranges only.

This means the system should:

- Treat selected transcript ranges as the high-level keep regions.
- Optionally expand those regions with configurable padding.
- Run silence analysis only inside those selected regions.
- Build the final output from the resulting keep ranges.

Transcript selection and silence trimming must remain composable:

```text
Original video
-> transcript timestamp selection
-> optional timestamp correction
-> optional padding
-> optional silence analysis inside selected ranges
-> final keep ranges
-> final Analyze preflight
-> user approval
-> render/export
```

Transcript selection should not replace silence trimming. When silence trimming is enabled, transcript selection should constrain where silence trimming is allowed to operate.

### 7. Mandatory Analyze Preflight

Analyze Mode is a required final step before every video encoding operation.

Encoding controls must be disabled until the app has a fresh Analyze report for the exact current inputs and settings. Any change to source files, selected transcript ranges, padding, silence threshold, minimum silence, minimum clip length, output format, concatenation order, or export settings invalidates the report and requires Analyze to run again.

The encode action should appear only from the current Analyze report and should use approval language such as `Render This Plan`. The user should understand they are approving a specific computed plan, not starting a blind export.

When encoding starts, the backend must use the final keep ranges from the approved Analyze report. It must not rerun analysis and risk producing a different plan from the one the user approved.

## Analyze Report

Analyze Mode should be rebuilt around a structured report object that the UI can render and the backend can encode from.

The report should include:

- report id
- report fingerprint/hash over all inputs and settings
- generated timestamp
- source video metadata
- selected transcript ranges, if any
- silence-detected ranges
- final keep ranges
- warning and blocking-error lists
- human-readable summary fields

Required human-readable summary fields:

- source duration
- selected transcript duration
- detected silence duration
- discarded-too-short duration
- final estimated output duration
- estimated cut duration
- percent kept and percent removed relative to original source
- percent kept and percent removed relative to selected transcript ranges when selections are used

Display ranges as readable timestamps plus durations:

```text
00:03:40.200 -> 00:04:10.000, 29.8s
```

Group report details by source video, then by selected transcript range, then by final keep ranges inside that selection.

Warnings and blocking states should be written in plain language. Examples:

- No audio stream was detected, so silence trimming cannot run.
- No transcript ranges are selected.
- All possible clips were removed by the current settings.
- One or more selected ranges are invalid, empty, or outside the source duration.
- Selected ranges overlap and will be merged before analysis.
- The estimated output is very short.
- These settings would produce an empty export, so rendering is blocked.

## UI State Rules

The app should track an analysis lifecycle for each export plan.

The UI should also behave like a step-based workflow with forward and backward navigation. The user must be able to move back from later steps to earlier steps, update choices, and continue forward again without restarting the project.

Required navigation behavior:

- Provide forward and backward movement between workflow steps.
- Allow returning from timestamp selection to timestamp editing.
- Allow returning from optional silence trim configuration to timestamp selection or timestamp editing.
- Allow returning from Analyze report review to export settings, optional silence trim settings, timestamp selection, or timestamp editing.
- Preserve prior selections and settings when moving backward.
- Mark downstream analysis as stale when earlier choices change.
- Let the user proceed forward again with the updated choices through the same required Analyze gate.
- Do not model navigation around a video player or visual timeline.

Recommended states:

- `draft`: inputs or settings exist, but no current analysis has been run.
- `analyzing`: analysis is running.
- `readyToReview`: analysis completed and the report matches current settings.
- `approved`: user approved the current report.
- `rendering`: backend is encoding from the approved report.
- `stale`: the report no longer matches current settings.
- `blocked`: analysis found errors that prevent rendering.

Controls:

- Show `Run Analyze` when the plan is `draft` or `stale`.
- Show the report review UI when the plan is `readyToReview`, `approved`, or `blocked`.
- Show `Render This Plan` only when the plan is `approved` and the report fingerprint matches current settings.
- Disable all video encoding controls in `draft`, `analyzing`, `stale`, and `blocked`.
- If the user changes anything that affects output, immediately move the plan to `stale` and hide or disable render controls.

## Initial Architecture Direction

The UI should sit on top of reusable backend operations rather than manually constructing command strings.

Recommended approach:

- Extract shared video operations into reusable backend functions.
- Keep FFmpeg/ffprobe operations centralized.
- Represent transcript segments, selected ranges, analysis reports, and render plans as structured JSON.
- Let the UI call backend commands or APIs with structured inputs.
- Use existing PowerShell scripts only as references or temporary internal helpers where useful.

## Report Fingerprint

The report fingerprint must be a SHA-256 hash over a canonical JSON representation of all inputs and settings that affect the final output.

This includes:

- source video identity: path, size, and last modified timestamp
- selected transcript ranges: start, end, and source video
- manually adjusted transcript timestamps
- padding settings, both global and per-range
- silence trim parameters: threshold, minimum silence, minimum clip length, and related options
- export settings: format, codec, edit-friendly flag, and target frame rate
- concatenation inputs and order, if applicable

The JSON must be normalized before hashing:

- sort object keys consistently
- use stable ordering for arrays
- normalize timestamp values into a single numeric precision
- normalize paths consistently for the current platform
- omit volatile UI-only state that cannot affect output

The fingerprint must change whenever any value that could affect the final output changes.

## Suggested Data Model

Transcript Segment:

```json
{
  "id": "seg_000123",
  "sourceVideo": "D:/Media dump/example.mp4",
  "originalStart": 220.5,
  "originalEnd": 236.8,
  "adjustedStart": 220.2,
  "adjustedEnd": 237.1,
  "text": "This is the important explanation about the build.",
  "selected": true,
  "timestampAdjusted": true
}
```

Selected Range:

```json
{
  "id": "range_000123",
  "sourceVideo": "D:/Media dump/example.mp4",
  "start": 220.2,
  "end": 237.1,
  "leadIn": 1.5,
  "leadOut": 2.0,
  "source": "transcript-selection-with-adjusted-timestamps"
}
```

Final Keep Range:

```json
{
  "id": "keep_000123",
  "sourceVideo": "D:/Media dump/example.mp4",
  "sourceRangeId": "range_000123",
  "start": 220.8,
  "end": 236.7,
  "duration": 15.9,
  "source": "silence-trim-within-transcript-selection"
}
```

Analyze Report:

```json
{
  "id": "analysis_2026-05-18T14-30-00",
  "fingerprint": "sha256-of-inputs-and-settings",
  "status": "readyToReview",
  "summary": {
    "sourceDurationText": "12m 34.2s",
    "selectedDurationText": "3m 10.0s",
    "detectedSilenceText": "48.6s",
    "discardedTooShortText": "4.2s",
    "estimatedOutputText": "2m 17.2s",
    "estimatedCutText": "10m 17.0s",
    "keptPercentOfSource": 18.2,
    "removedPercentOfSource": 81.8,
    "keptPercentOfSelection": 72.2,
    "removedPercentOfSelection": 27.8
  },
  "warnings": [],
  "blockingErrors": [],
  "finalKeepRanges": []
}
```

## Look-Ahead Features

### Transcript-Based Concatenation

Allow selected transcript ranges from one or more videos to be rendered into separate clips or concatenated into one final video.

Possible workflow:

```text
Select source videos
-> transcribe
-> optionally edit transcript timestamps
-> select transcript ranges
-> apply padding/silence trim settings
-> run final Analyze preflight
-> approve report
-> concatenate approved clips
-> export final video
```

### Per-Range Customization

Allow selected transcript ranges to have custom trim behavior.

Examples:

- Larger lead-in before one selected segment.
- Larger lead-out after another segment.
- Disable silence trim for a specific selection.
- Mark a range as "must keep full segment".
- Add notes/labels to selected ranges.

### Project Save/Load

Allow users to save work-in-progress selection state.

A project file could store:

- source video paths
- transcript paths
- selected transcript segments
- manually adjusted transcript timestamps
- custom padding
- last generated Analyze report
- report approval state
- generated keep ranges
- output settings

Saved approval must be invalidated when reopened if the source files, settings, or selections no longer match the stored Analyze report fingerprint.

## Acceptance Criteria

- User can select an OBS-recorded MP4 from the UI.
- User can run transcription without writing PowerShell commands.
- User can review timestamped transcript segments in the UI.
- User can edit transcript timestamps with normalized timestamp inputs.
- User can manually select relevant transcript segments.
- User can navigate backward and forward between steps without restarting the project.
- User can configure rendering against selected transcript timestamp ranges.
- User can optionally configure silence analysis only against selected transcript timestamp ranges.
- User cannot start any video encoding before running Analyze.
- User cannot start any video encoding after settings change until Analyze is rerun.
- Analyze Mode clearly previews the exact final keep ranges before export.
- Analyze Mode shows human-readable durations and percentages.
- Analyze Mode shows both source-relative and selection-relative percentages when transcript selections exist.
- Encoding uses the approved Analyze report's final keep ranges.
- Empty or invalid outputs are blocked with human-readable warnings before FFmpeg is invoked.
- The UI does not require embedded video playback, frame extraction, timestamp thumbnails, or visual timeline editing.
- Output behavior remains compatible with FFmpeg-based toolkit conventions where that compatibility helps the UI.

## Test Plan

- Verify export controls are disabled before Analyze runs.
- Verify Analyze produces readable durations and percentages for full-video silence trimming.
- Verify Analyze produces both original-source percentages and selected-range percentages when transcript selections are active.
- Verify edited transcript timestamps are validated, normalized, preserved separately from originals, and used for analysis.
- Verify backward/forward navigation preserves selections and marks downstream analysis stale after relevant changes.
- Verify changing any selection or trim/export setting invalidates the report and disables encoding again.
- Verify the SHA-256 fingerprint is stable for equivalent canonical JSON and changes for every output-affecting setting.
- Verify encoding uses the approved keep ranges from the report.
- Verify empty or invalid outputs are blocked with human-readable warnings instead of invoking FFmpeg.
- Verify no UI requirement depends on frame images, thumbnails, or an embedded video player.
