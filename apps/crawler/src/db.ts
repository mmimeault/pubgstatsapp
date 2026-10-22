import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

export type Db = Database.Database

export const SCHEMA_VERSION = 5

const MIGRATION_1 = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  shard TEXT NOT NULL,
  name TEXT NOT NULL,
  name_folded TEXT NOT NULL,
  ban_type TEXT,
  clan_id TEXT,
  is_tracked INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_synced_at TEXT,
  UNIQUE (shard, name_folded)
);
CREATE INDEX IF NOT EXISTS idx_players_lookup ON players (shard, name_folded);

CREATE TABLE IF NOT EXISTS seasons (
  id TEXT NOT NULL,
  shard TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (id, shard)
);
CREATE INDEX IF NOT EXISTS idx_seasons_current ON seasons (shard, is_current);

CREATE TABLE IF NOT EXISTS player_season_stats (
  player_id TEXT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  season_id TEXT NOT NULL,
  shard TEXT NOT NULL,
  mode TEXT NOT NULL,
  rounds_played INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  top10s INTEGER NOT NULL DEFAULT 0,
  kills INTEGER NOT NULL DEFAULT 0,
  assists INTEGER NOT NULL DEFAULT 0,
  damage_dealt REAL NOT NULL DEFAULT 0,
  headshot_kills INTEGER NOT NULL DEFAULT 0,
  time_survived INTEGER NOT NULL DEFAULT 0,
  longest_kill REAL NOT NULL DEFAULT 0,
  best_rank_point INTEGER,
  raw_json TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (player_id, season_id, mode)
);

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  shard TEXT NOT NULL,
  map_name TEXT NOT NULL,
  game_mode TEXT NOT NULL,
  match_type TEXT NOT NULL,
  duration INTEGER,
  created_at TEXT NOT NULL,
  season_state TEXT,
  raw_json TEXT,
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_matches_created ON matches (created_at DESC);

CREATE TABLE IF NOT EXISTS match_participants (
  match_id TEXT NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  player_id TEXT NOT NULL,
  shard TEXT NOT NULL,
  name TEXT NOT NULL,
  placement INTEGER,
  kills INTEGER NOT NULL DEFAULT 0,
  headshots INTEGER NOT NULL DEFAULT 0,
  assists INTEGER NOT NULL DEFAULT 0,
  dbno INTEGER NOT NULL DEFAULT 0,
  damage REAL NOT NULL DEFAULT 0,
  time_survived INTEGER NOT NULL DEFAULT 0,
  walk_distance REAL NOT NULL DEFAULT 0,
  ride_distance REAL NOT NULL DEFAULT 0,
  death_type TEXT,
  PRIMARY KEY (match_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_participants_player ON match_participants (player_id, match_id);

CREATE TABLE IF NOT EXISTS crawl_jobs (
  id TEXT PRIMARY KEY,
  player_key TEXT NOT NULL,
  shard TEXT NOT NULL,
  player_name TEXT NOT NULL,
  player_id TEXT,
  kind TEXT NOT NULL DEFAULT 'player_sync',
  status TEXT NOT NULL DEFAULT 'pending',
  phase TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  error TEXT,
  error_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_job
  ON crawl_jobs (player_key) WHERE status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS idx_jobs_status ON crawl_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_player ON crawl_jobs (player_key, created_at DESC);

CREATE TABLE IF NOT EXISTS api_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL,
  called_at INTEGER NOT NULL,
  status INTEGER,
  remaining INTEGER,
  reset_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_calls_time ON api_calls (called_at);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`

const MIGRATION_2 = `
ALTER TABLE matches ADD COLUMN telemetry_url TEXT;
ALTER TABLE matches ADD COLUMN telemetry_fetched_at TEXT;
ALTER TABLE matches ADD COLUMN telemetry_error TEXT;

CREATE TABLE IF NOT EXISTS match_kills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  event_time TEXT NOT NULL,
  killer_id TEXT,
  killer_name TEXT,
  killer_is_bot INTEGER NOT NULL DEFAULT 0,
  victim_id TEXT,
  victim_name TEXT,
  victim_is_bot INTEGER NOT NULL DEFAULT 0,
  weapon TEXT,
  damage_reason TEXT,
  distance REAL,
  finisher_name TEXT,
  is_suicide INTEGER NOT NULL DEFAULT 0,
  is_teamkill INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_kills_match ON match_kills (match_id, event_time);
CREATE INDEX IF NOT EXISTS idx_kills_killer ON match_kills (killer_id, event_time);
`

const MIGRATION_3 = `
ALTER TABLE match_participants ADD COLUMN team_id INTEGER;
ALTER TABLE match_participants ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_participants_team ON match_participants (match_id, team_id);
`

const MIGRATION_4 = `
ALTER TABLE crawl_jobs ADD COLUMN season_id TEXT;

CREATE TABLE IF NOT EXISTS player_season_fetches (
  player_id TEXT NOT NULL,
  season_id TEXT NOT NULL,
  shard TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  status TEXT NOT NULL,
  last_error TEXT,
  PRIMARY KEY (player_id, season_id)
);
CREATE INDEX IF NOT EXISTS idx_season_fetches_player ON player_season_fetches (player_id, season_id);
`

const MIGRATION_5 = `
ALTER TABLE crawl_jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE crawl_jobs ADD COLUMN run_after TEXT;
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON crawl_jobs (status, run_after, priority, created_at);
`

export function openDb(dbPath: string): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.pragma('synchronous = NORMAL')
  return db
}

export function migrate(db: Db): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `)
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
    | { version: number | null }
    | undefined
  let version = row?.version ?? 0

  if (version < 1) {
    const apply = db.transaction(() => {
      db.exec(MIGRATION_1)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        1,
        new Date().toISOString(),
      )
    })
    apply()
    version = 1
  }

  if (version < 2) {
    const apply = db.transaction(() => {
      db.exec(MIGRATION_2)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        2,
        new Date().toISOString(),
      )
    })
    apply()
    version = 2
  }

  if (version < 3) {
    const apply = db.transaction(() => {
      db.exec(MIGRATION_3)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        3,
        new Date().toISOString(),
      )
    })
    apply()
    version = 3
  }

  if (version < 4) {
    const apply = db.transaction(() => {
      db.exec(MIGRATION_4)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        4,
        new Date().toISOString(),
      )
    })
    apply()
    version = 4
  }

  if (version < 5) {
    const apply = db.transaction(() => {
      db.exec(MIGRATION_5)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        5,
        new Date().toISOString(),
      )
    })
    apply()
    version = 5
  }

  return version
}

export function getSchemaVersion(db: Db): number | null {
  try {
    const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
      | { version: number | null }
      | undefined
    return row?.version ?? null
  } catch {
    return null
  }
}

export function tableCount(
  db: Db,
  table: 'players' | 'matches' | 'crawl_jobs' | 'match_kills',
): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
    return row.count
  } catch {
    return 0
  }
}
