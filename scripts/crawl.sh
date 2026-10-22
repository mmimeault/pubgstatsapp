#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$ROOT/.tools/node/bin:$PATH"
export npm_config_cache="$ROOT/.tools/npm-cache"
cd "$ROOT"

NAME="${1:-DarkNext3000}"
SHARD="${2:-steam}"
MATCHES="${3:-20}"

exec npx tsx apps/crawler/src/cli.ts sync --shard "$SHARD" --name "$NAME" --matches "$MATCHES"
