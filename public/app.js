// ---------- DOM refs ----------
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const chromeLabel = document.getElementById("chromeLabel");
const scrubberFill = document.getElementById("scrubberFill");
const configurePanel = document.getElementById("configurePanel");
const hiddenVideo = document.getElementById("hiddenVideo");
const previewCanvas = document.getElementById("previewCanvas");
const previewTag = document.getElementById("previewTag");

const fpsSlider = document.getElementById("fpsSlider");
const fpsValue = document.getElementById("fpsValue");
const videoQSlider = document.getElementById("videoQSlider");
const videoQValue = document.getElementById("videoQValue");
const videoQSub = document.getElementById("videoQSub");
const audioQSlider = document.getElementById("audioQSlider");
const audioQValue = document.getElementById("audioQValue");
const audioQSub = document.getElementById("audioQSub");

const compressBtn = document.getElementById("compressBtn");
const cancelBtn = document.getElementById("cancelBtn");

const states = {
  idle: document.getElementById("stateIdle"),
  processing: document.getElementById("stateProcessing"),
  done: document.getElementById("stateDone"),
  error: document.getElementById("stateError"),
};

const progressFill = document.getElementById("progressFill");
const progressPct = document.getElementById("progressPct");
const downloadBtn = document.getElementById("downloadBtn");
const errorMsg = document.getElementById("errorMsg");

let selectedFile = null;
let sourceCanvas = null; // holds the captured frame at a reasonable working resolution
let objectUrl = null;

// ---------- state machine ----------
function showState(name) {
  for (const key in states) {
    states[key].hidden = key !== name;
  }
}

function showConfigure(show) {
  configurePanel.hidden = !show;
}

function resetToIdle() {
  showState("idle");
  showConfigure(false);
  chromeLabel.textContent = "no file loaded";
  scrubberFill.style.width = "0%";
  previewCanvas.hidden = true;
  previewTag.hidden = true;
  fileInput.value = "";
  selectedFile = null;
  sourceCanvas = null;
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
}

// ---------- file selection ----------
dropzone.addEventListener("click", () => {
  if (!states.idle.hidden) fileInput.click();
});

dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("dragover");
});

dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("dragover");
});

dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  if (!states.idle.hidden && e.dataTransfer.files[0]) {
    handleFile(e.dataTransfer.files[0]);
  }
});

fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});

document.getElementById("resetBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  resetToIdle();
});

document.getElementById("retryBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  resetToIdle();
});

cancelBtn.addEventListener("click", () => resetToIdle());

async function handleFile(file) {
  selectedFile = file;
  chromeLabel.textContent = file.name;

  objectUrl = URL.createObjectURL(file);
  hiddenVideo.src = objectUrl;

  try {
    await captureSourceFrame(hiddenVideo);
    showConfigure(true);
    states.idle.hidden = true;
    previewCanvas.hidden = false;
    previewTag.hidden = false;
    scheduleRender();
  } catch (err) {
    showError("Couldn't read that video file. Try a different one.");
  }
}

// Grab one frame from the video (roughly a quarter of the way in, so we
// skip any black intro) and stash it on an offscreen canvas we can
// re-sample cheaply every time a slider moves.
function captureSourceFrame(video) {
  return new Promise((resolve, reject) => {
    const onError = () => reject(new Error("video load error"));
    video.addEventListener("error", onError, { once: true });

    video.addEventListener(
      "loadedmetadata",
      () => {
        video.currentTime = Math.min(1, video.duration * 0.25 || 0);
      },
      { once: true }
    );

    video.addEventListener(
      "seeked",
      () => {
        const maxW = 640;
        const scale = Math.min(1, maxW / video.videoWidth);
        const w = Math.round(video.videoWidth * scale);
        const h = Math.round(video.videoHeight * scale);

        sourceCanvas = document.createElement("canvas");
        sourceCanvas.width = w;
        sourceCanvas.height = h;
        sourceCanvas.getContext("2d").drawImage(video, 0, 0, w, h);

        // Size the visible preview canvas to match the real aspect ratio.
        previewCanvas.width = 480;
        previewCanvas.height = Math.round(480 * (h / w));

        video.removeEventListener("error", onError);
        resolve();
      },
      { once: true }
    );
  });
}

// ---------- setting <-> quality mapping ----------
// Single source of truth for what a slider position means, shared between
// the live preview and the values sent to the server for the real encode.
function lerp(t, a, b) {
  return a + (b - a) * t;
}

function videoSettingsFromQuality(q) {
  const t = (q - 1) / 9; // 0..1
  const width = Math.round(lerp(t, 120, 480) / 2) * 2; // keep even
  const bitrateKbps = Math.round(lerp(t, 80, 1200));
  return { width, bitrateKbps };
}

function audioSettingsFromQuality(q) {
  const t = (q - 1) / 9;
  const bitrateKbps = Math.round(lerp(t, 24, 160));
  const sampleRate = q <= 3 ? 11025 : q <= 6 ? 22050 : 44100;
  const channels = q <= 5 ? 1 : 2;
  return { bitrateKbps, sampleRate, channels };
}

// ---------- live preview rendering ----------
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderPreview();
  });
}

function renderPreview() {
  if (!sourceCanvas) return;

  const vq = parseInt(videoQSlider.value, 10);
  const aq = parseInt(audioQSlider.value, 10);
  const { width: encodeWidth, bitrateKbps } = videoSettingsFromQuality(vq);
  const aspect = sourceCanvas.height / sourceCanvas.width;
  const tinyW = Math.max(20, encodeWidth);
  const tinyH = Math.max(15, Math.round(tinyW * aspect));

  // Step 1: downsample to the "encode resolution" with a flattened,
  // slightly desaturated color grade, approximating the ffmpeg eq filter.
  const tiny = document.createElement("canvas");
  tiny.width = tinyW;
  tiny.height = tinyH;
  const tctx = tiny.getContext("2d");
  tctx.filter = "saturate(85%) contrast(108%) brightness(102%)";
  tctx.drawImage(sourceCanvas, 0, 0, tinyW, tinyH);

  // Step 2: blow it back up with no smoothing, so the resolution loss
  // reads as visible blockiness, same as a low-res video stretched to
  // fill a player.
  const pctx = previewCanvas.getContext("2d");
  pctx.imageSmoothingEnabled = false;
  pctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  pctx.drawImage(tiny, 0, 0, tinyW, tinyH, 0, 0, previewCanvas.width, previewCanvas.height);

  // Step 3: grain + banding, both scaled inversely with bitrate — a
  // starved bitrate means more visible noise and posterization.
  applyArtifacts(pctx, previewCanvas.width, previewCanvas.height, bitrateKbps);

  // ---- update labels ----
  const fps = parseInt(fpsSlider.value, 10);
  const audio = audioSettingsFromQuality(aq);

  fpsValue.textContent = `${fps} fps`;
  videoQValue.textContent = `${vq} / 10`;
  videoQSub.textContent = `${encodeWidth}×${Math.round(encodeWidth * aspect)} · ~${bitrateKbps}kbps`;
  audioQValue.textContent = `${aq} / 10`;
  audioQSub.textContent = `${audio.channels === 1 ? "mono" : "stereo"} · ${audio.bitrateKbps}kbps · ${(audio.sampleRate / 1000).toFixed(2)}kHz`;
  previewTag.textContent = `${encodeWidth}×${Math.round(encodeWidth * aspect)} · ${bitrateKbps}kbps`;
}

function applyArtifacts(ctx, w, h, bitrateKbps) {
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;

  // Lower bitrate -> more grain, fewer color levels (banding).
  const noiseAmt = clampNum(lerp((1200 - bitrateKbps) / (1200 - 80), 6, 42), 6, 42);
  const levels = clampNum(lerp((bitrateKbps - 80) / (1200 - 80), 6, 40), 6, 40);
  const step = 256 / levels;

  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      let v = d[i + c];
      v = Math.round(v / step) * step; // banding
      v += (Math.random() - 0.5) * noiseAmt; // grain
      d[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  ctx.putImageData(imgData, 0, 0);
}

function clampNum(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

[fpsSlider, videoQSlider, audioQSlider].forEach((el) => {
  el.addEventListener("input", scheduleRender);
});

// ---------- kick off the real encode ----------
compressBtn.addEventListener("click", () => {
  if (!selectedFile) return;
  startCompression(selectedFile);
});

async function startCompression(file) {
  showConfigure(false);
  showState("processing");
  progressFill.style.width = "0%";
  progressPct.textContent = "0%";

  const vq = parseInt(videoQSlider.value, 10);
  const aq = parseInt(audioQSlider.value, 10);
  const fps = parseInt(fpsSlider.value, 10);
  const video = videoSettingsFromQuality(vq);
  const audio = audioSettingsFromQuality(aq);

  const formData = new FormData();
  formData.append("video", file);
  formData.append("fps", fps);
  formData.append("videoWidth", video.width);
  formData.append("videoBitrateKbps", video.bitrateKbps);
  formData.append("audioBitrateKbps", audio.bitrateKbps);
  formData.append("audioChannels", audio.channels);
  formData.append("audioSampleRate", audio.sampleRate);

  try {
    const uploadRes = await fetch("/api/compress", {
      method: "POST",
      body: formData,
    });
    const uploadData = await uploadRes.json();

    if (!uploadRes.ok) {
      throw new Error(uploadData.error || "Upload failed.");
    }

    pollStatus(uploadData.jobId);
  } catch (err) {
    showError(err.message);
  }
}

function pollStatus(jobId) {
  const interval = setInterval(async () => {
    try {
      const res = await fetch(`/api/status/${jobId}`);
      const data = await res.json();

      if (data.status === "processing") {
        const pct = data.progress || 0;
        progressFill.style.width = `${pct}%`;
        scrubberFill.style.width = `${pct}%`;
        progressPct.textContent = `${pct}%`;
      } else if (data.status === "done") {
        clearInterval(interval);
        progressFill.style.width = "100%";
        scrubberFill.style.width = "100%";
        downloadBtn.href = `/api/download/${jobId}`;
        showState("done");
      } else if (data.status === "error") {
        clearInterval(interval);
        showError(data.error || "Something went wrong during compression.");
      }
    } catch (err) {
      clearInterval(interval);
      showError("Lost connection to the server.");
    }
  }, 800);
}

function showError(message) {
  showConfigure(false);
  errorMsg.textContent = message;
  showState("error");
}