const steps = [
  { id: "source", title: "Select Source Video" },
  { id: "transcript", title: "Generate and Review Transcript" },
  { id: "timestamps", title: "Edit Transcript Timestamps" },
  { id: "selection", title: "Manual Timestamp Selection" },
  { id: "export", title: "Configure Export Plan" },
  { id: "analyze", title: "Analyze Preflight" },
  { id: "render", title: "Render Approved Plan" },
];

const state = {
  config: null,
  desktop: Boolean(window.__TAURI__?.core?.invoke),
  currentStep: 0,
  browseDir: "",
  browseParent: null,
  sourceVideos: [],
  transcriptSegments: [],
  transcriptPath: "",
  planState: "draft",
  report: null,
  renderResult: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const invoke = (...args) => window.__TAURI__.core.invoke(...args);
const openDialog = (...args) => window.__TAURI__?.dialog?.open?.(...args);

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

function segmentDuration(segment) {
  return Math.max(0, Number(segment.adjustedEnd) - Number(segment.adjustedStart));
}

async function api(path, options = {}) {
  if (state.desktop) {
    return desktopApi(path, options);
  }
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(data.error || "Request failed.");
  }
  return data;
}

async function desktopApi(path, options = {}) {
  const method = options.method || "GET";
  const body = options.body ? JSON.parse(options.body) : {};
  if (method === "GET" && path === "/api/config") {
    return invokeCommand("get_config");
  }
  if (method === "GET" && path.startsWith("/api/browse")) {
    const url = new URL(path, window.location.href);
    return invokeCommand("browse_directory", { requestedDir: url.searchParams.get("dir") || null });
  }
  if (method === "POST" && path === "/api/probe") {
    return invokeCommand("probe_videos", { paths: body.paths || (body.path ? [body.path] : []) });
  }
  if (method === "POST" && path === "/api/transcribe") {
    return invokeCommand("load_or_run_transcript", { request: body });
  }
  if (method === "POST" && path === "/api/analyze") {
    return invokeCommand("analyze_plan", { request: body });
  }
  if (method === "POST" && path === "/api/render") {
    return invokeCommand("render_report", { request: body });
  }
  throw new Error(`Unsupported desktop API call: ${method} ${path}`);
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

function renderDesktopPanel() {
  const panel = $(".desktop-panel");
  if (!panel) return;
  panel.classList.toggle("hidden", !state.desktop);
  if (!state.desktop) return;

  const settings = state.config?.settings || {};
  $("#workspace-path").value = state.config?.workspacePath || settings.workspacePath || "";
  $("#ffmpeg-path").value = settings.dependencyPaths?.ffmpeg || "";
  $("#ffprobe-path").value = settings.dependencyPaths?.ffprobe || "";
  $("#python-path").value = settings.dependencyPaths?.python || "";
  $("#workspace-status").textContent = state.config?.workspacePath
    ? `Workspace is ${state.config.workspacePath}`
    : "Choose a workspace folder before transcribing, analyzing, or rendering.";

  $("#dependency-grid").innerHTML = dependencyList()
    .map(
      (dependency) => `
        <div class="dependency ${dependency.available ? "ok" : "bad"}">
          <strong>${escapeHtml(dependency.name)}</strong>
          <span>${escapeHtml(dependency.requiredFor)}</span>
          <small>${escapeHtml(dependency.version || dependency.message || "")}</small>
          ${dependency.resolvedPath ? `<small>${escapeHtml(dependency.resolvedPath)}</small>` : ""}
        </div>
      `,
    )
    .join("");
}

function currentDesktopSettings() {
  const existing = state.config?.settings || {};
  return {
    workspacePath: $("#workspace-path").value.trim() || null,
    dependencyPaths: {
      ffmpeg: $("#ffmpeg-path").value.trim() || null,
      ffprobe: $("#ffprobe-path").value.trim() || null,
      python: $("#python-path").value.trim() || null,
    },
    transcription: {
      model: $("#model-input").value.trim() || existing.transcription?.model || "base",
      language: $("#language-input").value.trim() || null,
      device: $("#device-input").value || existing.transcription?.device || "cpu",
      computeType: existing.transcription?.computeType || "auto",
      beamSize: existing.transcription?.beamSize || 5,
    },
    export: {
      videoCodec: $("#video-codec").value || existing.export?.videoCodec || "libx264",
      audioCodec: "aac",
      editFriendly: $("#edit-friendly").checked,
      frameRate: $("#frame-rate").value ? Number($("#frame-rate").value) : null,
    },
  };
}

function getSettings() {
  return {
    padding: {
      leadIn: Number($("#lead-in").value || 0),
      leadOut: Number($("#lead-out").value || 0),
    },
    silence: {
      enabled: $("#silence-enabled").checked,
      thresholdDb: Number($("#threshold-db").value || -39),
      minSilenceSeconds: Number($("#min-silence").value || 0.6),
      minClipSeconds: Number($("#min-clip").value || 0.3),
      frontPaddingSeconds: Number($("#front-padding").value || 0.1),
    },
    export: {
      outputFile: $("#output-file").value.trim(),
      videoCodec: $("#video-codec").value,
      audioCodec: "aac",
      editFriendly: $("#edit-friendly").checked,
      frameRate: $("#frame-rate").value ? Number($("#frame-rate").value) : null,
      format: "mp4",
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
  $("#transcript-status").textContent = state.transcriptSegments.length
    ? `${state.transcriptSegments.length} segments loaded from ${state.transcriptPath || "transcript data"}.`
    : "No transcript loaded.";
  $("#transcript-preview").innerHTML = state.transcriptSegments
    .slice(0, 80)
    .map(
      (segment) => `
        <p><strong>${formatTimestamp(segment.adjustedStart)} - ${formatTimestamp(segment.adjustedEnd)}</strong> ${escapeHtml(segment.text)}</p>
      `,
    )
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
  $("#selection-summary").innerHTML = [
    ["Segments", String(selected.length)],
    ["Selected duration", formatDuration(duration)],
    ["Transcript duration", formatDuration(state.transcriptSegments.reduce((total, segment) => total + segmentDuration(segment), 0))],
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
  return `
    <div class="segment-row ${segment.selected ? "selected" : ""} ${adjusted ? "adjusted" : ""}" data-index="${index}">
      ${showCheckbox ? `<input type="checkbox" data-field="selected" ${segment.selected ? "checked" : ""} aria-label="Select segment">` : `<span class="pill">${index + 1}</span>`}
      <label>Start <input data-field="adjustedStart" value="${formatTimestamp(segment.adjustedStart)}"></label>
      <label>End <input data-field="adjustedEnd" value="${formatTimestamp(segment.adjustedEnd)}"></label>
      <div class="segment-text">
        <p>${escapeHtml(segment.text)}</p>
        <div class="segment-original">Original ${formatTimestamp(segment.originalStart)} - ${formatTimestamp(segment.originalEnd)}</div>
      </div>
      <span class="pill">${adjusted ? "Adjusted" : formatDuration(segmentDuration(segment))}</span>
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
  renderDesktopPanel();
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
    const data = await api(`/api/browse?dir=${encodeURIComponent(dir || "")}`, { method: "GET", headers: {} });
    renderBrowser(data);
  } catch (error) {
    showNotice(error.message, true);
  }
}

async function selectSource(sourcePath) {
  try {
    const data = await api("/api/probe", {
      method: "POST",
      body: JSON.stringify({ paths: [sourcePath] }),
    });
    state.sourceVideos = data.videos;
    state.transcriptSegments = [];
    state.transcriptPath = "";
    state.report = null;
    state.planState = "draft";
    showNotice("");
    render();
  } catch (error) {
    showNotice(error.message, true);
  }
}

async function chooseWorkspace() {
  if (!state.desktop || !openDialog) return;
  try {
    const selected = await openDialog({ directory: true, multiple: false, title: "Choose VidVerba Workspace" });
    if (!selected) return;
    state.config = await invokeCommand("set_workspace", { path: selected });
    await browse(state.config.defaultInputDir);
    showNotice("Workspace saved.");
    render();
  } catch (error) {
    showNotice(error.message || String(error), true);
  }
}

async function chooseSourceFile() {
  if (!state.desktop || !openDialog) return;
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

async function saveDesktopSettings() {
  if (!state.desktop) return;
  try {
    state.config = await invokeCommand("save_settings", { settings: currentDesktopSettings() });
    showNotice("Desktop settings saved.");
    render();
  } catch (error) {
    showNotice(error.message || String(error), true);
  }
}

async function loadTranscript(force) {
  if (!state.sourceVideos.length) {
    showNotice("Select a source video first.", true);
    return;
  }
  if (state.desktop && (!dependencyAvailable("python") || !dependencyAvailable("faster-whisper"))) {
    showNotice("Python and faster-whisper must be ready before transcription can run.", true);
    return;
  }
  const button = force ? $("#force-transcript") : $("#load-transcript");
  try {
    setBusy(button, true, force ? "Transcribing..." : "Loading...");
    showNotice("");
    const data = await api("/api/transcribe", {
      method: "POST",
      body: JSON.stringify({
        sourcePath: state.sourceVideos[0].path,
        model: $("#model-input").value.trim() || "base",
        language: $("#language-input").value.trim(),
        device: $("#device-input").value,
        force,
      }),
    });
    state.transcriptSegments = data.segments;
    state.transcriptPath = data.path || "";
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
  if (state.desktop && (!dependencyAvailable("ffmpeg") || !dependencyAvailable("ffprobe"))) {
    showNotice("ffmpeg and ffprobe must be ready before analysis can run.", true);
    return;
  }
  try {
    const button = $("#run-analyze");
    setBusy(button, true, "Analyzing...");
    state.planState = "analyzing";
    renderShell();
    const report = await api("/api/analyze", {
      method: "POST",
      body: JSON.stringify({
        sourcePath: state.sourceVideos[0].path,
        sourceVideos: state.sourceVideos.map((video) => video.path),
        transcriptSegments: state.transcriptSegments,
        settings: getSettings(),
      }),
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
  if (state.desktop && !dependencyAvailable("ffmpeg")) {
    showNotice("ffmpeg must be ready before rendering can run.", true);
    return;
  }
  try {
    const button = $("#render-button");
    setBusy(button, true, "Rendering...");
    state.planState = "rendering";
    renderShell();
    const result = await api("/api/render", {
      method: "POST",
      body: JSON.stringify({
        report: state.report,
        outputFile: $("#output-file").value.trim(),
      }),
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
  $("#back-button").addEventListener("click", () => goToStep(state.currentStep - 1));
  $("#next-button").addEventListener("click", () => goToStep(state.currentStep + 1));
  $("#open-folder").addEventListener("click", () => browse($("#folder-input").value));
  $("#up-folder").addEventListener("click", () => state.browseParent && browse(state.browseParent));
  $("#choose-workspace").addEventListener("click", chooseWorkspace);
  $("#choose-source").addEventListener("click", chooseSourceFile);
  $("#save-dependencies").addEventListener("click", saveDesktopSettings);
  $("#folder-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") browse($("#folder-input").value);
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
  state.config = await api("/api/config", { method: "GET", headers: {} });
  if (state.desktop) {
    $("#model-input").value = state.config.settings?.transcription?.model || "base";
    $("#language-input").value = state.config.settings?.transcription?.language || "";
    $("#device-input").value = state.config.settings?.transcription?.device || "cpu";
    $("#video-codec").value = state.config.settings?.export?.videoCodec || "libx264";
    $("#edit-friendly").checked = state.config.settings?.export?.editFriendly ?? true;
    $("#frame-rate").value = state.config.settings?.export?.frameRate || "";
  }
  await browse(state.config.defaultInputDir);
  render();
}

init().catch((error) => showNotice(error.message, true));
