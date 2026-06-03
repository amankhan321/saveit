const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join(__dirname, "tmp");

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Middleware
app.use(cors());
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);
app.use(express.json());
app.use(express.static("public"));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: "Too many requests. Try again later." },
});
app.use("/api/", limiter);

// Check yt-dlp availability
function getYtdlpPath() {
  try {
    execSync("which yt-dlp", { stdio: "ignore" });
    return "yt-dlp";
  } catch {
    const localPath = path.join(__dirname, "yt-dlp");
    if (fs.existsSync(localPath)) return localPath;
    return null;
  }
}

// Detect platform from URL
function detectPlatform(url) {
  const u = url.toLowerCase();
  if (u.includes("youtube.com") || u.includes("youtu.be")) return "YouTube";
  if (u.includes("twitter.com") || u.includes("x.com")) return "Twitter/X";
  if (u.includes("instagram.com")) return "Instagram";
  if (u.includes("tiktok.com")) return "TikTok";
  if (u.includes("reddit.com") || u.includes("redd.it")) return "Reddit";
  return "Unknown";
}

// Validate URL
function isValidUrl(str) {
  try {
    const url = new URL(str);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

// Cleanup old temp files (older than 10 min)
function cleanupTemp() {
  try {
    const files = fs.readdirSync(TEMP_DIR);
    const now = Date.now();
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > 10 * 60 * 1000) {
        fs.unlinkSync(filePath);
      }
    }
  } catch {}
}

setInterval(cleanupTemp, 5 * 60 * 1000);

// ──────────────────────────────────────────
// API: Fetch video info
// ──────────────────────────────────────────
app.post("/api/info", (req, res) => {
  const { url } = req.body;
  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: "Invalid URL provided." });
  }

  const ytdlp = getYtdlpPath();
  if (!ytdlp) {
    return res.status(500).json({
      error: "yt-dlp is not installed on the server.",
    });
  }

  const platform = detectPlatform(url);
  const args = [
    "--dump-json",
    "--no-warnings",
    "--no-playlist",
    "--flat-playlist",
    url,
  ];

  const proc = spawn(ytdlp, args, { timeout: 30000 });
  let stdout = "";
  let stderr = "";

  proc.stdout.on("data", (d) => (stdout += d.toString()));
  proc.stderr.on("data", (d) => (stderr += d.toString()));

  proc.on("close", (code) => {
    if (code !== 0) {
      console.error("yt-dlp info error:", stderr);
      return res.status(422).json({
        error: "Could not fetch video info. The URL may be invalid or the video is private.",
      });
    }

    try {
      const info = JSON.parse(stdout);
      const formats = (info.formats || [])
        .filter((f) => f.url && f.ext)
        .map((f) => ({
          format_id: f.format_id,
          ext: f.ext,
          quality: f.format_note || f.height ? `${f.height || "?"}p` : "unknown",
          filesize: f.filesize || f.filesize_approx || null,
          has_video: !!f.vcodec && f.vcodec !== "none",
          has_audio: !!f.acodec && f.acodec !== "none",
          resolution: f.resolution || (f.height ? `${f.width}x${f.height}` : null),
          fps: f.fps || null,
        }));

      // Build simplified quality options
      const qualities = [];
      const seenQualities = new Set();

      // Best video+audio
      qualities.push({ id: "best", label: "Best Quality (Video + Audio)", type: "video" });

      // Audio only
      qualities.push({ id: "bestaudio", label: "Audio Only (Best)", type: "audio" });

      // Specific resolutions
      const resolutions = [2160, 1440, 1080, 720, 480, 360];
      for (const r of resolutions) {
        const hasRes = formats.some((f) => f.has_video && String(f.quality).includes(String(r)));
        if (hasRes && !seenQualities.has(r)) {
          seenQualities.add(r);
          qualities.push({
            id: `res_${r}`,
            label: `${r}p`,
            type: "video",
          });
        }
      }

      res.json({
        title: info.title || "Untitled",
        thumbnail: info.thumbnail || null,
        duration: info.duration || null,
        platform,
        uploader: info.uploader || info.channel || null,
        qualities,
      });
    } catch (e) {
      console.error("Parse error:", e.message);
      res.status(500).json({ error: "Failed to parse video information." });
    }
  });

  proc.on("error", (err) => {
    console.error("yt-dlp spawn error:", err);
    res.status(500).json({ error: "Server error processing request." });
  });
});

// ──────────────────────────────────────────
// API: Download video
// ──────────────────────────────────────────
app.post("/api/download", (req, res) => {
  const { url, quality } = req.body;
  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: "Invalid URL." });
  }

  const ytdlp = getYtdlpPath();
  if (!ytdlp) {
    return res.status(500).json({ error: "yt-dlp not installed." });
  }

  const fileId = uuidv4();
  const outputTemplate = path.join(TEMP_DIR, `${fileId}.%(ext)s`);

  let formatArg = "best[ext=mp4]/best";
  if (quality === "bestaudio") {
    formatArg = "bestaudio[ext=m4a]/bestaudio";
  } else if (quality && quality.startsWith("res_")) {
    const height = quality.replace("res_", "");
    formatArg = `best[height<=${height}][ext=mp4]/best[height<=${height}]`;
  }

  const args = [
    "-f", formatArg,
    "--merge-output-format", quality === "bestaudio" ? "m4a" : "mp4",
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "--progress",
    "-o", outputTemplate,
    url,
  ];

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const proc = spawn(ytdlp, args, { timeout: 120000 });
  let lastProgress = 0;

  proc.stdout.on("data", (data) => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      const match = line.match(/(\d+\.?\d*)%/);
      if (match) {
        const pct = parseFloat(match[1]);
        if (pct > lastProgress) {
          lastProgress = pct;
          res.write(`data: ${JSON.stringify({ type: "progress", percent: pct })}\n\n`);
        }
      }
    }
  });

  proc.stderr.on("data", (data) => {
    console.error("yt-dlp stderr:", data.toString());
  });

  proc.on("close", (code) => {
    if (code !== 0) {
      res.write(`data: ${JSON.stringify({ type: "error", message: "Download failed." })}\n\n`);
      res.end();
      return;
    }

    // Find the output file
    const files = fs.readdirSync(TEMP_DIR).filter((f) => f.startsWith(fileId));
    if (files.length === 0) {
      res.write(`data: ${JSON.stringify({ type: "error", message: "File not found after download." })}\n\n`);
      res.end();
      return;
    }

    const filename = files[0];
    const downloadPath = `/api/file/${filename}`;
    res.write(`data: ${JSON.stringify({ type: "done", downloadPath, filename })}\n\n`);
    res.end();
  });

  proc.on("error", (err) => {
    console.error("Spawn error:", err);
    res.write(`data: ${JSON.stringify({ type: "error", message: "Server error." })}\n\n`);
    res.end();
  });

  req.on("close", () => {
    proc.kill("SIGTERM");
  });
});

// ──────────────────────────────────────────
// API: Serve downloaded file
// ──────────────────────────────────────────
app.get("/api/file/:filename", (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(TEMP_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File expired or not found." });
  }

  const ext = path.extname(filename).toLowerCase();
  const mimeTypes = {
    ".mp4": "video/mp4",
    ".m4a": "audio/mp4",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".mp3": "audio/mpeg",
  };

  res.setHeader("Content-Type", mimeTypes[ext] || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="saveit_${filename}"`);

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);

  stream.on("end", () => {
    setTimeout(() => {
      try { fs.unlinkSync(filePath); } catch {}
    }, 60000);
  });
});

// Health check
app.get("/api/health", (req, res) => {
  const ytdlp = getYtdlpPath();
  res.json({
    status: "ok",
    ytdlp: !!ytdlp,
    timestamp: new Date().toISOString(),
  });
});

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`SaveIt running on http://localhost:${PORT}`);
  const ytdlp = getYtdlpPath();
  if (!ytdlp) {
    console.warn("⚠ yt-dlp not found. Install it: pip install yt-dlp");
  } else {
    console.log("✓ yt-dlp detected");
  }
});
