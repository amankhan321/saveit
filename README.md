# SaveIt — Video Downloader

A clean, self-hosted video downloader for personal and educational use.

## Supported platforms

- **Twitter/X** (with cookies — see TWITTER_SETUP.md)
- **Instagram** (public reels/posts)
- **TikTok** (public videos)

Reddit and YouTube are **not supported by default** — both block downloads from datacenter/cloud IP addresses. They can be enabled by routing traffic through a residential proxy (set the `PROXY_URL` environment variable); the code paths are already built in and activate automatically when a proxy is configured.

## Tech Stack

- **Backend**: Node.js + Express
- **Frontend**: Vanilla HTML/CSS/JS
- **Engine**: yt-dlp + ffmpeg

## Deployment (DigitalOcean droplet, Docker)

SSH into an Ubuntu droplet and run:

```bash
cd /
git clone https://github.com/amankhan321/saveit.git /opt/saveit
bash /opt/saveit/deploy-droplet.sh
```

The app runs on port 80. To update after code changes:

```bash
cd /opt/saveit && git pull && docker build -t saveit . && docker rm -f saveit && \
  docker run -d --name saveit --restart unless-stopped -p 80:3000 saveit
```

### Optional environment variables

Add these with `-e VAR="value"` in the `docker run` command:

- `TWITTER_COOKIES` — Netscape-format cookies to enable Twitter/X (see TWITTER_SETUP.md)
- `PROXY_URL` — residential proxy (e.g. `http://user:pass@host:port`) to enable Reddit + YouTube

## Disclaimer

For **personal and fair use only**. Respect copyright. Do not redistribute or commercially use downloaded content without permission. This tool does not host, store, or cache any video content.
