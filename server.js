const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();

const UPLOAD_DIR = path.join(__dirname, "tmp", "uploads");
const OUTPUT_DIR = path.join(__dirname, "tmp", "outputs");
for (const dir of [UPLOAD_DIR, OUTPUT_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

// 500mb max imumoccupany120
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const id = crypto.randomUUID();
      cb(null, `${id}${path.extname(file.originalname) || ".mp4"}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("video/")) {
      return cb(new Error("Only video files are accepted."));
    }
    cb(null, true);
  },
});

// swap to redis later but this works for now. jobId -> { status, progress, outputPath }
const jobs = new Map();

app.use(express.static(path.join(__dirname, "public")));

const LIMITS = {
  fps: { min: 5, max: 30, default: 15 },
  videoWidth: { min: 80, max: 640, default: 320 },
  videoBitrateKbps: { min: 40, max: 2000, default: 300 },
  audioBitrateKbps: { min: 16, max: 256, default: 64 },
  audioChannels: { allowed: [1, 2], default: 1 },
  audioSampleRate: { allowed: [11025, 22050, 44100], default: 22050 },
};

function clampInt(value, { min, max, default: fallback }) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function pickAllowed(value, { allowed, default: fallback }) {
  const n = parseInt(value, 10);
  return allowed.includes(n) ? n : fallback;
}

function parseSettings(body) {
  let videoWidth = clampInt(body.videoWidth, LIMITS.videoWidth);
  videoWidth = videoWidth % 2 === 0 ? videoWidth : videoWidth - 1;

  return {
    fps: clampInt(body.fps, LIMITS.fps),
    videoWidth,
    videoBitrateKbps: clampInt(body.videoBitrateKbps, LIMITS.videoBitrateKbps),
    audioBitrateKbps: clampInt(body.audioBitrateKbps, LIMITS.audioBitrateKbps),
    audioChannels: pickAllowed(body.audioChannels, LIMITS.audioChannels),
    audioSampleRate: pickAllowed(body.audioSampleRate, LIMITS.audioSampleRate),
  };
}

app.post("/api/compress", (req, res) => {
  upload.single("video")(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No video file was uploaded." });
    }

    const settings = parseSettings(req.body);
    const jobId = crypto.randomUUID();
    const inputPath = req.file.path;
    const outputPath = path.join(OUTPUT_DIR, `${jobId}.mp4`);

    jobs.set(jobId, { status: "processing", progress: 0 });
    res.json({ jobId, settings });

    runRetroCompression(inputPath, outputPath, settings)
      .on("progress", (p) => {
        const job = jobs.get(jobId);
        if (job) job.progress = Math.min(99, Math.round(p.percent || 0));
      })
      .on("end", () => {
        jobs.set(jobId, { status: "done", progress: 100, outputPath });
        fs.unlink(inputPath, () => {});
      })
      .on("error", (ffErr) => {
        jobs.set(jobId, { status: "error", error: ffErr.message });
        fs.unlink(inputPath, () => {});
      })
      .run();
  });
});

app.get("/api/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Unknown job." });
  res.json({ status: job.status, progress: job.progress ?? 0, error: job.error });
});

app.get("/api/download/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== "done") {
    return res.status(404).json({ error: "File not ready or not found." });
  }
  res.download(job.outputPath, "retro-compressed.mp4", (err) => {
    if (!err) {
      fs.unlink(job.outputPath, () => {});
      jobs.delete(req.params.jobId);
    }
  });
});

// yeah, i remember retros. this COMPRESSES THE VIDEO
function runRetroCompression(inputPath, outputPath, settings) {
  const { fps, videoWidth, videoBitrateKbps, audioBitrateKbps, audioChannels, audioSampleRate } = settings;
  const maxrate = videoBitrateKbps;
  const bufsize = videoBitrateKbps * 2;

  return ffmpeg(inputPath)
    .videoFilters([
      `scale=${videoWidth}:-2:flags=bilinear`,
      `fps=${fps}`,
      "noise=alls=6:allf=t+u",
      "eq=saturation=0.85:contrast=1.08:brightness=0.02",
    ])
    .videoCodec("libx264")
    .outputOptions([
      "-preset veryfast",
      `-b:v ${videoBitrateKbps}k`,
      `-maxrate ${maxrate}k`,
      `-bufsize ${bufsize}k`,
      "-pix_fmt yuv420p",
      "-movflags +faststart",
    ])
    .audioCodec("aac")
    .audioBitrate(`${audioBitrateKbps}k`)
    .audioChannels(audioChannels)
    .audioFrequency(audioSampleRate)
    .output(outputPath);
}

app.listen(3000, () => {
  console.log(`2009.video running on http://localhost:3000`);
});
