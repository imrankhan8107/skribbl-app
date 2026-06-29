#!/bin/bash
# Cloud-init script for Oracle Cloud — auto-deploys Skribbl game
# Paste this into the "Cloud-init script" field when creating the instance

set -e

# Install Docker from official repo (Ubuntu 22.04)
apt-get update -y
apt-get install -y ca-certificates curl gnupg git

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Start and enable Docker
systemctl enable docker
systemctl start docker

# Clone the repo (feature/redis-scaling branch has docker-compose.yml)
cd /home/ubuntu
git clone -b feature/redis-scaling https://github.com/imrankhan8107/skribbl-app.git
cd skribbl-app

# Run with docker compose (multi-worker + Redis + nginx)
docker compose up -d --build

# Open firewall ports
iptables -I INPUT -p tcp --dport 80 -j ACCEPT
iptables -I INPUT -p tcp --dport 8080 -j ACCEPT
iptables -I INPUT -p tcp --dport 8000 -j ACCEPT
netfilter-persistent save
