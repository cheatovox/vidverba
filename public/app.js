const steps = [
  { id: "source", title: "Select Source Video" },
  { id: "transcript", title: "Generate and Review Transcript" },
  { id: "timestamps", title: "Edit Transcript Timestamps" },
  { id: "selection", title: "Manual Timestamp Selection" },
  { id: "export", title: "Configure Export Plan" },
  { id: "analyze", title: "Analyze Preflight" },
  { id: "render", title: "Render Approved Plan" },
];

const DEFAULT_TRANSCRIPTION_MODEL = "medium";
const TRANSCRIPTION_MODELS = ["tiny", "base", "small", "medium", "large-v3"];
const DEFAULT_VAD_MIN_SILENCE_MS = 500;
const DEFAULT_HALLUCINATION_SILENCE_THRESHOLD = 1.0;
const DEFAULT_TRANSCRIPT_SILENCE_THRESHOLD_DB = -39;
const DEFAULT_PLAN_DEFAULTS = {
  padding: {
    leadIn: 0.5,
    leadOut: 0.8,
  },
  silence: {
    enabled: false,
    thresholdDb: -39,
    minSilenceSeconds: 0.6,
    minClipSeconds: 0.3,
    frontPaddingSeconds: 0.1,
  },
  export: {
    outputFile: "",
    videoCodec: "libx264",
    audioCodec: "aac",
    editFriendly: true,
    frameRate: null,
    format: "mp4",
  },
};

const state = {
  config: null,
  tauriReady: Boolean(window.__TAURI__?.core?.invoke),
  currentStep: 0,
  browseDir: "",
  browseParent: null,
  sourceVideos: [],
  transcriptSegments: [],
  transcriptPath: "",
  transcriptMetadata: null,
  planState: "draft",
  report: null,
  renderResult: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const invoke = (...args) => {
  const tauriCore = window.__TAURI__?.core;
  if (!tauriCore?.invoke) {
    throw new Error("VidVerba must be run through the Tauri desktop shell.");
  }
  return tauriCore.invoke(...args);
};
const openDialog = (...args) => window.__TAURI__?.dialog?.open?.(...args);

function normalizeTranscriptionModel(value) {
  const model = String(value || "").trim();
  return TRANSCRIPTION_MODELS.includes(model) ? model : DEFAULT_TRANSCRIPTION_MODEL;
}

function planDefaults() {
  const configured = state.config?.planDefaults || {};
  return {
    padding: {
      leadIn: configured.padding?.leadIn ?? DEFAULT_PLAN_DEFAULTS.padding.leadIn,
      leadOut: configured.padding?.leadOut ?? DEFAULT_PLAN_DEFAULTS.padding.leadOut,
    },
    silence: {
      enabled: configured.silence?.enabled ?? DEFAULT_PLAN_DEFAULTS.silence.enabled,
      thresholdDb: configured.silence?.thresholdDb ?? DEFAULT_PLAN_DEFAULTS.silence.thresholdDb,
      minSilenceSeconds: configured.silence?.minSilenceSeconds ?? DEFAULT_PLAN_DEFAULTS.silence.minSilenceSeconds,
      minClipSeconds: configured.silence?.minClipSeconds ?? DEFAULT_PLAN_DEFAULTS.silence.minClipSeconds,
      frontPaddingSeconds: configured.silence?.frontPaddingSeconds ?? DEFAULT_PLAN_DEFAULTS.silence.frontPaddingSeconds,
    },
    export: {
      outputFile: configured.export?.outputFile ?? DEFAULT_PLAN_DEFAULTS.export.outputFile,
      videoCodec: configured.export?.videoCodec ?? DEFAULT_PLAN_DEFAULTS.export.videoCodec,
      audioCodec: configured.export?.audioCodec ?? DEFAULT_PLAN_DEFAULTS.export.audioCodec,
      editFriendly: configured.export?.editFriendly ?? DEFAULT_PLAN_DEFAULTS.export.editFriendly,
      frameRate: configured.export?.frameRate ?? DEFAULT_PLAN_DEFAULTS.export.frameRate,
      format: configured.export?.format ?? DEFAULT_PLAN_DEFAULTS.export.format,
    },
  };
}

function optionalNumberInput(selector) {
  const value = $(selector).value.trim();
  if (!value) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberInput(selector, fallback) {
  const value = optionalNumberInput(selector);
  return value ?? fallback;
}

function integerInput(selector, fallback) {
  return Math.max(0, Math.round(numberInput(selector, fallback)));
}

function applyPlanDefaults(defaults = planDefaults()) {
  $("#lead-in").value = defaults.padding.leadIn;
  $("#lead-out").value = defaults.padding.leadOut;
  $("#silence-enabled").checked = defaults.silence.enabled;
  $("#threshold-db").value = defaults.silence.thresholdDb;
  $("#min-silence").value = defaults.silence.minSilenceSeconds;
  $("#min-clip").value = defaults.silence.minClipSeconds;
  $("#front-padding").value = defaults.silence.frontPaddingSeconds;
  $("#video-codec").value = defaults.export.videoCodec;
  $("#frame-rate").value = defaults.export.frameRate ?? "";
  $("#edit-friendly").checked = defaults.export.editFriendly;
  $("#output-file").value = defaults.export.outputFile || "";
}

function applyConfigToMainControls({ applyPlan = false } = {}) {
  $("#model-input").value = normalizeTranscriptionModel(state.config?.settings?.transcription?.model);
  $("#language-input").value = state.config?.settings?.transcription?.language || "";
  $("#device-input").value = state.config?.settings?.transcription?.device || "auto";
  if (applyPlan) applyPlanDefaults(planDefaults());
}

function selectedTranscriptionModel() {
  return normalizeTranscriptionModel($("#model-input").value);
}

async function invokeCommand(command, payload = {}) {
  try {
    return await invoke(command, payload);
  } catch (error) {
    throw new Error(error?.message || String(error));
  }
}

function formatTimestamp(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const wholeSeconds = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function parseTimestamp(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const parts = text.split(":");
  if (parts.length > 3) return null;
  const numeric = parts.map(Number);
  if (numeric.some((part) => Number.isNaN(part))) return null;
  if (parts.length === 3) return numeric[0] * 3600 + numeric[1] * 60 + numeric[2];
  if (parts.length === 2) return numeric[0] * 60 + numeric[1];
  return numeric[0];
}

function formatDuration(seconds) {
  const value = Math.max(0, Number(seconds || 0));
  const minutes = Math.floor(value / 60);
  const sec = value % 60;
  return minutes > 0 ? `${minutes}m ${sec.toFixed(1)}s` : `${sec.toFixed(1)}s`;
}

function formatClockDuration(seconds) {
  const number = Number(seconds);
  if (!Number.isFinite(number) || number < 0) return "unknown";
  const totalSeconds = Math.round(number);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const sec = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${minutes}:${String(sec).padStart(2, "0")}`;
}

function optionalMetricNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function metadataValue(metadata, ...keys) {
  for (const key of keys) {
    const value = metadata?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return null;
}

function formatDeviceLabel(value) {
  const label = String(value || "unknown");
  if (label.toLowerCase() === "cuda") return "CUDA";
  if (label.toLowerCase() === "cpu") return "CPU";
  if (label.toLowerCase() === "auto") return "Auto";
  return label;
}

function formatRealtimeSpeed(speed, duration, transcriptionTime) {
  const explicit = optionalMetricNumber(speed);
  const calculated =
    explicit ?? (duration && transcriptionTime ? optionalMetricNumber(duration) / optionalMetricNumber(transcriptionTime) : null);
  return Number.isFinite(calculated) && calculated > 0 ? `${calculated.toFixed(2)}x realtime` : "unknown";
}

function segmentDuration(segment) {
  return Math.max(0, Number(segment.adjustedEnd) - Number(segment.adjustedStart));
}

function validationStatus(segment) {
  const status = segment.validation?.status || "unknown";
  return ["ok", "warning", "bad", "unknown"].includes(status) ? status : "unknown";
}

function validationReasons(segment) {
  return Array.isArray(segment.validation?.reasons) ? segment.validation.reasons : [];
}

function qualityCounts(segments = state.transcriptSegments) {
  return segments.reduce(
    (counts, segment) => {
      counts[validationStatus(segment)] += 1;
      return counts;
    },
    { ok: 0, warning: 0, bad: 0, unknown: 0 },
  );
}

function qualityBadge(segment) {
  const status = validationStatus(segment);
  const label = status === "ok" ? "OK" : status === "bad" ? "Bad" : status === "warning" ? "Review" : "Unknown";
  const reasons = validationReasons(segment).join("; ");
  return `<span class="quality-badge ${status}" title="${escapeHtml(reasons || "Transcript quality status")}">${label}</span>`;
}

function getConfig() {
  return invokeCommand("get_config");
}

function saveRuntimeConfig(request) {
  return invokeCommand("save_runtime_config", { request });
}

function browseDirectory(requestedDir) {
  return invokeCommand("browse_directory", { requestedDir: requestedDir || null });
}

function probeVideos(paths) {
  return invokeCommand("probe_videos", { paths });
}

function loadOrRunTranscript(request) {
  return invokeCommand("load_or_run_transcript", { request });
}

function analyzePlan(request) {
  return invokeCommand("analyze_plan", { request });
}

function renderApprovedReport(request) {
  return invokeCommand("render_report", { request });
}

function showNotice(message, isError = false) {
  const notice = $("#notice");
  if (!message) {
    notice.className = "notice hidden";
    notice.textContent = "";
    return;
  }
  notice.className = `notice${isError ? " error" : ""}`;
  notice.textContent = message;
}

function setBusy(button, busy, text) {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = text || "Working...";
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

function invalidateAnalysis() {
  if (state.report) {
    state.planState = "stale";
  } else {
    state.planState = "draft";
  }
  state.renderResult = null;
  render();
}

function dependencyList() {
  const deps = state.config?.dependencies;
  return deps ? [deps.ffmpeg, deps.ffprobe, deps.python, deps.fasterWhisper] : [];
}

function dependencyAvailable(name) {
  return dependencyList().find((dependency) => dependency?.name === name)?.available;
}

function compactVersion(value) {
  return String(value || "").replace(/\s+Copyright.*$/i, "");
}

function renderSettingsPanel() {
  $("#settings-button").classList.toggle("active", isSettingsPanelOpen());
  $("#settings-button").setAttribute("aria-expanded", String(isSettingsPanelOpen()));
  $("#settings-config-path").textContent = state.config?.runtimeConfigPath || "config.toml";
  $("#settings-dependency-list").innerHTML = dependencyList()
    .map(
      (dependency) => `
        <div class="settings-dependency ${dependency.available ? "ok" : "bad"}">
          <strong>${escapeHtml(dependency.name)} <span>${dependency.available ? "Ready" : "Needs setup"}</span></strong>
          <span>${escapeHtml(dependency.requiredFor)}</span>
          <small>${escapeHtml(compactVersion(dependency.version) || dependency.message || "")}</small>
          ${dependency.resolvedPath ? `<small>${escapeHtml(dependency.resolvedPath)}</small>` : ""}
        </div>
      `,
    )
    .join("");
}

function isSettingsPanelOpen() {
  return !$("#settings-panel").classList.contains("hidden");
}

function openSettingsPanel() {
  syncSettingsPanelInputs();
  showSettingsStatus("");
  $("#settings-panel").classList.remove("hidden");
  $("#settings-scrim").classList.remove("hidden");
  renderSettingsPanel();
}

function closeSettingsPanel() {
  $("#settings-panel").classList.add("hidden");
  $("#settings-scrim").classList.add("hidden");
  renderSettingsPanel();
}

function showSettingsStatus(message, isError = false) {
  const status = $("#settings-save-status");
  status.textContent = message || "";
  status.classList.toggle("error-text", Boolean(isError));
}

function syncSettingsPanelInputs() {
  const existing = state.config?.settings || {};
  const defaults = planDefaults();
  $("#settings-workspace-path").value = state.config?.workspacePath || existing.workspacePath || "";
  $("#settings-ffmpeg-path").value = existing.dependencyPaths?.ffmpeg || "";
  $("#settings-ffprobe-path").value = existing.dependencyPaths?.ffprobe || "";
  $("#settings-python-path").value = existing.dependencyPaths?.python || "";
  $("#settings-model-input").value = normalizeTranscriptionModel(existing.transcription?.model);
  $("#settings-language-input").value = existing.transcription?.language || "";
  $("#settings-device-input").value = existing.transcription?.device || "auto";
  $("#settings-compute-type").value = existing.transcription?.computeType || "auto";
  $("#settings-beam-size").value = existing.transcription?.beamSize ?? 5;
  $("#settings-vad-min-silence-ms").value = existing.transcription?.vadMinSilenceMs ?? DEFAULT_VAD_MIN_SILENCE_MS;
  $("#settings-hallucination-threshold").value =
    existing.transcription?.hallucinationSilenceThreshold ?? DEFAULT_HALLUCINATION_SILENCE_THRESHOLD;
  $("#settings-transcript-silence-db").value =
    existing.transcription?.silenceThresholdDb ?? DEFAULT_TRANSCRIPT_SILENCE_THRESHOLD_DB;
  $("#settings-vad-filter").checked = existing.transcription?.vadFilter ?? true;
  $("#settings-word-timestamps").checked = existing.transcription?.wordTimestamps ?? true;
  $("#settings-condition-previous").checked = existing.transcription?.conditionOnPreviousText ?? false;
  $("#settings-lead-in").value = defaults.padding.leadIn;
  $("#settings-lead-out").value = defaults.padding.leadOut;
  $("#settings-silence-enabled").checked = defaults.silence.enabled;
  $("#settings-threshold-db").value = defaults.silence.thresholdDb;
  $("#settings-min-silence").value = defaults.silence.minSilenceSeconds;
  $("#settings-min-clip").value = defaults.silence.minClipSeconds;
  $("#settings-front-padding").value = defaults.silence.frontPaddingSeconds;
  $("#settings-video-codec").value = defaults.export.videoCodec;
  $("#settings-frame-rate").value = defaults.export.frameRate ?? "";
  $("#settings-edit-friendly").checked = defaults.export.editFriendly;
  $("#settings-output-file").value = defaults.export.outputFile || "";
}

function currentRuntimeConfig() {
  const existing = state.config?.settings || {};
  const defaults = planDefaults();
  return {
    desktop: {
      workspacePath: $("#settings-workspace-path").value.trim() || null,
      dependencyPaths: {
        ffmpeg: $("#settings-ffmpeg-path").value.trim() || null,
        ffprobe: $("#settings-ffprobe-path").value.trim() || null,
        python: $("#settings-python-path").value.trim() || null,
      },
      transcription: {
        model: normalizeTranscriptionModel($("#settings-model-input").value),
        language: $("#settings-language-input").value.trim() || null,
        device: $("#settings-device-input").value || existing.transcription?.device || "auto",
        computeType: $("#settings-compute-type").value.trim() || existing.transcription?.computeType || "auto",
        beamSize: integerInput("#settings-beam-size", existing.transcription?.beamSize ?? 5),
        vadFilter: $("#settings-vad-filter").checked,
        vadMinSilenceMs: integerInput(
          "#settings-vad-min-silence-ms",
          existing.transcription?.vadMinSilenceMs ?? DEFAULT_VAD_MIN_SILENCE_MS,
        ),
        wordTimestamps: $("#settings-word-timestamps").checked,
        conditionOnPreviousText: $("#settings-condition-previous").checked,
        hallucinationSilenceThreshold: numberInput(
          "#settings-hallucination-threshold",
          existing.transcription?.hallucinationSilenceThreshold ?? DEFAULT_HALLUCINATION_SILENCE_THRESHOLD,
        ),
        silenceThresholdDb: numberInput(
          "#settings-transcript-silence-db",
          existing.transcription?.silenceThresholdDb ?? DEFAULT_TRANSCRIPT_SILENCE_THRESHOLD_DB,
        ),
      },
      export: {
        videoCodec: $("#settings-video-codec").value || existing.export?.videoCodec || DEFAULT_PLAN_DEFAULTS.export.videoCodec,
        audioCodec: existing.export?.audioCodec || DEFAULT_PLAN_DEFAULTS.export.audioCodec,
        editFriendly: $("#settings-edit-friendly").checked,
        frameRate: optionalNumberInput("#settings-frame-rate"),
      },
    },
    plan: {
      padding: {
        leadIn: numberInput("#settings-lead-in", DEFAULT_PLAN_DEFAULTS.padding.leadIn),
        leadOut: numberInput("#settings-lead-out", DEFAULT_PLAN_DEFAULTS.padding.leadOut),
      },
      silence: {
        enabled: $("#settings-silence-enabled").checked,
        thresholdDb: numberInput("#settings-threshold-db", DEFAULT_PLAN_DEFAULTS.silence.thresholdDb),
        minSilenceSeconds: numberInput("#settings-min-silence", DEFAULT_PLAN_DEFAULTS.silence.minSilenceSeconds),
        minClipSeconds: numberInput("#settings-min-clip", DEFAULT_PLAN_DEFAULTS.silence.minClipSeconds),
        frontPaddingSeconds: numberInput("#settings-front-padding", DEFAULT_PLAN_DEFAULTS.silence.frontPaddingSeconds),
      },
      export: {
        outputFile: $("#settings-output-file").value.trim(),
        videoCodec: $("#settings-video-codec").value || DEFAULT_PLAN_DEFAULTS.export.videoCodec,
        audioCodec: defaults.export.audioCodec || existing.export?.audioCodec || DEFAULT_PLAN_DEFAULTS.export.audioCodec,
        editFriendly: $("#settings-edit-friendly").checked,
        frameRate: optionalNumberInput("#settings-frame-rate"),
        format: defaults.export.format || DEFAULT_PLAN_DEFAULTS.export.format,
      },
    },
  };
}

function getSettings() {
  const defaults = planDefaults();
  return {
    padding: {
      leadIn: numberInput("#lead-in", defaults.padding.leadIn),
      leadOut: numberInput("#lead-out", defaults.padding.leadOut),
    },
    silence: {
      enabled: $("#silence-enabled").checked,
      thresholdDb: numberInput("#threshold-db", defaults.silence.thresholdDb),
      minSilenceSeconds: numberInput("#min-silence", defaults.silence.minSilenceSeconds),
      minClipSeconds: numberInput("#min-clip", defaults.silence.minClipSeconds),
      frontPaddingSeconds: numberInput("#front-padding", defaults.silence.frontPaddingSeconds),
    },
    export: {
      outputFile: $("#output-file").value.trim(),
      videoCodec: $("#video-codec").value || defaults.export.videoCodec,
      audioCodec: defaults.export.audioCodec || "aac",
      editFriendly: $("#edit-friendly").checked,
      frameRate: optionalNumberInput("#frame-rate"),
      format: defaults.export.format || "mp4",
    },
  };
}

function canMoveNext() {
  const id = steps[state.currentStep].id;
  if (id === "source") return state.sourceVideos.length > 0;
  if (id === "transcript") return state.transcriptSegments.length > 0;
  if (id === "timestamps") return state.transcriptSegments.every((segment) => segment.adjustedStart >= 0 && segment.adjustedStart < segment.adjustedEnd);
  if (id === "selection") return state.transcriptSegments.some((segment) => segment.selected);
  if (id === "analyze") return state.planState === "approved";
  return true;
}

function goToStep(index) {
  state.currentStep = Math.max(0, Math.min(steps.length - 1, index));
  showNotice("");
  render();
}

function renderStepNav() {
  $("#steps").innerHTML = steps
    .map(
      (step, index) => `
        <button class="step-button ${index === state.currentStep ? "active" : ""}" type="button" data-step="${index}">
          <span class="step-index">${index + 1}</span>${step.title}
        </button>
      `,
    )
    .join("");
  $$(".step-button").forEach((button) => {
    button.addEventListener("click", () => goToStep(Number(button.dataset.step)));
  });
}

function renderShell() {
  const step = steps[state.currentStep];
  $("#step-eyebrow").textContent = step.id;
  $("#step-title").textContent = step.title;
  $("#plan-state").textContent = state.planState;
  $$(".view").forEach((view) => view.classList.remove("active"));
  $(`#view-${step.id}`).classList.add("active");
  $("#back-button").disabled = state.currentStep === 0;
  $("#next-button").disabled = state.currentStep === steps.length - 1 || !canMoveNext();
}

function renderBrowser(data) {
  state.browseDir = data.current;
  state.browseParent = data.parent;
  $("#folder-input").value = data.current;
  $("#roots").innerHTML = data.roots.map((root) => `<button type="button" data-root="${escapeHtml(root)}">${escapeHtml(root)}</button>`).join("");
  $("#browser-list").innerHTML = data.entries
    .map(
      (entry) => `
        <div class="browser-entry" data-type="${entry.type}" data-path="${escapeHtml(entry.path)}">
          <span>${entry.type === "folder" ? "□" : "▣"}</span>
          <div>
            <div class="entry-name">${escapeHtml(entry.name)}</div>
            <div class="entry-meta">${entry.type === "folder" ? "Folder" : entry.sizeText}</div>
          </div>
          <span class="pill">${entry.type === "folder" ? "Open" : "Select"}</span>
        </div>
      `,
    )
    .join("");

  $$("#roots button").forEach((button) => button.addEventListener("click", () => browse(button.dataset.root)));
  $$(".browser-entry").forEach((entry) => {
    entry.addEventListener("click", () => {
      if (entry.dataset.type === "folder") {
        browse(entry.dataset.path);
      } else {
        selectSource(entry.dataset.path);
      }
    });
  });
}

function renderSources() {
  const list = $("#source-list");
  if (!state.sourceVideos.length) {
    list.className = "source-list empty-state";
    list.textContent = "No source selected.";
    $("#metadata-grid").innerHTML = "";
    return;
  }
  list.className = "source-list";
  list.innerHTML = state.sourceVideos
    .map(
      (video) => `
        <div class="source-item">
          <strong>${escapeHtml(video.filename)}</strong>
          <span class="entry-meta">${escapeHtml(video.path)}</span>
        </div>
      `,
    )
    .join("");
  const primary = state.sourceVideos[0];
  $("#metadata-grid").innerHTML = [
    ["Duration", primary.durationText],
    ["Stream start", primary.startTimeText || "00:00:00.000"],
    ["Resolution", primary.resolution],
    ["Frame rate", primary.frameRateText],
    ["Size", primary.fileSizeText],
    ["Audio", primary.hasAudio ? "present" : "missing"],
    ["Modified", new Date(primary.modifiedMs).toLocaleString()],
  ]
    .map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`)
    .join("");
}

function renderTranscript() {
  const counts = qualityCounts();
  $("#transcript-status").textContent = state.transcriptSegments.length
    ? `${state.transcriptSegments.length} segments loaded from ${state.transcriptPath || "transcript data"}. Quality: ${counts.ok} OK, ${counts.warning} review, ${counts.bad} bad, ${counts.unknown} unknown.`
    : "No transcript loaded.";
  renderTranscriptMetrics();
  $("#transcript-preview").innerHTML = state.transcriptSegments
    .slice(0, 80)
    .map(
      (segment) => `
        <p>${qualityBadge(segment)} <strong>${formatTimestamp(segment.adjustedStart)} - ${formatTimestamp(segment.adjustedEnd)}</strong> ${escapeHtml(segment.text)}</p>
      `,
    )
    .join("");
}

function renderTranscriptMetrics() {
  const metrics = $("#transcript-metrics");
  if (!state.transcriptSegments.length) {
    metrics.innerHTML = "";
    return;
  }
  const metadata = state.transcriptMetadata || {};
  const sourceDuration = state.sourceVideos[0]?.duration;
  const duration = optionalMetricNumber(metadataValue(metadata, "duration_seconds", "durationSeconds")) ?? sourceDuration;
  const transcriptionTime = optionalMetricNumber(
    metadataValue(metadata, "transcription_time_seconds", "transcriptionTimeSeconds"),
  );
  const fallbackReason = metadataValue(metadata, "cpu_fallback_reason", "cpuFallbackReason");
  const rows = [
    ["Duration", formatClockDuration(duration)],
    ["Transcription Time", formatClockDuration(transcriptionTime)],
    [
      "Speed",
      formatRealtimeSpeed(
        metadataValue(metadata, "speed_realtime", "speedRealtime"),
        duration,
        transcriptionTime,
      ),
    ],
    ["Model", metadataValue(metadata, "model") || selectedTranscriptionModel()],
    [
      "Requested Device",
      formatDeviceLabel(metadataValue(metadata, "requested_device", "requestedDevice") || $("#device-input").value),
    ],
    ["Actual Device", formatDeviceLabel(metadataValue(metadata, "actual_device", "actualDevice", "device"))],
    ["Compute", metadataValue(metadata, "compute_type", "computeType") || "unknown"],
    ...(fallbackReason ? [["CPU Fallback", fallbackReason]] : []),
  ];
  metrics.innerHTML = rows
    .map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`)
    .join("");
}

function renderTimestampRows() {
  const table = $("#timestamp-table");
  if (!state.transcriptSegments.length) {
    table.innerHTML = `<div class="empty-state">No transcript segments.</div>`;
    return;
  }
  table.innerHTML = state.transcriptSegments
    .map((segment, index) => segmentRow(segment, index, false))
    .join("");
  bindSegmentInputs(table);
}

function renderSelectionRows() {
  const selected = state.transcriptSegments.filter((segment) => segment.selected);
  const duration = selected.reduce((total, segment) => total + segmentDuration(segment), 0);
  const counts = qualityCounts(selected);
  $("#selection-summary").innerHTML = [
    ["Segments", String(selected.length)],
    ["Selected duration", formatDuration(duration)],
    ["Transcript duration", formatDuration(state.transcriptSegments.reduce((total, segment) => total + segmentDuration(segment), 0))],
    ["Selected quality", `${counts.ok} OK / ${counts.warning} review / ${counts.bad} bad / ${counts.unknown} unknown`],
  ]
    .map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`)
    .join("");

  const table = $("#selection-table");
  if (!state.transcriptSegments.length) {
    table.innerHTML = `<div class="empty-state">No transcript segments.</div>`;
    return;
  }
  table.innerHTML = state.transcriptSegments
    .map((segment, index) => segmentRow(segment, index, true))
    .join("");
  bindSegmentInputs(table);
}

function segmentRow(segment, index, showCheckbox) {
  const adjusted = Math.abs(segment.originalStart - segment.adjustedStart) > 0.001 || Math.abs(segment.originalEnd - segment.adjustedEnd) > 0.001;
  const reasons = validationReasons(segment);
  return `
    <div class="segment-row ${segment.selected ? "selected" : ""} ${adjusted ? "adjusted" : ""} quality-${validationStatus(segment)}" data-index="${index}">
      ${showCheckbox ? `<input type="checkbox" data-field="selected" ${segment.selected ? "checked" : ""} aria-label="Select segment">` : `<span class="pill">${index + 1}</span>`}
      <label>Start <input data-field="adjustedStart" value="${formatTimestamp(segment.adjustedStart)}"></label>
      <label>End <input data-field="adjustedEnd" value="${formatTimestamp(segment.adjustedEnd)}"></label>
      <div class="segment-text">
        <p>${escapeHtml(segment.text)}</p>
        <div class="segment-original">Original ${formatTimestamp(segment.originalStart)} - ${formatTimestamp(segment.originalEnd)}</div>
        ${reasons.length ? `<div class="segment-quality-note">${escapeHtml(reasons.join("; "))}</div>` : ""}
      </div>
      <div class="segment-meta">
        ${qualityBadge(segment)}
        <span class="pill">${adjusted ? "Adjusted" : formatDuration(segmentDuration(segment))}</span>
      </div>
    </div>
  `;
}

function bindSegmentInputs(root) {
  root.querySelectorAll(".segment-row").forEach((row) => {
    const index = Number(row.dataset.index);
    row.querySelectorAll("input").forEach((input) => {
      input.addEventListener("change", () => {
        const segment = state.transcriptSegments[index];
        const field = input.dataset.field;
        if (field === "selected") {
          segment.selected = input.checked;
        } else {
          const parsed = parseTimestamp(input.value);
          if (parsed === null) {
            showNotice("Timestamp input could not be parsed.", true);
            input.value = formatTimestamp(segment[field]);
            return;
          }
          segment[field] = Math.round(parsed * 1000) / 1000;
          input.value = formatTimestamp(segment[field]);
          segment.timestampAdjusted =
            Math.abs(segment.originalStart - segment.adjustedStart) > 0.001 ||
            Math.abs(segment.originalEnd - segment.adjustedEnd) > 0.001;
          if (segment.adjustedStart >= segment.adjustedEnd) {
            showNotice("Segment start must be before segment end.", true);
          } else {
            showNotice("");
          }
        }
        invalidateAnalysis();
      });
    });
  });
}

function renderReport() {
  const report = state.report;
  const canApprove = Boolean(report && report.status === "readyToReview" && state.planState === "readyToReview");
  $("#approve-report").disabled = !canApprove;
  $("#fingerprint-line").textContent = report
    ? `${report.status} · ${report.fingerprint.slice(0, 16)} · ${new Date(report.generatedAt).toLocaleString()}`
    : "No current report.";
  if (!report) {
    $("#report-view").className = "report-view empty-state";
    $("#report-view").textContent = "Run Analyze to preview the exact keep ranges.";
    return;
  }
  $("#report-view").className = "report-view";
  const messages = [
    ...report.blockingErrors.map((message) => ["bad", message]),
    ...report.warnings.map((message) => ["warn", message]),
    ...(report.blockingErrors.length === 0 && state.planState !== "stale" ? [["ok", "Report is ready for approval."]] : []),
    ...(state.planState === "stale" ? [["warn", "Settings changed after this report. Run Analyze again."]] : []),
  ];
  $("#report-view").innerHTML = `
    <div class="report-summary">
      ${[
        ["Source", report.summary.sourceDurationText],
        ["Selected", report.summary.selectedDurationText],
        ["Silence", report.summary.detectedSilenceText],
        ["Too short", report.summary.discardedTooShortText],
        ["Output", report.summary.estimatedOutputText],
        ["Cut", report.summary.estimatedCutText],
        ["Kept of source", `${report.summary.keptPercentOfSource}%`],
        ["Kept of selection", `${report.summary.keptPercentOfSelection}%`],
      ]
        .map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`)
        .join("")}
    </div>
    <div class="messages">
      ${messages.map(([kind, message]) => `<div class="message ${kind}">${escapeHtml(message)}</div>`).join("")}
    </div>
    <div class="report-section">
      <h3>Final Keep Ranges</h3>
      ${report.finalKeepRanges.length ? report.finalKeepRanges.map(reportRange).join("") : `<div class="empty-state">No keep ranges.</div>`}
    </div>
  `;
}

function reportRange(range) {
  return `
    <div class="report-row">
      <strong>${formatTimestamp(range.start)} - ${formatTimestamp(range.end)}, ${formatDuration(range.duration)}</strong>
      <small>${escapeHtml(range.source)} · ${escapeHtml(range.sourceVideo)}</small>
    </div>
  `;
}

function renderRenderPanel() {
  const canRender = state.planState === "approved" && state.report?.status === "approved";
  $("#render-button").disabled = !canRender;
  $("#render-status").textContent = canRender
    ? "Ready to encode from the approved report."
    : "Awaiting an approved Analyze report.";
  if (state.renderResult) {
    $("#render-status").textContent = `Rendered ${state.renderResult.sizeText}: ${state.renderResult.outputFile}`;
    $("#render-log").textContent = state.renderResult.logTail || "";
  }
}

function render() {
  renderSettingsPanel();
  renderStepNav();
  renderShell();
  renderSources();
  renderTranscript();
  renderTimestampRows();
  renderSelectionRows();
  renderReport();
  renderRenderPanel();
}

async function browse(dir) {
  try {
    showNotice("");
    const data = await browseDirectory(dir);
    renderBrowser(data);
  } catch (error) {
    showNotice(error.message, true);
  }
}

async function selectSource(sourcePath) {
  try {
    const data = await probeVideos([sourcePath]);
    state.sourceVideos = data.videos;
    state.transcriptSegments = [];
    state.transcriptPath = "";
    state.transcriptMetadata = null;
    state.report = null;
    state.planState = "draft";
    showNotice("");
    render();
  } catch (error) {
    showNotice(error.message, true);
  }
}

async function chooseWorkspace() {
  if (!state.tauriReady || !openDialog) return;
  try {
    const selected = await openDialog({ directory: true, multiple: false, title: "Choose VidVerba Workspace" });
    if (!selected) return;
    $("#settings-workspace-path").value = selected;
    state.config = await saveRuntimeConfig(currentRuntimeConfig());
    applyConfigToMainControls({ applyPlan: true });
    syncSettingsPanelInputs();
    await browse(state.config.defaultInputDir);
    showSettingsStatus("Workspace saved.");
    render();
  } catch (error) {
    showSettingsStatus(error.message || String(error), true);
  }
}

async function chooseSourceFile() {
  if (!state.tauriReady || !openDialog) return;
  try {
    const selected = await openDialog({
      multiple: false,
      title: "Choose Source Video",
      filters: [{ name: "Video", extensions: ["mp4", "mov", "mkv", "webm"] }],
    });
    if (selected) await selectSource(selected);
  } catch (error) {
    showNotice(error.message || String(error), true);
  }
}

async function saveRuntimeConfigFromPanel() {
  if (!state.tauriReady) return;
  const button = $("#save-runtime-config");
  try {
    setBusy(button, true, "Saving...");
    const previousInputDir = state.config?.defaultInputDir;
    state.config = await saveRuntimeConfig(currentRuntimeConfig());
    applyConfigToMainControls({ applyPlan: true });
    syncSettingsPanelInputs();
    if (state.report) {
      state.planState = "stale";
      state.renderResult = null;
    }
    if (state.config.defaultInputDir && state.config.defaultInputDir !== previousInputDir) {
      await browse(state.config.defaultInputDir);
    }
    showSettingsStatus("Saved to config.toml.");
    render();
  } catch (error) {
    showSettingsStatus(error.message || String(error), true);
  } finally {
    setBusy(button, false);
  }
}

async function loadTranscript(force) {
  if (!state.sourceVideos.length) {
    showNotice("Select a source video first.", true);
    return;
  }
  if (!dependencyAvailable("python") || !dependencyAvailable("faster-whisper")) {
    showNotice("Python and faster-whisper must be ready before transcription can run.", true);
    return;
  }
  const button = force ? $("#force-transcript") : $("#load-transcript");
  try {
    setBusy(button, true, force ? "Transcribing..." : "Loading...");
    showNotice("");
    const data = await loadOrRunTranscript({
      sourcePath: state.sourceVideos[0].path,
      model: selectedTranscriptionModel(),
      language: $("#language-input").value.trim(),
      device: $("#device-input").value,
      computeType: state.config?.settings?.transcription?.computeType ?? "auto",
      beamSize: state.config?.settings?.transcription?.beamSize ?? 5,
      vadFilter: state.config?.settings?.transcription?.vadFilter ?? true,
      vadMinSilenceMs: state.config?.settings?.transcription?.vadMinSilenceMs ?? DEFAULT_VAD_MIN_SILENCE_MS,
      wordTimestamps: state.config?.settings?.transcription?.wordTimestamps ?? true,
      conditionOnPreviousText: state.config?.settings?.transcription?.conditionOnPreviousText ?? false,
      hallucinationSilenceThreshold:
        state.config?.settings?.transcription?.hallucinationSilenceThreshold ?? DEFAULT_HALLUCINATION_SILENCE_THRESHOLD,
      silenceThresholdDb:
        state.config?.settings?.transcription?.silenceThresholdDb ?? DEFAULT_TRANSCRIPT_SILENCE_THRESHOLD_DB,
      force,
    });
    state.transcriptSegments = data.segments;
    state.transcriptPath = data.path || "";
    state.transcriptMetadata = data.metadata || null;
    state.report = null;
    state.planState = "draft";
    showNotice(data.reusedExisting ? "Loaded an existing transcript." : "Transcript generated.");
    render();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    setBusy(button, false);
  }
}

async function runAnalyze() {
  if (!state.sourceVideos.length || !state.transcriptSegments.some((segment) => segment.selected)) {
    showNotice("Select source video and transcript ranges before analysis.", true);
    return;
  }
  if (!dependencyAvailable("ffmpeg") || !dependencyAvailable("ffprobe")) {
    showNotice("ffmpeg and ffprobe must be ready before analysis can run.", true);
    return;
  }
  try {
    const button = $("#run-analyze");
    setBusy(button, true, "Analyzing...");
    state.planState = "analyzing";
    renderShell();
    const report = await analyzePlan({
      sourcePath: state.sourceVideos[0].path,
      sourceVideos: state.sourceVideos.map((video) => video.path),
      transcriptSegments: state.transcriptSegments,
      settings: getSettings(),
    });
    state.report = report;
    state.planState = report.status === "blocked" ? "blocked" : "readyToReview";
    showNotice("");
    render();
  } catch (error) {
    state.planState = "draft";
    showNotice(error.message, true);
    render();
  } finally {
    setBusy($("#run-analyze"), false);
  }
}

async function renderApproved() {
  if (!dependencyAvailable("ffmpeg")) {
    showNotice("ffmpeg must be ready before rendering can run.", true);
    return;
  }
  try {
    const button = $("#render-button");
    setBusy(button, true, "Rendering...");
    state.planState = "rendering";
    renderShell();
    const result = await renderApprovedReport({
      report: state.report,
      outputFile: $("#output-file").value.trim(),
    });
    state.renderResult = result;
    state.planState = "approved";
    showNotice("Render complete.");
    render();
  } catch (error) {
    state.planState = "approved";
    showNotice(error.message, true);
    render();
  } finally {
    setBusy($("#render-button"), false);
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function bindEvents() {
  $("#settings-button").addEventListener("click", openSettingsPanel);
  $("#settings-close").addEventListener("click", closeSettingsPanel);
  $("#settings-scrim").addEventListener("click", closeSettingsPanel);
  $("#save-runtime-config").addEventListener("click", saveRuntimeConfigFromPanel);
  $("#back-button").addEventListener("click", () => goToStep(state.currentStep - 1));
  $("#next-button").addEventListener("click", () => goToStep(state.currentStep + 1));
  $("#open-folder").addEventListener("click", () => browse($("#folder-input").value));
  $("#up-folder").addEventListener("click", () => state.browseParent && browse(state.browseParent));
  $("#choose-workspace").addEventListener("click", chooseWorkspace);
  $("#choose-source").addEventListener("click", chooseSourceFile);
  $("#folder-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") browse($("#folder-input").value);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isSettingsPanelOpen()) closeSettingsPanel();
  });
  $("#load-transcript").addEventListener("click", () => loadTranscript(false));
  $("#force-transcript").addEventListener("click", () => loadTranscript(true));
  $("#reset-adjustments").addEventListener("click", () => {
    state.transcriptSegments.forEach((segment) => {
      segment.adjustedStart = segment.originalStart;
      segment.adjustedEnd = segment.originalEnd;
      segment.timestampAdjusted = false;
    });
    invalidateAnalysis();
  });
  $("#select-all").addEventListener("click", () => {
    state.transcriptSegments.forEach((segment) => (segment.selected = true));
    invalidateAnalysis();
  });
  $("#select-none").addEventListener("click", () => {
    state.transcriptSegments.forEach((segment) => (segment.selected = false));
    invalidateAnalysis();
  });
  [
    "#lead-in",
    "#lead-out",
    "#silence-enabled",
    "#threshold-db",
    "#min-silence",
    "#min-clip",
    "#front-padding",
    "#video-codec",
    "#frame-rate",
    "#edit-friendly",
    "#output-file",
  ].forEach((selector) => $(selector).addEventListener("change", invalidateAnalysis));
  $("#run-analyze").addEventListener("click", runAnalyze);
  $("#approve-report").addEventListener("click", () => {
    if (!state.report || state.report.status !== "readyToReview" || state.planState !== "readyToReview") return;
    state.report = { ...state.report, status: "approved" };
    state.planState = "approved";
    render();
  });
  $("#render-button").addEventListener("click", renderApproved);
}

async function init() {
  bindEvents();
  render();
  if (!state.tauriReady) {
    showNotice("VidVerba is a Tauri desktop app. Run it with the desktop shell.", true);
    return;
  }
  state.config = await getConfig();
  applyConfigToMainControls({ applyPlan: true });
  syncSettingsPanelInputs();
  await browse(state.config.defaultInputDir);
  render();
}

init().catch((error) => showNotice(error.message, true));
