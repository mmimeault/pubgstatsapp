import {
  aggregateModeStats,
  computeModeStats,
  computeRecentSummary,
  isModernSeason,
  mapLabel,
  modeLabel,
  seasonLabel,
  seasonNumber,
  weaponLabel,
  type CrawlInfo,
  type KillEvent,
  type MatchDeath,
  type MatchSummary,
  type MatchTeammate,
  type ModeStats,
  type ProfileResponse,
  type SeasonInfo,
  type SeasonOption,
  type SeasonScanInfo,
  type SeasonStatsResponse,
} from '@pubgstats/shared'
import { config } from './config'
import { computeRefreshCooldown } from './cooldown'
import { getActiveJob, getLatestJob, getHeartbeat, heartbeatAgeMs, mapJob, playerKey, seasonScanKey } from './jobs'
import type { Db, KillRow, MatchRow, ParticipantRow, PlayerRow, SeasonStatsRow } from './types'

function currentSeasonId(db: Db, playerId: string, shard: string): string | null {
  const current = db
    .prepare('SELECT id FROM seasons WHERE shard = ? AND is_current = 1 ORDER BY fetched_at DESC LIMIT 1')
    .get(shard) as { id: string } | undefined
  if (current) return current.id

  const fallback = db
    .prepare(
      `SELECT season_id FROM player_season_stats
       WHERE player_id = ? ORDER BY fetched_at DESC LIMIT 1`,
    )
    .get(playerId) as { season_id: string } | undefined
  return fallback?.season_id ?? null
}

function seasonInfo(db: Db, shard: string, seasonId: string | null): SeasonInfo | null {
  if (!seasonId) return null
  const row = db
    .prepare('SELECT id, is_current FROM seasons WHERE shard = ? AND id = ?')
    .get(shard, seasonId) as { id: string; is_current: number } | undefined
  return {
    id: seasonId,
    label: seasonLabel(seasonId),
    isCurrent: row ? row.is_current === 1 : true,
  }
}

function toPlayerSummary(player: PlayerRow) {
  return {
    id: player.id,
    shard: player.shard as ProfileResponse['player']['shard'],
    name: player.name,
    banType: player.ban_type,
    clanId: player.clan_id,
    lastSyncedAt: player.last_synced_at,
  }
}

export function buildSeasonOptions(db: Db, player: PlayerRow): SeasonOption[] {
  const rows = db
    .prepare(
      `SELECT s.id,
              s.is_current,
              COALESCE(SUM(pss.rounds_played), 0) AS rounds,
              COUNT(pss.mode) AS cached_modes,
              MAX(CASE WHEN pf.fetched_at IS NOT NULL THEN 1 ELSE 0 END) AS marked
       FROM seasons s
       LEFT JOIN player_season_stats pss
         ON pss.season_id = s.id AND pss.player_id = ?
       LEFT JOIN player_season_fetches pf
         ON pf.season_id = s.id AND pf.player_id = ?
       WHERE s.shard = ?
       GROUP BY s.id, s.is_current`,
    )
    .all(player.id, player.id, player.shard) as Array<{
    id: string
    is_current: number
    rounds: number
    cached_modes: number
    marked: number
  }>

  return rows
    .map((row) => ({
      id: row.id,
      label: seasonLabel(row.id),
      isCurrent: row.is_current === 1,
      fetched: row.marked === 1 || row.cached_modes > 0,
      rounds: row.rounds,
    }))
    .sort(
      (a, b) =>
        Number(b.isCurrent) - Number(a.isCurrent) ||
        seasonNumber(b.id) - seasonNumber(a.id) ||
        b.id.localeCompare(a.id),
    )
}

export function seasonScanCandidates(db: Db, shard: string, limit: number): string[] {
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

export function buildSeasonScan(db: Db, player: PlayerRow): SeasonScanInfo {
  const candidates = seasonScanCandidates(db, player.shard, config.seasonScanLimit)
  if (candidates.length === 0) {
    return { status: 'done', scanned: 0, total: 0, played: 0, nextBatchAt: null }
  }

  const placeholders = candidates.map(() => '?').join(', ')
  const markers = db
    .prepare(
      `SELECT season_id FROM player_season_fetches
       WHERE player_id = ? AND season_id IN (${placeholders})`,
    )
    .all(player.id, ...candidates) as Array<{ season_id: string }>
  const stats = db
    .prepare(
      `SELECT season_id, SUM(rounds_played) AS rounds
       FROM player_season_stats
       WHERE player_id = ? AND season_id IN (${placeholders})
       GROUP BY season_id`,
    )
    .all(player.id, ...candidates) as Array<{ season_id: string; rounds: number }>

  const scannedIds = new Set<string>()
  for (const marker of markers) scannedIds.add(marker.season_id)
  for (const row of stats) scannedIds.add(row.season_id)
  const active = getActiveJob(
    db,
    seasonScanKey(player.shard, player.name),
  )

  const scanned = scannedIds.size
  return {
    status: active ? 'scanning' : scanned < candidates.length ? 'idle' : 'done',
    scanned,
    total: candidates.length,
    played: stats.filter((row) => row.rounds > 0).length,
    nextBatchAt: active?.run_after ?? null,
  }
}


export function buildSeasonStats(
  db: Db,
  player: PlayerRow,
  seasonId: string,
): SeasonStatsResponse | null {
  const season = seasonInfo(db, player.shard, seasonId)
  if (!season) return null
  const allModes = modeStatsForPlayer(db, player.id, seasonId)
  const modes = allModes.filter((mode) => mode.rounds > 0)
  return {
    player: toPlayerSummary(player),
    season,
    modes,
    totals: aggregateModeStats(allModes),
    defaultMode: modes[0]?.mode ?? 'all',
    hasGames: modes.length > 0,
  }
}

export interface SeasonFetchRow {
  status: string
  fetched_at: string
  last_error: string | null
}

export function getSeasonFetch(
  db: Db,
  playerId: string,
  seasonId: string,
): SeasonFetchRow | undefined {
  return db
    .prepare(
      'SELECT status, fetched_at, last_error FROM player_season_fetches WHERE player_id = ? AND season_id = ?',
    )
    .get(playerId, seasonId) as SeasonFetchRow | undefined
}

export function modeStatsForPlayer(db: Db, playerId: string, seasonId: string): ModeStats[] {
  const rows = db
    .prepare(
      `SELECT * FROM player_season_stats
       WHERE player_id = ? AND season_id = ? ORDER BY rounds_played DESC`,
    )
    .all(playerId, seasonId) as SeasonStatsRow[]

  return rows.map((row) =>
    computeModeStats({
      mode: row.mode,
      rounds: row.rounds_played,
      wins: row.wins,
      top10s: row.top10s,
      kills: row.kills,
      assists: row.assists,
      damage: row.damage_dealt,
      headshots: row.headshot_kills,
      timeSurvived: row.time_survived,
      longestKill: row.longest_kill,
      bestRankPoint: row.best_rank_point,
    }),
  )
}

export function listMatches(db: Db, playerId: string, limit: number, offset = 0): MatchSummary[] {
  const rows = db
    .prepare(
      `SELECT m.*, mp.*
       FROM match_participants mp
       JOIN matches m ON m.id = mp.match_id
       WHERE mp.player_id = ?
       ORDER BY m.created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(playerId, limit, offset) as Array<MatchRow & ParticipantRow>

  const killsByMatch = new Map<string, KillRow[]>()
  const teammatesByMatch = new Map<string, MatchTeammate[]>()
  const deathsByMatch = new Map<string, MatchDeath>()
  if (rows.length > 0) {
    const placeholders = rows.map(() => '?').join(', ')
    const matchIds = rows.map((row) => row.id)

    const kills = db
      .prepare(
        `SELECT * FROM match_kills
         WHERE killer_id = ? AND match_id IN (${placeholders})
         ORDER BY event_time ASC`,
      )
      .all(playerId, ...matchIds) as KillRow[]
    for (const kill of kills) {
      const list = killsByMatch.get(kill.match_id) ?? []
      list.push(kill)
      killsByMatch.set(kill.match_id, list)
    }

    const teammates = db
      .prepare(
        `SELECT me.match_id AS match_id, p.player_id, p.name, p.is_bot
         FROM match_participants me
         JOIN match_participants p
           ON p.match_id = me.match_id AND p.team_id = me.team_id
         WHERE me.player_id = ?
           AND me.match_id IN (${placeholders})
           AND me.team_id IS NOT NULL
           AND p.player_id <> me.player_id
         ORDER BY p.is_bot ASC, p.name ASC`,
      )
      .all(playerId, ...matchIds) as Array<{
      match_id: string
      player_id: string
      name: string
      is_bot: number
    }>
    for (const mate of teammates) {
      const list = teammatesByMatch.get(mate.match_id) ?? []
      list.push({ id: mate.player_id, name: mate.name, isBot: mate.is_bot === 1 })
      teammatesByMatch.set(mate.match_id, list)
    }

    const deaths = db
      .prepare(
        `SELECT * FROM match_kills
         WHERE victim_id = ? AND match_id IN (${placeholders})
         ORDER BY event_time DESC`,
      )
      .all(playerId, ...matchIds) as KillRow[]
    for (const death of deaths) {
      if (deathsByMatch.has(death.match_id)) continue
      deathsByMatch.set(death.match_id, {
        killerId: death.killer_id,
        killerName: death.killer_name,
        killerIsBot: death.killer_is_bot === 1,
        weapon: death.weapon,
        weaponLabel: weaponLabel(death.weapon),
        distance: death.distance,
        eventTime: death.event_time,
        isSuicide: death.is_suicide === 1,
        isTeamkill: death.is_teamkill === 1,
      })
    }
  }

  return rows.map((row) => {
    const placement = row.placement ?? 0
    const killEvents: KillEvent[] = (killsByMatch.get(row.id) ?? []).map((kill) => ({
      victimName: kill.victim_name ?? 'Unknown',
      victimIsBot: kill.victim_is_bot === 1,
      weapon: kill.weapon,
      weaponLabel: weaponLabel(kill.weapon),
      distance: kill.distance,
      eventTime: kill.event_time,
      isTeamkill: kill.is_teamkill === 1,
      isSuicide: kill.is_suicide === 1,
      finisherName: kill.finisher_name,
    }))

    return {
      id: row.id,
      mapName: row.map_name,
      mapLabel: mapLabel(row.map_name),
      gameMode: row.game_mode,
      modeLabel: modeLabel(row.game_mode),
      createdAt: row.created_at,
      duration: row.duration ?? 0,
      placement,
      kills: row.kills,
      headshots: row.headshots,
      assists: row.assists,
      dbno: row.dbno,
      damage: Math.round(row.damage * 10) / 10,
      timeSurvived: row.time_survived,
      walkDistance: Math.round(row.walk_distance),
      rideDistance: Math.round(row.ride_distance),
      deathType: row.death_type,
      win: placement === 1,
      top10: placement > 0 && placement <= 10,
      killDataFetched: row.telemetry_fetched_at !== null,
      killEvents,
      death: deathsByMatch.get(row.id) ?? null,
      teammates: teammatesByMatch.get(row.id) ?? [],
    }
  })
}

function recentMatches(db: Db, playerId: string, limit = 20): MatchSummary[] {
  return listMatches(db, playerId, limit)
}

function crawlInfo(db: Db, player: PlayerRow): CrawlInfo {
  const key = playerKey(player.shard, player.name)
  const active = getActiveJob(db, key)
  const latest = getLatestJob(db, key)
  const heartbeat = getHeartbeat(db)
  const age = heartbeatAgeMs(heartbeat)
  const crawlerOnline = age !== null && age < config.heartbeatTimeoutMs
  const lastSyncedAt = player.last_synced_at
  const cooldown = computeRefreshCooldown(
    lastSyncedAt,
    latest?.created_at ?? null,
    config.refreshCooldownSeconds,
  )
  const stale =
    !lastSyncedAt ||
    Date.now() - new Date(lastSyncedAt).getTime() > config.staleAfterSeconds * 1000

  if (active) {
    return {
      state: active.status === 'running' ? 'running' : 'queued',
      job: mapJob(active),
      lastSyncedAt,
      stale,
      crawlerOnline,
      refreshAvailableAt: cooldown.availableAt,
      refreshCooldownSeconds: cooldown.remainingSeconds,
    }
  }

  if (latest?.status === 'failed' && (!lastSyncedAt || latest.created_at > lastSyncedAt)) {
    return {
      state: 'failed',
      job: mapJob(latest),
      lastSyncedAt,
      stale,
      crawlerOnline,
      refreshAvailableAt: cooldown.availableAt,
      refreshCooldownSeconds: cooldown.remainingSeconds,
    }
  }

  return {
    state: crawlerOnline ? 'idle' : 'offline',
    job: null,
    lastSyncedAt,
    stale,
    crawlerOnline,
    refreshAvailableAt: cooldown.availableAt,
    refreshCooldownSeconds: cooldown.remainingSeconds,
  }
}

export function buildProfile(db: Db, player: PlayerRow): ProfileResponse {
  const seasonId = currentSeasonId(db, player.id, player.shard)
  const allModes = seasonId ? modeStatsForPlayer(db, player.id, seasonId) : []
  const totals = aggregateModeStats(allModes)
  const modes = allModes.filter((mode) => mode.rounds > 0)
  // Match details are intentionally capped; season stats above come from the
  // full-season aggregate endpoint and cover every game in the season.
  const matches = recentMatches(db, player.id, config.recentMatchLimit)
  const totalMatches = (
    db
      .prepare('SELECT COUNT(*) AS count FROM match_participants WHERE player_id = ?')
      .get(player.id) as { count: number }
  ).count

  return {
    player: {
      id: player.id,
      shard: player.shard as ProfileResponse['player']['shard'],
      name: player.name,
      banType: player.ban_type,
      clanId: player.clan_id,
      lastSyncedAt: player.last_synced_at,
    },
    season: seasonInfo(db, player.shard, seasonId),
    modes,
    totals,
    defaultMode: modes[0]?.mode ?? 'all',
    recentMatches: matches,
    recentMatchesTotal: totalMatches,
    recentSummary: computeRecentSummary(matches),
    crawl: crawlInfo(db, player),
    meta: {
      generatedAt: new Date().toISOString(),
      staleAfterSeconds: config.staleAfterSeconds,
      recentMatchesLimit: config.recentMatchLimit,
      seasonStatsScope: 'all-games',
    },
  }
}

export function playerHasSeasonStats(db: Db, playerId: string): boolean {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM player_season_stats WHERE player_id = ?')
    .get(playerId) as { count: number }
  return row.count > 0
}
