import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { migrate, openDb } from '../src/db'
import {
  backfillParticipantTeams,
  storeMatch,
  syncPlayer,
  type ProgressUpdate,
  type SyncJob,
} from '../src/ingest'
import type { PubgApi } from '../src/pubg/client'
import type {
  MatchResponse,
  PlayerResource,
  PlayerSearchResponse,
  PlayerSeasonResponse,
  SeasonsResponse,
} from '../src/pubg/types'

const fixture = (name: string): string =>
  fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

const playerSearch = JSON.parse(fixture('player-search.json')) as PlayerSearchResponse
const seasons = JSON.parse(fixture('seasons.json')) as SeasonsResponse
const seasonStats = JSON.parse(fixture('season-stats.json')) as PlayerSeasonResponse
const match = JSON.parse(fixture('match.json')) as MatchResponse

const player = playerSearch.data[0]

interface FakeClient extends PubgApi {
  matchFetches: string[]
  playerByNameCalls: number
  playerByIdCalls: number
  seasonsCalls: number
  seasonStatsCalls: number
}

function makeFakeClient(): FakeClient {
  const fake: FakeClient = {
    matchFetches: [],
    playerByNameCalls: 0,
    playerByIdCalls: 0,
    seasonsCalls: 0,
    seasonStatsCalls: 0,
    async getPlayerByName(): Promise<PlayerResource> {
      fake.playerByNameCalls += 1
      return player
    },
    async getPlayerById(_shard, id): Promise<PlayerResource> {
      fake.playerByIdCalls += 1
      expect(id).toBe(player.id)
      return player
    },
    async getSeasons(): Promise<SeasonsResponse['data']> {
      fake.seasonsCalls += 1
      return seasons.data
    },
    async getSeasonStats(): Promise<PlayerSeasonResponse['data']> {
      fake.seasonStatsCalls += 1
      return seasonStats.data
    },
    async getMatch(_shard, matchId): Promise<MatchResponse> {
      fake.matchFetches.push(matchId)
      const cloned = structuredClone(match)
      cloned.data.id = matchId
      return cloned
    },
  }
  return fake
}

function setup() {
  const db = openDb(':memory:')
  migrate(db)
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO crawl_jobs
       (id, player_key, shard, player_name, kind, status, phase, progress,
        attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'player_sync', 'running', 'queued', 0, 1, ?, ?)`,
  ).run('job-1', 'steam:darknext3000', 'steam', 'DarkNext3000', now, now)

  const job: SyncJob = {
    id: 'job-1',
    shard: 'steam',
    player_name: 'DarkNext3000',
  }
  return { db, job }
}

const count = (db: ReturnType<typeof setup>['db'], table: string): number => {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number
  }
  return row.count
}

describe('syncPlayer', () => {
  it('fetches full-season stats while limiting match details', async () => {
    const { db, job } = setup()
    const client = makeFakeClient()
    const progress: ProgressUpdate[] = []
    let telemetryFetches = 0
    const fetchImpl = (async () => {
      telemetryFetches += 1
      return new Response('[]', { status: 200 })
    }) as typeof fetch

    const first = await syncPlayer(db, client, job, {
      matchLimit: 5,
      matchConcurrency: 2,
      telemetryConcurrency: 2,
      fetchImpl,
      onProgress: (update) => {
        progress.push(update)
      },
    })

    expect(first.seasonId).toBe('division.bro.official.pc-2018-43')
    expect(first.matchesRequested).toBe(5)
    expect(first.matchesFetched).toBe(5)
    expect(first.matchesCached).toBe(0)
    expect(first.statsModes).toBe(6)
    // Only 5 match details are fetched, but the season endpoint still reports
    // all 79 duo-fpp games for the current season.
    expect(first.telemetryProcessed).toBe(5)
    expect(first.telemetryFailed).toBe(0)
    expect(first.killEvents).toBe(0)
    expect(telemetryFetches).toBe(5)
    expect(progress.some((update) => update.phase === 'telemetry')).toBe(true)
    expect(client.playerByNameCalls).toBe(1)
    expect(client.playerByIdCalls).toBe(0)
    expect(client.seasonsCalls).toBe(1)
    expect(client.seasonStatsCalls).toBe(1)
    expect(client.matchFetches).toHaveLength(5)

    expect(count(db, 'players')).toBe(1)
    expect(count(db, 'seasons')).toBe(seasons.data.length)
    expect(count(db, 'player_season_stats')).toBe(6)
    expect(count(db, 'matches')).toBe(5)
    expect(count(db, 'match_participants')).toBe(95 * 5)

    const storedPlayer = db
      .prepare('SELECT * FROM players WHERE id = ?')
      .get(player.id) as {
      name: string
      name_folded: string
      ban_type: string | null
      clan_id: string | null
      last_synced_at: string | null
    }
    expect(storedPlayer.name).toBe('DarkNext3000')
    expect(storedPlayer.name_folded).toBe('darknext3000')
    expect(storedPlayer.ban_type).toBe('Innocent')
    expect(storedPlayer.clan_id).toBeNull()
    expect(storedPlayer.last_synced_at).not.toBeNull()

    const duoFpp = db
      .prepare(
        `SELECT rounds_played, wins, kills, damage_dealt, best_rank_point
         FROM player_season_stats WHERE player_id = ? AND season_id = ? AND mode = ?`,
      )
      .get(player.id, first.seasonId, 'duo-fpp') as {
      rounds_played: number
      wins: number
      kills: number
      damage_dealt: number
      best_rank_point: number | null
    }
    expect(duoFpp.rounds_played).toBe(79)
    expect(duoFpp.wins).toBe(11)
    expect(duoFpp.kills).toBe(187)
    expect(duoFpp.damage_dealt).toBeCloseTo(22934.596)
    expect(duoFpp.best_rank_point).toBeNull()

    const jobRow = db.prepare('SELECT player_id FROM crawl_jobs WHERE id = ?').get('job-1') as {
      player_id: string | null
    }
    expect(jobRow.player_id).toBe(player.id)

    expect(progress.at(-1)).toMatchObject({ phase: 'done', progress: 100 })

    // A second run must reuse everything and not fetch any match payloads.
    client.matchFetches = []
    const second = await syncPlayer(db, client, job, {
      matchLimit: 5,
      matchConcurrency: 2,
      fetchImpl,
    })

    expect(second.matchesRequested).toBe(5)
    expect(second.matchesFetched).toBe(0)
    expect(second.matchesCached).toBe(5)
    expect(second.telemetryProcessed).toBe(0)
    expect(telemetryFetches).toBe(5)
    expect(client.matchFetches).toHaveLength(0)
    expect(client.playerByNameCalls).toBe(1)
    expect(client.playerByIdCalls).toBe(1)
    expect(client.seasonsCalls).toBe(1)
    expect(client.seasonStatsCalls).toBe(2)

    expect(count(db, 'players')).toBe(1)
    expect(count(db, 'seasons')).toBe(seasons.data.length)
    expect(count(db, 'player_season_stats')).toBe(6)
    expect(count(db, 'matches')).toBe(5)
    expect(count(db, 'match_participants')).toBe(95 * 5)

    db.close()
  })

  it('skips bots/participants without a playerId', () => {
    const { db } = setup()
    const cloned = structuredClone(match)
    cloned.data.id = 'match-with-bot'
    const participants = cloned.included?.filter((item) => item.type === 'participant') ?? []
    expect(participants.length).toBe(95)
    const bot = participants[0] as {
      attributes?: { stats?: { playerId?: string; name?: string } }
    }
    bot.attributes = bot.attributes ?? {}
    bot.attributes.stats = { ...(bot.attributes.stats ?? {}), playerId: '', name: 'bot' }

    const stored = storeMatch(db, cloned, 'steam')

    expect(stored).toBe(94)
    expect(count(db, 'matches')).toBe(1)
    expect(count(db, 'match_participants')).toBe(94)
    db.close()
  })

  it('maps roster teams and backfills team data from raw JSON', () => {
    const { db } = setup()
    const cloned = structuredClone(match)
    cloned.data.id = 'match-teams'
    storeMatch(db, cloned, 'steam')

    const rows = db
      .prepare('SELECT player_id, team_id, is_bot FROM match_participants WHERE match_id = ?')
      .all('match-teams') as Array<{ player_id: string; team_id: number | null; is_bot: number }>
    expect(rows.length).toBe(95)
    expect(rows.filter((row) => row.team_id !== null).length).toBeGreaterThanOrEqual(90)
    expect(rows.filter((row) => row.is_bot === 1).length).toBe(3)

    const me = rows.find((row) => row.player_id === player.id)
    expect(me?.team_id).not.toBeNull()
    const teammates = db
      .prepare(
        `SELECT p.player_id FROM match_participants p
         WHERE p.match_id = 'match-teams'
           AND p.team_id = (SELECT team_id FROM match_participants WHERE match_id = 'match-teams' AND player_id = ?)
           AND p.player_id <> ?`,
      )
      .all(player.id, player.id) as Array<{ player_id: string }>
    expect(teammates).toHaveLength(1)

    // Simulate rows stored before schema v3; the raw JSON is enough to repair them.
    db.prepare('UPDATE match_participants SET team_id = NULL, is_bot = 0 WHERE match_id = ?').run(
      'match-teams',
    )
    expect(backfillParticipantTeams(db, ['match-teams'])).toBe(1)
    const repaired = db
      .prepare('SELECT team_id, is_bot FROM match_participants WHERE match_id = ?')
      .all('match-teams') as Array<{ team_id: number | null; is_bot: number }>
    expect(repaired.filter((row) => row.team_id !== null).length).toBeGreaterThanOrEqual(90)
    expect(repaired.filter((row) => row.is_bot === 1).length).toBe(3)
    db.close()
  })
})
