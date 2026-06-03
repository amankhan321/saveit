# SaveIt — Video Downloader

A clean, self-hosted video downloader for personal and educational use. Supports YouTube, Twitter/X, Instagram Reels, TikTok, and Reddit.

## Tech Stack

- **Backend**: Node.js + Express
- **Frontend**: Vanilla HTML/CSS/JS
- **Engine**: yt-dlp (must be installed on the host)

## Requirements

- Node.js 18+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) installed and available in PATH
- ffmpeg (for merging video/audio streams)

## Setup

```bash
# Install yt-dlp
pip install yt-dlp

# Install ffmpeg (Ubuntu/Debian)
sudo apt install ffmpeg

# Clone and install
git clone https://github.com/amankhan321/saveit.git
cd saveit
npm install

# Run
npm start
```

Open `http://localhost:3000` in your browser.

## Features

- Multi-platform support (YouTube, Twitter/X, Instagram, TikTok, Reddit)
- Quality selection with resolution options
- Real-time download progress via SSE
- Audio-only extraction
- Rate limiting and security headers
- Auto-cleanup of temporary files

## Deployment

This app requires a server environment with yt-dlp and ffmpeg installed. It is **not compatible with Vercel serverless functions** since yt-dlp needs a persistent process.

**Recommended platforms:**
- [Railway](https://railway.app) — easiest, supports Node.js + system packages
- [Render](https://render.com) — free tier available
- Any VPS (DigitalOcean, Linode, etc.)

For Railway/Render, add a `nixpacks.toml` or `Dockerfile` to include yt-dlp and ffmpeg.

## Disclaimer

This tool is for **personal and fair use only**. Respect copyright. Do not redistribute or commercially use downloaded content without permission from the original creator. This tool does not host, store, or cache any video content.
