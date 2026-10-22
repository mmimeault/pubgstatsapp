import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate, openDb, type Db } from '../../crawler/src/db'
import {
  buildSeasonOptions,
  buildSeasonScan,
  buildSeasonStats,
  getSeasonFetch,
} from '../src/profile'

const tempDirs: string[] = []

function testDb(): Db {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pubgstats-seasons-'))
  tempDirs.push(dir)
  const db = openDb(path.join(dir, 'test.db'))
  migrate(db)
  return db
}

const currentSeason = 'division.bro.official.pc-2018-43'
const previousSeason = 'division.bro.official.pc-2018-42'
const emptySeason = 'division.bro.official.pc-2018-41'
const playerId = 'account.test'

function seed(db: Db) {
  const now = new Date('2026-10-21T12:00:00.000Z').toISOString()
  db.prepare(
    `INSERT INTO players (id, shard, name, name_folded, created_at, updated_at, last_synced_at)
     VALUES (?, 'steam', 'TestPlayer', 'testplayer', ?, ?, ?)`,
  ).run(playerId, now, now, now)

  const insertSeason = db.prepare(
    'INSERT INTO seasons (id, shard, is_current, fetched_at) VALUES (?, ?, ?, ?)',
  )
  insertSeason.run(currentSeason, 'steam', 1, now)
  insertSeason.run(previousSeason, 'steam', 0, now)
  insertSeason.run(emptySeason, 'steam', 0, now)

  const insertStats = db.prepare(
    `INSERT INTO player_season_stats
       (player_id, season_id, shard, mode, rounds_played, wins, top10s, kills, assists,
        damage_dealt, headshot_kills, time_survived, longest_kill, best_rank_point,
        raw_json, fetched_at)
     VALUES (?, ?, 'steam', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
  )
  insertStats.run(playerId, currentSeason, 'duo-fpp', 20, 2, 8, 40, 5, 3000, 6, 20_000, 200, now)
  insertStats.run(playerId, previousSeason, 'duo-fpp', 10, 1, 3, 15, 2, 1200, 2, 9000, 150, now)
  insertStats.run(playerId, previousSeason, 'squad', 5, 0, 1, 4, 1, 400, 1, 3000, 80, now)

  const insertFetch = db.prepare(
    `INSERT INTO player_season_fetches (player_id, season_id, shard, fetched_at, status, last_error)
     VALUES (?, ?, 'steam', ?, ?, NULL)`,
  )
  insertFetch.run(playerId, currentSeason, now, 'ok')
  insertFetch.run(playerId, previousSeason, now, 'ok')
  insertFetch.run(playerId, emptySeason, now, 'empty')
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('season profiles', () => {
  it('lists seasons current-first with cached rounds and fetched state', () => {
    const db = testDb()
    seed(db)
    const player = db.prepare('SELECT * FROM players').get() as never

    const options = buildSeasonOptions(db, player)
    expect(options.map((option) => option.id)).toEqual([
      currentSeason,
      previousSeason,
      emptySeason,
    ])
    expect(options[0]).toMatchObject({ isCurrent: true, fetched: true, rounds: 20 })
    expect(options[1]).toMatchObject({ isCurrent: false, fetched: true, rounds: 15 })
    expect(options[2]).toMatchObject({ isCurrent: false, fetched: true, rounds: 0 })
    expect(getSeasonFetch(db, playerId, previousSeason)?.status).toBe('ok')

    const scan = buildSeasonScan(db, player)
    expect(scan).toMatchObject({
      status: 'done',
      scanned: 3,
      total: 3,
      played: 2,
      nextBatchAt: null,
    })
    db.close()
  })

  it('builds stats for a historical season and handles an empty one', () => {
    const db = testDb()
    seed(db)
    const player = db.prepare('SELECT * FROM players').get() as never

    const previous = buildSeasonStats(db, player, previousSeason)
    expect(previous?.season).toMatchObject({ id: previousSeason, label: 'Season 42', isCurrent: false })
    expect(previous?.hasGames).toBe(true)
    expect(previous?.modes).toHaveLength(2)
    expect(previous?.totals.rounds).toBe(15)
    expect(previous?.defaultMode).toBe('duo-fpp')

    const empty = buildSeasonStats(db, player, emptySeason)
    expect(empty?.hasGames).toBe(false)
    expect(empty?.modes).toHaveLength(0)
    expect(empty?.totals.rounds).toBe(0)
    db.close()
  })
})
