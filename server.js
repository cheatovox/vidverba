import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

// Legacy/dev-only HTTP preview server.
//
// Production VidVerba is the Tauri desktop app in src-tauri. The frontend assets
// under public/ are bundled by Tauri and talk to Rust commands through
// window.__TAURI__; they are not intended to run as a standalone browser app.
// Keep production behavior in src-tauri/src/lib.rs, not in this file.

const __filename = fileURLToPath(import.meta.url);
const appRoot = path.dirname(__filename);
const repoRoot = path.resolve(appRoot, "..");
const publicRoot = path.join(appRoot, "public");
const dataRoot = path.join(appRoot, "data");
const transcriptRoot = path.join(dataRoot, "transcripts");
const renderRoot = path.join(appRoot, "renders");

const PORT = Number(process.env.PORT || 5178);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm"]);
const DEFAULT_TRANSCRIPTION_MODEL = "medium";
const TRANSCRIPTION_MODELS = new Set(["tiny", "base", "small", "medium", "large-v3"]);
const DEFAULT_VAD_MIN_SILENCE_MS = 500;
const DEFAULT_HALLUCINATION_SILENCE_THRESHOLD = 1.0;
const DEFAULT_TRANSCRIPT_SILENCE_THRESHOLD_DB = -39;
const LEGACY_DEV_SERVER_ENABLED = process.argv.includes("--legacy-dev-server");
const LEGACY_BROWSER_API_ENABLED = process.argv.includes("--with-legacy-api");

if (!LEGACY_DEV_SERVER_ENABLED) {
  console.error("server.js is legacy/dev-only. Use `npm start` for the Tauri desktop app.");
  console.error("For a static browser preview, run `npm run legacy:web`.");
  process.exit(1);
}

fs.mkdirSync(transcriptRoot, { recursive: true });
fs.mkdirSync(renderRoot, { recursive: true });

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendText(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": contentType });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 25_000_000) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        windowsHide: true,
        maxBuffer: 1024 * 1024 * 64,
        ...options,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function normalizePathForIdentity(inputPath) {
  return path.resolve(inputPath).replaceAll("\\", "/").toLowerCase();
}

function roundSeconds(value) {
  return Math.max(0, Math.round(Number(value || 0) * 1000) / 1000);
}

function normalizeTranscriptionModel(value) {
  const model = String(value || "").trim();
  return TRANSCRIPTION_MODELS.has(model) ? model : DEFAULT_TRANSCRIPTION_MODEL;
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        if (value[key] !== undefined) {
          acc[key] = stableValue(value[key]);
        }
        return acc;
      }, {});
  }
  if (typeof value === "number") {
    return roundSeconds(value);
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function sha256Canonical(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function formatTimestamp(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function formatDuration(seconds) {
  const value = Math.max(0, Number(seconds || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const sec = value % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${sec.toFixed(1)}s`;
  if (minutes > 0) return `${minutes}m ${sec.toFixed(1)}s`;
  return `${sec.toFixed(1)}s`;
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes || 0);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function parseFrameRate(rate) {
  if (!rate || rate === "0/0") return null;
  const [num, den] = String(rate).split("/").map(Number);
  if (!num || !den) return Number(rate) || null;
  return Math.round((num / den) * 1000) / 1000;
}

function fileIdentity(inputPath) {
  const resolved = path.resolve(inputPath);
  const stat = fs.statSync(resolved);
  return {
    path: normalizePathForIdentity(resolved),
    size: stat.size,
    modifiedMs: Math.round(stat.mtimeMs),
  };
}

async function probeVideo(inputPath) {
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`Video file was not found: ${resolved}`);
  }

  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    resolved,
  ]);
  const raw = JSON.parse(stdout);
  const videoStream = raw.streams?.find((stream) => stream.codec_type === "video");
  const audioStream = raw.streams?.find((stream) => stream.codec_type === "audio");
  const stat = fs.statSync(resolved);
  const duration = Number(raw.format?.duration || videoStream?.duration || 0);
  const startTime = Number(videoStream?.start_time || raw.format?.start_time || 0);
  const frameRate = parseFrameRate(videoStream?.avg_frame_rate || videoStream?.r_frame_rate);

  return {
    path: resolved,
    filename: path.basename(resolved),
    duration,
    durationText: formatDuration(duration),
    startTime,
    startTimeText: formatTimestamp(startTime),
    width: Number(videoStream?.width || 0),
    height: Number(videoStream?.height || 0),
    resolution: videoStream ? `${videoStream.width || 0} x ${videoStream.height || 0}` : "unknown",
    frameRate,
    frameRateText: frameRate ? `${frameRate} fps` : "unknown",
    fileSize: stat.size,
    fileSizeText: formatBytes(stat.size),
    hasAudio: Boolean(audioStream),
    modifiedMs: Math.round(stat.mtimeMs),
  };
}

function listWindowsRoots() {
  if (process.platform !== "win32") return ["/"];
  const roots = [];
  for (let code = 65; code <= 90; code += 1) {
    const drive = `${String.fromCharCode(code)}:\\`;
    if (fs.existsSync(drive)) roots.push(drive);
  }
  return roots;
}

function browseDirectory(requestedDir) {
  const current = path.resolve(requestedDir || repoRoot);
  if (!fs.existsSync(current) || !fs.statSync(current).isDirectory()) {
    throw new Error(`Folder was not found: ${current}`);
  }
  const entries = fs
    .readdirSync(current, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith(".") || entry.name === ".")
    .map((entry) => {
      const fullPath = path.join(current, entry.name);
      const isDirectory = entry.isDirectory();
      const ext = path.extname(entry.name).toLowerCase();
      if (!isDirectory && !VIDEO_EXTENSIONS.has(ext)) return null;
      const stat = fs.statSync(fullPath);
      return {
        name: entry.name,
        path: fullPath,
        type: isDirectory ? "folder" : "video",
        size: isDirectory ? null : stat.size,
        sizeText: isDirectory ? "" : formatBytes(stat.size),
        modifiedMs: Math.round(stat.mtimeMs),
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  return {
    current,
    parent: path.dirname(current) === current ? null : path.dirname(current),
    roots: listWindowsRoots(),
    entries,
  };
}

function transcriptCandidates(sourcePath) {
  const stem = path.basename(sourcePath, path.extname(sourcePath));
  return [
    path.join(transcriptRoot, `${stem}.json`),
    path.join(repoRoot, "output", "video-transcripts", `${stem}.json`),
    path.join(repoRoot, "output", "json", `${stem}.json`),
  ];
}

function normalizeTranscript(sourcePath, raw, transcriptPath) {
  const source = path.resolve(sourcePath);
  const segments = (raw.segments || []).map((segment, index) => ({
    id: `seg_${String(index + 1).padStart(6, "0")}`,
    sourceVideo: source,
    originalStart: roundSeconds(segment.start),
    originalEnd: roundSeconds(segment.end),
    adjustedStart: roundSeconds(segment.adjustedStart ?? segment.start),
    adjustedEnd: roundSeconds(segment.adjustedEnd ?? segment.end),
    text: String(segment.text || "").trim(),
    avgLogprob: optionalNumber(segment.avgLogprob ?? segment.avg_logprob),
    compressionRatio: optionalNumber(segment.compressionRatio ?? segment.compression_ratio),
    noSpeechProb: optionalNumber(segment.noSpeechProb ?? segment.no_speech_prob),
    temperature: optionalNumber(segment.temperature),
    words: normalizeWords(segment.words),
    validation: normalizeValidation(segment.validation),
    selected: Boolean(segment.selected),
    timestampAdjusted: Boolean(segment.timestampAdjusted),
  }));
  return {
    path: transcriptPath,
    metadata: raw.metadata || {},
    transcript: raw.transcript || "",
    segments,
  };
}

function optionalNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeWords(words) {
  return Array.isArray(words)
    ? words.map((word) => ({
        start: roundSeconds(word.start),
        end: roundSeconds(word.end),
        word: String(word.word || ""),
        probability: optionalNumber(word.probability),
      }))
    : [];
}

function unknownValidation() {
  return {
    status: "unknown",
    reasons: ["no confidence metadata available"],
    silentDuration: null,
    silentPercent: null,
    leadingSilence: null,
    meanWordProbability: null,
  };
}

function normalizeValidation(validation) {
  if (!validation || typeof validation !== "object") return unknownValidation();
  const status = ["ok", "warning", "bad", "unknown"].includes(validation.status)
    ? validation.status
    : "unknown";
  return {
    status,
    reasons: Array.isArray(validation.reasons) ? validation.reasons.map(String) : [],
    silentDuration: optionalNumber(validation.silentDuration ?? validation.silent_duration),
    silentPercent: optionalNumber(validation.silentPercent ?? validation.silent_percent),
    leadingSilence: optionalNumber(validation.leadingSilence ?? validation.leading_silence),
    meanWordProbability: optionalNumber(
      validation.meanWordProbability ?? validation.mean_word_probability,
    ),
  };
}

async function loadOrRunTranscript(body) {
  const sourcePath = path.resolve(body.sourcePath || "");
  if (!fs.existsSync(sourcePath)) throw new Error("Select a source video before transcribing.");

  if (!body.force) {
    const existing = transcriptCandidates(sourcePath).find((candidate) => fs.existsSync(candidate));
    if (existing) {
      const raw = JSON.parse(fs.readFileSync(existing, "utf8"));
      return { reusedExisting: true, ...normalizeTranscript(sourcePath, raw, existing) };
    }
  }

  const scriptPath = path.join(repoRoot, "Invoke-TranscriptMp4.ps1");
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Transcript script was not found: ${scriptPath}`);
  }

  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    sourcePath,
    "-OutputDir",
    transcriptRoot,
    "-Model",
    normalizeTranscriptionModel(body.model),
    "-Device",
    body.device || "auto",
    "-ComputeType",
    body.computeType || "auto",
    "-BeamSize",
    String(body.beamSize || 5),
    "-VadFilter",
    String(body.vadFilter ?? true),
    "-VadMinSilenceMs",
    String(body.vadMinSilenceMs || DEFAULT_VAD_MIN_SILENCE_MS),
    "-WordTimestamps",
    String(body.wordTimestamps ?? true),
    "-ConditionOnPreviousText",
    String(body.conditionOnPreviousText ?? false),
    "-HallucinationSilenceThreshold",
    String(body.hallucinationSilenceThreshold || DEFAULT_HALLUCINATION_SILENCE_THRESHOLD),
    "-SilenceThresholdDb",
    String(body.silenceThresholdDb || DEFAULT_TRANSCRIPT_SILENCE_THRESHOLD_DB),
  ];
  if (body.language) {
    args.push("-Language", body.language);
  }
  await execFileAsync("pwsh", args, { cwd: repoRoot, timeout: 1000 * 60 * 90 });

  const generated = transcriptCandidates(sourcePath).find((candidate) => fs.existsSync(candidate));
  if (!generated) {
    throw new Error("Transcription finished, but no transcript JSON was found.");
  }
  const raw = JSON.parse(fs.readFileSync(generated, "utf8"));
  return { reusedExisting: false, ...normalizeTranscript(sourcePath, raw, generated) };
}

function overlapOrTouch(a, b) {
  return a.sourceVideo === b.sourceVideo && b.start <= a.end + 0.001;
}

function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => {
    const bySource = a.sourceVideo.localeCompare(b.sourceVideo);
    if (bySource !== 0) return bySource;
    return a.start - b.start;
  });
  const merged = [];
  let hadOverlap = false;
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && overlapOrTouch(previous, range)) {
      previous.end = Math.max(previous.end, range.end);
      previous.duration = roundSeconds(previous.end - previous.start);
      previous.sourceRangeIds.push(...range.sourceRangeIds);
      hadOverlap = true;
    } else {
      merged.push({ ...range, sourceRangeIds: [...range.sourceRangeIds] });
    }
  }
  return { ranges: merged, hadOverlap };
}

function sumDurations(ranges) {
  return ranges.reduce((total, range) => total + Math.max(0, range.end - range.start), 0);
}

async function detectSilence(sourceVideo, start, end, settings) {
  const duration = Math.max(0, end - start);
  if (duration <= 0) return [];
  const thresholdDb = Number(settings.thresholdDb ?? -39);
  const minSilenceSeconds = Number(settings.minSilenceSeconds ?? 0.6);
  const { stderr } = await execFileAsync("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-ss",
    String(start),
    "-t",
    String(duration),
    "-i",
    sourceVideo,
    "-vn",
    "-af",
    `silencedetect=noise=${thresholdDb}dB:d=${minSilenceSeconds}`,
    "-f",
    "null",
    "-",
  ]);

  const silences = [];
  let openStart = null;
  for (const line of stderr.split(/\r?\n/)) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
    if (startMatch) {
      const raw = Number(startMatch[1]);
      openStart = raw < start - 0.1 ? raw + start : raw;
    }
    const endMatch = line.match(/silence_end:\s*([0-9.]+)/);
    if (endMatch && openStart !== null) {
      const raw = Number(endMatch[1]);
      const silenceEnd = raw < start - 0.1 ? raw + start : raw;
      silences.push({
        start: Math.max(start, roundSeconds(openStart)),
        end: Math.min(end, roundSeconds(silenceEnd)),
      });
      openStart = null;
    }
  }
  if (openStart !== null) {
    silences.push({ start: Math.max(start, roundSeconds(openStart)), end });
  }
  return silences.filter((range) => range.end > range.start);
}

async function addSelectedAudioWarnings(selectedRanges, metadataByPath, settings, warnings) {
  const minSilenceSeconds = Number(settings.minSilenceSeconds ?? 0.6);
  const thresholdDb = Number(settings.thresholdDb ?? -39);
  for (const selectedRange of selectedRanges) {
    if (["bad", "warning"].includes(selectedRange.validationStatus)) continue;
    const metadata = metadataByPath.get(normalizePathForIdentity(selectedRange.sourceVideo));
    if (!metadata?.hasAudio) continue;

    const duration = Math.max(0, selectedRange.end - selectedRange.start);
    if (duration < Math.max(minSilenceSeconds, 0.2)) continue;

    let silences = [];
    try {
      silences = await detectSilence(
        selectedRange.sourceVideo,
        selectedRange.start,
        selectedRange.end,
        settings,
      );
    } catch (error) {
      warnings.push(
        `Could not inspect audio inside selected range ${formatTimestamp(selectedRange.start)} - ${formatTimestamp(selectedRange.end)}: ${error.message}`,
      );
      continue;
    }

    const silentDuration = silenceOverlapDuration(selectedRange, silences);
    const silentPercent = duration > 0 ? (silentDuration / duration) * 100 : 0;
    if (silentDuration >= duration - 0.05 || silentPercent >= 90) {
      warnings.push(
        `Selected range ${formatTimestamp(selectedRange.start)} - ${formatTimestamp(selectedRange.end)} is effectively silent (${Math.min(100, silentPercent).toFixed(0)}% below ${thresholdDb.toFixed(1)} dB). Rendering will include this visual range, but the transcript timestamp may point at quiet audio.`,
      );
      continue;
    }

    const leadingSilence = leadingSilenceDuration(selectedRange, silences);
    if (leadingSilence >= 2 && leadingSilence / duration >= 0.25) {
      warnings.push(
        `Selected range ${formatTimestamp(selectedRange.start)} - ${formatTimestamp(selectedRange.end)} starts with ${formatDuration(leadingSilence)} of silence before audio rises above ${thresholdDb.toFixed(1)} dB.`,
      );
    }
  }
}

function addTranscriptValidationWarnings(selectedRanges, warnings) {
  for (const range of selectedRanges) {
    if (!["bad", "warning"].includes(range.validationStatus)) continue;
    const reasons = range.validationReasons?.length
      ? range.validationReasons.join("; ")
      : "no details provided";
    warnings.push(
      `Selected transcript range ${formatTimestamp(range.start)} - ${formatTimestamp(range.end)} was flagged as ${range.validationStatus.toUpperCase()} during transcription: ${reasons}.`,
    );
  }
}

function silenceOverlapDuration(range, silences) {
  return silences.reduce(
    (total, silence) => total + Math.max(0, Math.min(silence.end, range.end) - Math.max(silence.start, range.start)),
    0,
  );
}

function leadingSilenceDuration(range, silences) {
  const leading = silences.find((silence) => silence.start <= range.start + 0.05 && silence.end > range.start);
  return leading ? Math.max(0, Math.min(leading.end, range.end) - range.start) : 0;
}

function silenceToKeepRanges(sourceVideo, sourceRangeId, start, end, silences, settings) {
  const minClipSeconds = Number(settings.minClipSeconds ?? 0.3);
  const frontPaddingSeconds = Number(settings.frontPaddingSeconds ?? 0);
  const keep = [];
  let cursor = start;
  for (const silence of silences.sort((a, b) => a.start - b.start)) {
    if (silence.start > cursor) {
      keep.push({
        sourceVideo,
        sourceRangeId,
        start: Math.max(start, cursor - frontPaddingSeconds),
        end: silence.start,
      });
    }
    cursor = Math.max(cursor, silence.end);
  }
  if (cursor < end) {
    keep.push({
      sourceVideo,
      sourceRangeId,
      start: Math.max(start, cursor - frontPaddingSeconds),
      end,
    });
  }

  let discardedTooShort = 0;
  const longEnough = [];
  for (const range of keep) {
    const duration = range.end - range.start;
    if (duration < minClipSeconds) {
      discardedTooShort += duration;
    } else {
      longEnough.push(range);
    }
  }
  const merged = mergeRanges(
    longEnough.map((range, index) => ({
      ...range,
      id: `keep_raw_${index + 1}`,
      duration: roundSeconds(range.end - range.start),
      source: "silence-trim-within-transcript-selection",
      sourceRangeIds: [range.sourceRangeId],
    })),
  ).ranges;
  return { keep: merged, discardedTooShort };
}

function buildSelectedRanges(body, metadataByPath) {
  const settings = body.settings || {};
  const leadIn = Number(settings.padding?.leadIn ?? 0);
  const leadOut = Number(settings.padding?.leadOut ?? 0);
  const selectedSegments = (body.transcriptSegments || []).filter((segment) => segment.selected);
  return selectedSegments.map((segment, index) => {
    const sourceVideo = path.resolve(segment.sourceVideo || body.sourcePath || "");
    const metadata = metadataByPath.get(normalizePathForIdentity(sourceVideo));
    const sourceDuration = metadata?.duration || Number.MAX_SAFE_INTEGER;
    const start = Math.max(0, roundSeconds(Number(segment.adjustedStart) - leadIn));
    const end = Math.min(sourceDuration, roundSeconds(Number(segment.adjustedEnd) + leadOut));
    return {
      id: `range_${String(index + 1).padStart(6, "0")}`,
      sourceVideo,
      segmentId: segment.id,
      originalStart: roundSeconds(segment.originalStart),
      originalEnd: roundSeconds(segment.originalEnd),
      adjustedStart: roundSeconds(segment.adjustedStart),
      adjustedEnd: roundSeconds(segment.adjustedEnd),
      start,
      end,
      duration: roundSeconds(end - start),
      leadIn,
      leadOut,
      source: segment.timestampAdjusted
        ? "transcript-selection-with-adjusted-timestamps"
        : "transcript-selection",
      text: segment.text || "",
      validationStatus: segment.validation?.status || "unknown",
      validationReasons: segment.validation?.reasons || [],
      sourceRangeIds: [`range_${String(index + 1).padStart(6, "0")}`],
    };
  });
}

async function analyzePlan(body) {
  const warnings = [];
  const blockingErrors = [];
  const settings = body.settings || {};
  const exportSettings = {
    ...(settings.export || {}),
    outputFile: settings.export?.outputFile || defaultOutputFile(),
  };
  const sourcePaths = [...new Set([...(body.sourceVideos || []), body.sourcePath].filter(Boolean).map((p) => path.resolve(p)))];
  if (sourcePaths.length === 0) {
    blockingErrors.push("No source video is selected.");
  }

  const sourceMetadata = [];
  for (const sourcePath of sourcePaths) {
    try {
      sourceMetadata.push(await probeVideo(sourcePath));
    } catch (error) {
      blockingErrors.push(error.message);
    }
  }
  const metadataByPath = new Map(sourceMetadata.map((item) => [normalizePathForIdentity(item.path), item]));
  const selectedRanges = buildSelectedRanges(body, metadataByPath);

  if (selectedRanges.length === 0) {
    blockingErrors.push("No transcript ranges are selected.");
  }
  for (const range of selectedRanges) {
    const metadata = metadataByPath.get(normalizePathForIdentity(range.sourceVideo));
    if (!metadata) {
      blockingErrors.push(`Selected range references an unknown source video: ${range.sourceVideo}`);
      continue;
    }
    if (range.adjustedStart < 0 || range.adjustedEnd < 0) {
      blockingErrors.push("One or more selected ranges has a negative timestamp.");
    }
    if (range.adjustedStart >= range.adjustedEnd) {
      blockingErrors.push("One or more selected ranges has a start time greater than or equal to its end time.");
    }
    if (range.adjustedEnd > metadata.duration + 0.001) {
      blockingErrors.push("One or more selected ranges extends beyond the source duration.");
    }
  }

  const { ranges: mergedSelectedRanges, hadOverlap } = mergeRanges(selectedRanges);
  if (hadOverlap) {
    warnings.push("Selected ranges overlap and will be merged before analysis.");
  }
  addTranscriptValidationWarnings(selectedRanges, warnings);

  const silenceSettings = settings.silence || {};
  if (silenceSettings.enabled) {
    for (const metadata of sourceMetadata) {
      if (!metadata.hasAudio) {
        blockingErrors.push("No audio stream was detected, so silence trimming cannot run.");
      }
    }
  } else if (blockingErrors.length === 0) {
    await addSelectedAudioWarnings(selectedRanges, metadataByPath, silenceSettings, warnings);
  }

  const detectedSilenceRanges = [];
  let finalKeepRanges = [];
  let discardedTooShortDuration = 0;

  if (blockingErrors.length === 0) {
    if (silenceSettings.enabled) {
      for (const selectedRange of mergedSelectedRanges) {
        const silences = await detectSilence(
          selectedRange.sourceVideo,
          selectedRange.start,
          selectedRange.end,
          silenceSettings,
        );
        detectedSilenceRanges.push(
          ...silences.map((range, index) => ({
            id: `silence_${detectedSilenceRanges.length + index + 1}`,
            sourceVideo: selectedRange.sourceVideo,
            sourceRangeId: selectedRange.id,
            start: roundSeconds(range.start),
            end: roundSeconds(range.end),
            duration: roundSeconds(range.end - range.start),
          })),
        );
        const result = silenceToKeepRanges(
          selectedRange.sourceVideo,
          selectedRange.id,
          selectedRange.start,
          selectedRange.end,
          silences,
          silenceSettings,
        );
        discardedTooShortDuration += result.discardedTooShort;
        finalKeepRanges.push(...result.keep);
      }
    } else {
      finalKeepRanges = mergedSelectedRanges.map((range, index) => ({
        id: `keep_${String(index + 1).padStart(6, "0")}`,
        sourceVideo: range.sourceVideo,
        sourceRangeId: range.id,
        start: range.start,
        end: range.end,
        duration: roundSeconds(range.end - range.start),
        source: "transcript-selection",
        validationStatus: range.validationStatus,
        validationReasons: range.validationReasons,
      }));
    }

    finalKeepRanges = finalKeepRanges
      .filter((range) => range.end > range.start)
      .map((range, index) => ({
        ...range,
        id: `keep_${String(index + 1).padStart(6, "0")}`,
        duration: roundSeconds(range.end - range.start),
      }));

    if (finalKeepRanges.length === 0) {
      blockingErrors.push("These settings would produce an empty export, so rendering is blocked.");
    }
  }

  const sourceDuration = sourceMetadata.reduce((total, item) => total + item.duration, 0);
  const selectedDuration = sumDurations(mergedSelectedRanges);
  const detectedSilenceDuration = sumDurations(detectedSilenceRanges);
  const estimatedOutputDuration = sumDurations(finalKeepRanges);
  const estimatedCutDuration = Math.max(0, sourceDuration - estimatedOutputDuration);
  if (estimatedOutputDuration > 0 && estimatedOutputDuration < 5) {
    warnings.push("The estimated output is very short.");
  }

  const keptPercentOfSource = sourceDuration > 0 ? (estimatedOutputDuration / sourceDuration) * 100 : 0;
  const keptPercentOfSelection = selectedDuration > 0 ? (estimatedOutputDuration / selectedDuration) * 100 : 0;

  const fingerprintInput = {
    sources: sourceMetadata.map((metadata) => fileIdentity(metadata.path)),
    selectedTranscriptRanges: selectedRanges.map((range) => ({
      id: range.id,
      sourceVideo: normalizePathForIdentity(range.sourceVideo),
      originalStart: range.originalStart,
      originalEnd: range.originalEnd,
      adjustedStart: range.adjustedStart,
      adjustedEnd: range.adjustedEnd,
      start: range.start,
      end: range.end,
      leadIn: range.leadIn,
      leadOut: range.leadOut,
      validationStatus: range.validationStatus,
      validationReasons: range.validationReasons,
    })),
    settings: {
      padding: settings.padding || {},
      silence: settings.silence || {},
      export: exportSettings,
    },
  };
  const fingerprint = sha256Canonical(fingerprintInput);
  const status = blockingErrors.length > 0 ? "blocked" : "readyToReview";
  const generatedAt = new Date().toISOString();

  return {
    id: `analysis_${generatedAt.replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z")}`,
    fingerprint,
    fingerprintInput,
    generatedAt,
    status,
    sourceVideos: sourceMetadata,
    selectedTranscriptRanges: selectedRanges.map(({ sourceRangeIds, ...range }) => range),
    mergedSelectedRanges: mergedSelectedRanges.map(({ sourceRangeIds, ...range }) => range),
    detectedSilenceRanges,
    finalKeepRanges,
    warnings,
    blockingErrors,
    summary: {
      sourceDuration,
      sourceDurationText: formatDuration(sourceDuration),
      selectedDuration,
      selectedDurationText: formatDuration(selectedDuration),
      detectedSilenceDuration,
      detectedSilenceText: formatDuration(detectedSilenceDuration),
      discardedTooShortDuration,
      discardedTooShortText: formatDuration(discardedTooShortDuration),
      estimatedOutputDuration,
      estimatedOutputText: formatDuration(estimatedOutputDuration),
      estimatedCutDuration,
      estimatedCutText: formatDuration(estimatedCutDuration),
      keptPercentOfSource: Math.round(keptPercentOfSource * 10) / 10,
      removedPercentOfSource: Math.round((100 - keptPercentOfSource) * 10) / 10,
      keptPercentOfSelection: Math.round(keptPercentOfSelection * 10) / 10,
      removedPercentOfSelection: Math.round((100 - keptPercentOfSelection) * 10) / 10,
    },
  };
}

function defaultOutputFile() {
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "");
  return path.join(renderRoot, `VidVerba-export-${stamp}.mp4`);
}

function validateReportSourcesCurrent(report) {
  const sourceIdentities = report.fingerprintInput?.sources || [];
  for (const identity of sourceIdentities) {
    const current = fileIdentity(identity.path);
    if (
      current.path !== identity.path ||
      current.size !== identity.size ||
      current.modifiedMs !== identity.modifiedMs
    ) {
      throw new Error("A source video changed after analysis. Run Analyze again before rendering.");
    }
  }
}

async function renderReport(body) {
  const report = body.report;
  if (!report || report.status !== "approved") {
    throw new Error("Approve a current Analyze report before rendering.");
  }
  const currentFingerprint = sha256Canonical(report.fingerprintInput);
  if (currentFingerprint !== report.fingerprint) {
    throw new Error("The approved Analyze report fingerprint is invalid.");
  }
  validateReportSourcesCurrent(report);

  const keepRanges = report.finalKeepRanges || [];
  if (keepRanges.length === 0) {
    throw new Error("The approved report does not contain any keep ranges.");
  }

  const sourcePaths = [...new Set(keepRanges.map((range) => path.resolve(range.sourceVideo)))];
  const inputIndex = new Map(sourcePaths.map((source, index) => [normalizePathForIdentity(source), index]));
  const metadataByPath = new Map((report.sourceVideos || []).map((source) => [normalizePathForIdentity(source.path), source]));
  const allHaveAudio = sourcePaths.every((source) => metadataByPath.get(normalizePathForIdentity(source))?.hasAudio);
  const filterParts = [];
  const concatLabels = [];

  keepRanges.forEach((range, index) => {
    const sourceIndex = inputIndex.get(normalizePathForIdentity(range.sourceVideo));
    filterParts.push(
      `[${sourceIndex}:v]setpts=PTS-STARTPTS,trim=start=${range.start}:end=${range.end},setpts=PTS-STARTPTS[v${index}]`,
    );
    concatLabels.push(`[v${index}]`);
    if (allHaveAudio) {
      filterParts.push(
        `[${sourceIndex}:a]asetpts=PTS-STARTPTS,atrim=start=${range.start}:end=${range.end},asetpts=PTS-STARTPTS[a${index}]`,
      );
      concatLabels.push(`[a${index}]`);
    }
  });
  filterParts.push(
    `${concatLabels.join("")}concat=n=${keepRanges.length}:v=1:a=${allHaveAudio ? 1 : 0}[vout]${allHaveAudio ? "[aout]" : ""}`,
  );

  const approvedOutputFile = path.resolve(report.fingerprintInput?.settings?.export?.outputFile || defaultOutputFile());
  if (body.outputFile && path.resolve(body.outputFile) !== approvedOutputFile) {
    throw new Error("Output file changed after approval. Run Analyze again before rendering.");
  }
  const outputFile = approvedOutputFile;
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });

  const exportSettings = report.fingerprintInput?.settings?.export || {};
  const videoCodec = exportSettings.videoCodec || "libx264";
  const args = ["-hide_banner", "-y"];
  for (const source of sourcePaths) {
    args.push("-i", source);
  }
  args.push("-filter_complex", filterParts.join(";"), "-map", "[vout]");
  if (allHaveAudio) args.push("-map", "[aout]");
  args.push("-c:v", videoCodec);
  if (allHaveAudio) args.push("-c:a", exportSettings.audioCodec || "aac");
  if (exportSettings.editFriendly) {
    args.push("-pix_fmt", "yuv420p", "-movflags", "+faststart");
    if (exportSettings.frameRate) args.push("-r", String(exportSettings.frameRate));
  }
  args.push(outputFile);

  const { stderr } = await execFileAsync("ffmpeg", args, {
    cwd: appRoot,
    timeout: 1000 * 60 * 120,
  });

  return {
    outputFile,
    sizeText: fs.existsSync(outputFile) ? formatBytes(fs.statSync(outputFile).size) : "",
    logTail: stderr.split(/\r?\n/).slice(-16).join("\n"),
  };
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const fullPath = path.resolve(publicRoot, `.${requested}`);
  if (!fullPath.startsWith(publicRoot)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    sendText(res, 404, "Not found");
    return;
  }
  const ext = path.extname(fullPath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
  };
  res.writeHead(200, { "content-type": types[ext] || "application/octet-stream" });
  fs.createReadStream(fullPath).pipe(res);
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && url.pathname === "/api/config") {
      sendJson(res, 200, {
        appRoot,
        repoRoot,
        defaultInputDir: repoRoot,
        transcriptRoot,
        renderRoot,
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/browse") {
      sendJson(res, 200, browseDirectory(url.searchParams.get("dir") || repoRoot));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/probe") {
      const body = await readBody(req);
      const paths = body.paths || (body.path ? [body.path] : []);
      const videos = [];
      for (const inputPath of paths) videos.push(await probeVideo(inputPath));
      sendJson(res, 200, { videos });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/transcribe") {
      const body = await readBody(req);
      sendJson(res, 200, await loadOrRunTranscript(body));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/analyze") {
      const body = await readBody(req);
      sendJson(res, 200, await analyzePlan(body));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/render") {
      const body = await readBody(req);
      sendJson(res, 200, await renderReport(body));
      return;
    }
    sendJson(res, 404, { error: "API endpoint not found." });
  } catch (error) {
    sendJson(res, 400, {
      error: error.message,
      stderr: error.stderr,
      stdout: error.stdout,
    });
  }
}

const server = http.createServer((req, res) => {
  if (req.url?.startsWith("/api/")) {
    if (!LEGACY_BROWSER_API_ENABLED) {
      sendJson(res, 410, {
        error:
          "The legacy browser API is disabled. Production VidVerba uses Tauri commands from the desktop shell.",
      });
      return;
    }
    handleApi(req, res);
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`VidVerba legacy dev-only preview is running at http://localhost:${PORT}`);
  console.log("Production uses the Tauri desktop shell and bundled frontend assets.");
});
