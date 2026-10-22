export type Shard = 'steam' | 'kakao' | 'psn' | 'xbox'

export const SHARDS: Shard[] = ['steam', 'kakao', 'psn', 'xbox']

export const SHARD_LABELS: Record<Shard, string> = {
  steam: 'Steam',
  kakao: 'Kakao',
  psn: 'PlayStation',
  xbox: 'Xbox',
}

export interface PlayerSummary {
  id: string
  shard: Shard
  name: string
  banType: string | null
  clanId: string | null
  lastSyncedAt: string | null
}

export interface SeasonInfo {
  id: string
  label: string
  isCurrent: boolean
}

export interface SeasonOption extends SeasonInfo {
  fetched: boolean
  rounds: number
}

export interface SeasonListResponse {
  seasons: SeasonOption[]
  scan: SeasonScanInfo
}

export interface SeasonScanInfo {
  status: 'idle' | 'scanning' | 'done'
  scanned: number
  total: number
  played: number
  nextBatchAt: string | null
}

export interface SeasonStatsResponse {
  player: PlayerSummary
  season: SeasonInfo
  modes: ModeStats[]
  totals: ModeStats
  defaultMode: string
  hasGames: boolean
}

export interface SeasonCrawlingResponse {
  status: 'crawling'
  seasonId: string
  job: JobSummary
}

export interface ModeStats {
  mode: string
  label: string
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
  kd: number
  winRate: number
  top10Rate: number
  avgDamage: number
  hsRate: number
  avgSurvival: number
}

export interface MatchSummary {
  id: string
  mapName: string
  mapLabel: string
  gameMode: string
  modeLabel: string
  createdAt: string
  duration: number
  placement: number
  kills: number
  headshots: number
  assists: number
  dbno: number
  damage: number
  timeSurvived: number
  walkDistance: number
  rideDistance: number
  deathType: string | null
  win: boolean
  top10: boolean
  killDataFetched: boolean
  killEvents: KillEvent[]
  death: MatchDeath | null
  teammates: MatchTeammate[]
}

export interface MatchDeath {
  killerId: string | null
  killerName: string | null
  killerIsBot: boolean
  weapon: string | null
  weaponLabel: string
  distance: number | null
  eventTime: string
  isSuicide: boolean
  isTeamkill: boolean
}

export interface MatchTeammate {
  id: string
  name: string
  isBot: boolean
}

export interface MatchDetailInfo {
  id: string
  shard: Shard
  mapName: string
  mapLabel: string
  gameMode: string
  modeLabel: string
  matchType: string
  createdAt: string
  duration: number
  killDataFetched: boolean
  telemetryError: string | null
}

export interface MatchParticipantDetail {
  id: string
  name: string
  isBot: boolean
  teamId: number | null
  placement: number | null
  kills: number
  headshots: number
  assists: number
  dbno: number
  damage: number
  timeSurvived: number
  walkDistance: number
  rideDistance: number
  deathType: string | null
  isMe: boolean
  isTeammate: boolean
}

export interface MatchKillDetail {
  eventTime: string
  killerId: string | null
  killerName: string | null
  killerIsBot: boolean
  killerTeamId: number | null
  killerPlacement: number | null
  victimId: string | null
  victimName: string
  victimIsBot: boolean
  victimTeamId: number | null
  victimPlacement: number | null
  weapon: string | null
  weaponLabel: string
  distance: number | null
  finisherName: string | null
  isSuicide: boolean
  isTeamkill: boolean
}

export interface MatchDeathDetail {
  killerId: string | null
  killerName: string | null
  killerIsBot: boolean
  killerTeamId: number | null
  killerPlacement: number | null
  victimPlacement: number | null
  weapon: string | null
  weaponLabel: string
  distance: number | null
  eventTime: string
  isSuicide: boolean
  isTeamkill: boolean
}

export interface MatchDetailResponse {
  player: PlayerSummary
  match: MatchDetailInfo
  me: MatchParticipantDetail
  teammates: MatchParticipantDetail[]
  participants: MatchParticipantDetail[]
  kills: MatchKillDetail[]
  myKills: MatchKillDetail[]
  death: MatchDeathDetail | null
}

export interface KillEvent {
  victimName: string
  victimIsBot: boolean
  weapon: string | null
  weaponLabel: string
  distance: number | null
  eventTime: string
  isTeamkill: boolean
  isSuicide: boolean
  finisherName: string | null
}

export interface RecentSummary {
  count: number
  wins: number
  top10s: number
  kills: number
  damage: number
  avgPlacement: number
  kd: number
  avgDamage: number
  avgSurvival: number
  botKills: number
  humanKills: number
  kdNoBots: number
}

export type JobStatus = 'pending' | 'running' | 'done' | 'failed'
export type CrawlPhase =
  | 'queued'
  | 'resolving_player'
  | 'seasons'
  | 'season_stats'
  | 'matches'
  | 'telemetry'
  | 'done'
  | 'failed'

export interface JobSummary {
  id: string
  playerKey: string
  shard: Shard
  playerName: string
  playerId: string | null
  seasonId: string | null
  kind: string
  priority: number
  runAfter: string | null
  status: JobStatus
  phase: CrawlPhase
  progress: number
  message: string | null
  error: string | null
  attempts: number
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface CrawlInfo {
  state: 'idle' | 'queued' | 'running' | 'failed' | 'offline'
  job: JobSummary | null
  lastSyncedAt: string | null
  stale: boolean
  crawlerOnline: boolean
  refreshAvailableAt: string | null
  refreshCooldownSeconds: number
}

export interface ProfileResponse {
  player: PlayerSummary
  season: SeasonInfo | null
  modes: ModeStats[]
  totals: ModeStats
  defaultMode: string
  recentMatches: MatchSummary[]
  recentMatchesTotal: number
  recentSummary: RecentSummary
  crawl: CrawlInfo
  meta: {
    generatedAt: string
    staleAfterSeconds: number
    recentMatchesLimit: number
    seasonStatsScope: 'all-games'
  }
}

export interface CrawlingResponse {
  status: 'crawling'
  job: JobSummary
  player: PlayerSummary | null
}

export interface MatchesPageResponse {
  matches: MatchSummary[]
  pagination: {
    limit: number
    offset: number
    count: number
    total: number
  }
}

export interface NotFoundResponse {
  error: 'player_not_found'
  message: string
  hint?: string
  retryAfterSeconds?: number
  job?: JobSummary
}

export interface ApiErrorResponse {
  error: string
  message: string
  hint?: string
  retryAfterSeconds?: number
}

export interface HealthResponse {
  ok: boolean
  database: {
    path: string
    schemaVersion: number | null
    players: number
    matches: number
    kills: number
    lastSyncedAt: string | null
  }
  crawler: {
    online: boolean
    lastHeartbeat: string | null
  }
  queue: {
    pending: number
    running: number
    failed: number
  }
}
