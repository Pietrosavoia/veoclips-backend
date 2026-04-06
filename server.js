require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const http = require("http");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const { createClient } = require("@supabase/supabase-js");

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const server = http.createServer(app);
server.timeout = 0;
server.keepAliveTimeout = 0;
server.headersTimeout = 0;

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

// THIS IS VERSION 3 - STREAMING UPLOAD FIX
app.post("/upload", (req, res) => {
  req.setTimeout(0);
  res.setTimeout(0);
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
      console.log("=== UPLOAD RECEIVED V3 ===", req.file.originalname, req.file.size, "bytes");
      const storagePath = `${userId}/${gameId}.mp4`;
      console.log("=== STREAMING TO SUPABASE STORAGE V3 ===", storagePath);
      
      // Use streaming instead of readFileSync to handle files over 2GB
      const { pipeline } = require("stream/promises");
      const { Readable } = require("stream");
      
      const fileStats = fs.statSync(tempFilePath);
      console.log("=== FILE SIZE V3 ===", fileStats.size, "bytes");
      
      const fileStream = fs.createReadStream(tempFilePath);
      
      const { error: uploadError } = await supabase.storage
        .from("game-videos")
        .upload(storagePath, fileStream, {
          contentType: "video/mp4",
          upsert: true,
          duplex: "half",
        });
      
      if (uploadError) {
        console.error("=== SUPABASE UPLOAD FAILED V3 ===", uploadError);
        return res.status(500).json({ error: `Storage upload failed: ${uploadError.message}` });
      }
      console.log("=== UPLOAD COMPLETE V3 ===", storagePath);
      res.json({ gameId, storagePath, status: "uploaded" });
    } catch (uploadErr) {
      console.error("Upload error V3:", uploadErr);
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
    return res.status(400).json({ error: "gameId and userId are required" });
  }
  const jobId = `scan-${gameId}-${Date.now()}`;
  supabase.from("scan_jobs").insert({
    id: jobId,
    game_id: gameId,
    user_id: userId,
    status: "scanning",
    started_at: new Date().toISOString(),
  }).then(() => console.log(`[SCAN] Scan job inserted into DB`))
    .catch((err) => console.error("[SCAN] Failed to create scan job:", err));
  res.json({ jobId, status: "started" });
  const waitFor
