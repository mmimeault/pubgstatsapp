import type { MatchSummary, ModeStats, RecentSummary } from './types'
import { modeLabel } from './labels'

export interface ModeStatsInput {
  mode: string
  rounds: number
  wins: number
  top10s: number
  kills: number
  assists: number
  damage: number
  headshots: number
  timeSurvived: number
  longestKill: number
  bestRankPoint: number | null
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export function computeModeStats(input: ModeStatsInput): ModeStats {
  const deaths = Math.max(0, input.rounds - input.wins)
  return {
    mode: input.mode,
    label: modeLabel(input.mode),
    rounds: input.rounds,
    wins: input.wins,
    top10s: input.top10s,
    kills: input.kills,
    assists: input.assists,
    damage: round(input.damage, 1),
    headshots: input.headshots,
    timeSurvived: input.timeSurvived,
    longestKill: round(input.longestKill, 1),
    bestRankPoint: input.bestRankPoint,
    kd: deaths > 0 ? round(input.kills / deaths) : input.kills > 0 ? round(input.kills) : 0,
    winRate: input.rounds > 0 ? round((input.wins / input.rounds) * 100, 1) : 0,
    top10Rate: input.rounds > 0 ? round((input.top10s / input.rounds) * 100, 1) : 0,
    avgDamage: input.rounds > 0 ? round(input.damage / input.rounds, 1) : 0,
    hsRate: input.kills > 0 ? round((input.headshots / input.kills) * 100, 1) : 0,
    avgSurvival: input.rounds > 0 ? round(input.timeSurvived / input.rounds, 1) : 0,
  }
}

export function aggregateModeStats(modes: ModeStats[]): ModeStats {
  const sum = modes.reduce(
    (acc, mode) => ({
      rounds: acc.rounds + mode.rounds,
      wins: acc.wins + mode.wins,
      top10s: acc.top10s + mode.top10s,
      kills: acc.kills + mode.kills,
      assists: acc.assists + mode.assists,
      damage: acc.damage + mode.damage,
      headshots: acc.headshots + mode.headshots,
      timeSurvived: acc.timeSurvived + mode.timeSurvived,
      longestKill: Math.max(acc.longestKill, mode.longestKill),
      bestRankPoint: Math.max(acc.bestRankPoint ?? 0, mode.bestRankPoint ?? 0) || null,
    }),
    {
      rounds: 0,
      wins: 0,
      top10s: 0,
      kills: 0,
      assists: 0,
      damage: 0,
      headshots: 0,
      timeSurvived: 0,
      longestKill: 0,
      bestRankPoint: null as number | null,
    },
  )
  return computeModeStats({ ...sum, mode: 'all' })
}

export function computeRecentSummary(matches: MatchSummary[]): RecentSummary {
  const count = matches.length
  const wins = matches.filter((m) => m.win).length
  const top10s = matches.filter((m) => m.top10).length
  const kills = matches.reduce((acc, m) => acc + m.kills, 0)
  const damage = matches.reduce((acc, m) => acc + m.damage, 0)
  const placement = matches.reduce((acc, m) => acc + m.placement, 0)
  const survived = matches.reduce((acc, m) => acc + m.timeSurvived, 0)
  const deaths = Math.max(0, count - wins)
  const botKills = matches.reduce(
    (acc, match) =>
      acc +
      match.killEvents.filter((kill) => kill.victimIsBot && !kill.isTeamkill && !kill.isSuicide)
        .length,
    0,
  )

  return {
    count,
    wins,
    top10s,
    kills,
    damage: round(damage, 1),
    avgPlacement: count > 0 ? round(placement / count, 1) : 0,
    kd: deaths > 0 ? round(kills / deaths) : kills,
    avgDamage: count > 0 ? round(damage / count, 1) : 0,
    avgSurvival: count > 0 ? round(survived / count, 1) : 0,
    botKills,
    humanKills: Math.max(0, kills - botKills),
    kdNoBots: deaths > 0 ? round(Math.max(0, kills - botKills) / deaths) : Math.max(0, kills - botKills),
  }
}
