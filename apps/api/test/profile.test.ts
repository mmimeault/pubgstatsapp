import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate, openDb, type Db } from '../../crawler/src/db'
import { buildProfile } from '../src/profile'
import { createJob, getActiveJob } from '../src/jobs'

const tempDirs: string[] = []

function testDb(): Db {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pubgstats-api-'))
  tempDirs.push(dir)
  const db = openDb(path.join(dir, 'test.db'))
  migrate(db)
  return db
}

function seed(db: Db) {
  const now = new Date('2026-10-19T12:00:00.000Z').toISOString()
  db.prepare(
    `INSERT INTO players (id, shard, name, name_folded, ban_type, clan_id, is_tracked, created_at, updated_at, last_synced_at)
     VALUES (?, 'steam', 'TestPlayer', 'testplayer', 'Innocent', NULL, 1, ?, ?, ?)`,
  ).run('account.test', now, now, now)
  db.prepare(
    `INSERT INTO seasons (id, shard, is_current, fetched_at)
     VALUES ('division.bro.official.pc-2018-43', 'steam', 1, ?)`,
  ).run(now)

  const insertStats = db.prepare(
    `INSERT INTO player_season_stats
      (player_id, season_id, shard, mode, rounds_played, wins, top10s, kills, assists,
       damage_dealt, headshot_kills, time_survived, longest_kill, best_rank_point, raw_json, fetched_at)
     VALUES ('account.test', 'division.bro.official.pc-2018-43', 'steam', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
  )
  insertStats.run('duo-fpp', 10, 2, 5, 20, 3, 2000, 8, 10_000, 150, now)
  insertStats.run('squad-fpp', 5, 0, 1, 5, 1, 400, 1, 3_000, 90, now)

  const insertMatch = db.prepare(
    `INSERT INTO matches (id, shard, map_name, game_mode, match_type, duration, created_at, season_state, raw_json, fetched_at)
     VALUES (?, 'steam', ?, 'duo-fpp', 'official', 1500, ?, 'progress', NULL, ?)`,
  )
  insertMatch.run('11111111-1111-1111-1111-111111111111', 'Baltic_Main', '2026-10-19T10:00:00.000Z', now)
  insertMatch.run('22222222-2222-2222-2222-222222222222', 'Desert_Main', '2026-10-18T10:00:00.000Z', now)
  db.prepare(
    `UPDATE matches SET telemetry_fetched_at = ?, telemetry_url = 'https://example.test/t.json'
     WHERE id = '11111111-1111-1111-1111-111111111111'`,
  ).run(now)

  const insertKill = db.prepare(
    `INSERT INTO match_kills
       (match_id, event_time, killer_id, killer_name, killer_is_bot, victim_id, victim_name,
        victim_is_bot, weapon, damage_reason, distance, finisher_name, is_suicide, is_teamkill)
     VALUES ('11111111-1111-1111-1111-111111111111', ?, 'account.test', 'TestPlayer', 0, ?, ?, ?, ?, 'TorsoShot', ?, NULL, 0, 0)`,
  )
  insertKill.run('2026-10-19T10:05:00.000Z', 'ai.1', 'BotOne', 1, 'WeapM24_C', 63.5)
  insertKill.run('2026-10-19T10:10:00.000Z', 'account.human', 'HumanVictim', 0, 'WeapHK416_C', 12.4)
  db.prepare(
    `INSERT INTO match_kills
       (match_id, event_time, killer_id, killer_name, killer_is_bot, victim_id, victim_name,
        victim_is_bot, weapon, damage_reason, distance, finisher_name, is_suicide, is_teamkill)
     VALUES ('11111111-1111-1111-1111-111111111111', ?, 'ai.2', 'BotKiller', 1,
             'account.test', 'TestPlayer', 0, 'WeapUMP_C', 'TorsoShot', 8.0, NULL, 0, 0)`,
  ).run('2026-10-19T10:20:00.000Z')

  const insertParticipant = db.prepare(
    `INSERT INTO match_participants
       (match_id, player_id, shard, name, placement, kills, headshots, assists, dbno, damage,
        time_survived, walk_distance, ride_distance, death_type, team_id, is_bot)
     VALUES (?, ?, 'steam', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  insertParticipant.run('11111111-1111-1111-1111-111111111111', 'account.test', 'TestPlayer', 1, 6, 2, 2, 1, 700, 1400, 2000, 400, 'alive', 7, 0)
  insertParticipant.run('11111111-1111-1111-1111-111111111111', 'account.mate', 'Mate', 1, 2, 1, 1, 0, 300, 1200, 1800, 300, 'alive', 7, 0)
  insertParticipant.run('11111111-1111-1111-1111-111111111111', 'ai.2', 'BotKiller', 3, 4, 1, 0, 2, 500, 1300, 1500, 500, 'alive', 9, 1)
  insertParticipant.run('22222222-2222-2222-2222-222222222222', 'account.test', 'TestPlayer', 12, 2, 0, 0, 0, 200, 800, 1200, 100, 'byplayer', 7, 0)
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('buildProfile', () => {
  it('returns current-season modes, totals and recent matches', () => {
    const db = testDb()
    seed(db)

    const profile = buildProfile(db, db.prepare('SELECT * FROM players').get() as never)

    expect(profile.player.name).toBe('TestPlayer')
    expect(profile.season?.label).toBe('Season 43')
    expect(profile.modes).toHaveLength(2)
    expect(profile.defaultMode).toBe('duo-fpp')
    // Season totals cover all games, not the 2 match details seeded below.
    expect(profile.totals.rounds).toBe(15)
    expect(profile.totals.kills).toBe(25)
    expect(profile.totals.kd).toBe(1.92)
    expect(profile.recentMatches).toHaveLength(2)
    expect(profile.recentMatchesTotal).toBe(2)
    expect(profile.recentMatches[0].mapLabel).toBe('Erangel')
    expect(profile.recentMatches[0].win).toBe(true)
    expect(profile.recentMatches[0].killDataFetched).toBe(true)
    expect(profile.recentMatches[0].killEvents).toHaveLength(2)
    expect(profile.recentMatches[0].killEvents[0]).toMatchObject({
      victimName: 'BotOne',
      victimIsBot: true,
      weaponLabel: 'M24',
      distance: 63.5,
    })
    expect(profile.recentMatches[0].teammates).toEqual([
      { id: 'account.mate', name: 'Mate', isBot: false },
    ])
    expect(profile.recentMatches[0].death).toMatchObject({
      killerName: 'BotKiller',
      killerIsBot: true,
      weaponLabel: 'UMP45',
      distance: 8,
    })
    expect(profile.recentMatches[1].killDataFetched).toBe(false)
    expect(profile.recentMatches[1].killEvents).toHaveLength(0)
    expect(profile.recentMatches[1].teammates).toHaveLength(0)
    expect(profile.recentMatches[1].death).toBeNull()
    expect(profile.recentSummary.wins).toBe(1)
    expect(profile.recentSummary.kills).toBe(8)
    expect(profile.recentSummary.kd).toBe(8)
    expect(profile.recentSummary.botKills).toBe(1)
    expect(profile.recentSummary.humanKills).toBe(7)
    expect(profile.recentSummary.kdNoBots).toBe(7)
    // No crawler heartbeat in the test DB.
    expect(profile.crawl.crawlerOnline).toBe(false)
  })

  it('works when a player has no season stats yet', () => {
    const db = testDb()
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO players (id, shard, name, name_folded, created_at, updated_at)
       VALUES ('account.empty', 'steam', 'Empty', 'empty', ?, ?)`,
    ).run(now, now)

    const profile = buildProfile(db, db.prepare('SELECT * FROM players').get() as never)
    expect(profile.season).toBeNull()
    expect(profile.modes).toHaveLength(0)
    expect(profile.totals.rounds).toBe(0)
    expect(profile.recentMatches).toHaveLength(0)
    expect(profile.recentMatchesTotal).toBe(0)
  })
})

describe('crawl jobs', () => {
  it('deduplicates active jobs per player key', () => {
    const db = testDb()
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO players (id, shard, name, name_folded, created_at, updated_at)
       VALUES ('account.test', 'steam', 'TestPlayer', 'testplayer', ?, ?)`,
    ).run(now, now)

    const first = createJob(db, 'steam', 'TestPlayer')
    const second = createJob(db, 'steam', 'testplayer')
    expect(second.created).toBe(false)
    expect(second.job.id).toBe(first.job.id)
    expect(getActiveJob(db, 'steam:testplayer')?.id).toBe(first.job.id)
    expect(second.job.player_id).toBe('account.test')

    db.prepare("UPDATE crawl_jobs SET status = 'done' WHERE id = ?").run(first.job.id)
    const third = createJob(db, 'steam', 'TestPlayer')
    expect(third.created).toBe(true)
    expect(third.job.id).not.toBe(first.job.id)
  })
})
