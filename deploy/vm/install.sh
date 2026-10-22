#!/usr/bin/env bash
# Installs the PUBGSTATS stack on a Debian 12 VM.
# Designed to run as root. Re-running it updates code and restarts services
# without touching /opt/pubgstats/data.
set -euo pipefail

SITE_HOST="${SITE_HOST:-}"
GCS_BUCKET="${GCS_BUCKET:-}"
ENABLE_BACKUPS="${ENABLE_BACKUPS:-true}"
SOURCE_TGZ="${SOURCE_TGZ:-/tmp/pubgstats-src.tgz}"
SOURCE_ENV="${SOURCE_ENV:-/tmp/pubgstats.env}"
APP_DIR="${APP_DIR:-/opt/pubgstats/app}"
DATA_DIR="${DATA_DIR:-/opt/pubgstats/data}"
SERVICE_USER="${SERVICE_USER:-pubgstats}"
LITESTREAM_VERSION="${LITESTREAM_VERSION:-0.5.17}"
NODE_VERSION="${NODE_VERSION:-v24.22.0}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root (use sudo)." >&2
  exit 1
fi

SITE_HOST="${SITE_HOST#http://}"
SITE_HOST="${SITE_HOST#https://}"
SITE_HOST="${SITE_HOST%%/*}"
if [[ -z "${SITE_HOST}" ]]; then
  echo "SITE_HOST is required (for example 34-123-45-67.sslip.io)." >&2
  exit 1
fi
if [[ ! -f "${SOURCE_TGZ}" ]]; then
  echo "Source archive not found: ${SOURCE_TGZ}" >&2
  exit 1
fi
if [[ ! -f "${SOURCE_ENV}" ]]; then
  echo "Environment file not found: ${SOURCE_ENV}" >&2
  exit 1
fi

trap 'rm -f "${SOURCE_ENV}" "${SOURCE_TGZ}"' EXIT

echo "==> Stopping existing services"
systemctl stop pubgstats-api pubgstats-crawler litestream 2>/dev/null || true

echo "==> Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg apt-transport-https \
  debian-keyring debian-archive-keyring \
  build-essential python3 sqlite3 sudo

echo "==> Creating service user and directories"
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /opt/pubgstats --shell /bin/bash "${SERVICE_USER}"
fi
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 750 "${DATA_DIR}"
mkdir -p /opt/pubgstats

echo "==> Ensuring swap (helps npm install/build on e2-micro)"
if ! swapon --show | grep -q '/swapfile'; then
  if [[ ! -f /swapfile ]]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Installing Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y --no-install-recommends caddy
fi

echo "==> Installing application source"
rm -rf "${APP_DIR}"
mkdir -p "${APP_DIR}"
tar -xzf "${SOURCE_TGZ}" -C "${APP_DIR}"
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 750 "${APP_DIR}/data"
install -m 600 -o "${SERVICE_USER}" -g "${SERVICE_USER}" "${SOURCE_ENV}" "${APP_DIR}/.env"
chown -R "${SERVICE_USER}:${SERVICE_USER}" /opt/pubgstats

echo "==> Installing project-local Node ${NODE_VERSION}"
sudo -u "${SERVICE_USER}" bash -lc "cd '${APP_DIR}' && ./scripts/bootstrap.sh"

echo "==> Installing dependencies"
sudo -u "${SERVICE_USER}" bash -lc "cd '${APP_DIR}' && ./scripts/with-node.sh npm ci"

echo "==> Verifying better-sqlite3"
sudo -u "${SERVICE_USER}" bash -lc "cd '${APP_DIR}' && ./scripts/with-node.sh node -e \"const D=require('better-sqlite3'); new D(':memory:'); console.log('sqlite ok')\""

echo "==> Verifying tsx"
sudo -u "${SERVICE_USER}" bash -lc "cd '${APP_DIR}' && ./scripts/with-node.sh node --import tsx -e \"console.log('tsx ok')\""

echo "==> Building web assets"
sudo -u "${SERVICE_USER}" bash -lc "cd '${APP_DIR}' && ./scripts/with-node.sh npm run build --workspace @pubgstats/web"
chmod -R a+rX "${APP_DIR}/apps/web/dist"

echo "==> Configuring Caddy for ${SITE_HOST}"
cat >/etc/caddy/Caddyfile <<EOF
${SITE_HOST} {
	encode zstd gzip

	handle /api/* {
		reverse_proxy 127.0.0.1:3001
	}

	handle {
		root * ${APP_DIR}/apps/web/dist
		try_files {path} /index.html
		file_server
	}
}
EOF
caddy validate --config /etc/caddy/Caddyfile >/dev/null
systemctl enable caddy
systemctl reload-or-restart caddy

echo "==> Installing systemd units"
cat >/etc/systemd/system/pubgstats-api.service <<EOF
[Unit]
Description=PUBGSTATS API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
Environment=NODE_ENV=production
Environment=HOME=/opt/pubgstats
Environment=PATH=${APP_DIR}/.tools/node/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=${APP_DIR}/.tools/node/bin/node --import tsx apps/api/src/index.ts
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=${APP_DIR}/data ${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/pubgstats-crawler.service <<EOF
[Unit]
Description=PUBGSTATS crawler daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
Environment=NODE_ENV=production
Environment=HOME=/opt/pubgstats
Environment=PATH=${APP_DIR}/.tools/node/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=${APP_DIR}/.tools/node/bin/node --import tsx apps/crawler/src/daemon.ts
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=${APP_DIR}/data ${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF

if [[ "${ENABLE_BACKUPS}" == "true" && -n "${GCS_BUCKET}" ]]; then
  echo "==> Installing Litestream"
  if [[ ! -x /usr/local/bin/litestream ]]; then
    tmpdir="$(mktemp -d)"
    curl -fsSL \
      "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-x86_64.tar.gz" \
      -o "${tmpdir}/litestream.tgz"
    tar -xzf "${tmpdir}/litestream.tgz" -C "${tmpdir}"
    install -m 0755 "${tmpdir}/litestream" /usr/local/bin/litestream
    rm -rf "${tmpdir}"
  fi

  cat >/etc/litestream.yml <<EOF
dbs:
  - path: ${DATA_DIR}/pubg.db
    replica:
      type: gs
      bucket: ${GCS_BUCKET}
      path: pubgstats
EOF

  cat >/etc/systemd/system/litestream.service <<EOF
[Unit]
Description=Litestream SQLite replication
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
ExecStart=/usr/local/bin/litestream replicate -config /etc/litestream.yml
Restart=always
RestartSec=10
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF
else
  echo "==> Backups disabled (set GCS_BUCKET or ENABLE_BACKUPS=true to enable)"
  systemctl disable --now litestream 2>/dev/null || true
  rm -f /etc/systemd/system/litestream.service
fi

systemctl daemon-reload
systemctl enable pubgstats-api pubgstats-crawler
systemctl restart pubgstats-api pubgstats-crawler
if [[ -f /etc/systemd/system/litestream.service ]]; then
  systemctl enable litestream
  systemctl restart litestream
fi

echo "==> Waiting for the API"
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3001/api/health >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo
echo "Service status:"
systemctl is-active pubgstats-api || true
systemctl is-active pubgstats-crawler || true
systemctl is-active caddy || true
if [[ -f /etc/systemd/system/litestream.service ]]; then
  systemctl is-active litestream || true
fi
echo
echo "Site: https://${SITE_HOST}"
echo "Logs: journalctl -u pubgstats-api -u pubgstats-crawler -f"
echo "Backups: journalctl -u litestream -f (if enabled)"

rm -f "${SOURCE_ENV}" "${SOURCE_TGZ}"
