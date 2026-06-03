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
// HTTP helpers
// ──────────────────────────────────────────
function httpGet(url, headers = {}, maxRedirects = 8) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error("Too many redirects"));
    const lib = url.startsWith("https") ? https : http;
    const defaultHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "identity",
      "Cache-Control": "no-cache",
      ...headers,
    };
    lib.get(url, { headers: defaultHeaders, timeout: 20000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        let newUrl = res.headers.location;
        if (newUrl.startsWith("/")) { const u = new URL(url); newUrl = u.origin + newUrl; }
        return httpGet(newUrl, headers, maxRedirects - 1).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, data, headers: res.headers }));
    }).on("error", reject).on("timeout", () => reject(new Error("Timeout")));
  });
}

function downloadFile(url, dest, headers = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);
    lib.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        ...headers,
      },
      timeout: 60000,
    }, (res) => {
      if ([301, 302, 303, 307].includes(res.statusCode) && res.headers.location) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        return downloadFile(res.headers.location, dest, headers).then(resolve).catch(reject);
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
// Reddit: HTML scraping approach
// ──────────────────────────────────────────
async function getRedditVideoInfo(url) {
  let cleanUrl = url.split("?")[0];
  if (!cleanUrl.endsWith("/")) cleanUrl += "/";

  const errors = [];

  // Approach 1: Fetch HTML page and extract video data from embedded JSON
  const htmlUrls = [
    cleanUrl,
    cleanUrl.replace("www.reddit.com", "old.reddit.com"),
    cleanUrl.replace("www.reddit.com", "i.reddit.com"),
  ];

  for (const pageUrl of htmlUrls) {
    try {
      const resp = await httpGet(pageUrl, {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      });

      if (resp.status === 200 && resp.data) {
        const result = extractVideoFromHtml(resp.data, url);
        if (result) return result;
        errors.push(`html(${new URL(pageUrl).hostname}): no video found in page`);
      } else {
        errors.push(`html(${new URL(pageUrl).hostname}): ${resp.status}`);
      }
    } catch (e) {
      errors.push(`html: ${e.message}`);
    }
  }

  // Approach 2: Try JSON endpoints anyway (might work on some hosts)
  const jsonUrls = [
    cleanUrl.replace("www.reddit.com", "old.reddit.com") + ".json?raw_json=1&limit=1",
    cleanUrl + ".json?raw_json=1&limit=1",
  ];

  for (const jsonUrl of jsonUrls) {
    try {
      const resp = await httpGet(jsonUrl, {
        "Accept": "application/json",
        "User-Agent": "web:saveit:v1.0 (by /u/saveit_app)",
      });
      if (resp.status === 200) {
        const parsed = parseRedditJson(resp.data);
        if (parsed) return parsed;
      }
      errors.push(`json(${new URL(jsonUrl).hostname}): ${resp.status}`);
    } catch (e) {
      errors.push(`json: ${e.message}`);
    }
  }

  // Approach 3: Try v.redd.it embed page
  try {
    const embedResult = await tryRedditEmbed(url);
    if (embedResult) return embedResult;
  } catch (e) {
    errors.push(`embed: ${e.message}`);
  }

  throw new Error(`Could not fetch Reddit video. Tried ${errors.length} approaches. Details: ${errors.join(" | ")}`);
}

function extractVideoFromHtml(html, originalUrl) {
  // Method 1: Look for packaged-media-json or media-permalink data
  // Reddit embeds video data in several script patterns

  // Pattern: "fallback_url":"https://v.redd.it/..."
  const fallbackMatch = html.match(/"fallback_url"\s*:\s*"(https?:\/\/v\.redd\.it\/[^"]+)"/);
  if (fallbackMatch) {
    const videoUrl = fallbackMatch[1].replace(/&amp;/g, "&");
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/ : \w+$/, "").replace(/ - Reddit$/, "").trim() : "Reddit Video";

    // Extract dimensions
    const heightMatch = html.match(/"height"\s*:\s*(\d+)/);
    const durationMatch = html.match(/"duration"\s*:\s*(\d+)/);
    const isGifMatch = html.match(/"is_gif"\s*:\s*(true|false)/);

    const height = heightMatch ? parseInt(heightMatch[1]) : 720;
    const isGif = isGifMatch ? isGifMatch[1] === "true" : false;

    // Build audio URL from video URL
    const audioUrl = videoUrl.replace(/DASH_\d+\.mp4/, "DASH_AUDIO_128.mp4")
                             .replace(/DASH_\d+/, "DASH_AUDIO_128")
                             .split("?")[0];

    // Try to get thumbnail
    const thumbMatch = html.match(/"thumbnail"\s*:\s*"(https?:\/\/[^"]+)"/);
    const thumbnail = thumbMatch ? thumbMatch[1].replace(/&amp;/g, "&") : null;

    return {
      title,
      thumbnail,
      duration: durationMatch ? parseInt(durationMatch[1]) : null,
      platform: "Reddit",
      uploader: null,
      video_url: videoUrl,
      audio_url: audioUrl,
      height,
      is_gif: isGif,
    };
  }

  // Pattern: Look for v.redd.it URLs directly
  const vreddMatch = html.match(/https?:\/\/v\.redd\.it\/([a-z0-9]+)\/DASH_(\d+)/i);
  if (vreddMatch) {
    const videoId = vreddMatch[1];
    const quality = vreddMatch[2];
    const videoUrl = `https://v.redd.it/${videoId}/DASH_${quality}.mp4`;
    const audioUrl = `https://v.redd.it/${videoId}/DASH_AUDIO_128.mp4`;

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/ : \w+$/, "").replace(/ - Reddit$/, "").trim() : "Reddit Video";

    return {
      title,
      thumbnail: null,
      duration: null,
      platform: "Reddit",
      uploader: null,
      video_url: videoUrl,
      audio_url: audioUrl,
      height: parseInt(quality) || 720,
      is_gif: false,
    };
  }

  // Pattern: Look for shreddit-player or reddit-player-embed with src
  const playerMatch = html.match(/https?:\/\/v\.redd\.it\/([a-z0-9]+)/i);
  if (playerMatch) {
    const videoId = playerMatch[1];
    // Try common quality patterns
    return {
      title: "Reddit Video",
      thumbnail: null,
      duration: null,
      platform: "Reddit",
      uploader: null,
      video_url: `https://v.redd.it/${videoId}/DASH_720.mp4`,
      audio_url: `https://v.redd.it/${videoId}/DASH_AUDIO_128.mp4`,
      height: 720,
      is_gif: false,
      _videoId: videoId,
    };
  }

  return null;
}

function parseRedditJson(rawData) {
  try {
    const json = JSON.parse(rawData);
    const post = json?.[0]?.data?.children?.[0]?.data;
    if (!post) return null;

    const videoSource = post.is_video && post.media?.reddit_video
      ? post.media.reddit_video
      : post.crosspost_parent_list?.[0]?.is_video && post.crosspost_parent_list[0].media?.reddit_video
        ? post.crosspost_parent_list[0].media.reddit_video
        : null;

    if (!videoSource) return null;

    return {
      title: post.title || "Reddit Video",
      thumbnail: post.thumbnail && post.thumbnail !== "default" ? post.thumbnail.replace(/&amp;/g, "&") : null,
      duration: videoSource.duration || null,
      platform: "Reddit",
      uploader: post.author || null,
      video_url: videoSource.fallback_url,
      audio_url: videoSource.fallback_url.replace(/DASH_\d+/, "DASH_AUDIO_128").split("?")[0],
      height: videoSource.height || 720,
      is_gif: videoSource.is_gif || false,
    };
  } catch { return null; }
}

async function tryRedditEmbed(url) {
  // Try Reddit's oEmbed endpoint
  try {
    const oembedUrl = `https://www.reddit.com/oembed?url=${encodeURIComponent(url)}`;
    const resp = await httpGet(oembedUrl, { "Accept": "application/json" });
    if (resp.status === 200) {
      const data = JSON.parse(resp.data);
      if (data.html) {
        const srcMatch = data.html.match(/src="([^"]+)"/);
        if (srcMatch) {
          const embedPageResp = await httpGet(srcMatch[1]);
          if (embedPageResp.status === 200) {
            return extractVideoFromHtml(embedPageResp.data, url);
          }
        }
      }
    }
  } catch {}
  return null;
}

async function downloadRedditVideo(videoUrl, audioUrl, isGif, outputPath, videoId) {
  const videoPath = outputPath + ".video.mp4";
  const audioPath = outputPath + ".audio.mp4";
  const finalPath = outputPath + ".mp4";

  // If we have a videoId but the specific quality URL fails, try alternatives
  const videoUrls = [videoUrl];
  if (videoId) {
    videoUrls.push(
      `https://v.redd.it/${videoId}/DASH_1080.mp4`,
      `https://v.redd.it/${videoId}/DASH_720.mp4`,
      `https://v.redd.it/${videoId}/DASH_480.mp4`,
      `https://v.redd.it/${videoId}/DASH_360.mp4`,
      `https://v.redd.it/${videoId}/DASH_240.mp4`,
    );
  }

  // Try each video URL until one works
  let downloaded = false;
  for (const vUrl of videoUrls) {
    try {
      await downloadFile(vUrl, videoPath);
      downloaded = true;
      break;
    } catch {}
  }

  if (!downloaded) throw new Error("Could not download video stream from Reddit.");

  if (isGif) {
    fs.renameSync(videoPath, finalPath);
    return finalPath;
  }

  // Try downloading audio
  let hasAudio = false;
  const audioUrls = [audioUrl];
  if (videoId) {
    audioUrls.push(
      `https://v.redd.it/${videoId}/DASH_AUDIO_128.mp4`,
      `https://v.redd.it/${videoId}/DASH_AUDIO_64.mp4`,
      `https://v.redd.it/${videoId}/DASH_audio.mp4`,
      `https://v.redd.it/${videoId}/audio`,
    );
  }

  for (const aUrl of audioUrls) {
    try {
      await downloadFile(aUrl, audioPath);
      hasAudio = true;
      break;
    } catch {}
  }

  if (hasAudio) {
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn("ffmpeg", ["-i", videoPath, "-i", audioPath, "-c:v", "copy", "-c:a", "aac", "-y", finalPath]);
      ffmpeg.on("close", (code) => {
        try { fs.unlinkSync(videoPath); } catch {}
        try { fs.unlinkSync(audioPath); } catch {}
        code === 0 ? resolve(finalPath) : reject(new Error("ffmpeg merge failed"));
      });
      ffmpeg.on("error", reject);
    });
  } else {
    fs.renameSync(videoPath, finalPath);
    return finalPath;
  }
}

// ──────────────────────────────────────────
// yt-dlp for non-Reddit platforms
// ──────────────────────────────────────────
function getYtdlpPath() {
  try { execSync("which yt-dlp", { stdio: "ignore" }); return "yt-dlp"; } catch {}
  const lp = path.join(__dirname, "yt-dlp");
  return fs.existsSync(lp) ? lp : null;
}

function detectPlatform(url) {
  const u = url.toLowerCase();
  if (u.includes("youtube.com") || u.includes("youtu.be")) return "YouTube";
  if (u.includes("twitter.com") || u.includes("x.com")) return "Twitter/X";
  if (u.includes("instagram.com")) return "Instagram";
  if (u.includes("tiktok.com")) return "TikTok";
  if (u.includes("reddit.com") || u.includes("redd.it")) return "Reddit";
  return "Unknown";
}

function isValidUrl(str) {
  try { const u = new URL(str); return ["http:", "https:"].includes(u.protocol); } catch { return false; }
}

function ytdlpBaseArgs() {
  return [
    "--no-warnings", "--no-playlist", "--no-check-certificates",
    "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "--extractor-retries", "5", "--socket-timeout", "30", "--force-ipv4", "--geo-bypass",
  ];
}

function cleanupTemp() {
  try {
    const files = fs.readdirSync(TEMP_DIR);
    const now = Date.now();
    for (const f of files) {
      const fp = path.join(TEMP_DIR, f);
      try { if (now - fs.statSync(fp).mtimeMs > 10 * 60 * 1000) fs.unlinkSync(fp); } catch {}
    }
  } catch {}
}
setInterval(cleanupTemp, 5 * 60 * 1000);

// ──────────────────────────────────────────
// API: Info
// ──────────────────────────────────────────
app.post("/api/info", async (req, res) => {
  const { url } = req.body;
  if (!url || !isValidUrl(url)) return res.status(400).json({ error: "Invalid URL." });
  const platform = detectPlatform(url);

  // Reddit — HTML scraping
  if (platform === "Reddit") {
    try {
      const info = await getRedditVideoInfo(url);
      const qualities = [{ id: "best", label: `Best Quality (${info.height}p)`, type: "video" }];
      if (!info.is_gif) qualities.push({ id: "bestaudio", label: "Audio Only", type: "audio" });
      return res.json({
        title: info.title, thumbnail: info.thumbnail, duration: info.duration,
        platform: "Reddit", uploader: info.uploader ? `u/${info.uploader}` : null, qualities,
        _reddit: { video_url: info.video_url, audio_url: info.audio_url, is_gif: info.is_gif, _videoId: info._videoId || null },
      });
    } catch (err) {
      console.error("Reddit error:", err.message);
      return res.status(422).json({ error: err.message });
    }
  }

  // Other platforms — yt-dlp
  const ytdlp = getYtdlpPath();
  if (!ytdlp) return res.status(500).json({ error: "yt-dlp not installed." });

  const args = [...ytdlpBaseArgs(), "--dump-json", "--flat-playlist", url];
  const proc = spawn(ytdlp, args, { timeout: 60000 });
  let stdout = "", stderr = "";
  proc.stdout.on("data", (d) => (stdout += d.toString()));
  proc.stderr.on("data", (d) => (stderr += d.toString()));
  proc.on("close", (code) => {
    if (code !== 0) {
      console.error(`yt-dlp info (${platform}):`, stderr.slice(0, 500));
      return res.status(422).json({
        error: platform === "YouTube"
          ? "YouTube blocks cloud servers. This is a known limitation."
          : `Could not fetch from ${platform}. URL may be invalid or private.`,
      });
    }
    try {
      const info = JSON.parse(stdout);
      const formats = (info.formats || []).filter((f) => f.url && f.ext);
      const qualities = [
        { id: "best", label: "Best Quality (Video + Audio)", type: "video" },
        { id: "bestaudio", label: "Audio Only (Best)", type: "audio" },
      ];
      const seen = new Set();
      for (const r of [2160, 1440, 1080, 720, 480, 360]) {
        if (formats.some((f) => f.vcodec && f.vcodec !== "none" && f.height === r) && !seen.has(r)) {
          seen.add(r);
          qualities.push({ id: `res_${r}`, label: `${r}p`, type: "video" });
        }
      }
      res.json({
        title: info.title || "Untitled", thumbnail: info.thumbnail || null,
        duration: info.duration || null, platform,
        uploader: info.uploader || info.channel || null, qualities,
      });
    } catch { res.status(500).json({ error: "Failed to parse video info." }); }
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
      res.write(`data: ${JSON.stringify({ type: "progress", percent: 10, status: "Downloading video stream..." })}\n\n`);
      if (quality === "bestaudio") {
        const audioPath = path.join(TEMP_DIR, `${fileId}.m4a`);
        await downloadFile(_reddit.audio_url, audioPath);
        res.write(`data: ${JSON.stringify({ type: "done", downloadPath: `/api/file/${fileId}.m4a`, filename: `${fileId}.m4a` })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ type: "progress", percent: 30, status: "Downloading..." })}\n\n`);
        const outputPath = path.join(TEMP_DIR, fileId);
        const finalPath = await downloadRedditVideo(_reddit.video_url, _reddit.audio_url, _reddit.is_gif, outputPath, _reddit._videoId);
        const filename = path.basename(finalPath);
        res.write(`data: ${JSON.stringify({ type: "progress", percent: 90, status: "Merging audio + video..." })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "done", downloadPath: `/api/file/${filename}`, filename })}\n\n`);
      }
    } catch (err) {
      console.error("Reddit download error:", err.message);
      res.write(`data: ${JSON.stringify({ type: "error", message: "Reddit download failed: " + err.message })}\n\n`);
    }
    return res.end();
  }

  // Other platforms — yt-dlp
  const ytdlp = getYtdlpPath();
  if (!ytdlp) { res.write(`data: ${JSON.stringify({ type: "error", message: "yt-dlp not installed." })}\n\n`); return res.end(); }

  const outputTemplate = path.join(TEMP_DIR, `${fileId}.%(ext)s`);
  let formatArg;
  if (quality === "bestaudio") formatArg = "bestaudio[ext=m4a]/bestaudio/best";
  else if (quality?.startsWith("res_")) { const h = quality.replace("res_", ""); formatArg = `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`; }
  else formatArg = "bestvideo+bestaudio/best";

  const args = [...ytdlpBaseArgs(), "-f", formatArg, "--merge-output-format", quality === "bestaudio" ? "m4a" : "mp4", "--newline", "--progress", "-o", outputTemplate, url];
  const proc = spawn(ytdlp, args, { timeout: 180000 });
  let lastProgress = 0;

  proc.stdout.on("data", (data) => {
    for (const line of data.toString().split("\n")) {
      const m = line.match(/(\d+\.?\d*)%/);
      if (m) { const pct = parseFloat(m[1]); if (pct > lastProgress) { lastProgress = pct; res.write(`data: ${JSON.stringify({ type: "progress", percent: pct })}\n\n`); } }
      if (line.includes("erging")) res.write(`data: ${JSON.stringify({ type: "progress", percent: 99, status: "Merging..." })}\n\n`);
    }
  });
  proc.stderr.on("data", (d) => console.error(`yt-dlp (${platform}):`, d.toString().slice(0, 200)));
  proc.on("close", (code) => {
    if (code !== 0) {
      res.write(`data: ${JSON.stringify({ type: "error", message: platform === "YouTube" ? "YouTube blocks cloud servers." : `Download failed for ${platform}.` })}\n\n`);
      return res.end();
    }
    const files = fs.readdirSync(TEMP_DIR).filter((f) => f.startsWith(fileId));
    if (!files.length) { res.write(`data: ${JSON.stringify({ type: "error", message: "File not found." })}\n\n`); return res.end(); }
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
  fs.createReadStream(filePath).pipe(res).on("end", () => {
    setTimeout(() => { try { fs.unlinkSync(filePath); } catch {} }, 60000);
  });
});

// Health + debug
app.get("/api/health", async (req, res) => {
  const ytdlp = getYtdlpPath();
  let ver = "not installed";
  if (ytdlp) try { ver = execSync(`${ytdlp} --version`).toString().trim(); } catch {}

  // Quick Reddit connectivity test
  let redditStatus = "unknown";
  try {
    const r = await httpGet("https://www.reddit.com/r/pics.json?limit=1", { "Accept": "application/json" });
    redditStatus = `status ${r.status}`;
  } catch (e) { redditStatus = `error: ${e.message}`; }

  res.json({ status: "ok", ytdlp: !!ytdlp, ytdlp_version: ver, reddit_api: redditStatus, timestamp: new Date().toISOString() });
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`SaveIt running on port ${PORT}`);
  const ytdlp = getYtdlpPath();
  if (ytdlp) try { console.log("yt-dlp", execSync(`${ytdlp} --version`).toString().trim()); } catch {}
});
