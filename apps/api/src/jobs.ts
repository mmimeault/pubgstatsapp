import crypto from 'node:crypto'
import type { JobSummary, Shard } from '@pubgstats/shared'
import type { Db, JobRow, PlayerRow } from './types'

export function playerKey(shard: string, name: string): string {
  return `${shard}:${name.trim().toLowerCase()}`
}

export function seasonPlayerKey(shard: string, name: string, seasonId: string): string {
  return `${playerKey(shard, name)}:${seasonId}`
}

export function seasonScanKey(shard: string, name: string): string {
  return `${playerKey(shard, name)}:scan`
}

export function mapJob(row: JobRow): JobSummary {
  return {
    id: row.id,
    playerKey: row.player_key,
    shard: row.shard as Shard,
    playerName: row.player_name,
    playerId: row.player_id,
    seasonId: row.season_id,
    kind: row.kind,
    priority: row.priority,
    runAfter: row.run_after,
    status: row.status,
    phase: row.phase as JobSummary['phase'],
    progress: row.progress,
    message: row.message,
    error: row.error,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

export function findPlayer(db: Db, shard: string, name: string): PlayerRow | undefined {
  return db
    .prepare('SELECT * FROM players WHERE shard = ? AND name_folded = ?')
    .get(shard, name.trim().toLowerCase()) as PlayerRow | undefined
}

export function findPlayerById(db: Db, id: string): PlayerRow | undefined {
  return db.prepare('SELECT * FROM players WHERE id = ?').get(id) as PlayerRow | undefined
}

export function getJob(db: Db, id: string): JobRow | undefined {
  return db.prepare('SELECT * FROM crawl_jobs WHERE id = ?').get(id) as JobRow | undefined
}

export function getActiveJob(db: Db, key: string): JobRow | undefined {
  return db
    .prepare(
      "SELECT * FROM crawl_jobs WHERE player_key = ? AND status IN ('pending', 'running') ORDER BY created_at DESC LIMIT 1",
    )
    .get(key) as JobRow | undefined
}

export function getLatestJob(db: Db, key: string): JobRow | undefined {
  return db
    .prepare(
      'SELECT * FROM crawl_jobs WHERE player_key = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    )
    .get(key) as JobRow | undefined
}

export interface CreateJobResult {
  job: JobRow
  created: boolean
}

/** Enqueue a crawl, returning the existing active job when one already exists. */
export function createJob(db: Db, shard: string, name: string): CreateJobResult {
  const key = playerKey(shard, name)
  const active = getActiveJob(db, key)
  if (active) return { job: active, created: false }

  const player = findPlayer(db, shard, name)
  const now = new Date().toISOString()
  const id = crypto.randomUUID()

  try {
    db.prepare(
      `INSERT INTO crawl_jobs
         (id, player_key, shard, player_name, player_id, kind, status, phase, progress, attempts, created_at, updated_at)
       VALUES
         (?, ?, ?, ?, ?, 'player_sync', 'pending', 'queued', 0, 0, ?, ?)`,
    ).run(id, key, shard, name.trim(), player?.id ?? null, now, now)
  } catch (error) {
    // Partial unique index guarantees a single active job per player.
    const raced = getActiveJob(db, key)
    if (raced) return { job: raced, created: false }
    throw error
  }

  const job = getJob(db, id)
  if (!job) throw new Error('Failed to create crawl job')
  return { job, created: true }
}

/** Enqueue a stats-only fetch for one season. */
export function createSeasonJob(
  db: Db,
  shard: string,
  name: string,
  seasonId: string,
): CreateJobResult {
  const key = seasonPlayerKey(shard, name, seasonId)
  const active = getActiveJob(db, key)
  if (active) return { job: active, created: false }

  const player = findPlayer(db, shard, name)
  const now = new Date().toISOString()
  const id = crypto.randomUUID()

  try {
    db.prepare(
      `INSERT INTO crawl_jobs
         (id, player_key, shard, player_name, player_id, season_id, kind, status,
          phase, progress, attempts, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'season_sync', 'pending', 'queued', 0, 0, 10, ?, ?)`,
    ).run(id, key, shard, name.trim(), player?.id ?? null, seasonId, now, now)
  } catch (error) {
    const raced = getActiveJob(db, key)
    if (raced) return { job: raced, created: false }
    throw error
  }

  const job = getJob(db, id)
  if (!job) throw new Error('Failed to create season crawl job')
  return { job, created: true }
}

/** Low-priority background season discovery batch. */
export function createSeasonScanJob(
  db: Db,
  shard: string,
  name: string,
  playerId: string | null,
  runAfter: string | null = null,
): CreateJobResult {
  const key = seasonScanKey(shard, name)
  const active = getActiveJob(db, key)
  if (active) return { job: active, created: false }

  const now = new Date().toISOString()
  const id = crypto.randomUUID()

  try {
    db.prepare(
      `INSERT INTO crawl_jobs
         (id, player_key, shard, player_name, player_id, kind, status, phase, progress,
          attempts, priority, run_after, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'season_scan', 'pending', 'queued', 0, 0, 20, ?, ?, ?)`,
    ).run(id, key, shard, name.trim(), playerId, runAfter, now, now)
  } catch (error) {
    const raced = getActiveJob(db, key)
    if (raced) return { job: raced, created: false }
    throw error
  }

  const job = getJob(db, id)
  if (!job) throw new Error('Failed to create season scan job')
  return { job, created: true }
}

export function getHeartbeat(db: Db): string | null {
  try {
    const row = db
      .prepare("SELECT value FROM sync_state WHERE key = 'crawler_heartbeat'")
      .get() as { value: string } | undefined
    return row?.value ?? null
  } catch {
    return null
  }
}

export function heartbeatAgeMs(heartbeat: string | null, now = Date.now()): number | null {
  if (!heartbeat) return null
  const time = new Date(heartbeat).getTime()
  if (Number.isNaN(time)) return null
  return Math.max(0, now - time)
}

export function queueCounts(db: Db): { pending: number; running: number; failed: number } {
  const rows = db
    .prepare(
      `SELECT status, COUNT(*) AS count FROM crawl_jobs
       WHERE status IN ('pending', 'running', 'failed') GROUP BY status`,
    )
    .all() as Array<{ status: string; count: number }>
  const result = { pending: 0, running: 0, failed: 0 }
  for (const row of rows) {
    if (row.status in result) result[row.status as keyof typeof result] = row.count
  }
  return result
}
