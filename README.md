# PUBGSTATS

A local-first PUBG stats lookup. The web UI shows switchable season stats and recent match details (20 at a time, up to the 32 PUBG exposes), backed by a standalone crawler that caches PUBG API responses in SQLite.

The project is split into three apps so the crawler, read API and UI can be deployed independently later.

```
apps/
  crawler/   # owns PUBG API access, rate limiting, jobs, SQLite writes
  api/       # read-only stats API + crawl enqueue endpoint
  web/       # React + Vite UI
packages/
  shared/    # DTO types, labels, metric calculations
data/
  pubg.db    # SQLite (WAL), created by the crawler
```

## Architecture

```
Web (React) ──REST──▶ API (Fastify)
                        │  INSERT crawl job (only write)
                        ▼
                  data/pubg.db ◀── crawler daemon
                        ▲                │
                        │                ▼
                  API reads        PUBG API (rate-limited)
```

- **Crawler** is the only process with `PUBG_API_KEY`. It owns the schema, runs migrations, claims one job at a time, calls PUBG, and writes stats/matches.
- **API** reads everything from SQLite. Its only write is a `crawl_jobs` row when a player is first viewed or refreshed. It never calls PUBG.
- **Web** only calls the API. It polls while a crawl is running and renders cached data instantly afterwards.

SQLite is used because the data is relational and needs incremental upserts, job claiming and concurrent readers. CSV cannot provide those safely. The schema is small enough to move to Postgres later without changing the crawler's contract.

## Quick start

Requires macOS/Linux and `curl`. No global Node install is needed: the setup script downloads Node 24 LTS into `.tools/node`, uses `.tools/npm-cache`, and makes no shell changes.

```bash
# 1. Project-local Node + dependencies
make setup

# 2. Configure the API key (server-side only)
cp .env.example .env
# edit .env and set PUBG_API_KEY=...

# 3. Crawl your player once (3 rate-limited calls + free match/telemetry calls)
make crawl NAME=DarkNext3000 SHARD=steam

# 4. Run crawler daemon + API + web UI locally
make local
```

Open http://localhost:5173. The demo route is:

```
http://localhost:5173/player/steam/DarkNext3000
```

For the deployed environment, use `make live` (and `make url` to print the public URL).

`make local` starts:

- crawler daemon on no network port (SQLite job queue)
- API on http://127.0.0.1:3001
- Vite dev server on http://localhost:5173 (proxies `/api` to the API)

## Commands

| Command | Description |
| --- | --- |
| `make setup` | Download project-local Node and install dependencies |
| `make crawl NAME=DarkNext3000 SHARD=steam` | Run one crawl synchronously |
| `make local` | Start crawler, API and web locally (alias: `make dev`) |
| `make live` | Deploy/update the production VM |
| `make login` | Authenticate the Google Cloud CLI |
| `make url` | Print the live site URL |
| `make status` | Local database/crawler status |
| `make stop` | Stop the local crawler daemon |
| `make typecheck` | TypeScript checks for all apps |
| `make test` | Vitest suite |
| `make build` | Production build of the web app |

Direct scripts (they set the local Node `PATH` for you):

```bash
./scripts/crawler.sh status
./scripts/crawler.sh sync --shard steam --name DarkNext3000 --matches 20
./scripts/crawl.sh DarkNext3000 steam 20
```

## How crawling works

A cold player crawl makes only **three rate-limited requests**:

1. `GET /shards/:shard/players?filter[playerNames]=:name`
2. `GET /shards/:shard/seasons` (cached for 24h)
3. `GET /shards/:shard/players/:id/seasons/:seasonId` (all modes in one response)

Then it fetches up to 32 recent match details — the maximum PUBG exposes within its 14-day window. The UI shows the first 20 and loads the rest from SQLite on demand. The PUBG docs state that `/matches` and telemetry are **not** rate-limited, so only the three calls above consume the 10 requests/minute budget.

For each stored match, the crawler downloads the public telemetry asset and indexes its `LogPlayerKillV2` events. Telemetry is also free, so a cold crawl can load up to 32 matches and their kill events without spending extra API slots.

A refresh costs two rate-limited calls (player + season stats) plus only matches that are not already stored. Matches and their telemetry are immutable and cached forever; a refresh only downloads telemetry for new match IDs.

### Season aggregate vs match details

These are deliberately separate:

- **Season stats** come from `GET /players/{id}/seasons/{seasonId}`. That one request returns full-season aggregates for every mode, covering **all season games** (79 for the demo player), regardless of how many match details are stored. This is what the season card displays.
- **Match details** are capped by `PUBG_MATCH_LIMIT` (default 32, the API maximum). Only these matches and their telemetry are stored. The profile returns the first `PROFILE_RECENT_MATCH_LIMIT` (default 20); the **Load more** button pages through the remaining stored details from SQLite with no additional API calls.
- **Season K/D** is `season kills / (season rounds - season wins)` and includes bot kills. PUBG does not expose a bot split in the season aggregate, so a no-bot season K/D cannot be derived from the API. **Recent K/D** is shown both ways and recalculates as more stored matches are loaded.

### Season switching

The season card lists the **current season plus the seasons the player has actually played**. Discovery runs automatically in the background:

- Only the **newest 10 modern seasons** are scanned initially.
- The crawler processes **2 seasons per batch**, then schedules the next batch **60 seconds later**.
- Profile sync (current season + recent matches) always has priority; background scans use a lower queue priority and `run_after`.
- Every fetched season is cached forever; empty seasons are marked and skipped.
- The UI shows `Scanning season history · 4/10` while the dropdown fills in.
- Selecting a played season loads its cached aggregates; the selected season is stored in the URL as `?season=division...`.
- The season endpoint still supports any known season on demand; the initial scan is intentionally limited to the 10 newest.

Recent matches are deliberately **not** tied to the selected season: the season card shows that season's aggregates, while the table below always shows the most recent stored match details.

### Match history limits (validated)

There is **no player match-history endpoint**. This was verified against the official OpenAPI specs and live API:

- Players exposes only `GET /players` and `GET /players/{accountId}`.
- The player object contains "a list of their recent matches (up to 14 days old)" and has **no pagination links or meta**.
- The docs state a **maximum of 32 match IDs per player** within that 14-day window.
- **Data older than 14 days is not available** (PUBG retention limit).
- Season stats exposes aggregates only; the matches API only accepts a single `GET /matches/{id}`.
- Candidate history endpoints (`/players/{id}/matches`, `/players/{id}/seasons/{id}/matches`, `/matches?filter[playerIds]=...`) all return `404`.

Consequences:

- The season card can show **all season games** because PUBG computes that aggregate server-side.
- No-bot K/D is exact only for the **loaded match details** (20 initially, up to 32 stored).
- A full-season no-bot K/D would require accumulating matches going forward. Historical season games cannot be backfilled.

The rate limiter is a rolling 60-second window persisted in `api_calls`, so restarting the crawler cannot create a burst. It honors `X-RateLimit-*` headers, waits for the 429 reset timestamp, retries 5xx with backoff, and serializes all rate-limited requests.

### Kills and bot detection

Season stats are aggregates returned by PUBG. Per-game kills are a different data source: each match's **telemetry** contains `LogPlayerKillV2` events, which the crawler normalizes into `match_kills`.

For every kill, the crawler stores:

- killer and victim names/account IDs
- `victim_is_bot` / `killer_is_bot`
- weapon asset and damage reason
- distance (converted from cm to metres)
- whether the kill was a suicide or team kill
- the finisher when a teammate finished the kill

Bots are identified from telemetry characters with `type: "user_ai"` (or `type: "ai"`) and `ai.*` account IDs. The UI shows one `BOT` or `PLAYER` tag per kill, plus a bot-kill count on each match row and in the recent-20 summary.

Kill credit in PUBG goes to the player who knocked the victim. The crawler uses `killerDamageInfo` for the credited killer's weapon/distance and records the finisher separately when it differs. Telemetry payloads are not stored; only the normalized kill rows (about 90 per match).

For each match, the UI also uses the kill events where the player is the **victim** to show who killed them, with weapon, distance and bot/player tag. Roster data is used to list the player's **teammates**; these names and every human killer/victim link to `/player/{shard}/{name}`, which triggers a normal crawl of that player.

Upgrading an existing database: schema v5 adds job priority and `run_after`; v4 added `crawl_jobs.season_id` and `player_season_fetches`; v3 added `team_id`/`is_bot` to `match_participants`. `make local` migrates automatically and backfills team data from stored raw JSON. Season stats are then discovered in the background.

The recent-match summary computes K/D twice: all kills, and kills excluding bots (`humanKills / deaths`). The season card always shows the season K/D including bots. A full-season no-bot K/D is not possible: PUBG only exposes up to 32 match IDs within a 14-day window, so historical season games cannot be reconstructed. The no-bot figure is therefore scoped to the loaded match details and labeled as such.

### First view and refresh flow

1. UI opens `/player/steam/DarkNext3000`.
2. API finds the cached player → `200` with the profile.
3. If not cached, API enqueues a `crawl_jobs` row → `202` with job progress.
4. Crawler claims the job atomically and updates `phase`/`progress`.
5. UI polls every 1.2s, then receives `200` when the crawl is done.

While a **first-time** crawl is running, the profile endpoint keeps returning `202` even after partial stats/matches have been written (`players.last_synced_at IS NULL` + active job). The UI therefore stays on the progress loader until the crawl is fully done, instead of rendering a half-populated profile. Refreshes of an existing player return cached data immediately; the UI merges newly stored rows into the loaded list rather than shrinking it back to the first page.

### Refresh cooldown

Each account can be refreshed at most once per **60 seconds** (`REFRESH_COOLDOWN_SECONDS`). The cooldown starts from the latest crawl activity (successful sync completion, or a failed request) and is enforced by the API:

- `POST /api/players/:shard/:name/refresh` returns `429` with `Retry-After` and `retryAfterSeconds` when the cooldown is active.
- The profile response exposes `crawl.refreshAvailableAt` and `crawl.refreshCooldownSeconds`.
- The UI disables the refresh button and shows a live `Refresh in 42s` countdown.

An already-running crawl still wins: refresh requests return the existing job instead of starting another one.

Only one active job can exist per player (`player_key = shard:lowercase(name)` with a partial unique index). Extra refresh requests return the existing job instead of starting another crawl.

The API can autostart the crawler daemon when it is not running (`CRAWLER_AUTOSTART=true`). `make local` starts both explicitly and disables autostart to avoid a duplicate daemon.

## Rate limit and caching defaults

| Setting | Default |
| --- | --- |
| `PUBG_RATE_LIMIT_RPM` | `10` |
| `PUBG_MATCH_LIMIT` | `32` |
| `PUBG_MATCH_CONCURRENCY` | `5` |
| `PUBG_TELEMETRY_CONCURRENCY` | `2` |
| `PUBG_TELEMETRY_TIMEOUT_MS` | `60000` |
| `PROFILE_RECENT_MATCH_LIMIT` | `20` |
| `REFRESH_COOLDOWN_SECONDS` | `60` |
| `SEASON_SCAN_LIMIT` | `10` |
| `SEASON_SCAN_BATCH_SIZE` | `2` |
| `SEASON_SCAN_INTERVAL_SECONDS` | `60` |
| `PUBG_SEASON_CACHE_HOURS` | `24` |
| `PROFILE_STALE_AFTER_SECONDS` | `900` |

All are environment variables (see `.env.example`). The limiter adapts to a higher limit by changing `PUBG_RATE_LIMIT_RPM`.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | DB schema, counts, crawler heartbeat, queue |
| `GET /api/players/:shard/:name` | `200` profile, `202` crawling, `404` not found |
| `GET /api/players/:shard/:name/seasons` | Seasons + automatic scan progress |
| `GET /api/players/:shard/:name/seasons/:seasonId` | `200` season stats, `202` fetching, `404` unavailable |
| `POST /api/players/:shard/:name/refresh` | Enqueue/return active crawl job (`202`) |
| `GET /api/jobs/:id` | Crawl job status/progress |
| `GET /api/players/:shard/:name/matches?limit=20&offset=0` | Paginated stored matches |
| `GET /api/matches/:matchId` | Stored match + participants |

Shards: `steam`, `kakao`, `psn`, `xbox`.

The profile response contains:

```jsonc
{
  "player": { "id": "account...", "name": "DarkNext3000", "shard": "steam", "lastSyncedAt": "..." },
  "season": { "id": "division.bro.official.pc-2018-43", "label": "Season 43", "isCurrent": true },
  "modes": [
    {
      "mode": "duo-fpp",
      "rounds": 79,
      "wins": 11,
      "kills": 187,
      "assists": 46,
      "damage": 22934.6,
      "headshots": 46,
      "kd": 2.75,
      "winRate": 13.9,
      "top10Rate": 51.9,
      "avgDamage": 290.3,
      "hsRate": 24.6
    }
  ],
  "totals": { "...": "aggregate of all modes" },
  "defaultMode": "duo-fpp",
  "recentMatches": [
    {
      "id": "9b2f5c3a-...",
      "mapLabel": "Erangel",
      "modeLabel": "Duo FPP",
      "placement": 9,
      "kills": 3,
      "damage": 289.7,
      "timeSurvived": 1175,
      "win": false,
      "top10": true,
      "killDataFetched": true,
      "killEvents": [
        {
          "victimName": "KawhisBiggerClaw",
          "victimIsBot": false,
          "weaponLabel": "M24",
          "distance": 63.5,
          "eventTime": "2026-10-19T03:07:42.434Z",
          "isTeamkill": false,
          "isSuicide": false,
          "finisherName": null
        }
      ],
      "death": {
        "killerName": "Jeremyh24",
        "killerIsBot": false,
        "weaponLabel": "SLR",
        "distance": 56,
        "eventTime": "2026-10-19T03:24:24.452Z"
      },
      "teammates": [
        { "id": "account...", "name": "bytesl4yer", "isBot": false }
      ]
    }
  ],
  "recentMatchesTotal": 21,
  "recentSummary": {
    "avgPlacement": 16.6,
    "kd": 2.61,
    "avgDamage": 292,
    "wins": 2,
    "botKills": 13,
    "humanKills": 34,
    "kdNoBots": 1.89
  },
  "crawl": {
    "state": "idle",
    "stale": false,
    "crawlerOnline": true,
    "lastSyncedAt": "...",
    "refreshAvailableAt": "...",
    "refreshCooldownSeconds": 0
  }
}
```

## Data model

- `players` — account id, shard, exact name, folded name, ban/clan, last sync
- `seasons` — season id, shard, current flag, cache timestamp
- `player_season_stats` — per player/season/mode aggregates
- `player_season_fetches` — per player/season fetch state (`ok`, `empty`, `error`)
- `matches` — map, mode, duration, created time, telemetry URL/status, raw JSON
- `match_participants` — stored participant stats, `team_id` and bot flag used for teammate lists
- `match_kills` — normalized telemetry kill events: killer/victim, bot flags, weapon, distance, team/suicide flags
- `crawl_jobs` — queue with priority, scheduled `run_after`, and one active job per player or season fetch
- `api_calls` — persistent rate-limit ledger
- `sync_state` — crawler heartbeat

Raw match JSON is retained so future features (weapon/heatmap aggregation, match detail views) do not require re-fetching matches. Raw telemetry payloads are not retained; only the normalized kill rows are stored.

## What is shared between players

Match data is global, not copied per user:

| Data | Storage | Scope |
| --- | --- | --- |
| Match + raw JSON | `matches` (PK: match id) | Global, one row per match |
| All participants/stats | `match_participants` (PK: match id + account id) | Global, ~90 rows per match |
| All kill events | `match_kills` | Global, one row per kill |
| Seasons | `seasons` | Shared per shard |
| API rate ledger / heartbeat | `api_calls`, `sync_state` | Global |
| Player identity | `players` | Per account |
| Season aggregates | `player_season_stats` | Per player/season/mode |
| Crawl requests | `crawl_jobs` | Per player |

`syncPlayer` diffs a player's recent match IDs against `matches`. A match already stored for any other player is **not fetched again**; its participants and kills are reused. Telemetry is fetched once per match and only normalized kills are kept.

Measured on the local database:

- **125 matches** stored once, containing **11,534 participant rows** and **11,668 kill events**.
- `bytesl4yer`: requested 27 matches, **fetched only 6**; the other 21 were already cached from other players.
- `n0ops_TV`: requested 32 matches, fetched 30 (2 reused). Its profile showed 35 stored details because 3 more matches already existed from earlier crawls.
- 25 matches are present in more than one crawled player's history.

Rate-limit nuance: `/matches` and telemetry are already free, so sharing them saves time, bandwidth and DB writes rather than the 10/min budget. The two limited calls per player (player lookup + season stats) are account-specific and cannot be shared across different players. Requests for the **same** player share one active job and the cached profile.

Possible future reuse improvements:

- Add a short refresh cooldown per player so repeated refresh clicks do not spend another two limited calls.
- If future features need damage timelines/heatmaps, store richer normalized telemetry once per match (or compressed raw telemetry) so every participant benefits.


## Notes and limitations

- **PUBG names are case-sensitive.** `darknext3000` returns 404 while `DarkNext3000` works. The UI shows this hint when a lookup fails.
- PUBG does not expose season deaths, so season K/D uses `kills / (rounds - wins)`. Match-level K/D uses the stored match results.
- PUBG does not expose a season-level bot split, and match history is capped at 32 match IDs within 14 days. The no-bot K/D is therefore computed only for the loaded match details; the season card and recent summary label this scope explicitly.
- Ranked and casual stats share one row per mode in the current schema; if a mode has both, ranked values overwrite casual values. This demo account has casual stats only. Split the primary key before adding ranked-focused views.
- The crawler processes one job at a time. Match downloads inside a job use concurrency 5; telemetry uses concurrency 2.
- Telemetry files are large (a 26-minute match is ~23 MB uncompressed). A cold crawl of up to 32 matches takes a few extra seconds and temporarily uses memory while parsing. Set `PUBG_TELEMETRY_CONCURRENCY=1` on constrained machines.
- Per-match kill counts come from participant stats. The kill list comes from telemetry; both matched exactly for the demo data, but a telemetry processing failure will show "Kill details not indexed yet" for that match.
- There is no automatic 10-minute polling. Data refreshes when the UI asks for it (first view or the refresh button) or when you run `make crawl`.
- The API is bound to `127.0.0.1` by default and has no authentication. Do not expose it publicly as-is.
- The API key is read only by the crawler. It is gitignored and never sent to the browser.
- The key used during initial development was shared in a chat, so rotate it in the PUBG developer console before making the repository public or deploying.
- `.tools/` and `data/*.db*` are gitignored. `make setup` recreates the toolchain; the crawler recreates the database.

## Scaling path

- Swap SQLite for Postgres in the crawler and API (`crawl_jobs` becomes a proper job queue; the job semantics stay the same).
- Run the crawler as a worker service and the API as N stateless replicas behind a proxy.
- Increase `PUBG_RATE_LIMIT_RPM` after the PUBG developer console approves a higher limit; no code change is needed.
- Add telemetry-derived features (damage timelines, weapon heatmaps) as new projections over `match_kills` / match raw payloads; the ingestion pipeline is already in place.

## Cloud deployment

The chosen deployment is a single `e2-micro` VM in **`us-east1`** (always-free tier) with Caddy, the API/crawler under systemd, SQLite, and Litestream backups to GCS. It requires no DNS purchase (`*.sslip.io` + automatic TLS) and no database rewrite.

**Live:** https://35-237-169-60.sslip.io

- Full runbook, costs, backups and the **Cloud Run + Cloud SQL upgrade path**: [`docs/deployment.md`](docs/deployment.md)
- Authenticate locally: `make login`
- Deploy/update: `make live`
- Print the live URL: `make url`
- GKE is intentionally not used; it is significantly more expensive at this scale.
