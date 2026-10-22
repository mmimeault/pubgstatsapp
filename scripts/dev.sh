#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$ROOT/.tools/node/bin:$PATH"
export npm_config_cache="$ROOT/.tools/npm-cache"
# The dev script starts the crawler explicitly, so the API must not spawn a second one.
export CRAWLER_AUTOSTART=false
cd "$ROOT"

# Avoid running two crawlers when the API previously autostarted one.
if [ -f "$ROOT/data/crawler.pid" ]; then
  PID="$(cat "$ROOT/data/crawler.pid" 2>/dev/null || true)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$ROOT/data/crawler.pid"
fi

exec npx concurrently \
  --kill-others \
  --names "crawler,api,web" \
  --prefix-colors "yellow,cyan,magenta" \
  "npm run dev --workspace @pubgstats/crawler" \
  "npm run dev --workspace @pubgstats/api" \
  "npm run dev --workspace @pubgstats/web"
