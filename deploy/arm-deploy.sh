#!/usr/bin/env bash
# Self-checking auto-deploy for the poker leaderboard (ARM host).
#
# Runs every 5 minutes via systemd timer (see poker-deploy.service/.timer):
#   1. fetch origin/main
#   2. if unchanged → exit silently
#   3. run the test suite in a throwaway bun container (zero deps needed)
#   4. only if tests pass → rebuild + `docker compose up -d`
#
# If tests fail, the script exits non-zero and the OLD version keeps running.
set -euo pipefail

APP_DIR=/srv/poker
cd "$APP_DIR"

# Nothing to do if main hasn't moved.
git fetch --quiet origin main
NEW=$(git rev-parse origin/main)
OLD=$(git rev-parse HEAD)
if [ "$NEW" = "$OLD" ]; then
  exit 0
fi

echo "[deploy] new commit: ${NEW:0:8} (was ${OLD:0:8})"

# Swap the working tree to the new code BEFORE testing.
git reset --hard origin/main

# Tests first — abort deploy (and keep the old container) on failure.
echo "[deploy] running tests..."
docker run --rm -v "$APP_DIR":/app -w /app oven/bun:1 bun test

echo "[deploy] tests passed, rebuilding..."
docker compose up -d --build

echo "[deploy] ok"
