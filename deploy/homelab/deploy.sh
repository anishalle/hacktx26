#!/usr/bin/env bash
# Sync the backend to the homelab and rebuild the dev API (https://hacktx26.anishalle.com).
# Usage: deploy/homelab/deploy.sh [--env]   (--env also uploads the local .env)
set -euo pipefail

HOST=ubuntu@34.200.110.216
DIR=apps/hacktx26
cd "$(dirname "$0")/../.."

ssh "$HOST" "mkdir -p ~/$DIR"
rsync -az --delete --exclude __pycache__ --exclude .env --exclude compose.yml \
  Dockerfile .dockerignore pyproject.toml uv.lock README.md backend "$HOST:~/$DIR/"
scp -q deploy/homelab/compose.yml "$HOST:~/$DIR/compose.yml"
if [[ "${1:-}" == "--env" ]]; then
  scp -q .env "$HOST:~/$DIR/.env"
  ssh "$HOST" "chmod 600 ~/$DIR/.env"
fi
ssh "$HOST" "cd ~/$DIR && docker compose up -d --build && docker compose ps"
