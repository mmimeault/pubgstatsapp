# Deployment

## Live deployment (current)

| Item | Value |
| --- | --- |
| Project | `project-825fe074-4fff-449e-b66` |
| Site | **https://35-237-169-60.sslip.io** |
| VM | `pubgstats-vm` · `e2-micro` · `us-east1-b` |
| Static IP | `35.237.169.60` |
| Backup bucket | `gs://project-825fe074-4fff-449e-b66-pubgstats-backups` |
| Budget | CAD $50/month, alerts at 50% and 90% |
| Database | Seeded from local: 6 players, 125 matches, 11,668 kill events |
| Services | `pubgstats-api`, `pubgstats-crawler`, `caddy`, `litestream` |

The cloud database was seeded from the local SQLite file: **6 players, 125 matches, 11,668 kill events**. `DarkNext3000` and `Jeremyh24` were verified through the public API/UI.

## Chosen setup: single VM in us-east1

This is the cheapest path that keeps the current SQLite model and requires no database rewrite. The deployment uses the US `us-east1` region so the VM, disk and static IP fall under the always-free e2-micro allowance. It is farther from Montreal than `northamerica-northeast1` (~25–40 ms), but costs effectively **$0/month** within the free tier.

```
Internet
   │ HTTPS (sslip.io)
   ▼
Caddy ──────────────► static web (apps/web/dist)
   │
   └─ /api/* ───────► Fastify API ──┐
                                    ├── SQLite /opt/pubgstats/data/pubg.db
Crawler daemon ─────────────────────┘
                                    │
                                    └── Litestream ──► GCS backups
```

- **Compute:** one Compute Engine `e2-micro` (Debian 12) in `us-east1`.
- **Web:** Vite production build served by Caddy.
- **API + crawler:** systemd services running the same code as local.
- **Database:** SQLite on a 30 GB standard persistent disk (WAL, shared by API + crawler).
- **TLS/URL:** Caddy + Let's Encrypt using a free `sslip.io` hostname based on the VM IP. No domain purchase.
- **Backups:** Litestream continuously replicates SQLite to a GCS bucket.
- **Secrets:** `/opt/pubgstats/app/.env`, mode `600`, owned by `pubgstats`.

### Cost

| Item | Approx. monthly |
| --- | --- |
| e2-micro in us-east1 | $0 (always-free tier) |
| 30 GB standard persistent disk | $0 (free tier) |
| Static external IP on free-tier VM | $0 |
| Egress (2 users, small JSON) | usually under 1 GB free |
| GCS backups | pennies |
| **Total** | **~$0/month** |

The `$300` trial credit is valid for 90 days and is essentially untouched by this deployment. Verify the billing page after deployment because free-tier rules and regional pricing can change.

> **Latency tradeoff:** Montreal (`northamerica-northeast1`) would be closer, but the e2-micro always-free tier does not apply there. That option costs roughly $12–15/month. Switch with `REGION=northamerica-northeast1 ZONE=northamerica-northeast1-a ./deploy/vm/deploy.sh` if you prefer lower latency later.

### Prerequisites

1. Google Cloud account with the free-trial billing account linked.
2. Local login:

```bash
./scripts/gcloud-login.sh
```

3. Select the project (create one in the console first if needed):

```bash
./scripts/gcloud.sh config set project YOUR_PROJECT_ID
```

### Deploy

```bash
make live
```

This runs the same idempotent deployment as `./deploy/vm/deploy.sh`.

The script is idempotent and:

1. Enables Compute, Storage, IAM, Logging, Monitoring and Billing Budgets.
2. Creates a **$50/month budget alert** (50% and 90% thresholds).
3. Creates the VM service account and a GCS backup bucket.
4. Reserves a static IP and opens firewall `80/443`; SSH is restricted to your current public IP.
5. Creates the `e2-micro` VM with 30 GB standard disk.
6. Packages the repo, uploads it, installs Node/Caddy/Litestream, builds the web app, and starts systemd services.
7. Prints the HTTPS URL.

The default URL looks like:

```
https://34-123-45-67.sslip.io
```

`sslip.io` resolves that hostname to `34.123.45.67`. Caddy obtains the certificate automatically. No DNS account is needed.

You can override the hostname later:

```bash
SITE_HOST=stats.example.com make live
```

Point an A record at the static IP first, then run the deploy so Caddy can issue a certificate.

### Operations

```bash
# SSH
./scripts/gcloud.sh compute ssh pubgstats-vm --zone=us-east1-b

# Service status
./scripts/gcloud.sh compute ssh pubgstats-vm --zone=us-east1-b \
  --command='sudo systemctl status pubgstats-api pubgstats-crawler caddy litestream'

# Logs
./scripts/gcloud.sh compute ssh pubgstats-vm --zone=us-east1-b \
  --command='sudo journalctl -u pubgstats-api -u pubgstats-crawler -f'

# Update code (from your machine)
make live
```

Data in `/opt/pubgstats/data` is preserved across deploys. The crawler keeps its PID file under `/opt/pubgstats/app/data`; the database is under `/opt/pubgstats/data`.

### Seeding the cloud DB from the local cache (done once)

The public DB now contains the local dataset. The safe procedure, if you ever need to repeat it:

```bash
# 1. Checkpoint the local DB and copy it to the VM
./scripts/with-node.sh node -e "const D=require('better-sqlite3');const db=new D('data/pubg.db');db.pragma('wal_checkpoint(TRUNCATE)');db.close()"
./scripts/gcloud.sh compute scp data/pubg.db pubgstats-vm:/tmp/pubgstats-seed.db \
  --zone=us-east1-b --quiet

# 2. Stop writers, remove the old DB + Litestream state
./scripts/gcloud.sh compute ssh pubgstats-vm --zone=us-east1-b --quiet --command='
  sudo systemctl stop pubgstats-api pubgstats-crawler litestream
  sudo rm -rf /opt/pubgstats/data/.pubg.db-litestream
  sudo rm -f /opt/pubgstats/data/pubg.db-wal /opt/pubgstats/data/pubg.db-shm
  sudo install -o pubgstats -g pubgstats -m 600 /tmp/pubgstats-seed.db /opt/pubgstats/data/pubg.db
  sudo rm -f /tmp/pubgstats-seed.db
'

# 3. Clear the old replica, then start Litestream fresh
./scripts/gcloud.sh --quiet storage rm -r \
  gs://project-825fe074-4fff-449e-b66-pubgstats-backups/pubgstats
./scripts/gcloud.sh compute ssh pubgstats-vm --zone=us-east1-b --quiet --command='
  sudo systemctl start litestream
  sleep 6
  sudo systemctl start pubgstats-crawler pubgstats-api
'
```

Skipping the `.pubg.db-litestream` reset leaves Litestream referencing LTX files from the previous database and it will loop on missing files. If that happens, stop Litestream, delete `.pubg.db-litestream`, clear the replica prefix, and restart.

The local `data/pubg.db` is never modified by the deployment.

### Backups and restore

Litestream replicates to:

```
gs://YOUR_PROJECT-pubgstats-backups/pubgstats
```

Bucket lifecycle deletes backups older than 30 days.

Restore on the VM:

```bash
# Stop writers first
sudo systemctl stop pubgstats-api pubgstats-crawler litestream
sudo mv /opt/pubgstats/data/pubg.db /opt/pubgstats/data/pubg.db.broken
sudo -u pubgstats litestream restore \
  -o /opt/pubgstats/data/pubg.db \
  gs://YOUR_PROJECT-pubgstats-backups/pubgstats
sudo chown pubgstats:pubgstats /opt/pubgstats/data/pubg.db
sudo systemctl start litestream pubgstats-crawler pubgstats-api
```

Test the restore path at least once.

### Security notes

- Only `80/443` are public; `22` is restricted to your current IP.
- The API listens on `127.0.0.1:3001`; Caddy is the only public entry point.
- The PUBG API key exists only in `/opt/pubgstats/app/.env` on the VM. It is never in the web bundle.
- Rotate the PUBG key if the VM or `.env` is ever exposed.
- The VM service account only has `storage.admin` on the backup bucket plus logging/monitoring scopes.
- Re-running `deploy.sh` updates the SSH firewall source to your current IP.

### Teardown

```bash
./scripts/gcloud.sh compute instances delete pubgstats-vm \
  --zone=us-east1-b --quiet
./scripts/gcloud.sh compute addresses delete pubgstats-ip \
  --region=us-east1 --quiet
./scripts/gcloud.sh storage buckets rm -r gs://YOUR_PROJECT-pubgstats-backups
```

Delete the budget and service account manually if you are done with the project.

---

## Future upgrade: Cloud Run + Cloud SQL Postgres

This is documented now but not implemented. It is the path to choose if you want a managed database, scale-to-zero, and no VM maintenance.

### Architecture

```
Cloud Run (API + built web, one HTTPS *.run.app URL)
        │ Cloud SQL connector (private, no public DB IP)
        ▼
Cloud SQL for PostgreSQL — db-f1-micro (0.6 GB, 25 connections)
        ▲
Cloud Run crawler service (authenticated, min instances 0)
        │
        └── Cloud Scheduler drain (optional, every 10 min)
```

- **No DNS:** Cloud Run provides `https://<service>-<hash>-uc.a.run.app`.
- **No public database port:** connect with the Cloud SQL Unix socket (`/cloudsql/PROJECT:REGION:INSTANCE`).
- **No GKE:** the free GKE credit covers the control plane, but pods and a load balancer cost more than Cloud Run for this workload.

### Cost

| Item | Approx. monthly |
| --- | --- |
| Cloud Run API + web | ~$0 at this traffic (free tier) |
| Cloud Run crawler | ~$0 |
| Cloud SQL `db-f1-micro` + 10 GB SSD | ~$9.37 |
| Artifact Registry / Secret Manager / logs | < $1 |
| **Total** | **~$10–12/month** |

Set Cloud Run max instances to 1–2 so the micro instance's 25 connections are not exhausted.

### What must change in the code

1. **Database layer:** replace `better-sqlite3` with `pg` (async). The current crawler/API code is synchronous; all DB helpers, transactions and queries become async.
2. **Schema:**
   - `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGINT GENERATED ALWAYS AS IDENTITY`.
   - `TEXT` timestamps remain ISO strings or move to `timestamptz`.
   - `?` placeholders → `$1, $2, ...`.
   - `rowid` ordering → `(created_at, id)`.
   - `PRAGMA` statements removed.
   - Keep `ON CONFLICT` and partial unique indexes (Postgres supports both).
3. **Migrations:** use ordered SQL files / a migration runner against Cloud SQL.
4. **Crawler trigger:** add an authenticated `POST /run` (or Cloud Run Job) that processes one queued job. The API calls it via an ID token; the API service account gets `roles/run.invoker` on the crawler.
5. **Secrets:** PUBG key and DB password in Secret Manager, injected as Cloud Run env vars.
6. **Deployment:** Cloud Build builds images to Artifact Registry; `gcloud run deploy` for API/web and crawler.
7. **Backups:** Cloud SQL automated backups or scheduled `pg_dump` to GCS.
8. **Connection management:** Cloud Run max instances 1–2, DB pool per instance ≤ 5.
9. **Tests:** run against a Postgres instance (local Docker or Cloud SQL) before cutting over.

### Migration outline

1. Create Cloud SQL Postgres micro in `us-east1`.
2. Port schema and DB layer; keep SQLite support for local dev if desired.
3. Build and deploy the API + web to Cloud Run with the Cloud SQL connector.
4. Deploy the crawler as a Cloud Run service; wire the API trigger and IAM.
5. Crawl a test player, compare counts with the SQLite DB.
6. Point the web at the Cloud Run API and verify auth/rate limits.
7. Keep the VM running until the new stack is verified, then delete it.

### Why not GKE

GKE's `$74.40` monthly free-tier credit covers one cluster's management fee, but not the worker capacity. For two small services plus a load balancer, this POC would spend roughly **$50–80+/month** and add Kubernetes operational work without any benefit at two users. Use GKE only if learning Kubernetes is an explicit goal.
