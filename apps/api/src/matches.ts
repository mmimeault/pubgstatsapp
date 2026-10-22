import {
  mapLabel,
  modeLabel,
  weaponLabel,
  type MatchDeathDetail,
  type MatchDetailResponse,
  type MatchKillDetail,
  type MatchParticipantDetail,
  type PlayerSummary,
} from '@pubgstats/shared'
import type { Db, KillRow, MatchRow, ParticipantRow, PlayerRow } from './types'

function playerSummary(player: PlayerRow): PlayerSummary {
  return {
    id: player.id,
    shard: player.shard as PlayerSummary['shard'],
    name: player.name,
    banType: player.ban_type,
    clanId: player.clan_id,
    lastSyncedAt: player.last_synced_at,
  }
}

function participantDetail(
  row: ParticipantRow,
  me: ParticipantRow,
): MatchParticipantDetail {
  const isMe = row.player_id === me.player_id
  return {
    id: row.player_id,
    name: row.name,
    isBot: row.is_bot === 1,
    teamId: row.team_id,
    placement: row.placement,
    kills: row.kills,
    headshots: row.headshots,
    assists: row.assists,
    dbno: row.dbno,
    damage: Math.round(row.damage * 10) / 10,
    timeSurvived: row.time_survived,
    walkDistance: Math.round(row.walk_distance),
    rideDistance: Math.round(row.ride_distance),
    deathType: row.death_type,
    isMe,
    isTeammate:
      !isMe &&
      me.team_id !== null &&
      row.team_id !== null &&
      row.team_id === me.team_id,
  }
}

function killDetail(
  row: KillRow,
  participants: Map<string, MatchParticipantDetail>,
): MatchKillDetail {
  const killer = row.killer_id ? participants.get(row.killer_id) : undefined
  const victim = row.victim_id ? participants.get(row.victim_id) : undefined
  return {
    eventTime: row.event_time,
    killerId: row.killer_id,
    killerName: row.killer_name ?? killer?.name ?? null,
    killerIsBot: row.killer_is_bot === 1,
    killerTeamId: killer?.teamId ?? null,
    killerPlacement: killer?.placement ?? null,
    victimId: row.victim_id,
    victimName: row.victim_name ?? victim?.name ?? 'Unknown',
    victimIsBot: row.victim_is_bot === 1,
    victimTeamId: victim?.teamId ?? null,
    victimPlacement: victim?.placement ?? null,
    weapon: row.weapon,
    weaponLabel: weaponLabel(row.weapon),
    distance: row.distance,
    finisherName: row.finisher_name,
    isSuicide: row.is_suicide === 1,
    isTeamkill: row.is_teamkill === 1,
  }
}

/**
 * Build the full match page for one participant. The participant list is
 * sorted by team placement and then kills, which doubles as the lobby ranking.
 */
export function buildMatchDetail(
  db: Db,
  player: PlayerRow,
  matchId: string,
): MatchDetailResponse | null {
  const match = db
    .prepare('SELECT * FROM matches WHERE id = ? AND shard = ?')
    .get(matchId, player.shard) as MatchRow | undefined
  if (!match) return null

  const rows = db
    .prepare(
      `SELECT *
       FROM match_participants
       WHERE match_id = ?
       ORDER BY COALESCE(placement, 9999) ASC,
                COALESCE(team_id, 9999) ASC,
                kills DESC,
                name ASC`,
    )
    .all(matchId) as ParticipantRow[]

  const meRow = rows.find((row) => row.player_id === player.id)
  if (!meRow) return null

  const participants = rows.map((row) => participantDetail(row, meRow))
  const byId = new Map(participants.map((participant) => [participant.id, participant]))
  const me = byId.get(player.id) as MatchParticipantDetail
  const teammates = participants
    .filter((participant) => participant.isTeammate)
    .sort((a, b) => b.kills - a.kills || a.name.localeCompare(b.name))

  const killRows = db
    .prepare('SELECT * FROM match_kills WHERE match_id = ? ORDER BY event_time ASC')
    .all(matchId) as KillRow[]
  const kills = killRows.map((row) => killDetail(row, byId))
  const myKills = kills.filter((kill) => kill.killerId === player.id)

  const deathRow = [...killRows].reverse().find((row) => row.victim_id === player.id)
  const death: MatchDeathDetail | null = deathRow
    ? (() => {
        const killer = deathRow.killer_id ? byId.get(deathRow.killer_id) : undefined
        return {
          killerId: deathRow.killer_id,
          killerName: deathRow.killer_name ?? killer?.name ?? null,
          killerIsBot: deathRow.killer_is_bot === 1,
          killerTeamId: killer?.teamId ?? null,
          killerPlacement: killer?.placement ?? null,
          victimPlacement: me.placement,
          weapon: deathRow.weapon,
          weaponLabel: weaponLabel(deathRow.weapon),
          distance: deathRow.distance,
          eventTime: deathRow.event_time,
          isSuicide: deathRow.is_suicide === 1,
          isTeamkill: deathRow.is_teamkill === 1,
        }
      })()
    : null

  return {
    player: playerSummary(player),
    match: {
      id: match.id,
      shard: match.shard as MatchDetailResponse['match']['shard'],
      mapName: match.map_name,
      mapLabel: mapLabel(match.map_name),
      gameMode: match.game_mode,
      modeLabel: modeLabel(match.game_mode),
      matchType: match.match_type,
      createdAt: match.created_at,
      duration: match.duration ?? 0,
      killDataFetched: match.telemetry_fetched_at !== null,
      telemetryError: match.telemetry_error,
    },
    me,
    teammates,
    participants,
    kills,
    myKills,
    death,
  }
}
