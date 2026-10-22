#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$ROOT/.tools/node/bin:$PATH"
export npm_config_cache="$ROOT/.tools/npm-cache"
cd "$ROOT"
exec "$@"
