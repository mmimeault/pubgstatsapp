#!/usr/bin/env bash
# Provisions the single-VM PUBGSTATS deployment and updates the app.
# Run from the repository root after `./scripts/gcloud-login.sh`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GCLOUD="$ROOT/scripts/gcloud.sh"
PROJECT_ID="${PROJECT_ID:-$("$GCLOUD" config get-value project 2>/dev/null || true)}"
PROJECT_ID="${PROJECT_ID%$'\n'}"

if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "(unset)" ]]; then
  echo "No GCP project selected." >&2
  echo "Run: ./scripts/gcloud.sh config set project YOUR_PROJECT_ID" >&2
  exit 1
fi

REGION="${REGION:-us-east1}"
ZONE="${ZONE:-us-east1-b}"
INSTANCE="${INSTANCE:-pubgstats-vm}"
IP_NAME="${IP_NAME:-pubgstats-ip}"
SA_NAME="${SA_NAME:-pubgstats-vm}"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
BUCKET="${BUCKET:-${PROJECT_ID}-pubgstats-backups}"
ENABLE_BACKUPS="${ENABLE_BACKUPS:-true}"
SSH_SOURCE_RANGE="${SSH_SOURCE_RANGE:-}"
SITE_HOST="${SITE_HOST:-}"
DATA_DIR="/opt/pubgstats/data"

if [[ -z "${SSH_SOURCE_RANGE}" ]]; then
  SSH_SOURCE_RANGE="$(curl -4 -fsS https://ifconfig.me 2>/dev/null || true)"
fi
if [[ -z "${SSH_SOURCE_RANGE}" ]]; then
  echo "Could not detect your public IP. Set SSH_SOURCE_RANGE=x.x.x.x and retry." >&2
  exit 1
fi
if [[ "${SSH_SOURCE_RANGE}" != */* ]]; then
  SSH_SOURCE_RANGE="${SSH_SOURCE_RANGE}/32"
fi

if [[ ! -f "$ROOT/.env" ]] || ! grep -q '^PUBG_API_KEY=.\+' "$ROOT/.env"; then
  echo "PUBG_API_KEY is missing from .env" >&2
  exit 1
fi

echo "==> Project:  ${PROJECT_ID}"
echo "==> Region:   ${REGION} (${ZONE})"
echo "==> Instance: ${INSTANCE}"

BILLING_ACCOUNT="$("$GCLOUD" billing projects describe "${PROJECT_ID}" --format='value(billingAccountName)' 2>/dev/null | sed 's|billingAccounts/||')"
if [[ -z "${BILLING_ACCOUNT}" ]]; then
  echo "No billing account is linked to ${PROJECT_ID}." >&2
  echo "Link the free-trial billing account in the Cloud Console first." >&2
  exit 1
fi

echo "==> Enabling APIs"
"$GCLOUD" services enable \
  compute.googleapis.com \
  storage.googleapis.com \
  iam.googleapis.com \
  logging.googleapis.com \
  monitoring.googleapis.com \
  cloudbilling.googleapis.com \
  cloudresourcemanager.googleapis.com \
  oslogin.googleapis.com \
  billingbudgets.googleapis.com

echo "==> Ensuring budget alert"
if ! "$GCLOUD" billing budgets list --billing-account="${BILLING_ACCOUNT}" \
  --format='value(displayName)' 2>/dev/null | grep -qx 'PUBGSTATS monthly'; then
  "$GCLOUD" billing budgets create \
    --billing-account="${BILLING_ACCOUNT}" \
    --display-name='PUBGSTATS monthly' \
    --budget-amount=50USD \
    --threshold-rule=percent=0.5 \
    --threshold-rule=percent=0.9 || \
    echo "Warning: could not create the budget alert; create one manually."
fi

echo "==> Ensuring VM service account"
if ! "$GCLOUD" iam service-accounts describe "${SA_EMAIL}" >/dev/null 2>&1; then
  "$GCLOUD" iam service-accounts create "${SA_NAME}" --display-name='PUBGSTATS VM'
fi
for _ in $(seq 1 15); do
  "$GCLOUD" iam service-accounts describe "${SA_EMAIL}" >/dev/null 2>&1 && break
  sleep 2
done

echo "==> Ensuring backup bucket"
if ! "$GCLOUD" storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1; then
  "$GCLOUD" storage buckets create "gs://${BUCKET}" \
    --location="${REGION}" \
    --uniform-bucket-level-access
fi
"$GCLOUD" storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role='roles/storage.admin' >/dev/null
"$GCLOUD" storage buckets update "gs://${BUCKET}" \
  --lifecycle-file="$ROOT/deploy/vm/lifecycle.json" >/dev/null

echo "==> Ensuring static IP"
if ! "$GCLOUD" compute addresses describe "${IP_NAME}" --region="${REGION}" >/dev/null 2>&1; then
  "$GCLOUD" compute addresses create "${IP_NAME}" --region="${REGION}"
fi
IP="$("$GCLOUD" compute addresses describe "${IP_NAME}" --region="${REGION}" --format='get(address)')"
if [[ -n "${SITE_HOST}" ]]; then
  SITE_HOST="${SITE_HOST#http://}"
  SITE_HOST="${SITE_HOST#https://}"
  SITE_HOST="${SITE_HOST%%/*}"
fi
if [[ -z "${SITE_HOST}" ]]; then
  SITE_HOST="${IP//./-}.sslip.io"
fi
echo "==> Public address: ${IP}"
echo "==> Site hostname:  ${SITE_HOST}"

echo "==> Ensuring firewall rules"
if ! "$GCLOUD" compute firewall-rules describe pubgstats-web >/dev/null 2>&1; then
  "$GCLOUD" compute firewall-rules create pubgstats-web \
    --allow=tcp:80,tcp:443 \
    --target-tags=pubgstats \
    --source-ranges=0.0.0.0/0
else
  "$GCLOUD" compute firewall-rules update pubgstats-web \
    --allow=tcp:80,tcp:443 \
    --target-tags=pubgstats \
    --source-ranges=0.0.0.0/0
fi

if ! "$GCLOUD" compute firewall-rules describe pubgstats-ssh >/dev/null 2>&1; then
  "$GCLOUD" compute firewall-rules create pubgstats-ssh \
    --allow=tcp:22 \
    --target-tags=pubgstats \
    --source-ranges="${SSH_SOURCE_RANGE}"
else
  "$GCLOUD" compute firewall-rules update pubgstats-ssh \
    --allow=tcp:22 \
    --target-tags=pubgstats \
    --source-ranges="${SSH_SOURCE_RANGE}"
fi

echo "==> Ensuring VM"
if ! "$GCLOUD" compute instances describe "${INSTANCE}" --zone="${ZONE}" >/dev/null 2>&1; then
  "$GCLOUD" compute instances create "${INSTANCE}" \
    --zone="${ZONE}" \
    --machine-type=e2-micro \
    --image-family=debian-12 \
    --image-project=debian-cloud \
    --boot-disk-size=30GB \
    --boot-disk-type=pd-standard \
    --address="${IP}" \
    --tags=pubgstats \
    --labels=app=pubgstats \
    --service-account="${SA_EMAIL}" \
    --scopes=https://www.googleapis.com/auth/devstorage.read_write,https://www.googleapis.com/auth/logging.write,https://www.googleapis.com/auth/monitoring.write \
    --metadata=enable-oslogin=TRUE
else
  STATUS="$("$GCLOUD" compute instances describe "${INSTANCE}" --zone="${ZONE}" --format='value(status)')"
  if [[ "${STATUS}" == "TERMINATED" ]]; then
    "$GCLOUD" compute instances start "${INSTANCE}" --zone="${ZONE}"
  fi
fi

echo "==> Waiting for SSH"
for _ in $(seq 1 60); do
  if "$GCLOUD" compute ssh "${INSTANCE}" --zone="${ZONE}" --quiet --command='true' >/dev/null 2>&1; then
    break
  fi
  sleep 5
done

echo "==> Packaging source"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
tar \
  --exclude='./.tools' \
  --exclude='./node_modules' \
  --exclude='./data' \
  --exclude='./.git' \
  --exclude='./apps/web/dist' \
  --exclude='./.env' \
  --exclude='*.log' \
  -czf "${TMP}/pubgstats-src.tgz" -C "${ROOT}" .

{
  grep -vE '^(PUBG_DB_PATH|CRAWLER_AUTOSTART|WEB_ORIGIN|HOST)=' "${ROOT}/.env"
  echo "PUBG_DB_PATH=${DATA_DIR}/pubg.db"
  echo "CRAWLER_AUTOSTART=false"
  echo "WEB_ORIGIN=https://${SITE_HOST}"
  echo "HOST=127.0.0.1"
} >"${TMP}/pubgstats.env"

echo "==> Uploading application"
"$GCLOUD" compute scp "${TMP}/pubgstats-src.tgz" "${INSTANCE}:/tmp/pubgstats-src.tgz" --zone="${ZONE}" --quiet
"$GCLOUD" compute scp "${TMP}/pubgstats.env" "${INSTANCE}:/tmp/pubgstats.env" --zone="${ZONE}" --quiet
"$GCLOUD" compute scp "$ROOT/deploy/vm/install.sh" "${INSTANCE}:/tmp/pubgstats-install.sh" --zone="${ZONE}" --quiet

"$GCLOUD" compute ssh "${INSTANCE}" --zone="${ZONE}" --quiet --command="sudo env SITE_HOST='${SITE_HOST}' GCS_BUCKET='${BUCKET}' ENABLE_BACKUPS='${ENABLE_BACKUPS}' bash /tmp/pubgstats-install.sh"

echo "==> Waiting for HTTPS"
for _ in $(seq 1 60); do
  if curl -fsS "https://${SITE_HOST}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 5
done

echo
echo "Deployment complete."
echo "Site:    https://${SITE_HOST}"
echo "Health:  https://${SITE_HOST}/api/health"
echo "SSH:     ./scripts/gcloud.sh compute ssh ${INSTANCE} --zone=${ZONE}"
echo "Logs:    ./scripts/gcloud.sh compute ssh ${INSTANCE} --zone=${ZONE} --command='sudo journalctl -u pubgstats-api -u pubgstats-crawler -f'"
echo
echo "Estimated baseline: e2-micro + 30GB disk + static IP in ${REGION}. The e2-micro free tier applies in us-east1; verify the current billing page after deployment."
