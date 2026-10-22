import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { migrate, openDb } from '../src/db'
import { syncSeason, syncSeasonScan } from '../src/ingest'
import { claimNextJob, createJob, createSeasonScanJob } from '../src/jobs'
import type { PubgApi } from '../src/pubg/client'
import type { PlayerSeasonResponse } from '../src/pubg/types'

const fixture = (name: string): string =>
  fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

const seasonStats = JSON.parse(fixture('season-stats.json')) as PlayerSeasonResponse
const playerId = 'account.46fd37b1d82a4607b43ebe7aa02841dc'
const shard = 'steam' as const
const currentSeason = 'division.bro.official.pc-2018-43'

function setup() {
  const db = openDb(':memory:')
  migrate(db)
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO players (id, shard, name, name_folded, ban_type, clan_id, is_tracked, created_at, updated_at)
     VALUES (?, ?, 'DarkNext3000', 'darknext3000', 'Innocent', NULL, 1, ?, ?)`,
  ).run(playerId, shard, now, now)

  for (let n = 43; n >= 32; n -= 1) {
    db.prepare(
      'INSERT INTO seasons (id, shard, is_current, fetched_at) VALUES (?, ?, ?, ?)',
    ).run(`division.bro.official.pc-2018-${n}`, shard, n === 43 ? 1 : 0, now)
  }
  return { db, now }
}

describe('syncSeasonScan', () => {
  it('fetches two unscanned seasons per batch and resumes from markers', async () => {
    const { db } = setup()
    const calls: string[] = []
    const client = {
      async getSeasonStats(_shard: string, _playerId: string, seasonId: string) {
        calls.push(seasonId)
        return seasonStats.data
      },
    } as unknown as PubgApi

    await syncSeason(
      db,
      client,
      {
        id: 'seed-current',
        shard,
        player_name: 'DarkNext3000',
        player_id: playerId,
        season_id: currentSeason,
      },
    )

    const first = await syncSeasonScan(
      db,
      client,
      { id: 'scan-1', shard, player_name: 'DarkNext3000', player_id: playerId },
      { limit: 10, batchSize: 2, now: () => new Date() },
    )

    expect(first).toMatchObject({ total: 10, scanned: 3, played: 3, more: true })
    expect(calls).toHaveLength(3)
    expect(calls.slice(1)).toEqual([
      'division.bro.official.pc-2018-42',
      'division.bro.official.pc-2018-41',
    ])
    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM matches').get() as { count: number }).count,
    ).toBe(0)

    const second = await syncSeasonScan(
      db,
      client,
      { id: 'scan-2', shard, player_name: 'DarkNext3000', player_id: playerId },
      { limit: 10, batchSize: 2, now: () => new Date() },
    )
    expect(second).toMatchObject({ total: 10, scanned: 5, played: 5, more: true })
    expect(calls).toHaveLength(5)
    db.close()
  })
})

describe('scan queue priority', () => {
  it('defers a background scan behind profile jobs and honors run_after', () => {
    const { db } = setup()
    const profile = createJob(db, shard, 'DarkNext3000')
    const future = new Date(Date.now() + 60_000).toISOString()
    const scan = createSeasonScanJob(db, shard, 'DarkNext3000', playerId, future)
    expect(scan.priority).toBe(20)
    expect(profile.priority).toBe(0)

    const first = claimNextJob(db)
    expect(first?.id).toBe(profile.id)

    // The scan is not eligible yet.
    expect(claimNextJob(db)).toBeNull()

    db.prepare('UPDATE crawl_jobs SET run_after = ? WHERE id = ?').run(
      new Date(Date.now() - 1_000).toISOString(),
      scan.id,
    )
    const second = claimNextJob(db)
    expect(second?.id).toBe(scan.id)
    expect(second?.kind).toBe('season_scan')
    db.close()
  })
})
