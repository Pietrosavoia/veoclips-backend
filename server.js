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
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ─── Supabase (service role for storage access) ──────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── Volume paths ────────────────────────────────────
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/uploads";
const CLIPS_DIR = process.env.CLIPS_DIR || "/clips";
const FRAMES_DIR = "/tmp/frames";

[UPLOAD_DIR, CLIPS_DIR, FRAMES_DIR].forEach((dir) => {
  fs.mkdirSync(dir, { recursive: true });
});

// ─── Multer for file uploads ─────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userDir = path.join(UPLOAD_DIR, req.body.userId || "unknown");
    fs.mkdirSync(userDir, { recursive: true });
    cb(null, userDir);
  },
  filename: (req, file, cb) => {
    const gameId = req.body.gameId || Date.now().toString();
    cb(null, `${gameId}.mp4`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5GB
  fileFilter: (req, file, cb) => {
    const allowed = ["video/mp4", "video/quicktime", "video/x-msvideo"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only video files (.mp4, .mov, .avi) are allowed"));
  },
});

// ─── SSE connections for scan progress ───────────────
const scanClients = new Map(); // jobId -> res

// ─── Health check ────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── Upload endpoint ─────────────────────────────────
app.post("/upload", upload.single("video"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No video file provided" });

    const { userId, gameId } = req.body;
    if (!userId || !gameId) {
      return res.status(400).json({ error: "userId and gameId are required" });
    }

    const storagePath = `${userId}/${gameId}.mp4`;

    res.json({
      gameId,
      storagePath,
      fileSizeBytes: req.file.size,
      status: "uploaded",
    });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Scan endpoint ───────────────────────────────────
app.post("/scan", async (req, res) => {
  const { gameId, userId, jerseyNumber, kitColor, startTime, endTime } = req.body;

  if (!gameId || !userId) {
    return res.status(400).json({ error: "gameId and userId are required" });
  }

  const jobId = `scan-${gameId}-${Date.now()}`;

  // Create scan job in DB
  await supabase.from("scan_jobs").insert({
    id: jobId,
    game_id: gameId,
    user_id: userId,
    status: "scanning",
    started_at: new Date().toISOString(),
  });

  res.json({ jobId, status: "started" });

  // Run scan in background
  runScan({ jobId, gameId, userId, jerseyNumber, kitColor, startTime, endTime });
});

// ─── SSE progress endpoint ──────────────────────────
app.get("/scan-progress/:jobId", (req, res) => {
  const { jobId } = req.params;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  res.write(`data: ${JSON.stringify({ status: "connected", jobId })}\n\n`);

  scanClients.set(jobId, res);

  req.on("close", () => {
    scanClients.delete(jobId);
  });
});

function sendScanProgress(jobId, data) {
  const client = scanClients.get(jobId);
  if (client) {
    client.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

// ─── Background scan worker ─────────────────────────
async function runScan({ jobId, gameId, userId, jerseyNumber, kitColor, startTime, endTime }) {
  const videoPath = path.join(UPLOAD_DIR, userId, `${gameId}.mp4`);

  if (!fs.existsSync(videoPath)) {
    sendScanProgress(jobId, { status: "error", message: "Video file not found on server" });
    await supabase.from("scan_jobs").update({ status: "failed" }).eq("id", jobId);
    return;
  }

  const framesDir = path.join(FRAMES_DIR, gameId);
  fs.mkdirSync(framesDir, { recursive: true });

  const clipsDir = path.join(CLIPS_DIR, gameId);
  fs.mkdirSync(clipsDir, { recursive: true });

  try {
    sendScanProgress(jobId, { status: "extracting_frames", progress: 5, clipsFound: 0 });

    // Step 1: Extract frames with FFmpeg
    await new Promise((resolve, reject) => {
      const cmd = ffmpeg(videoPath)
        .outputOptions(["-vf", "fps=0.5", "-q:v", "3"])
        .output(path.join(framesDir, "%04d.jpg"));

      if (startTime !== undefined) cmd.seekInput(startTime);
      if (endTime !== undefined) cmd.duration(endTime - (startTime || 0));

      cmd.on("end", resolve).on("error", reject).run();
    });

    sendScanProgress(jobId, { status: "analyzing_frames", progress: 30, clipsFound: 0 });

    // Step 2: Analyze frames (Roboflow or mock)
    const frameFiles = fs.readdirSync(framesDir).filter((f) => f.endsWith(".jpg")).sort();
    const totalFrames = frameFiles.length;

    await supabase.from("scan_jobs").update({ total_frames: totalFrames }).eq("id", jobId);

    const detections = [];
    const ROBOFLOW_API_KEY = process.env.ROBOFLOW_API_KEY;

    for (let i = 0; i < totalFrames; i++) {
      const frameTime = (startTime || 0) + i * 2; // 1 frame every 2 seconds
      const progress = 30 + Math.round((i / totalFrames) * 50);

      if (ROBOFLOW_API_KEY) {
        // Real Roboflow detection
        try {
          const framePath = path.join(framesDir, frameFiles[i]);
          const imageData = fs.readFileSync(framePath, { encoding: "base64" });

          const response = await fetch(
            `https://detect.roboflow.com/jersey-number-detection/1?api_key=${ROBOFLOW_API_KEY}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: imageData,
            }
          );
          const result = await response.json();

          const match = result.predictions?.find(
            (p) => p.class === String(jerseyNumber) && p.confidence > 0.5
          );

          if (match) {
            detections.push({
              frameIndex: i,
              timeSec: frameTime,
              confidence: Math.round(match.confidence * 100),
            });
          }
        } catch (err) {
          console.error(`Frame ${i} analysis error:`, err.message);
        }
      } else {
        // Mock detection (no Roboflow key)
        if (Math.random() < 0.15) {
          detections.push({
            frameIndex: i,
            timeSec: frameTime,
            confidence: Math.round(65 + Math.random() * 33),
          });
        }
      }

      if (i % 5 === 0) {
        sendScanProgress(jobId, {
          status: "analyzing_frames",
          progress,
          framesScanned: i + 1,
          totalFrames,
          clipsFound: detections.length,
        });

        await supabase.from("scan_jobs").update({
          frames_scanned: i + 1,
          clips_found: detections.length,
          progress_percent: progress,
        }).eq("id", jobId);
      }
    }

    sendScanProgress(jobId, { status: "cutting_clips", progress: 82, clipsFound: detections.length });

    // Step 3: Group detections into clips (within 5 seconds = same clip)
    const clips = [];
    let currentClip = null;

    for (const det of detections) {
      if (!currentClip || det.timeSec - currentClip.endSec > 5) {
        if (currentClip) clips.push(currentClip);
        currentClip = {
          startSec: Math.max(0, det.timeSec - 5),
          endSec: det.timeSec + 10,
          confidence: det.confidence,
          detections: [det],
        };
      } else {
        currentClip.endSec = det.timeSec + 10;
        currentClip.confidence = Math.max(currentClip.confidence, det.confidence);
        currentClip.detections.push(det);
      }
    }
    if (currentClip) clips.push(currentClip);

    // Step 4: Cut each clip with FFmpeg and upload to Supabase Storage
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const clipId = `${gameId}-clip-${i + 1}`;
      const clipFileName = `${clipId}.mp4`;
      const clipPath = path.join(clipsDir, clipFileName);

      sendScanProgress(jobId, {
        status: "cutting_clips",
        progress: 82 + Math.round((i / clips.length) * 15),
        clipsFound: clips.length,
        currentClip: i + 1,
      });

      // Cut clip with FFmpeg
      await new Promise((resolve, reject) => {
        ffmpeg(videoPath)
          .seekInput(clip.startSec)
          .duration(clip.endSec - clip.startSec)
          .outputOptions(["-c", "copy", "-movflags", "+faststart"])
          .output(clipPath)
          .on("end", resolve)
          .on("error", reject)
          .run();
      });

      // Upload cut clip to Supabase Storage
      const clipStoragePath = `${userId}/${clipFileName}`;
      const clipBuffer = fs.readFileSync(clipPath);

      await supabase.storage.from("clips").upload(clipStoragePath, clipBuffer, {
        contentType: "video/mp4",
        upsert: true,
      });

      // Save clip record to DB
      const playTypes = ["Dribble", "Shot", "Pass", "Defense", "Key Moment"];
      await supabase.from("clips").insert({
        id: clipId,
        game_id: gameId,
        user_id: userId,
        title: `Clip ${i + 1}`,
        play_type: playTypes[i % playTypes.length],
        start_time: clip.startSec,
        end_time: clip.endSec,
        confidence: clip.confidence,
        storage_path: clipStoragePath,
        minute: Math.round(clip.startSec / 60),
      });

      // Clean up local clip file
      fs.unlinkSync(clipPath);
    }

    // Step 5: Complete
    sendScanProgress(jobId, {
      status: "complete",
      progress: 100,
      clipsFound: clips.length,
    });

    await supabase.from("scan_jobs").update({
      status: "completed",
      progress_percent: 100,
      clips_found: clips.length,
      completed_at: new Date().toISOString(),
    }).eq("id", jobId);

    await supabase.from("games").update({ status: "scanned" }).eq("id", gameId);

    // Clean up frames
    fs.rmSync(framesDir, { recursive: true, force: true });
  } catch (err) {
    console.error("Scan error:", err);
    sendScanProgress(jobId, { status: "error", message: err.message });
    await supabase.from("scan_jobs").update({ status: "failed" }).eq("id", jobId);
  }
}

// ─── Get clip signed URL ─────────────────────────────
app.get("/clip/:clipId", async (req, res) => {
  try {
    const { data: clip, error } = await supabase
      .from("clips")
      .select("storage_path")
      .eq("id", req.params.clipId)
      .maybeSingle();

    if (error || !clip?.storage_path) {
      return res.status(404).json({ error: "Clip not found" });
    }

    const { data } = await supabase.storage
      .from("clips")
      .createSignedUrl(clip.storage_path, 3600);

    if (!data?.signedUrl) {
      return res.status(500).json({ error: "Could not generate signed URL" });
    }

    res.json({ signedUrl: data.signedUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete game video from Railway volume ───────────
app.delete("/game/:gameId", async (req, res) => {
  try {
    const { userId } = req.body || {};
    const { gameId } = req.params;

    // Try to find and delete the file
    const videoPath = path.join(UPLOAD_DIR, userId || "", `${gameId}.mp4`);
    if (fs.existsSync(videoPath)) {
      fs.unlinkSync(videoPath);
    }

    // Clean up any remaining clips dir
    const clipsDir = path.join(CLIPS_DIR, gameId);
    if (fs.existsSync(clipsDir)) {
      fs.rmSync(clipsDir, { recursive: true, force: true });
    }

    res.json({ status: "deleted", gameId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start server ────────────────────────────────────
app.listen(PORT, () => {
  console.log(`VeoClips backend running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
