#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_VERSION="${NODE_VERSION:-v24.22.0}"
INSTALL_DIR="$ROOT/.tools/node"

if [ -x "$INSTALL_DIR/bin/node" ]; then
  echo "Project-local Node already installed: $("$INSTALL_DIR/bin/node" -v)"
  exit 0
fi

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Darwin-arm64) PLATFORM="darwin-arm64" ;;
  Darwin-x86_64) PLATFORM="darwin-x64" ;;
  Linux-aarch64) PLATFORM="linux-arm64" ;;
  Linux-x86_64) PLATFORM="linux-x64" ;;
  *)
    echo "Unsupported platform: $OS-$ARCH" >&2
    echo "Install Node $NODE_VERSION manually and re-run 'make setup'." >&2
    exit 1
    ;;
esac

TARBALL="node-${NODE_VERSION}-${PLATFORM}.tar.gz"
URL="https://nodejs.org/dist/${NODE_VERSION}/${TARBALL}"

echo "Downloading Node ${NODE_VERSION} (${PLATFORM}) into .tools/ ..."
mkdir -p "$ROOT/.tools"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$URL" -o "$TMP/$TARBALL"
tar -xzf "$TMP/$TARBALL" -C "$TMP"
rm -rf "$INSTALL_DIR"
mv "$TMP/node-${NODE_VERSION}-${PLATFORM}" "$INSTALL_DIR"
mkdir -p "$ROOT/.tools/npm-cache"

echo "Installed $("$INSTALL_DIR/bin/node" -v) at .tools/node (project-local, no shell changes)."
