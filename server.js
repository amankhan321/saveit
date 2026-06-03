const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join(__dirname, "tmp");

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

app.use(cors());
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json());
app.use(express.static("public"));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50, message: { error: "Too many requests." } });
app.use("/api/", limiter);

// ──────────────────────────────────────────
// Helper: HTTP fetch with redirects
// ──────────────────────────────────────────
function httpGet(url, headers = {}, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error("Too many redirects"));
    const lib = url.startsWith("https") ? https : http;
    const defaultHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8",
      ...headers,
    };
    lib.get(url, { headers: defaultHeaders, timeout: 15000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        let newUrl = res.headers.location;
        if (newUrl.startsWith("/")) {
          const u = new URL(url);
          newUrl = u.origin + newUrl;
        }
        return httpGet(newUrl, headers, maxRedirects - 1).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, data, headers: res.headers }));
    }).on("error", reject).on("timeout", () => reject(new Error("Timeout")));
  });
}

// ──────────────────────────────────────────
// Reddit: Direct JSON API (no yt-dlp needed)
// ──────────────────────────────────────────
async function getRedditVideoInfo(url) {
  // Normalize URL — strip query params, ensure it ends with .json
  let cleanUrl = url.split("?")[0];
  if (!cleanUrl.endsWith("/")) cleanUrl += "/";
  const jsonUrl = cleanUrl + ".json";

  const resp = await httpGet(jsonUrl, {
    "Accept": "application/json",
  });

  if (resp.status !== 200) throw new Error(`Reddit returned ${resp.status}`);

  const json = JSON.parse(resp.data);
  const post = json?.[0]?.data?.children?.[0]?.data;
  if (!post) throw new Error("Could not parse Reddit post");

  // Reddit hosted video
  if (post.is_video && post.media?.reddit_video) {
    const rv = post.media.reddit_video;
    return {
      title: post.title || "Reddit Video",
      thumbnail: post.thumbnail && post.thumbnail !== "default" ? post.thumbnail : null,
      duration: rv.duration || null,
      platform: "Reddit",
      uploader: post.author || null,
      video_url: rv.fallback_url,
      audio_url: rv.fallback_url.replace(/DASH_\d+/, "DASH_AUDIO_128").split("?")[0],
      dash_url: rv.dash_url || null,
      height: rv.height,
      width: rv.width,
      is_gif: rv.is_gif || false,
    };
  }

  // Crosspost with video
  if (post.crosspost_parent_list?.length > 0) {
    const cross = post.crosspost_parent_list[0];
    if (cross.is_video && cross.media?.reddit_video) {
      const rv = cross.media.reddit_video;
      return {
        title: post.title || "Reddit Video",
        thumbnail: post.thumbnail && post.thumbnail !== "default" ? post.thumbnail : null,
        duration: rv.duration || null,
        platform: "Reddit",
        uploader: post.author || null,
        video_url: rv.fallback_url,
        audio_url: rv.fallback_url.replace(/DASH_\d+/, "DASH_AUDIO_128").split("?")[0],
        height: rv.height,
        width: rv.width,
        is_gif: rv.is_gif || false,
      };
    }
  }

  throw new Error("No Reddit video found in this post. It may be an image, text post, or external link.");
}

async function downloadRedditVideo(videoUrl, audioUrl, isGif, outputPath) {
  return new Promise(async (resolve, reject) => {
    try {
      // Download video stream
      const videoPath = outputPath + ".video.mp4";
      const audioPath = outputPath + ".audio.mp4";
      const finalPath = outputPath + ".mp4";

      await downloadFile(videoUrl, videoPath);

      if (isGif) {
        // GIFs have no audio
        fs.renameSync(videoPath, finalPath);
        return resolve(finalPath);
      }

      // Try downloading audio
      let hasAudio = false;
      try {
        await downloadFile(audioUrl, audioPath);
        hasAudio = true;
      } catch {
        // Some Reddit videos have no audio track — try alternate URL patterns
        const altAudioUrls = [
          videoUrl.replace(/DASH_\d+/, "DASH_AUDIO_64").split("?")[0],
          videoUrl.replace(/DASH_\d+/, "DASH_audio").split("?")[0],
          videoUrl.replace(/DASH_\d+/, "audio").split("?")[0],
        ];
        for (const alt of altAudioUrls) {
          try {
            await downloadFile(alt, audioPath);
            hasAudio = true;
            break;
          } catch {}
        }
      }

      if (hasAudio) {
        // Merge with ffmpeg
        const ffmpeg = spawn("ffmpeg", [
          "-i", videoPath,
          "-i", audioPath,
          "-c:v", "copy",
          "-c:a", "aac",
          "-y",
          finalPath,
        ]);
        ffmpeg.on("close", (code) => {
          try { fs.unlinkSync(videoPath); } catch {}
          try { fs.unlinkSync(audioPath); } catch {}
          if (code === 0) resolve(finalPath);
          else reject(new Error("ffmpeg merge failed"));
        });
        ffmpeg.on("error", reject);
      } else {
        // No audio — just rename video
        fs.renameSync(videoPath, finalPath);
        resolve(finalPath);
      }
    } catch (err) {
      reject(err);
    }
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);
    lib.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      },
      timeout: 30000,
    }, (res) => {
      if ([301, 302, 303, 307].includes(res.statusCode) && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(dest); });
    }).on("error", (err) => {
      try { fs.unlinkSync(dest); } catch {}
      reject(err);
    });
  });
}

// ──────────────────────────────────────────
// YouTube: yt-dlp with workarounds
// ──────────────────────────────────────────
function getYtdlpPath() {
  try { execSync("which yt-dlp", { stdio: "ignore" }); return "yt-dlp"; } catch {}
  const localPath = path.join(__dirname, "yt-dlp");
  if (fs.existsSync(localPath)) return localPath;
  return null;
}

function detectPlatform(url) {
  const u = url.toLowerCase();
  if (u.includes("youtube.com") || u.includes("youtu.be")) return "YouTube";
  if (u.includes("twitter.com") || u.includes("x.com")) return "Twitter/X";
  if (u.includes("instagram.com")) return "Instagram";
  if (u.includes("tiktok.com")) return "TikTok";
  if (u.includes("reddit.com") || u.includes("redd.it") || u.includes("v.redd.it")) return "Reddit";
  return "Unknown";
}

function isValidUrl(str) {
  try { const u = new URL(str); return ["http:", "https:"].includes(u.protocol); } catch { return false; }
}

function ytdlpBaseArgs(url) {
  return [
    "--no-warnings", "--no-playlist", "--no-check-certificates",
    "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "--extractor-retries", "5",
    "--socket-timeout", "30",
    "--force-ipv4",
    "--geo-bypass",
  ];
}

// Cleanup
function cleanupTemp() {
  try {
    const files = fs.readdirSync(TEMP_DIR);
    const now = Date.now();
    for (const f of files) {
      const fp = path.join(TEMP_DIR, f);
      try {
        if (now - fs.statSync(fp).mtimeMs > 10 * 60 * 1000) fs.unlinkSync(fp);
      } catch {}
    }
  } catch {}
}
setInterval(cleanupTemp, 5 * 60 * 1000);

// ──────────────────────────────────────────
// API: Fetch video info
// ──────────────────────────────────────────
app.post("/api/info", async (req, res) => {
  const { url } = req.body;
  if (!url || !isValidUrl(url)) return res.status(400).json({ error: "Invalid URL." });

  const platform = detectPlatform(url);

  // Reddit — use direct JSON API
  if (platform === "Reddit") {
    try {
      const info = await getRedditVideoInfo(url);
      const qualities = [{ id: "best", label: `Best Quality (${info.height}p)`, type: "video" }];
      if (!info.is_gif) qualities.push({ id: "bestaudio", label: "Audio Only", type: "audio" });
      return res.json({
        title: info.title,
        thumbnail: info.thumbnail,
        duration: info.duration,
        platform: "Reddit",
        uploader: info.uploader ? `u/${info.uploader}` : null,
        qualities,
        _reddit: { video_url: info.video_url, audio_url: info.audio_url, is_gif: info.is_gif },
      });
    } catch (err) {
      console.error("Reddit API error:", err.message);
      return res.status(422).json({ error: `Reddit: ${err.message}` });
    }
  }

  // All other platforms — yt-dlp
  const ytdlp = getYtdlpPath();
  if (!ytdlp) return res.status(500).json({ error: "yt-dlp not installed." });

  const args = [...ytdlpBaseArgs(url), "--dump-json", "--flat-playlist", url];
  const proc = spawn(ytdlp, args, { timeout: 60000 });
  let stdout = "", stderr = "";

  proc.stdout.on("data", (d) => (stdout += d.toString()));
  proc.stderr.on("data", (d) => (stderr += d.toString()));

  proc.on("close", (code) => {
    if (code !== 0) {
      console.error(`yt-dlp info error (${platform}):`, stderr.slice(0, 500));
      return res.status(422).json({
        error: `Could not fetch from ${platform}. ${platform === "YouTube" ? "YouTube actively blocks cloud servers — this is a known limitation. Try Twitter/X, Instagram, TikTok, or Reddit instead." : "The URL may be invalid or private."}`,
      });
    }
    try {
      const info = JSON.parse(stdout);
      const formats = (info.formats || []).filter((f) => f.url && f.ext);
      const qualities = [
        { id: "best", label: "Best Quality (Video + Audio)", type: "video" },
        { id: "bestaudio", label: "Audio Only (Best)", type: "audio" },
      ];
      const resolutions = [2160, 1440, 1080, 720, 480, 360];
      const seen = new Set();
      for (const r of resolutions) {
        if (formats.some((f) => f.vcodec && f.vcodec !== "none" && f.height === r) && !seen.has(r)) {
          seen.add(r);
          qualities.push({ id: `res_${r}`, label: `${r}p`, type: "video" });
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
      res.status(500).json({ error: "Failed to parse video info." });
    }
  });
  proc.on("error", () => res.status(500).json({ error: "Server error." }));
});

// ──────────────────────────────────────────
// API: Download
// ──────────────────────────────────────────
app.post("/api/download", async (req, res) => {
  const { url, quality, _reddit } = req.body;
  if (!url || !isValidUrl(url)) return res.status(400).json({ error: "Invalid URL." });

  const platform = detectPlatform(url);
  const fileId = uuidv4();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Reddit — direct download
  if (platform === "Reddit" && _reddit) {
    try {
      res.write(`data: ${JSON.stringify({ type: "progress", percent: 10, status: "Downloading video..." })}\n\n`);

      if (quality === "bestaudio") {
        const audioPath = path.join(TEMP_DIR, `${fileId}.m4a`);
        await downloadFile(_reddit.audio_url, audioPath);
        res.write(`data: ${JSON.stringify({ type: "done", downloadPath: `/api/file/${fileId}.m4a`, filename: `${fileId}.m4a` })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ type: "progress", percent: 30 })}\n\n`);
        const outputPath = path.join(TEMP_DIR, fileId);
        const finalPath = await downloadRedditVideo(_reddit.video_url, _reddit.audio_url, _reddit.is_gif, outputPath);
        const filename = path.basename(finalPath);
        res.write(`data: ${JSON.stringify({ type: "progress", percent: 90, status: "Merging..." })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "done", downloadPath: `/api/file/${filename}`, filename })}\n\n`);
      }
    } catch (err) {
      console.error("Reddit download error:", err.message);
      res.write(`data: ${JSON.stringify({ type: "error", message: "Reddit download failed: " + err.message })}\n\n`);
    }
    return res.end();
  }

  // All other platforms — yt-dlp
  const ytdlp = getYtdlpPath();
  if (!ytdlp) {
    res.write(`data: ${JSON.stringify({ type: "error", message: "yt-dlp not installed." })}\n\n`);
    return res.end();
  }

  const outputTemplate = path.join(TEMP_DIR, `${fileId}.%(ext)s`);
  let formatArg;
  if (quality === "bestaudio") formatArg = "bestaudio[ext=m4a]/bestaudio/best";
  else if (quality?.startsWith("res_")) {
    const h = quality.replace("res_", "");
    formatArg = `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`;
  } else formatArg = "bestvideo+bestaudio/best";

  const args = [
    ...ytdlpBaseArgs(url),
    "-f", formatArg,
    "--merge-output-format", quality === "bestaudio" ? "m4a" : "mp4",
    "--newline", "--progress",
    "-o", outputTemplate,
    url,
  ];

  const proc = spawn(ytdlp, args, { timeout: 180000 });
  let lastProgress = 0;

  proc.stdout.on("data", (data) => {
    for (const line of data.toString().split("\n")) {
      const m = line.match(/(\d+\.?\d*)%/);
      if (m) {
        const pct = parseFloat(m[1]);
        if (pct > lastProgress) { lastProgress = pct; res.write(`data: ${JSON.stringify({ type: "progress", percent: pct })}\n\n`); }
      }
      if (line.includes("Merging") || line.includes("erging"))
        res.write(`data: ${JSON.stringify({ type: "progress", percent: 99, status: "Merging..." })}\n\n`);
    }
  });
  proc.stderr.on("data", (d) => console.error(`yt-dlp (${platform}):`, d.toString().slice(0, 200)));

  proc.on("close", (code) => {
    if (code !== 0) {
      const msg = platform === "YouTube"
        ? "YouTube blocks downloads from cloud servers. This is a known limitation of server-hosted downloaders."
        : `Download failed for ${platform}.`;
      res.write(`data: ${JSON.stringify({ type: "error", message: msg })}\n\n`);
      return res.end();
    }
    const files = fs.readdirSync(TEMP_DIR).filter((f) => f.startsWith(fileId));
    if (!files.length) {
      res.write(`data: ${JSON.stringify({ type: "error", message: "File not found." })}\n\n`);
      return res.end();
    }
    res.write(`data: ${JSON.stringify({ type: "done", downloadPath: `/api/file/${files[0]}`, filename: files[0] })}\n\n`);
    res.end();
  });
  proc.on("error", () => { res.write(`data: ${JSON.stringify({ type: "error", message: "Server error." })}\n\n`); res.end(); });
  req.on("close", () => proc.kill("SIGTERM"));
});

// Serve files
app.get("/api/file/:filename", (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(TEMP_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File expired." });
  const ext = path.extname(filename).toLowerCase();
  const mime = { ".mp4": "video/mp4", ".m4a": "audio/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg" };
  res.setHeader("Content-Type", mime[ext] || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="saveit_${filename}"`);
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on("end", () => { setTimeout(() => { try { fs.unlinkSync(filePath); } catch {} }, 60000); });
});

// Health
app.get("/api/health", (req, res) => {
  const ytdlp = getYtdlpPath();
  let ver = "not installed";
  if (ytdlp) try { ver = execSync(`${ytdlp} --version`).toString().trim(); } catch {}
  res.json({ status: "ok", ytdlp: !!ytdlp, ytdlp_version: ver, timestamp: new Date().toISOString() });
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`SaveIt running on port ${PORT}`);
  const ytdlp = getYtdlpPath();
  if (ytdlp) try { console.log("yt-dlp", execSync(`${ytdlp} --version`).toString().trim()); } catch {}
});
