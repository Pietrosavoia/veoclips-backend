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
const multerStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});

const upload = multer({
  storage: multerStorage,
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5GB
});

// ─── SSE connections for scan progress ───────────────
const scanClients = new Map(); // jobId -> res

// ─── Health check ────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── Upload endpoint ─────────────────────────────────
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

      res.json({
        gameId,
        storagePath,
        status: "uploaded",
      });
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

// ─── Scan endpoint ───────────────────────────────────
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

  // Create scan job in DB (don't block response on failure)
  supabase.from("scan_jobs").insert({
    id: jobId,
    game_id: gameId,
    user_id: userId,
    status: "scanning",
    started_at: new Date().toISOString(),
  }).then(() => console.log(`[SCAN] Scan job inserted into DB`))
    .catch((err) => console.error("[SCAN] Failed to create scan job:", err));

  // Respond immediately
  res.json({ jobId, status: "started" });
  console.log(`[SCAN] Responded with jobId: ${jobId}`);

  // Wait for SSE client to connect before starting scan (up to 5s)
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

  // Run scan in background
  runScan({ jobId, gameId, userId, jerseyNumber, kitColor, startTime, endTime, storagePath });
});

// ─── SSE progress endpoint ──────────────────────────
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
      sendScanProgress(jobId, {
        status: "scanning",
        ...data,
      });
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
        })
        .eq("id", jobId)
        .then(() => {})
        .catch((err) => console.error(`[scan ${jobId}] Failed to persist progress:`, err.message));
    }
  };
}

// ─── Background scan worker ─────────────────────────
async function runScan({ jobId, gameId, userId, jerseyNumber, kitColor, startTime, endTime, storagePath }) {
  // Check both possible paths: /uploads/{userId}/{gameId}.mp4 (from upload endpoint) and /uploads/{gameId}.mp4
  const videoPathWithUser = path.join(UPLOAD_DIR, userId, `${gameId}.mp4`);
  const videoPathFlat = path.join(UPLOAD_DIR, `${gameId}.mp4`);
  const videoPath = fs.existsSync(videoPathWithUser) ? videoPathWithUser : videoPathFlat;
  console.log(`[scan ${jobId}] Checking video paths:`);
  console.log(`[scan ${jobId}]   with userId: ${videoPathWithUser} -> ${fs.existsSync(videoPathWithUser) ? 'EXISTS' : 'NOT FOUND'}`);
  console.log(`[scan ${jobId}]   flat: ${videoPathFlat} -> ${fs.existsSync(videoPathFlat) ? 'EXISTS' : 'NOT FOUND'}`);
  const numericStart = Number.isFinite(Number(startTime)) ? Number(startTime) : 0;
  const numericEnd = Number.isFinite(Number(endTime)) ? Number(endTime) : 0;
  const scanDuration = numericEnd > numericStart ? numericEnd - numericStart : 0;
  const estimatedTotalFrames = scanDuration > 0 ? Math.max(1, Math.ceil(scanDuration / 2)) : 0;
  const emitProgress = createScanProgressEmitter(jobId);

  console.log(`=== SCAN PROCESSING STARTED ===`);
  console.log(`[scan ${jobId}] runScan started`);
  console.log(`[scan ${jobId}] videoPath: ${videoPath}`);
  console.log(`[scan ${jobId}] scanDuration: ${scanDuration}s, estimatedFrames: ${estimatedTotalFrames}`);

  // Step 0: Download video from Supabase Storage if not on disk
  if (!fs.existsSync(videoPath)) {
    const bucket = "game-videos";
    const downloadPath = storagePath || `${userId}/${gameId}.mp4`;
    console.log(`=== DOWNLOADING VIDEO FROM SUPABASE ===`);
    console.log(`[scan ${jobId}] Bucket: "${bucket}", storagePath: "${downloadPath}"`);

    sendScanProgress(jobId, {
      status: "scanning",
      phase: "downloading",
      progress: 0,
      framesScanned: 0,
      totalFrames: estimatedTotalFrames,
      clipsFound: 0,
      message: "Downloading video from storage...",
    });

    try {
      const { data, error } = await supabase.storage.from(bucket).download(downloadPath);
      if (error || !data) {
        const errMsg = error?.message || "Download returned empty data";
        console.error(`[scan ${jobId}] Storage download failed: ${errMsg}`);
        sendScanProgress(jobId, { status: "error", message: `Failed to download video: ${errMsg}` });
        await supabase.from("scan_jobs").update({ status: "failed" }).eq("id", jobId);
        return;
      }

      // Write blob to disk
      const uploadDir = path.dirname(videoPath);
      fs.mkdirSync(uploadDir, { recursive: true });
      const buffer = Buffer.from(await data.arrayBuffer());
      fs.writeFileSync(videoPath, buffer);
      console.log(`=== VIDEO DOWNLOADED SUCCESSFULLY ===`);
      console.log(`[scan ${jobId}] Video downloaded (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);

      sendScanProgress(jobId, {
        status: "scanning",
        phase: "downloading",
        progress: 0,
        framesScanned: 0,
        totalFrames: estimatedTotalFrames,
        clipsFound: 0,
        message: "Video downloaded, starting scan...",
      });
    } catch (err) {
      console.error(`[scan ${jobId}] Storage download error:`, err);
      sendScanProgress(jobId, { status: "error", message: `Download error: ${err.message}` });
      await supabase.from("scan_jobs").update({ status: "failed" }).eq("id", jobId);
      return;
    }
  } else {
    console.log(`[scan ${jobId}] Video already on disk`);
  }

  const framesDir = path.join(FRAMES_DIR, gameId);
  fs.mkdirSync(framesDir, { recursive: true });

  const clipsDir = path.join(CLIPS_DIR, gameId);
  fs.mkdirSync(clipsDir, { recursive: true });

  try {
    emitProgress(
      {
        phase: "queued",
        progress: 0,
        framesScanned: 0,
        totalFrames: estimatedTotalFrames,
        clipsFound: 0,
        message: "Queued scan...",
      },
      { force: true }
    );

    // Step 1: Extract frames with FFmpeg
    await new Promise((resolve, reject) => {
      const cmd = ffmpeg(videoPath)
        .outputOptions(["-vf", "fps=0.5", "-q:v", "3"])
        .output(path.join(framesDir, "%04d.jpg"));

      if (startTime !== undefined) cmd.seekInput(startTime);
      if (endTime !== undefined) cmd.duration(endTime - (startTime || 0));

      cmd
        .on("start", (commandLine) => {
          console.log(`=== STARTING FFMPEG ===`);
          console.log(`[scan ${jobId}] FFmpeg extract started`);
          console.log(commandLine);
        })
        .on("progress", (ffmpegProgress) => {
          const processedSeconds = parseTimemarkToSeconds(ffmpegProgress.timemark);
          const extractionRatio = scanDuration > 0
            ? Math.min(processedSeconds / scanDuration, 1)
            : Math.min((ffmpegProgress.percent || 0) / 100, 1);
          const extractedFrames = estimatedTotalFrames > 0
            ? Math.min(Math.round(extractionRatio * estimatedTotalFrames), estimatedTotalFrames)
            : 0;

          emitProgress({
            phase: "extracting_frames",
            progress: Math.round(extractionRatio * 100),
            framesScanned: extractedFrames,
            totalFrames: estimatedTotalFrames,
            clipsFound: 0,
            message: `Extracting frames... ${Math.round(extractionRatio * 100)}%`,
          });
        })
        .on("stderr", (line) => {
          if (/error|frame=|time=/i.test(line)) {
            console.log(`[scan ${jobId}] FFmpeg extract: ${line}`);
          }
        })
        .on("end", () => {
          console.log(`[scan ${jobId}] FFmpeg extract completed`);
          emitProgress(
            {
              phase: "extracting_frames",
              progress: 100,
              framesScanned: estimatedTotalFrames,
              totalFrames: estimatedTotalFrames,
              clipsFound: 0,
              message: "Frame extraction complete",
            },
            { force: true }
          );
          resolve();
        })
        .on("error", (err, stdout, stderr) => {
          console.error(`[scan ${jobId}] FFmpeg extract error:`, err.message);
          if (stderr) console.error(stderr);
          reject(err);
        })
        .run();
    });

    // Step 2: Analyze frames (Roboflow or mock)
    const frameFiles = fs.readdirSync(framesDir).filter((f) => f.endsWith(".jpg")).sort();
    const totalFrames = frameFiles.length;

    if (totalFrames === 0) {
      throw new Error("FFmpeg extracted 0 frames");
    }

    emitProgress(
      {
        phase: "analyzing_frames",
        progress: 0,
        framesScanned: 0,
        totalFrames,
        clipsFound: 0,
        message: `Scanning frame 0 of ${totalFrames}`,
      },
      { force: true }
    );

    const detections = [];
    const ROBOFLOW_API_KEY = process.env.ROBOFLOW_API_KEY;

    for (let i = 0; i < totalFrames; i++) {
      const frameTime = numericStart + i * 2;
      const currentFrame = i + 1;
      const percentComplete = Math.round((currentFrame / totalFrames) * 100);

      // Log every 100 frames
      if (currentFrame === 1 || currentFrame % 100 === 0 || currentFrame === totalFrames) {
        console.log(`Frame ${currentFrame} of ${totalFrames} processed`);
      }

      if (ROBOFLOW_API_KEY) {
        try {
          const framePath = path.join(framesDir, frameFiles[i]);
          const imageData = fs.readFileSync(framePath, { encoding: "base64" });

          const response = await fetch(
            `https://detect.roboflow.com/jersey-number-ocr/1?api_key=${ROBOFLOW_API_KEY}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: imageData,
            }
          );

          const result = await response.json();
          const match = result.predictions?.find(
            (p) => p.class === String(jerseyNumber) && p.confidence > 0.6
          );

          if (match) {
            console.log(`=== CLIP FOUND at timestamp: ${frameTime}s (frame ${currentFrame}) ===`);
            detections.push({
              frameIndex: i,
              timeSec: frameTime,
              confidence: Math.round(match.confidence * 100),
            });
          }
        } catch (err) {
          console.error(`[scan ${jobId}] Frame ${currentFrame} analysis error:`, err.message);
        }
      } else if (Math.random() < 0.15) {
        console.log(`=== CLIP FOUND at timestamp: ${frameTime}s (frame ${currentFrame}, mock) ===`);
        detections.push({
          frameIndex: i,
          timeSec: frameTime,
          confidence: Math.round(65 + Math.random() * 33),
        });
      }

      emitProgress({
        phase: "analyzing_frames",
        progress: percentComplete,
        framesScanned: currentFrame,
        totalFrames,
        clipsFound: detections.length,
        message: `Scanning frame ${currentFrame} of ${totalFrames}`,
      });
    }

    emitProgress(
      {
        phase: "analyzing_frames",
        progress: 100,
        framesScanned: totalFrames,
        totalFrames,
        clipsFound: detections.length,
        message: `Scanning frame ${totalFrames} of ${totalFrames}`,
      },
      { force: true }
    );

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

    sendScanProgress(jobId, {
      status: "scanning",
      phase: "cutting_clips",
      progress: 100,
      framesScanned: totalFrames,
      totalFrames,
      clipsFound: clips.length,
      message: clips.length > 0 ? `Cutting ${clips.length} clips...` : "No clips found — wrapping up",
    });

    // Step 4: Cut each clip with FFmpeg and upload
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const clipId = `${gameId}-clip-${i + 1}`;
      const clipFileName = `${clipId}.mp4`;
      const clipPath = path.join(clipsDir, clipFileName);

      console.log(`[scan ${jobId}] Cutting clip ${i + 1}/${clips.length} (${clip.startSec}-${clip.endSec})`);
      sendScanProgress(jobId, {
        status: "scanning",
        phase: "cutting_clips",
        progress: 100,
        framesScanned: totalFrames,
        totalFrames,
        clipsFound: clips.length,
        currentClip: i + 1,
        message: `Cutting clip ${i + 1} of ${clips.length}`,
      });

      await new Promise((resolve, reject) => {
        ffmpeg(videoPath)
          .seekInput(clip.startSec)
          .duration(clip.endSec - clip.startSec)
          .outputOptions(["-c", "copy", "-movflags", "+faststart"])
          .output(clipPath)
          .on("start", (commandLine) => console.log(`[scan ${jobId}] FFmpeg cut started: ${commandLine}`))
          .on("end", () => {
            console.log(`[scan ${jobId}] FFmpeg cut completed for clip ${i + 1}`);
            resolve();
          })
          .on("error", (err, stdout, stderr) => {
            console.error(`[scan ${jobId}] FFmpeg cut error:`, err.message);
            if (stderr) console.error(stderr);
            reject(err);
          })
          .run();
      });

      const clipStoragePath = `${userId}/${clipFileName}`;
      const clipBuffer = fs.readFileSync(clipPath);

      await supabase.storage.from("clips").upload(clipStoragePath, clipBuffer, {
        contentType: "video/mp4",
        upsert: true,
      });

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

      fs.unlinkSync(clipPath);
    }

    console.log(`=== SCAN COMPLETE. Clips found: ${clips.length} ===`);
    sendScanProgress(jobId, {
      status: "complete",
      progress: 100,
      framesScanned: totalFrames,
      totalFrames,
      clipsFound: clips.length,
      message: "Scan complete!",
    });

    await supabase.from("scan_jobs").update({
      status: "completed",
      progress_percent: 100,
      clips_found: clips.length,
      completed_at: new Date().toISOString(),
      total_frames: totalFrames,
      frames_scanned: totalFrames,
    }).eq("id", jobId);

    await supabase.from("games").update({ status: "scanned" }).eq("id", gameId);
  } catch (err) {
    console.error(`[scan ${jobId}] Scan error:`, err);
    sendScanProgress(jobId, { status: "error", message: err.message || "Scan failed" });
    await supabase.from("scan_jobs").update({ status: "failed" }).eq("id", jobId);
  } finally {
    fs.rmSync(framesDir, { recursive: true, force: true });
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
