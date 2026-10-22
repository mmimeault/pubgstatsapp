#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export CLOUDSDK_CONFIG="$ROOT/.tools/gcloud-config"
export PATH="$ROOT/.tools/google-cloud-sdk/bin:$PATH"

echo "A browser window will open. Sign in with the Google account that owns the"
echo "GCP free trial, then approve the requested Cloud SDK scopes."
echo

gcloud auth login

echo
echo "Now authorizing Application Default Credentials for local tooling..."
gcloud auth application-default login

echo
echo "Authenticated accounts:"
gcloud auth list

echo
echo "Current configuration:"
gcloud config list
