/**
 * Minimal, tolerant typings for the subset of the PUBG JSON:API we consume.
 * Every attribute is optional because PUBG adds/removes fields over time and
 * bots often have incomplete payloads.
 */

export interface JsonApiResourceIdentifier {
  type: string
  id: string
}

export interface JsonApiRelationship<T extends JsonApiResourceIdentifier = JsonApiResourceIdentifier> {
  data?: T | T[] | null
}

export interface JsonApiResource<TAttributes = Record<string, unknown>> {
  type: string
  id: string
  attributes?: TAttributes
  relationships?: Record<string, JsonApiRelationship | undefined>
}

export interface JsonApiErrorObject {
  status?: string
  code?: string
  title?: string
  detail?: string
  source?: { pointer?: string; parameter?: string }
}

export interface JsonApiLinks {
  self?: string
  schema?: string
}

export interface JsonApiDocument<TData> {
  data: TData
  included?: JsonApiResource[]
  errors?: JsonApiErrorObject[]
  links?: JsonApiLinks
  meta?: Record<string, unknown>
}

export interface PlayerAttributes {
  name?: string
  stats?: unknown | null
  titleId?: string
  shardId?: string
  patchVersion?: string
  banType?: string
  clanId?: string
  [key: string]: unknown
}

export interface PlayerRelationships {
  assets?: JsonApiRelationship
  matches?: JsonApiRelationship
  [key: string]: JsonApiRelationship | undefined
}

export type PlayerResource = JsonApiResource<PlayerAttributes> & {
  relationships?: PlayerRelationships
}

export type PlayerSearchResponse = JsonApiDocument<PlayerResource[]>
export type PlayerResponse = JsonApiDocument<PlayerResource>

export interface SeasonAttributes {
  isCurrentSeason?: boolean
  isOffseason?: boolean
  [key: string]: unknown
}

export type SeasonResource = JsonApiResource<SeasonAttributes>
export type SeasonsResponse = JsonApiDocument<SeasonResource[]>

export interface GameModeStat {
  roundsPlayed?: number
  wins?: number
  top10s?: number
  kills?: number
  assists?: number
  damageDealt?: number
  headshotKills?: number
  timeSurvived?: number
  longestKill?: number
  bestRankPoint?: number | null
  [key: string]: unknown
}

export interface RankedGameModeStat extends GameModeStat {
  currentRankPoint?: number
  bestRankPoint?: number | null
  rankPoints?: number
  rankPointsTitle?: string
}

export interface PlayerSeasonAttributes {
  gameModeStats?: Record<string, GameModeStat>
  rankedGameModeStats?: Record<string, RankedGameModeStat>
  [key: string]: unknown
}

export type PlayerSeasonResource = JsonApiResource<PlayerSeasonAttributes>
export type PlayerSeasonResponse = JsonApiDocument<PlayerSeasonResource>

export interface MatchAttributes {
  mapName?: string
  matchType?: string
  seasonState?: string
  createdAt?: string
  stats?: unknown | null
  gameMode?: string
  tags?: unknown | null
  isCustomMatch?: boolean
  duration?: number
  titleId?: string
  shardId?: string
  [key: string]: unknown
}

export type MatchResource = JsonApiResource<MatchAttributes>
export type MatchResponse = JsonApiDocument<MatchResource>

export interface ParticipantStats {
  DBNOs?: number
  assists?: number
  boosts?: number
  damageDealt?: number
  deathType?: string
  headshotKills?: number
  heals?: number
  killPlace?: number
  killStreaks?: number
  kills?: number
  longestKill?: number
  name?: string
  playerId?: string
  revives?: number
  rideDistance?: number
  roadKills?: number
  swimDistance?: number
  teamKills?: number
  timeSurvived?: number
  vehicleDestroys?: number
  walkDistance?: number
  weaponsAcquired?: number
  winPlace?: number
  [key: string]: unknown
}

export interface ParticipantAttributes {
  actor?: string
  shardId?: string
  stats?: ParticipantStats
  [key: string]: unknown
}

export interface RosterStats {
  rank?: number
  teamId?: number
  [key: string]: unknown
}

export interface RosterAttributes {
  won?: string
  shardId?: string
  stats?: RosterStats
  [key: string]: unknown
}

export type ParticipantResource = JsonApiResource<ParticipantAttributes>
export type RosterResource = JsonApiResource<RosterAttributes>

export function asPlayerResource(value: unknown): PlayerResource | null {
  if (!value || typeof value !== 'object') return null
  const resource = value as Partial<PlayerResource>
  if (typeof resource.id !== 'string' || !resource.id) return null
  return resource as PlayerResource
}

export function isParticipant(resource: JsonApiResource): resource is ParticipantResource {
  return resource.type === 'participant'
}

export function isRoster(resource: JsonApiResource): resource is RosterResource {
  return resource.type === 'roster'
}
