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
const sizeOptions = document.getElementById("sizeOptions");
let videoSize = 480; // active resolution (height px)
const sizeBtns = [...sizeOptions.querySelectorAll(".size-btn")];
sizeBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    videoSize = parseInt(btn.dataset.size, 10);
    sizeBtns.forEach((b) => b.classList.toggle("is-active", b === btn));
    scheduleRender();
  });
});
const videoQSlider = document.getElementById("videoQSlider");
const videoQValue = document.getElementById("videoQValue");
const videoQSub = document.getElementById("videoQSub");
const audioQSlider = document.getElementById("audioQSlider");
const audioQValue = document.getElementById("audioQValue");
const audioQSub = document.getElementById("audioQSub");

const compressBtn = document.getElementById("compressBtn");
const cancelBtn = document.getElementById("cancelBtn");
const estimate = document.getElementById("estimate");

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
let videoDuration = 0; // seconds

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
    videoDuration = isFinite(hiddenVideo.duration) ? hiddenVideo.duration : 0;
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
        const maxW = 1600;
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
// Resolution stays FIXED here — the quality slider only throttles bitrate,
// which is what actually makes video look bad (blocking, banding, grain).
//
// These are deliberately non-linear. Bitrate is not a linear measure of
// perceived quality: the low end is already starved, while extra bitrate at
// the high end buys much more usable detail. The tiers also keep the labels
// honest about the intended anchors: 140kbps is video 6/10 and 24kbps is
// audio 4/10.
const VIDEO_QUALITY_KBPS = [40, 60, 80, 100, 120, 140, 240, 400, 800, 2000];
const AUDIO_QUALITY_KBPS = [16, 18, 20, 24, 32, 48, 64, 96, 128, 160];

function lerp(t, a, b) {
  return a + (b - a) * t;
}

function clampNum(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

// Resolution slider gives a pixel height (240p..720p). Derive an even width
// from the frame's aspect ratio so the server can scale to it.
function encodeWidthP() {
  const h = videoSize;
  const aspect = sourceCanvas ? sourceCanvas.width / sourceCanvas.height : 16 / 9;
  const w = Math.round(h * aspect);
  return w % 2 === 0 ? w : w - 1;
}

function videoSettingsFromQuality(q) {
  const index = clampNum(Math.round(q) - 1, 0, VIDEO_QUALITY_KBPS.length - 1);
  const bitrateKbps = VIDEO_QUALITY_KBPS[index];
  return { width: encodeWidthP(), bitrateKbps };
}

function audioSettingsFromQuality(q) {
  const index = clampNum(Math.round(q) - 1, 0, AUDIO_QUALITY_KBPS.length - 1);
  const bitrateKbps = AUDIO_QUALITY_KBPS[index];
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
  const { width: encodeW, bitrateKbps } = videoSettingsFromQuality(vq);
  const aspect = sourceCanvas.height / sourceCanvas.width;
  const good = (vq - 1) / 9; // 0 = worst, 1 = best
  const bad = 1 - good;

  // Step 1: render the frame at the encode resolution. We keep it at full
  // resolution — the ugliness has to come from codec artifacts below, not
  // from shrinking the picture.
  const tiny = document.createElement("canvas");
  tiny.width = encodeW;
  tiny.height = Math.round(encodeW * aspect);
  const tctx = tiny.getContext("2d");
  tctx.filter = "saturate(85%) contrast(108%) brightness(102%)";
  tctx.drawImage(sourceCanvas, 0, 0, tiny.width, tiny.height);

  // Step 2: pop it on the preview at full size with no smoothing. The
  // resolution doesn't change, so the "bad quality" has to be real.
  const pctx = previewCanvas.getContext("2d");
  pctx.imageSmoothingEnabled = false;
  pctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  pctx.drawImage(tiny, 0, 0, tiny.width, tiny.height, 0, 0, previewCanvas.width, previewCanvas.height);

  // Step 3: codec-style degradation, scaled with quality. Heavy block
  // artifacts at the low end, banding + grain everywhere below full quality.
  if (bad > 0.02) applyMacroblocking(pctx, previewCanvas.width, previewCanvas.height, bad);
  applyArtifacts(pctx, previewCanvas.width, previewCanvas.height, good);

  // ---- update labels ----
  const fps = parseInt(fpsSlider.value, 10);
  const audio = audioSettingsFromQuality(aq);

  fpsValue.textContent = `${fps} fps`;
  videoQValue.textContent = `${vq} / 10`;
  videoQSub.textContent = `~${bitrateKbps}kbps · ${levelWord(good)}`;
  audioQValue.textContent = `${aq} / 10`;
  audioQSub.textContent = `${audio.channels === 1 ? "mono" : "stereo"} · ${audio.bitrateKbps}kbps · ${(audio.sampleRate / 1000).toFixed(2)}kHz`;
  previewTag.textContent = `~${bitrateKbps}kbps · ${levelWord(good)}`;
  estimate.textContent = `est. ${formatSize(estimatedBytes(bitrateKbps, audio.bitrateKbps, fps))}`;
}

function estimatedBytes(videoKbps, audioKbps, fps) {
  // Overhead for the timebase + one-fewer frames than fps*duration.
  const seconds = videoDuration || 0;
  const frames = Math.max(0, Math.round(seconds * (fps || 1)) - 1);
  const overhead = 256;
  const bytes = Math.round(((videoKbps + audioKbps) * 1000 / 8) * seconds) - overhead * frames;
  return Math.max(0, bytes);
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function levelWord(bad) {
  if (bad > 0.8) return "brutal";
  if (bad > 0.6) return "awful";
  if (bad > 0.4) return "rough";
  if (bad > 0.2) return "meh";
  return "fine";
}

// Faux-H.264 macroblocking: the frame gets chopped into a grid and each cell
// is crushed to a quantized color, exactly like a starved encoder's blocks.
function applyMacroblocking(ctx, w, h, bad) {
  const src = ctx.getImageData(0, 0, w, h).data;
  const out = ctx.createImageData(w, h);
  const od = out.data;

  const bs = Math.max(5, Math.round(lerp(bad, 6, 28))); // bigger blocks when worse
  const step = Math.max(2, Math.round(lerp(bad, 32, 10))); // fewer color levels when worse

  for (let y = 0; y < h; y += bs) {
    for (let x = 0; x < w; x += bs) {
      const X = Math.min(x + bs, w);
      const Y = Math.min(y + bs, h);

      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y; yy < Y; yy++) {
        for (let xx = x; xx < X; xx++) {
          const i = (yy * w + xx) * 4;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; n++;
        }
      }
      r = (Math.round((r / n) / step) * step) & 255;
      g = (Math.round((g / n) / step) * step) & 255;
      b = (Math.round((b / n) / step) * step) & 255;

      for (let yy = y; yy < Y; yy++) {
        for (let xx = x; xx < X; xx++) {
          const i = (yy * w + xx) * 4;
          od[i] = r; od[i + 1] = g; od[i + 2] = b; od[i + 3] = 255;
        }
      }
    }
  }
  ctx.putImageData(out, 0, 0);
}

function applyArtifacts(ctx, w, h, good) {
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;

  // Lower quality -> more grain and fewer color levels (banding).
  const noiseAmt = clampNum(lerp(good, 40, 4), 3, 40);
  const levels = clampNum(lerp(good, 5, 34), 3, 34);
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
  previewCanvas.hidden = true;
  previewTag.hidden = true;
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
