import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { migrate, openDb } from '../src/db'
import { syncSeason } from '../src/ingest'
import type { PubgApi } from '../src/pubg/client'
import type { PlayerSeasonResponse } from '../src/pubg/types'

const fixture = (name: string): string =>
  fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

const seasonStats = JSON.parse(fixture('season-stats.json')) as PlayerSeasonResponse
const playerId = 'account.46fd37b1d82a4607b43ebe7aa02841dc'
const seasonId = 'division.bro.official.pc-2018-42'

function setup() {
  const db = openDb(':memory:')
  migrate(db)
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO players (id, shard, name, name_folded, ban_type, clan_id, is_tracked, created_at, updated_at)
     VALUES (?, 'steam', 'DarkNext3000', 'darknext3000', 'Innocent', NULL, 1, ?, ?)`,
  ).run(playerId, now, now)
  db.prepare(
    `INSERT INTO crawl_jobs
       (id, player_key, shard, player_name, player_id, season_id, kind, status, phase,
        progress, attempts, created_at, updated_at)
     VALUES ('job-season', ?, 'steam', 'DarkNext3000', ?, ?, 'season_sync', 'running',
             'queued', 0, 1, ?, ?)`,
  ).run(`steam:darknext3000:${seasonId}`, playerId, seasonId, now, now)

  return {
    db,
    job: {
      id: 'job-season',
      shard: 'steam' as const,
      player_name: 'DarkNext3000',
      player_id: playerId,
      season_id: seasonId,
    },
  }
}

describe('syncSeason', () => {
  it('fetches one season aggregate without matches and is idempotent', async () => {
    const { db, job } = setup()
    let calls = 0
    const client = {
      async getSeasonStats() {
        calls += 1
        return seasonStats.data
      },
    } as unknown as PubgApi

    const first = await syncSeason(db, client, job)
    expect(first).toMatchObject({ playerId, seasonId, status: 'ok' })
    expect(calls).toBe(1)
    expect(
      (
        db
          .prepare(
            'SELECT COUNT(*) AS count FROM player_season_stats WHERE player_id = ? AND season_id = ?',
          )
          .get(playerId, seasonId) as { count: number }
      ).count,
    ).toBe(6)
    const marker = db
      .prepare(
        'SELECT status FROM player_season_fetches WHERE player_id = ? AND season_id = ?',
      )
      .get(playerId, seasonId) as { status: string }
    expect(marker.status).toBe('ok')
    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM matches').get() as { count: number }).count,
    ).toBe(0)

    await syncSeason(db, client, job)
    expect(calls).toBe(2)
    expect(
      (
        db
          .prepare(
            'SELECT COUNT(*) AS count FROM player_season_stats WHERE player_id = ? AND season_id = ?',
          )
          .get(playerId, seasonId) as { count: number }
      ).count,
    ).toBe(6)
    db.close()
  })

  it('records a fetch error when PUBG fails', async () => {
    const { db, job } = setup()
    const client = {
      async getSeasonStats() {
        throw new Error('PUBG unavailable')
      },
    } as unknown as PubgApi

    await expect(syncSeason(db, client, job)).rejects.toThrow('PUBG unavailable')
    const marker = db
      .prepare(
        'SELECT status, last_error FROM player_season_fetches WHERE player_id = ? AND season_id = ?',
      )
      .get(playerId, seasonId) as { status: string; last_error: string }
    expect(marker.status).toBe('error')
    expect(marker.last_error).toContain('PUBG unavailable')
    db.close()
  })
})
