#!/bin/bash
# Update yt-dlp to latest version on every deploy
echo "Updating yt-dlp..."
curl -sL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod a+rx /usr/local/bin/yt-dlp
echo "yt-dlp version: $(yt-dlp --version)"
echo "Starting server..."
exec node server.js
