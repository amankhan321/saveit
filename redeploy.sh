#!/bin/bash
# Run this on the droplet to pull latest code and redeploy
set -e
cd /opt/saveit
echo "Pulling latest..."
git pull
echo "Rebuilding..."
docker build -t saveit .
echo "Restarting..."
docker rm -f saveit 2>/dev/null || true
docker run -d --name saveit --restart unless-stopped -p 80:3000 \
  ${TWITTER_COOKIES:+-e TWITTER_COOKIES="$TWITTER_COOKIES"} \
  saveit
echo "Done. Running at http://$(curl -s ifconfig.me)"
