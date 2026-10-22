export interface PlayerRow {
  id: string
  shard: string
  name: string
  name_folded: string
  ban_type: string | null
  clan_id: string | null
  is_tracked: number
  created_at: string
  updated_at: string
  last_synced_at: string | null
}

export interface SeasonRow {
  id: string
  shard: string
  is_current: number
  fetched_at: string
}

export interface SeasonStatsRow {
  player_id: string
  season_id: string
  shard: string
  mode: string
  rounds_played: number
  wins: number
  top10s: number
  kills: number
  assists: number
  damage_dealt: number
  headshot_kills: number
  time_survived: number
  longest_kill: number
  best_rank_point: number | null
  raw_json: string | null
  fetched_at: string
}

export interface MatchRow {
  id: string
  shard: string
  map_name: string
  game_mode: string
  match_type: string
  duration: number | null
  created_at: string
  season_state: string | null
  raw_json: string | null
  fetched_at: string
  telemetry_url: string | null
  telemetry_fetched_at: string | null
  telemetry_error: string | null
}

export interface KillRow {
  id: number
  match_id: string
  event_time: string
  killer_id: string | null
  killer_name: string | null
  killer_is_bot: number
  victim_id: string | null
  victim_name: string | null
  victim_is_bot: number
  weapon: string | null
  damage_reason: string | null
  distance: number | null
  finisher_name: string | null
  is_suicide: number
  is_teamkill: number
}

export interface ParticipantRow {
  match_id: string
  player_id: string
  shard: string
  name: string
  placement: number | null
  kills: number
  headshots: number
  assists: number
  dbno: number
  damage: number
  time_survived: number
  walk_distance: number
  ride_distance: number
  death_type: string | null
  team_id: number | null
  is_bot: number
}

export interface JobRow {
  id: string
  player_key: string
  shard: string
  player_name: string
  player_id: string | null
  season_id: string | null
  kind: string
  priority: number
  run_after: string | null
  status: 'pending' | 'running' | 'done' | 'failed'
  phase: string
  progress: number
  message: string | null
  error: string | null
  error_code: string | null
  attempts: number
  created_at: string
  updated_at: string
  started_at: string | null
  finished_at: string | null
}

export type Db = import('better-sqlite3').Database
