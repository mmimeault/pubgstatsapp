import type { CrawlPhase, Shard } from '@pubgstats/shared'
import { isModernSeason, seasonNumber } from '@pubgstats/shared'
import type { Db } from './db'
import { updateJob } from './jobs'
import type { PubgApi } from './pubg/client'
import { PubgApiError } from './pubg/client'
import type {
  GameModeStat,
  MatchResponse,
  ParticipantStats,
  PlayerResource,
  PlayerSeasonResource,
  SeasonResource,
} from './pubg/types'
import { isParticipant, isRoster } from './pubg/types'
import { ensureTelemetryForMatches, extractTelemetryUrl, type TelemetryLogger } from './telemetry'

export interface ProgressUpdate {
  phase: CrawlPhase
  progress: number
  message?: string | null
}

export interface SyncJob {
  id: string
  shard: Shard
  player_name: string
  player_id?: string | null
  season_id?: string | null
}

export interface SyncSeasonsOptions {
  force?: boolean
  cacheHours?: number
  now?: () => Date
}

export interface SyncSeasonOptions {
  now?: () => Date
  onProgress?: (update: ProgressUpdate) => void | Promise<void>
}

export interface SyncSeasonResult {
  playerId: string
  seasonId: string
  modes: number
  status: 'ok' | 'empty'
}

export interface SyncSeasonScanOptions {
  limit: number
  batchSize: number
  now?: () => Date
  onProgress?: (update: ProgressUpdate) => void | Promise<void>
}

export interface SyncSeasonScanResult {
  playerId: string
  scanned: number
  total: number
  played: number
  more: boolean
}

export interface SyncPlayerOptions {
  matchLimit?: number
  matchConcurrency?: number
  seasonCacheHours?: number
  now?: () => Date
  onProgress?: (update: ProgressUpdate) => void | Promise<void>
  skipTelemetry?: boolean
  telemetryConcurrency?: number
  telemetryTimeoutMs?: number
  fetchImpl?: typeof fetch
  logger?: TelemetryLogger
}

export interface SyncPlayerResult {
  playerId: string
  playerName: string
  seasonId: string | null
  matchesRequested: number
  matchesFetched: number
  matchesCached: number
  participantsStored: number
  statsModes: number
  telemetryProcessed: number
  telemetryFailed: number
  killEvents: number
}

const DEFAULT_MATCH_LIMIT = 20
const DEFAULT_MATCH_CONCURRENCY = 5
const DEFAULT_SEASON_CACHE_HOURS = 24
const SQLITE_CHUNK = 200

function stamp(now: () => Date): string {
  return now().toISOString()
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function integerValue(value: unknown, fallback = 0): number {
  return Math.trunc(numberValue(value, fallback))
}

function integerOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed) : null
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

interface CachedSeasonRow {
  id: string
  is_current: number
  fetched_at: string
}

/**
 * Refresh the season list if the cache is stale, then return the current
 * season id for the shard.
 */
export async function syncSeasons(
  db: Db,
  client: PubgApi,
  shard: Shard,
  options: SyncSeasonsOptions = {},
): Promise<string | null> {
  const clock = options.now ?? (() => new Date())
  const cacheHours = options.cacheHours ?? DEFAULT_SEASON_CACHE_HOURS
  const cached = db
    .prepare('SELECT id, is_current, fetched_at FROM seasons WHERE shard = ?')
    .all(shard) as CachedSeasonRow[]

  const current = cached.find((row) => row.is_current === 1)
  const newest = cached.reduce((latest, row) => {
    const parsed = Date.parse(row.fetched_at)
    return Number.isFinite(parsed) && parsed > latest ? parsed : latest
  }, 0)

  if (!options.force && current && newest > 0) {
    const ageMs = clock().getTime() - newest
    if (ageMs < cacheHours * 60 * 60 * 1000) return current.id
  }

  const seasons = await client.getSeasons(shard)
  const fetchedAt = stamp(clock)
  const hasCurrent = seasons.some(
    (season: SeasonResource) => season.attributes?.isCurrentSeason === true,
  )
  const previousCurrentIds = cached
    .filter((row) => row.is_current === 1)
    .map((row) => row.id)

  const upsert = db.prepare(
    `INSERT INTO seasons (id, shard, is_current, fetched_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id, shard) DO UPDATE SET
       is_current = excluded.is_current,
       fetched_at = excluded.fetched_at`,
  )

  const apply = db.transaction(() => {
    for (const season of seasons) {
      if (typeof season.id !== 'string' || !season.id) continue
      const isCurrent = hasCurrent
        ? season.attributes?.isCurrentSeason === true
        : previousCurrentIds.includes(season.id)
      upsert.run(season.id, shard, isCurrent ? 1 : 0, fetchedAt)
    }
  })
  apply()

  if (hasCurrent) {
    return (
      seasons.find((season) => season.attributes?.isCurrentSeason === true)?.id ?? null
    )
  }
  return previousCurrentIds[0] ?? null
}

interface PlayerRow {
  id: string
}

function upsertPlayer(db: Db, shard: Shard, player: PlayerResource, typedName: string): {
  id: string
  name: string
} {
  const attributes = player.attributes ?? {}
  const name = textOrNull(attributes.name) ?? typedName.trim()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO players
       (id, shard, name, name_folded, ban_type, clan_id, is_tracked, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       shard = excluded.shard,
       name = excluded.name,
       name_folded = excluded.name_folded,
       ban_type = excluded.ban_type,
       clan_id = excluded.clan_id,
       updated_at = excluded.updated_at`,
  ).run(
    player.id,
    shard,
    name,
    name.trim().toLowerCase(),
    textOrNull(attributes.banType),
    textOrNull(attributes.clanId),
    now,
    now,
  )
  return { id: player.id, name }
}

export interface StoredStatsResult {
  modes: number
}

/**
 * Replace all stored mode stats for one player/season pair in a single
 * transaction. Ranked variants override casual variants of the same mode.
 */
export function storeSeasonStats(
  db: Db,
  playerId: string,
  seasonId: string,
  shard: Shard,
  stats: PlayerSeasonResource,
  fetchedAt = new Date().toISOString(),
): StoredStatsResult {
  const attributes = stats.attributes ?? {}
  const modes = new Map<string, GameModeStat>()

  for (const [mode, values] of Object.entries(attributes.gameModeStats ?? {})) {
    if (values && typeof values === 'object') modes.set(mode, values)
  }
  for (const [mode, values] of Object.entries(attributes.rankedGameModeStats ?? {})) {
    if (!values || typeof values !== 'object') continue
    modes.set(mode, { ...(modes.get(mode) ?? {}), ...values })
  }

  const deleteStmt = db.prepare(
    'DELETE FROM player_season_stats WHERE player_id = ? AND season_id = ?',
  )
  const insertStmt = db.prepare(
    `INSERT INTO player_season_stats
       (player_id, season_id, shard, mode, rounds_played, wins, top10s, kills,
        assists, damage_dealt, headshot_kills, time_survived, longest_kill,
        best_rank_point, raw_json, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(player_id, season_id, mode) DO UPDATE SET
       shard = excluded.shard,
       rounds_played = excluded.rounds_played,
       wins = excluded.wins,
       top10s = excluded.top10s,
       kills = excluded.kills,
       assists = excluded.assists,
       damage_dealt = excluded.damage_dealt,
       headshot_kills = excluded.headshot_kills,
       time_survived = excluded.time_survived,
       longest_kill = excluded.longest_kill,
       best_rank_point = excluded.best_rank_point,
       raw_json = excluded.raw_json,
       fetched_at = excluded.fetched_at`,
  )

  const apply = db.transaction(() => {
    deleteStmt.run(playerId, seasonId)
    for (const [mode, values] of modes) {
      insertStmt.run(
        playerId,
        seasonId,
        shard,
        mode,
        integerValue(values.roundsPlayed),
        integerValue(values.wins),
        integerValue(values.top10s),
        integerValue(values.kills),
        integerValue(values.assists),
        numberValue(values.damageDealt),
        integerValue(values.headshotKills),
        integerValue(values.timeSurvived),
        numberValue(values.longestKill),
        integerOrNull(values.bestRankPoint),
        JSON.stringify(values),
        fetchedAt,
      )
    }
    markSeasonFetch(db, playerId, seasonId, shard, modes.size > 0 ? 'ok' : 'empty', null, fetchedAt)
  })
  apply()

  return { modes: modes.size }
}

export function markSeasonFetch(
  db: Db,
  playerId: string,
  seasonId: string,
  shard: Shard,
  status: 'ok' | 'empty' | 'error',
  error: string | null,
  fetchedAt = new Date().toISOString(),
): void {
  db.prepare(
    `INSERT INTO player_season_fetches
       (player_id, season_id, shard, fetched_at, status, last_error)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(player_id, season_id) DO UPDATE SET
       shard = excluded.shard,
       fetched_at = excluded.fetched_at,
       status = excluded.status,
       last_error = excluded.last_error`,
  ).run(playerId, seasonId, shard, fetchedAt, status, error)
}

/** Upsert one match and replace its participants atomically. */
export function storeMatch(
  db: Db,
  doc: MatchResponse,
  shard: Shard,
  fetchedAt = new Date().toISOString(),
): number {
  const match = doc.data
  if (!match || typeof match.id !== 'string' || !match.id) {
    throw new Error('Match document is missing data.id')
  }
  const attributes = match.attributes ?? {}
  const matchId = match.id
  const matchShard = (attributes.shardId as Shard | undefined) ?? shard
  const teamByResourceId = teamIdByParticipantResource(doc)

  const participants = (doc.included ?? []).filter((resource) => {
    if (!isParticipant(resource)) return false
    const playerId = resource.attributes?.stats?.playerId
    return typeof playerId === 'string' && playerId.trim().length > 0
  })

  const upsertMatch = db.prepare(
    `INSERT INTO matches
       (id, shard, map_name, game_mode, match_type, duration, created_at,
        season_state, raw_json, fetched_at, telemetry_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       shard = excluded.shard,
       map_name = excluded.map_name,
       game_mode = excluded.game_mode,
       match_type = excluded.match_type,
       duration = excluded.duration,
       created_at = excluded.created_at,
       season_state = excluded.season_state,
       raw_json = excluded.raw_json,
       fetched_at = excluded.fetched_at,
       telemetry_url = COALESCE(excluded.telemetry_url, matches.telemetry_url)`,
  )
  const deleteParticipants = db.prepare('DELETE FROM match_participants WHERE match_id = ?')
  const insertParticipant = db.prepare(
    `INSERT INTO match_participants
       (match_id, player_id, shard, name, placement, kills, headshots, assists,
        dbno, damage, time_survived, walk_distance, ride_distance, death_type, team_id, is_bot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(match_id, player_id) DO UPDATE SET
       shard = excluded.shard,
       name = excluded.name,
       placement = excluded.placement,
       kills = excluded.kills,
       headshots = excluded.headshots,
       assists = excluded.assists,
       dbno = excluded.dbno,
       damage = excluded.damage,
       time_survived = excluded.time_survived,
       walk_distance = excluded.walk_distance,
       ride_distance = excluded.ride_distance,
       death_type = excluded.death_type,
       team_id = excluded.team_id,
       is_bot = excluded.is_bot`,
  )

  const apply = db.transaction(() => {
    upsertMatch.run(
      matchId,
      matchShard,
      textOrNull(attributes.mapName) ?? 'Unknown',
      textOrNull(attributes.gameMode) ?? 'unknown',
      textOrNull(attributes.matchType) ?? 'unknown',
      attributes.duration === null || attributes.duration === undefined
        ? null
        : integerValue(attributes.duration),
      textOrNull(attributes.createdAt) ?? fetchedAt,
      textOrNull(attributes.seasonState),
      JSON.stringify(doc),
      fetchedAt,
      extractTelemetryUrl(doc),
    )

    deleteParticipants.run(matchId)
    for (const participant of participants) {
      const stats = (participant.attributes?.stats ?? {}) as ParticipantStats
      const playerId = (stats.playerId as string).trim()
      insertParticipant.run(
        matchId,
        playerId,
        (participant.attributes?.shardId as Shard | undefined) ?? matchShard,
        textOrNull(stats.name) ?? playerId,
        integerOrNull(stats.winPlace),
        integerValue(stats.kills),
        integerValue(stats.headshotKills),
        integerValue(stats.assists),
        integerValue(stats.DBNOs),
        numberValue(stats.damageDealt),
        integerValue(stats.timeSurvived),
        numberValue(stats.walkDistance),
        numberValue(stats.rideDistance),
        textOrNull(stats.deathType),
        teamByResourceId.get(participant.id) ?? null,
        isBotPlayerId(playerId) ? 1 : 0,
      )
    }
  })
  apply()

  return participants.length
}

function storedMatchIds(db: Db, ids: string[]): Set<string> {
  const stored = new Set<string>()
  for (let offset = 0; offset < ids.length; offset += SQLITE_CHUNK) {
    const chunk = ids.slice(offset, offset + SQLITE_CHUNK)
    const placeholders = chunk.map(() => '?').join(', ')
    const rows = db
      .prepare(`SELECT id FROM matches WHERE id IN (${placeholders})`)
      .all(...chunk) as Array<{ id: string }>
    for (const row of rows) stored.add(row.id)
  }
  return stored
}

function matchIdsFromPlayer(player: PlayerResource): string[] {
  const relationship = player.relationships?.matches
  const data = relationship?.data
  if (!Array.isArray(data)) return []
  const ids: string[] = []
  const seen = new Set<string>()
  for (const item of data) {
    if (!item || typeof item.id !== 'string' || item.id.length === 0) continue
    if (seen.has(item.id)) continue
    seen.add(item.id)
    ids.push(item.id)
  }
  return ids
}

function isBotPlayerId(playerId: string): boolean {
  return playerId.startsWith('ai.')
}

/** Roster resources map participant resource ids to PUBG team ids. */
function teamIdByParticipantResource(doc: MatchResponse): Map<string, number> {
  const teamByResource = new Map<string, number>()
  for (const resource of doc.included ?? []) {
    if (!isRoster(resource)) continue
    const teamId = resource.attributes?.stats?.teamId
    if (typeof teamId !== 'number') continue
    const refs = resource.relationships?.participants?.data
    if (!Array.isArray(refs)) continue
    for (const ref of refs) {
      if (ref && typeof ref.id === 'string') teamByResource.set(ref.id, teamId)
    }
  }
  return teamByResource
}

/**
 * Fill team_id/is_bot for matches stored before schema v3 by re-reading the raw
 * match JSON we already keep. No PUBG API calls are made.
 */
export function backfillParticipantTeams(db: Db, matchIds: string[]): number {
  if (matchIds.length === 0) return 0

  const rows: Array<{ id: string; raw_json: string }> = []
  for (let offset = 0; offset < matchIds.length; offset += SQLITE_CHUNK) {
    const chunk = matchIds.slice(offset, offset + SQLITE_CHUNK)
    const placeholders = chunk.map(() => '?').join(', ')
    rows.push(
      ...(db
        .prepare(
          `SELECT DISTINCT m.id, m.raw_json
           FROM matches m
           JOIN match_participants p ON p.match_id = m.id
           WHERE m.id IN (${placeholders})
             AND p.team_id IS NULL
             AND m.raw_json IS NOT NULL`,
        )
        .all(...chunk) as Array<{ id: string; raw_json: string }>),
    )
  }

  if (rows.length === 0) return 0

  const update = db.prepare(
    `UPDATE match_participants
     SET team_id = ?, is_bot = ?
     WHERE match_id = ? AND player_id = ?`,
  )
  let updatedMatches = 0

  for (const row of rows) {
    let doc: MatchResponse
    try {
      doc = JSON.parse(row.raw_json) as MatchResponse
    } catch {
      continue
    }
    const teamByResource = teamIdByParticipantResource(doc)
    const participants = (doc.included ?? []).filter(isParticipant)
    const apply = db.transaction(() => {
      for (const participant of participants) {
        const playerId = participant.attributes?.stats?.playerId?.trim()
        if (!playerId) continue
        update.run(
          teamByResource.get(participant.id) ?? null,
          isBotPlayerId(playerId) ? 1 : 0,
          row.id,
          playerId,
        )
      }
    })
    apply()
    updatedMatches += 1
  }

  return updatedMatches
}

/**
 * Resolve a player, refresh their season stats and fetch their recent matches.
 * Safe to run repeatedly: all writes are upserts/replacements and cached
 * matches are not fetched again.
 */
export async function syncPlayer(
  db: Db,
  client: PubgApi,
  job: SyncJob,
  options: SyncPlayerOptions = {},
): Promise<SyncPlayerResult> {
  const shard = job.shard
  const clock = options.now ?? (() => new Date())
  const matchLimit = Math.max(0, options.matchLimit ?? DEFAULT_MATCH_LIMIT)
  const matchConcurrency = Math.max(
    1,
    options.matchConcurrency ?? DEFAULT_MATCH_CONCURRENCY,
  )

  const report = async (
    phase: CrawlPhase,
    progress: number,
    message?: string,
  ): Promise<void> => {
    if (options.onProgress) await options.onProgress({ phase, progress, message })
  }

  await report('resolving_player', 5, 'Looking up player')

  const local = db
    .prepare('SELECT id FROM players WHERE shard = ? AND name_folded = ? LIMIT 1')
    .get(shard, job.player_name.trim().toLowerCase()) as PlayerRow | undefined

  let player: PlayerResource | undefined
  if (local) {
    try {
      player = await client.getPlayerById(shard, local.id)
    } catch (error) {
      // The stored id can disappear (account renamed/shard change); fall back
      // to the exact typed name so the job can recover.
      if (!(error instanceof PubgApiError) || error.status !== 404) throw error
    }
  }
  if (!player) {
    player = await client.getPlayerByName(shard, job.player_name)
  }

  const storedPlayer = upsertPlayer(db, shard, player, job.player_name)
  updateJob(db, job.id, { player_id: storedPlayer.id })
  await report('resolving_player', 15, `Resolved ${storedPlayer.name}`)

  await report('seasons', 20, 'Syncing seasons')
  const seasonId = await syncSeasons(db, client, shard, {
    cacheHours: options.seasonCacheHours,
    now: clock,
  })

  let statsModes = 0
  // One request returns the full-season aggregate for every mode, including
  // games whose match details we never download. Do not derive this from the
  // matchLimit below.
  await report('season_stats', 30, 'Fetching season stats')
  if (seasonId) {
    const stats = await client.getSeasonStats(shard, storedPlayer.id, seasonId)
    statsModes = storeSeasonStats(
      db,
      storedPlayer.id,
      seasonId,
      shard,
      stats,
      stamp(clock),
    ).modes
  }

  // Match details are capped by matchLimit. This is intentionally separate
  // from player_season_stats, which already covers the whole season.
  const matchIds = matchIdsFromPlayer(player).slice(0, matchLimit)
  const stored = storedMatchIds(db, matchIds)
  const missing = matchIds.filter((id) => !stored.has(id))

  await report('matches', 40, `Fetched 0/${missing.length} matches`)

  let fetched = 0
  let skipped = 0
  let processed = 0
  let participantsStored = 0

  const runWorker = async (): Promise<void> => {
    for (;;) {
      const index = processed
      if (index >= missing.length) return
      const matchId = missing[index]
      processed += 1
      try {
        const doc = await client.getMatch(shard, matchId)
        participantsStored += storeMatch(db, doc, shard, stamp(clock))
        fetched += 1
      } catch (error) {
        if (error instanceof PubgApiError && error.status === 404) {
          skipped += 1
        } else {
          throw error
        }
      }

      const progress = Math.min(
        68,
        40 + Math.floor((processed / Math.max(1, missing.length)) * 28),
      )
      const suffix = skipped > 0 ? ` (${skipped} unavailable)` : ''
      await report(
        'matches',
        progress,
        `Fetched ${fetched}/${missing.length} matches${suffix}`,
      )
    }
  }

  if (missing.length === 0) {
    await report('matches', 68, `All ${matchIds.length} matches already cached`)
  } else {
    const workers = Math.min(matchConcurrency, missing.length)
    await Promise.all(Array.from({ length: workers }, () => runWorker()))
  }

  const teamsUpdated = backfillParticipantTeams(db, matchIds)
  if (teamsUpdated > 0) {
    await report('matches', 69, `Updated teammate rosters for ${teamsUpdated} matches`)
  }

  let telemetry = { pending: 0, processed: 0, failed: 0, killEvents: 0 }
  if (!options.skipTelemetry && matchIds.length > 0) {
    await report('telemetry', 70, 'Indexing kill events')
    telemetry = await ensureTelemetryForMatches(db, matchIds, {
      concurrency: options.telemetryConcurrency ?? 2,
      timeoutMs: options.telemetryTimeoutMs,
      fetchImpl: options.fetchImpl,
      now: clock,
      logger: options.logger,
      onProgress: async (done, total, message) => {
        await report(
          'telemetry',
          70 + Math.floor((done / Math.max(1, total)) * 28),
          message,
        )
      },
    })
    if (telemetry.pending === 0) {
      await report('telemetry', 98, 'Kill events already cached')
    }
  }

  db.prepare('UPDATE players SET last_synced_at = ? WHERE id = ?').run(
    stamp(clock),
    storedPlayer.id,
  )

  const telemetrySuffix = options.skipTelemetry
    ? ''
    : `, ${telemetry.killEvents} kill events indexed${
        telemetry.failed > 0 ? ` (${telemetry.failed} telemetry unavailable)` : ''
      }`

  await report(
    'done',
    100,
    `Synced ${storedPlayer.name}: ${matchIds.length} matches (${fetched} fetched)${telemetrySuffix}`,
  )

  return {
    playerId: storedPlayer.id,
    playerName: storedPlayer.name,
    seasonId,
    matchesRequested: matchIds.length,
    matchesFetched: fetched,
    matchesCached: matchIds.length - missing.length,
    participantsStored,
    statsModes,
    telemetryProcessed: telemetry.processed,
    telemetryFailed: telemetry.failed,
    killEvents: telemetry.killEvents,
  }
}

/**
 * Fetch and cache one season's aggregate stats. This is one rate-limited call
 * and never touches matches or telemetry.
 */
export async function syncSeason(
  db: Db,
  client: PubgApi,
  job: SyncJob,
  options: SyncSeasonOptions = {},
): Promise<SyncSeasonResult> {
  const seasonId = job.season_id?.trim()
  if (!seasonId) throw new Error('Season job is missing season_id')

  const player = job.player_id
    ? (db.prepare('SELECT id FROM players WHERE id = ?').get(job.player_id) as
        | PlayerRow
        | undefined)
    : (db
        .prepare('SELECT id FROM players WHERE shard = ? AND name_folded = ?')
        .get(job.shard, job.player_name.trim().toLowerCase()) as PlayerRow | undefined)

  if (!player) {
    throw new Error(`Player ${job.player_name} is not cached; run a player sync first.`)
  }

  const clock = options.now ?? (() => new Date())
  const report = async (
    phase: CrawlPhase,
    progress: number,
    message: string,
  ): Promise<void> => {
    if (options.onProgress) await options.onProgress({ phase, progress, message })
  }

  await report('season_stats', 10, `Fetching ${seasonId} stats`)
  try {
    const stats = await client.getSeasonStats(job.shard, player.id, seasonId)
    const result = storeSeasonStats(
      db,
      player.id,
      seasonId,
      job.shard,
      stats,
      stamp(clock),
    )
    const status = result.modes > 0 ? 'ok' : 'empty'
    await report('done', 100, `Synced ${seasonId} (${result.modes} modes)`)
    return { playerId: player.id, seasonId, modes: result.modes, status }
  } catch (error) {
    markSeasonFetch(
      db,
      player.id,
      seasonId,
      job.shard,
      'error',
      error instanceof Error ? error.message : String(error),
      stamp(clock),
    )
    throw error
  }
}

/** Newest modern seasons for a shard, used by the background scanner. */
export function modernSeasonIds(db: Db, shard: Shard, limit: number): string[] {
  const rows = db
    .prepare('SELECT id FROM seasons WHERE shard = ?')
    .all(shard) as Array<{ id: string }>
  const ids = rows
    .map((row) => row.id)
    .filter((id) => isModernSeason(shard, id))
    .sort((a, b) => seasonNumber(b) - seasonNumber(a))
    .slice(0, Math.max(1, limit))

  const current = db
    .prepare('SELECT id FROM seasons WHERE shard = ? AND is_current = 1 LIMIT 1')
    .get(shard) as { id: string } | undefined
  if (current && !ids.includes(current.id)) ids.unshift(current.id)
  return ids.slice(0, Math.max(1, limit))
}

function scanProgress(
  db: Db,
  playerId: string,
  candidates: string[],
): { scanned: number; played: number; remaining: string[] } {
  if (candidates.length === 0) return { scanned: 0, played: 0, remaining: [] }
  const placeholders = candidates.map(() => '?').join(', ')
  const markers = db
    .prepare(
      `SELECT season_id FROM player_season_fetches
       WHERE player_id = ? AND season_id IN (${placeholders})`,
    )
    .all(playerId, ...candidates) as Array<{ season_id: string }>
  const stats = db
    .prepare(
      `SELECT season_id, SUM(rounds_played) AS rounds
       FROM player_season_stats
       WHERE player_id = ? AND season_id IN (${placeholders})
       GROUP BY season_id`,
    )
    .all(playerId, ...candidates) as Array<{ season_id: string; rounds: number }>

  const scannedIds = new Set<string>()
  for (const row of markers) scannedIds.add(row.season_id)
  for (const row of stats) scannedIds.add(row.season_id)

  return {
    scanned: scannedIds.size,
    played: stats.filter((row) => row.rounds > 0).length,
    remaining: candidates.filter((id) => !scannedIds.has(id)),
  }
}

/**
 * Fetch up to `batchSize` unscanned seasons for the background discovery job.
 * One request per season; empty/error seasons are marked so they are skipped.
 */
export async function syncSeasonScan(
  db: Db,
  client: PubgApi,
  job: SyncJob,
  options: SyncSeasonScanOptions,
): Promise<SyncSeasonScanResult> {
  const player = job.player_id
    ? (db.prepare('SELECT id FROM players WHERE id = ?').get(job.player_id) as
        | PlayerRow
        | undefined)
    : (db
        .prepare('SELECT id FROM players WHERE shard = ? AND name_folded = ?')
        .get(job.shard, job.player_name.trim().toLowerCase()) as PlayerRow | undefined)

  if (!player) {
    throw new Error(`Player ${job.player_name} is not cached; run a player sync first.`)
  }

  const clock = options.now ?? (() => new Date())
  const candidates = modernSeasonIds(db, job.shard, options.limit)
  const report = async (
    phase: CrawlPhase,
    progress: number,
    message: string,
  ): Promise<void> => {
    if (options.onProgress) await options.onProgress({ phase, progress, message })
  }

  await report('season_stats', 5, `Scanning ${candidates.length} season slots`)
  const before = scanProgress(db, player.id, candidates)
  const pending = before.remaining.slice(0, Math.max(1, options.batchSize))
  let processed = 0

  for (const seasonId of pending) {
    try {
      const stats = await client.getSeasonStats(job.shard, player.id, seasonId)
      storeSeasonStats(db, player.id, seasonId, job.shard, stats, stamp(clock))
    } catch (error) {
      markSeasonFetch(
        db,
        player.id,
        seasonId,
        job.shard,
        'error',
        error instanceof Error ? error.message : String(error),
        stamp(clock),
      )
    }

    processed += 1
    const current = scanProgress(db, player.id, candidates)
    await report(
      'season_stats',
      10 + Math.floor((processed / Math.max(1, pending.length)) * 80),
      `Scanned ${current.scanned}/${candidates.length} seasons (${current.played} played)`,
    )
  }

  const after = scanProgress(db, player.id, candidates)
  await report(
    'season_stats',
    95,
    `Scanned ${after.scanned}/${candidates.length} seasons (${after.played} played)`,
  )

  return {
    playerId: player.id,
    scanned: after.scanned,
    total: candidates.length,
    played: after.played,
    more: after.remaining.length > 0,
  }
}

