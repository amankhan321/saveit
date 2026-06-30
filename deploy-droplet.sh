#!/bin/bash
set -e

echo "=== SaveIt droplet setup ==="

# 1. Install Docker
echo "Installing Docker..."
apt-get update
apt-get install -y ca-certificates curl git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io

# 2. Clone the repo
echo "Cloning SaveIt..."
rm -rf /opt/saveit
git clone https://github.com/amankhan321/saveit.git /opt/saveit
cd /opt/saveit

# 3. Build the Docker image
echo "Building container..."
docker build -t saveit .

# 4. Run it (restart automatically on reboot/crash)
echo "Starting container..."
docker rm -f saveit 2>/dev/null || true
docker run -d \
  --name saveit \
  --restart unless-stopped \
  -p 80:3000 \
  saveit

echo ""
echo "=== Done! ==="
echo "SaveIt is running. Open http://$(curl -s ifconfig.me) in your browser."
echo ""
echo "Useful commands:"
echo "  docker logs saveit          # view logs"
echo "  docker restart saveit       # restart"
echo "  cd /opt/saveit && git pull && docker build -t saveit . && docker rm -f saveit && docker run -d --name saveit --restart unless-stopped -p 80:3000 saveit   # redeploy after code changes"
