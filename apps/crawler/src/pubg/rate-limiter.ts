import type Database from 'better-sqlite3'
import { sleep } from '../logger'

export interface RateLimiterOptions {
  rpm: number
  windowMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onWait?: (waitMs: number) => void
}

export interface RateLimitSnapshot {
  remaining: number | null
  resetAt: number | null
}

/**
 * Rolling-window limiter persisted in SQLite. The ledger survives restarts, so a
 * crash can never cause a burst against the PUBG API.
 */
export class RateLimiter {
  private readonly rpm: number
  private readonly windowMs: number
  private readonly now: () => number
  private readonly sleepFn: (ms: number) => Promise<void>
  private readonly onWait?: (waitMs: number) => void

  constructor(
    private readonly db: Database.Database,
    options: RateLimiterOptions,
  ) {
    this.rpm = options.rpm
    this.windowMs = options.windowMs ?? 60_000
    this.now = options.now ?? Date.now
    this.sleepFn = options.sleep ?? sleep
    this.onWait = options.onWait
  }

  /** Reserve one request slot, waiting if the window is full. Returns the call row id. */
  async acquire(endpoint: string): Promise<number> {
    for (;;) {
      const now = this.now()
      const windowStart = now - this.windowMs
      const rows = this.db
        .prepare('SELECT id, called_at FROM api_calls WHERE called_at > ? ORDER BY called_at ASC')
        .all(windowStart) as Array<{ id: number; called_at: number }>

      if (rows.length < this.rpm) {
        const result = this.db
          .prepare('INSERT INTO api_calls (endpoint, called_at) VALUES (?, ?)')
          .run(endpoint, now)
        return Number(result.lastInsertRowid)
      }

      const waitMs = rows[0].called_at + this.windowMs - now + 50
      this.onWait?.(waitMs)
      await this.sleepFn(waitMs)
    }
  }

  recordResponse(callId: number, snapshot: RateLimitSnapshot): void {
    this.db
      .prepare('UPDATE api_calls SET status = ?, remaining = ?, reset_at = ? WHERE id = ?')
      .run(null, snapshot.remaining ?? null, snapshot.resetAt ?? null, callId)
  }

  recordStatus(callId: number, status: number, snapshot: RateLimitSnapshot): void {
    this.db
      .prepare('UPDATE api_calls SET status = ?, remaining = ?, reset_at = ? WHERE id = ?')
      .run(status, snapshot.remaining ?? null, snapshot.resetAt ?? null, callId)
  }

  /** Number of requests made in the current window (used by tests/status). */
  usedInWindow(): number {
    const now = this.now()
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM api_calls WHERE called_at > ?')
      .get(now - this.windowMs) as { count: number }
    return row.count
  }
}

export function parseRateHeaders(headers: Headers): RateLimitSnapshot {
  const remainingHeader = headers.get('x-ratelimit-remaining')
  const resetHeader = headers.get('x-ratelimit-reset')
  const remaining = remainingHeader !== null ? Number(remainingHeader) : null
  const resetAt = resetHeader !== null ? Number(resetHeader) : null
  return {
    remaining: Number.isFinite(remaining) ? remaining : null,
    resetAt: Number.isFinite(resetAt) ? resetAt : null,
  }
}
