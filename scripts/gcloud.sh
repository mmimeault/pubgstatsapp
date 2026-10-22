#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export CLOUDSDK_CONFIG="$ROOT/.tools/gcloud-config"
export PATH="$ROOT/.tools/google-cloud-sdk/bin:$PATH"
exec gcloud "$@"
