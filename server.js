require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const { createClient } = require("@supabase/supabase-js");

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.options('*', cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const UPLOAD_DIR = process.env.UPLOAD_DIR || "/uploads";
const CLIPS_DIR = process.env.CLIPS_DIR || "/clips";
const FRAMES_DIR = "/tmp/frames";

[UPLOAD_DIR, CLIPS_DIR, FRAMES_DIR].forEach((dir) => {
  fs.mkdirSync(dir, { recursive: true });
});

const multerStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});

const upload = multer({
  storage: multerStorage,
  limits: { fileSize: 5 * 1024 * 1024 * 1024 },
});

const scanClients = new Map();

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.post("/upload", (req, res) => {
  upload.single("video")(req, res, async (err) => {
    if (err) {
      console.error("Multer upload error:", err);
      return res.status(500).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No video file provided" });
    }
    const tempFilePath = req.file.path;
    try {
      const { userId, gameId } = req.body;
      if (!userId || !gameId) {
        return res.status(400).json({ error: "userId and gameId required" });
      }
      console.log("=== UPLOAD RECEIVED ===", req.file.originalname, req.file.size, "bytes");
      const storagePath = `${userId}/${gameId}.mp4`;
      const fileBuffer = fs.readFileSync(tempFilePath);
      console.log("=== UPLOADING TO SUPABASE STORAGE ===", storagePath);
      const { error: uploadError } = await supabase.storage
        .from("game-videos")
        .upload(storagePath, fileBuffer, {
          contentType: "video/mp4",
          upsert: true,
        });
      if (uploadError) {
        console.error("=== SUPABASE UPLOAD FAILED ===", uploadError);
        return res.status(500).json({ error: `Storage upload failed: ${uploadError.message}` });
      }
      console.log("=== UPLOAD COMPLETE ===", storagePath);
      res.json({ gameId, storagePath, status: "uploaded" });
    } catch (uploadErr) {
      console.error("Upload error:", uploadErr);
      res.status(500).json({ error: uploadErr.message });
    } finally {
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    }
  });
});

app.post("/scan", async (req, res) => {
  const { gameId, userId, jerseyNumber, kitColor, startTime, endTime, storagePath } = req.body;
  console.log(`\n========================================`);
  console.log(`[SCAN] Request received for game: ${gameId}`);
  console.log(`[SCAN] userId: ${userId}`);
  console.log(`[SCAN] jerseyNumber: ${jerseyNumber}, kitColor: ${kitColor}`);
  console.log(`[SCAN] startTime: ${startTime}, endTime: ${endTime}`);
  console.log(`[SCAN] storagePath: ${storagePath}`);
  console.log(`========================================\n`);
  if (!gameId || !userId) {
    console.log("[SCAN] ERROR: missing gameId or userId");
    return res.status(400).json({ error: "gameId and userId are required" });
  }
  const jobId = `scan-${gameId}-${Date.now()}`;
  console.log(`[SCAN] Created jobId: ${jobId}`);
  supabase.from("scan_jobs").insert({
    id: jobId,
    game_id: gameId,
    user_id: userId,
    status: "scanning",
    started_at: new Date().toISOString(),
  }).then(() => console.log(`[SCAN] Scan job inserted into DB`))
    .catch((err) => console.error("[SCAN] Failed to create scan job:", err));
  res.json({ jobId, status: "started" });
  console.log(`[SCAN] Responded with jobId: ${jobId}`);
  console.log(`[SCAN] Waiting for SSE client to connect...`);
  const waitForClient = () => new Promise((resolve) => {
    let elapsed = 0;
    const interval = setInterval(() => {
      elapsed += 200;
      if (scanClients.has(jobId) || elapsed >= 5000) {
        clearInterval(interval);
        console.log(`[SCAN] SSE client ${scanClients.has(jobId) ? "connected" : "timed out"} after ${elapsed}ms`);
        resolve();
      }
    }, 200);
  });
  await waitForClient();
  runScan({ jobId, gameId, userId, jerseyNumber, kitColor, startTime, endTime, storagePath });
});

app.get("/scan-progress/:jobId", (req, res) => {
  const { jobId } = req.params;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  res.write("retry: 5000\n");
  res.write(`data: ${JSON.stringify({ status: "connected", jobId })}\n\n`);
  scanClients.set(jobId, res);
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(`event: ping\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
    }
  }, 15000);
  req.on("close", () => {
    clearInterval(heartbeat);
    scanClients.delete(jobId);
    res.end();
  });
});

function sendScanProgress(jobId, data) {
  const client = scanClients.get(jobId);
  if (client && !client.writableEnded) {
    client.write(`data: ${JSON.stringify({ ...data, sentAt: new Date().toISOString() })}\n\n`);
  }
}

function parseTimemarkToSeconds(timemark) {
  if (!timemark) return 0;
  const [hours = 0, minutes = 0, seconds = 0] = String(timemark).split(":").map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}

function createScanProgressEmitter(jobId) {
  let lastSentAt = 0;
  let lastPersistedAt = 0;
  return (data, { force = false } = {}) => {
    const now = Date.now();
    if (force || now - lastSentAt >= 5000) {
      lastSentAt = now;
      sendScanProgress(jobId, { status: "scanning", ...data });
    }
    if (data.totalFrames !== undefined && (force || now - lastPersistedAt >= 5000)) {
      lastPersistedAt = now;
      supabase
        .from("scan_jobs")
        .update({
          frames_scanned: data.framesScanned ?? 0,
          total_frames: data.totalFrames ?? null,
          clips_found: data.clipsFound ?? 0,
          progress_percent: data.progress ?? 0,
          status: data.progress >= 100 ? 'completed' : 'scanning'
        })
        .eq('id', jobId)
      lastPersistedAt = now
    }
  }
}

const PORT = process.env.PORT || 3000
app.listen(PORT, '0.0.0.0', () => {
  console.log(`VeoClips backend running on port ${PORT}`)
  console.log(`Health check: http://localhost:${PORT}/health`)
})
     
