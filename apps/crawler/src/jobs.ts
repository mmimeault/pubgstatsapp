import { randomUUID } from 'node:crypto'
import type { CrawlPhase, JobStatus, JobSummary, Shard } from '@pubgstats/shared'
import type { Db } from './db'

export interface CrawlJobRow {
  id: string
  player_key: string
  shard: string
  player_name: string
  player_id: string | null
  season_id: string | null
  kind: string
  priority: number
  run_after: string | null
  status: string
  phase: string
  progress: number
  message: string | null
  error: string | null
  error_code: string | null
  attempts: number
  created_at: string
  updated_at: string
  started_at: string | null
  finished_at: string | null
}

export interface JobPatch {
  status?: JobStatus
  phase?: CrawlPhase
  progress?: number
  message?: string | null
  error?: string | null
  error_code?: string | null
  player_id?: string | null
  started_at?: string | null
  finished_at?: string | null
  updated_at?: string
  attempts?: number
}

const PATCH_COLUMNS = {
  status: 'status',
  phase: 'phase',
  progress: 'progress',
  message: 'message',
  error: 'error',
  error_code: 'error_code',
  player_id: 'player_id',
  started_at: 'started_at',
  finished_at: 'finished_at',
  updated_at: 'updated_at',
  attempts: 'attempts',
} as const satisfies Record<keyof JobPatch, string>

export function playerKey(shard: string, name: string): string {
  return `${shard}:${name.trim().toLowerCase()}`
}

export function seasonPlayerKey(shard: string, name: string, seasonId: string): string {
  return `${playerKey(shard, name)}:${seasonId}`
}

export function seasonScanKey(shard: string, name: string): string {
  return `${playerKey(shard, name)}:scan`
}

export function toJobSummary(row: CrawlJobRow): JobSummary {
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
    status: row.status as JobStatus,
    phase: row.phase as CrawlPhase,
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

function rowOrNull(row: unknown): CrawlJobRow | null {
  return (row as CrawlJobRow | undefined) ?? null
}

function summaryOrNull(row: unknown): JobSummary | null {
  const job = rowOrNull(row)
  return job ? toJobSummary(job) : null
}

export function getJob(db: Db, id: string): JobSummary | null {
  return summaryOrNull(db.prepare('SELECT * FROM crawl_jobs WHERE id = ?').get(id))
}

export function getJobRow(db: Db, id: string): CrawlJobRow | null {
  return rowOrNull(db.prepare('SELECT * FROM crawl_jobs WHERE id = ?').get(id))
}

export function getActiveJob(db: Db, key: string): JobSummary | null {
  return summaryOrNull(
    db
      .prepare(
        `SELECT * FROM crawl_jobs
         WHERE player_key = ? AND status IN ('pending', 'running')
         ORDER BY created_at ASC, rowid ASC
         LIMIT 1`,
      )
      .get(key),
  )
}

export function getLatestFailedJob(db: Db, key?: string): JobSummary | null {
  const row = key
    ? db
        .prepare(
          `SELECT * FROM crawl_jobs
           WHERE player_key = ? AND status = 'failed'
           ORDER BY COALESCE(finished_at, updated_at) DESC, rowid DESC
           LIMIT 1`,
        )
        .get(key)
    : db
        .prepare(
          `SELECT * FROM crawl_jobs
           WHERE status = 'failed'
           ORDER BY COALESCE(finished_at, updated_at) DESC, rowid DESC
           LIMIT 1`,
        )
        .get()
  return summaryOrNull(row)
}

export function recentJobs(db: Db, limit = 5): JobSummary[] {
  const rows = db
    .prepare(
      `SELECT * FROM crawl_jobs
       ORDER BY COALESCE(updated_at, created_at) DESC, rowid DESC
       LIMIT ?`,
    )
    .all(Math.max(1, limit)) as CrawlJobRow[]
  return rows.map(toJobSummary)
}

export function createJob(db: Db, shard: Shard, name: string): JobSummary {
  const trimmed = name.trim()
  const key = playerKey(shard, trimmed)
  const existing = getActiveJob(db, key)
  if (existing) return existing

  const now = new Date().toISOString()
  try {
    db.prepare(
      `INSERT INTO crawl_jobs
         (id, player_key, shard, player_name, kind, status, phase, progress,
          attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'player_sync', 'pending', 'queued', 0, 0, ?, ?)`,
    ).run(randomUUID(), key, shard, trimmed, now, now)
  } catch (error) {
    // The partial unique index makes concurrent enqueueing race-safe.
    const raced = getActiveJob(db, key)
    if (raced) return raced
    throw error
  }

  const created = getActiveJob(db, key)
  if (!created) throw new Error('Failed to create crawl job')
  return created
}

/** Enqueue a stats-only fetch for one historical/current season. */
export function createSeasonJob(
  db: Db,
  shard: Shard,
  name: string,
  seasonId: string,
): JobSummary {
  const trimmed = name.trim()
  const key = seasonPlayerKey(shard, trimmed, seasonId)
  const existing = getActiveJob(db, key)
  if (existing) return existing

  const player = db
    .prepare('SELECT id FROM players WHERE shard = ? AND name_folded = ?')
    .get(shard, trimmed.toLowerCase()) as { id: string } | undefined
  const now = new Date().toISOString()

  try {
    db.prepare(
      `INSERT INTO crawl_jobs
         (id, player_key, shard, player_name, player_id, season_id, kind, status,
          phase, progress, attempts, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'season_sync', 'pending', 'queued', 0, 0, 10, ?, ?)`,
    ).run(
      randomUUID(),
      key,
      shard,
      trimmed,
      player?.id ?? null,
      seasonId,
      now,
      now,
    )
  } catch (error) {
    const raced = getActiveJob(db, key)
    if (raced) return raced
    throw error
  }

  const created = getActiveJob(db, key)
  if (!created) throw new Error('Failed to create season crawl job')
  return created
}

/** Create the next low-priority season discovery batch. */
export function createSeasonScanJob(
  db: Db,
  shard: Shard,
  name: string,
  playerId: string | null,
  runAfter: string | null = null,
): JobSummary {
  const trimmed = name.trim()
  const key = seasonScanKey(shard, trimmed)
  const existing = getActiveJob(db, key)
  if (existing) return existing

  const now = new Date().toISOString()
  try {
    db.prepare(
      `INSERT INTO crawl_jobs
         (id, player_key, shard, player_name, player_id, kind, status, phase, progress,
          attempts, priority, run_after, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'season_scan', 'pending', 'queued', 0, 0, 20, ?, ?, ?)`,
    ).run(randomUUID(), key, shard, trimmed, playerId, runAfter, now, now)
  } catch (error) {
    const raced = getActiveJob(db, key)
    if (raced) return raced
    throw error
  }

  const created = getActiveJob(db, key)
  if (!created) throw new Error('Failed to create season scan job')
  return created
}

function claimWhere(db: Db, where: string, params: unknown[]): JobSummary | null {
  const now = new Date().toISOString()
  return summaryOrNull(
    db
      .prepare(
        `UPDATE crawl_jobs
         SET status = 'running',
             started_at = COALESCE(started_at, ?),
             finished_at = NULL,
             updated_at = ?,
             attempts = attempts + 1
         WHERE id = (
           SELECT id FROM crawl_jobs
           WHERE ${where}
           ORDER BY priority ASC, created_at ASC, rowid ASC
           LIMIT 1
         )
         RETURNING *`,
      )
      .get(now, now, ...params),
  )
}

/** Atomically claim the oldest pending job, honoring run_after and priority. */
export function claimNextJob(db: Db): JobSummary | null {
  const now = new Date().toISOString()
  return claimWhere(
    db,
    "status = 'pending' AND (run_after IS NULL OR run_after <= ?)",
    [now],
  )
}

/** Atomically claim a specific pending job (used by the CLI). */
export function claimJob(db: Db, id: string): JobSummary | null {
  return claimWhere(db, "status = 'pending' AND id = ?", [id])
}

export function updateJob(db: Db, id: string, patch: JobPatch): JobSummary | null {
  const entries = Object.entries(patch).filter(
    ([key, value]) => key in PATCH_COLUMNS && value !== undefined,
  ) as Array<[keyof JobPatch, unknown]>

  const sets: string[] = []
  const params: unknown[] = []
  for (const [key, value] of entries) {
    sets.push(`${PATCH_COLUMNS[key]} = ?`)
    params.push(value)
  }
  if (!sets.some((set) => set.startsWith('updated_at ='))) {
    sets.push('updated_at = ?')
    params.push(new Date().toISOString())
  }

  if (sets.length === 0) return getJob(db, id)

  db.prepare(`UPDATE crawl_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...params, id)
  return getJob(db, id)
}

export interface RequeueResult {
  requeued: number
  failed: number
}

/**
 * Any `running` jobs were interrupted by a restart. Retry them while they have
 * attempts left; otherwise surface them as failed so the UI does not spin.
 */
export function requeueInterruptedJobs(db: Db, maxAttempts = 3): RequeueResult {
  const now = new Date().toISOString()
  const rows = db
    .prepare("SELECT id, attempts FROM crawl_jobs WHERE status = 'running'")
    .all() as Array<{ id: string; attempts: number }>

  const requeue = db.prepare(
    `UPDATE crawl_jobs
     SET status = 'pending',
         phase = 'queued',
         message = 'Requeued after crawler restart',
         started_at = NULL,
         finished_at = NULL,
         updated_at = ?
     WHERE id = ?`,
  )
  const fail = db.prepare(
    `UPDATE crawl_jobs
     SET status = 'failed',
         phase = 'failed',
         message = 'Crawler restarted too many times',
         error = 'Crawler restarted too many times',
         error_code = 'interrupted',
         finished_at = ?,
         updated_at = ?
     WHERE id = ?`,
  )

  let requeued = 0
  let failed = 0
  const apply = db.transaction(() => {
    for (const row of rows) {
      if (row.attempts < maxAttempts) {
        requeue.run(now, row.id)
        requeued += 1
      } else {
        fail.run(now, now, row.id)
        failed += 1
      }
    }
  })
  apply()
  return { requeued, failed }
}

export function writeHeartbeat(db: Db, at = new Date()): string {
  const value = at.toISOString()
  db.prepare(
    `INSERT INTO sync_state (key, value, updated_at)
     VALUES ('crawler_heartbeat', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(value, value)
  return value
}

export function getHeartbeat(db: Db): string | null {
  const row = db
    .prepare("SELECT value FROM sync_state WHERE key = 'crawler_heartbeat'")
    .get() as { value: string } | undefined
  return row?.value ?? null
}

export function clearHeartbeat(db: Db): void {
  db.prepare("DELETE FROM sync_state WHERE key = 'crawler_heartbeat'").run()
}
