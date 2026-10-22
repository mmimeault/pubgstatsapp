import type { Shard } from '@pubgstats/shared'
import type { Db } from '../db'
import type { Logger } from '../logger'
import { sleep as realSleep } from '../logger'
import {
  parseRateHeaders,
  type RateLimiter,
  type RateLimitSnapshot,
} from './rate-limiter'
import type {
  JsonApiErrorObject,
  MatchResponse,
  PlayerResource,
  PlayerResponse,
  PlayerSearchResponse,
  PlayerSeasonResource,
  PlayerSeasonResponse,
  SeasonResource,
  SeasonsResponse,
} from './types'

export type PubgErrorCode =
  | 'player_not_found'
  | 'match_not_found'
  | 'season_not_found'
  | 'not_found'
  | 'bad_request'
  | 'unauthorized'
  | 'rate_limited'
  | 'server_error'
  | 'timeout'
  | 'network_error'
  | 'invalid_response'
  | 'http_error'

export interface PubgApiErrorOptions {
  status?: number
  code: PubgErrorCode
  hint?: string
  retryAfterSeconds?: number
  detail?: string
}

export class PubgApiError extends Error {
  readonly status: number | null
  readonly code: PubgErrorCode
  readonly hint?: string
  readonly retryAfterSeconds?: number
  readonly detail?: string

  constructor(message: string, options: PubgApiErrorOptions) {
    super(message)
    this.name = 'PubgApiError'
    this.status = options.status ?? null
    this.code = options.code
    this.hint = options.hint
    this.retryAfterSeconds = options.retryAfterSeconds
    this.detail = options.detail
  }
}

/** Structural interface so tests can provide a fixture-backed client. */
export interface PubgApi {
  getPlayerByName(shard: Shard, name: string): Promise<PlayerResource>
  getPlayerById(shard: Shard, id: string): Promise<PlayerResource>
  getSeasons(shard: Shard): Promise<SeasonResource[]>
  getSeasonStats(
    shard: Shard,
    playerId: string,
    seasonId: string,
  ): Promise<PlayerSeasonResource>
  getMatch(shard: Shard, matchId: string): Promise<MatchResponse>
}

export interface PubgClientOptions {
  db: Db
  apiKey: string
  baseUrl?: string
  rateLimiter: RateLimiter
  timeoutMs?: number
  logger: Logger
  /** Injection points, primarily for tests. */
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  maxAttempts?: number
  rateLimitBufferMs?: number
}

interface RequestOptions {
  rateLimited: boolean
  endpoint: string
  notFoundCode?: PubgErrorCode
  notFoundHint?: string
}

export class PubgClient implements PubgApi {
  private readonly db: Db
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly rateLimiter: RateLimiter
  private readonly timeoutMs: number
  private readonly logger: Logger
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly sleepFn: (ms: number) => Promise<void>
  private readonly maxAttempts: number
  private readonly rateLimitBufferMs: number

  constructor(options: PubgClientOptions) {
    this.db = options.db
    this.apiKey = options.apiKey
    this.baseUrl = (options.baseUrl ?? 'https://api.pubg.com').replace(/\/+$/, '')
    this.rateLimiter = options.rateLimiter
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.logger = options.logger
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.now = options.now ?? Date.now
    this.sleepFn = options.sleep ?? realSleep
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3)
    this.rateLimitBufferMs = options.rateLimitBufferMs ?? 1_000
  }

  async getPlayerByName(shard: Shard, name: string): Promise<PlayerResource> {
    const path = `/shards/${encodeURIComponent(shard)}/players?filter%5BplayerNames%5D=${encodeURIComponent(name)}`
    const doc = await this.request<PlayerSearchResponse>(path, {
      rateLimited: true,
      endpoint: 'players?filter=playerNames',
      notFoundCode: 'player_not_found',
      notFoundHint:
        'PUBG player names are case-sensitive. Check the exact spelling and capitalization of the name.',
    })

    const resource = Array.isArray(doc.data) ? doc.data[0] : undefined
    if (!resource || typeof resource.id !== 'string' || !resource.id) {
      throw new PubgApiError(`Player "${name}" was not found on ${shard}`, {
        status: 404,
        code: 'player_not_found',
        hint: 'PUBG player names are case-sensitive. Check the exact spelling and capitalization of the name.',
      })
    }
    return resource
  }

  async getPlayerById(shard: Shard, id: string): Promise<PlayerResource> {
    const path = `/shards/${encodeURIComponent(shard)}/players/${encodeURIComponent(id)}`
    const doc = await this.request<PlayerResponse>(path, {
      rateLimited: true,
      endpoint: 'players/{id}',
      notFoundCode: 'player_not_found',
      notFoundHint: 'The stored player id no longer exists on this shard; try looking the player up by name.',
    })
    return this.expectResource<PlayerResource>(doc.data, 'player')
  }

  async getSeasons(shard: Shard): Promise<SeasonResource[]> {
    const path = `/shards/${encodeURIComponent(shard)}/seasons`
    const doc = await this.request<SeasonsResponse>(path, {
      rateLimited: true,
      endpoint: 'seasons',
    })
    if (!Array.isArray(doc.data)) {
      throw new PubgApiError('PUBG seasons response did not contain a list', {
        code: 'invalid_response',
      })
    }
    return doc.data
  }

  async getSeasonStats(
    shard: Shard,
    playerId: string,
    seasonId: string,
  ): Promise<PlayerSeasonResource> {
    const path = `/shards/${encodeURIComponent(shard)}/players/${encodeURIComponent(playerId)}/seasons/${encodeURIComponent(seasonId)}`
    const doc = await this.request<PlayerSeasonResponse>(path, {
      rateLimited: true,
      endpoint: 'season-stats',
      notFoundCode: 'season_not_found',
    })
    return this.expectObject<PlayerSeasonResource>(doc.data, 'player season stats')
  }

  async getMatch(shard: Shard, matchId: string): Promise<MatchResponse> {
    const path = `/shards/${encodeURIComponent(shard)}/matches/${encodeURIComponent(matchId)}`
    // Match payloads are explicitly exempt from PUBG's rate limit.
    return this.request<MatchResponse>(path, {
      rateLimited: false,
      endpoint: 'matches',
      notFoundCode: 'match_not_found',
    })
  }

  private expectResource<T extends { id?: string }>(value: unknown, label: string): T {
    if (!value || typeof value !== 'object' || typeof (value as { id?: unknown }).id !== 'string') {
      throw new PubgApiError(`PUBG ${label} response was malformed`, {
        code: 'invalid_response',
      })
    }
    return value as T
  }

  /**
   * Some PUBG resources (notably playerSeason) legitimately return `id: null`,
   * so only require an object for those.
   */
  private expectObject<T>(value: unknown, label: string): T {
    if (!value || typeof value !== 'object') {
      throw new PubgApiError(`PUBG ${label} response was malformed`, {
        code: 'invalid_response',
      })
    }
    return value as T
  }

  private async request<T>(path: string, options: RequestOptions): Promise<T> {
    const url = `${this.baseUrl}${path}`
    let attempt = 0

    for (;;) {
      attempt += 1
      const callId = options.rateLimited
        ? await this.rateLimiter.acquire(options.endpoint)
        : null
      let recorded = false

      try {
        const response = await this.fetchImpl(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'application/vnd.api+json',
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        })

        const snapshot = this.readRateSnapshot(response.headers)
        const body = await this.readBody(response)
        const status = response.status

        if (callId !== null) {
          this.rateLimiter.recordStatus(callId, status, snapshot)
          recorded = true
        }

        this.logger.debug('PUBG request completed', {
          endpoint: options.endpoint,
          status,
        })

        if (status === 429) {
          const waitMs = this.rateLimitWaitMs(snapshot)
          if (attempt >= this.maxAttempts) {
            throw new PubgApiError('PUBG API rate limit exceeded', {
              status,
              code: 'rate_limited',
              retryAfterSeconds: Math.ceil(waitMs / 1000),
            })
          }
          this.logger.warn('PUBG rate limit hit; waiting for reset', {
            endpoint: options.endpoint,
            attempt,
            waitMs,
          })
          await this.sleepFn(waitMs)
          continue
        }

        if (status >= 500) {
          if (attempt >= this.maxAttempts) {
            throw new PubgApiError(`PUBG API returned HTTP ${status}`, {
              status,
              code: 'server_error',
              detail: this.errorDetail(body),
            })
          }
          await this.sleepFn(this.backoffMs(attempt))
          continue
        }

        if (status === 404) {
          throw new PubgApiError(
            this.errorMessage(body) ?? `PUBG resource not found (${options.endpoint})`,
            {
              status,
              code: options.notFoundCode ?? 'not_found',
              hint: options.notFoundHint,
              detail: this.errorDetail(body),
            },
          )
        }

        if (status === 400) {
          throw new PubgApiError(
            this.errorMessage(body) ?? 'PUBG API rejected the request',
            { status, code: 'bad_request', detail: this.errorDetail(body) },
          )
        }

        if (status === 401 || status === 403) {
          throw new PubgApiError('PUBG API rejected the credentials', {
            status,
            code: 'unauthorized',
            hint: 'Check PUBG_API_KEY.',
          })
        }

        if (!response.ok) {
          throw new PubgApiError(`PUBG API returned HTTP ${status}`, {
            status,
            code: 'http_error',
            detail: this.errorDetail(body),
          })
        }

        if (body === null || typeof body !== 'object') {
          throw new PubgApiError('PUBG API returned an empty response', {
            status,
            code: 'invalid_response',
          })
        }

        return body as T
      } catch (error) {
        if (error instanceof PubgApiError) throw error

        if (callId !== null && !recorded) {
          this.rateLimiter.recordStatus(callId, 0, { remaining: null, resetAt: null })
        }

        const timedOut = this.isTimeout(error)
        if (attempt >= this.maxAttempts) {
          throw new PubgApiError(
            timedOut ? 'PUBG API request timed out' : 'PUBG API request failed',
            {
              code: timedOut ? 'timeout' : 'network_error',
              detail: error instanceof Error ? error.message : undefined,
            },
          )
        }

        const waitMs = this.backoffMs(attempt)
        this.logger.warn(timedOut ? 'PUBG request timed out; retrying' : 'PUBG request failed; retrying', {
          endpoint: options.endpoint,
          attempt,
          waitMs,
        })
        await this.sleepFn(waitMs)
      }
    }
  }

  private readRateSnapshot(headers: Headers): RateLimitSnapshot {
    try {
      return parseRateHeaders(headers)
    } catch {
      return { remaining: null, resetAt: null }
    }
  }

  private async readBody(response: Response): Promise<unknown> {
    const text = await response.text()
    if (!text) return null
    try {
      return JSON.parse(text) as unknown
    } catch {
      return null
    }
  }

  private errorMessage(body: unknown): string | undefined {
    const errors = (body as { errors?: JsonApiErrorObject[] } | null)?.errors
    const first = Array.isArray(errors) ? errors[0] : undefined
    return first?.detail ?? first?.title ?? undefined
  }

  private errorDetail(body: unknown): string | undefined {
    const errors = (body as { errors?: JsonApiErrorObject[] } | null)?.errors
    if (!Array.isArray(errors) || errors.length === 0) return undefined
    return errors
      .map((item) => [item.title, item.detail].filter(Boolean).join(': '))
      .filter(Boolean)
      .join('; ')
      .slice(0, 500)
  }

  private backoffMs(attempt: number): number {
    return 1_000 * 2 ** (attempt - 1)
  }

  private rateLimitWaitMs(snapshot: RateLimitSnapshot): number {
    const now = this.now()
    const resetMs = snapshot.resetAt !== null ? snapshot.resetAt * 1000 : now + 60_000
    const waitMs = resetMs - now + this.rateLimitBufferMs
    return Math.min(90_000, Math.max(250, waitMs))
  }

  private isTimeout(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false
    const name = (error as { name?: string }).name
    return name === 'TimeoutError' || name === 'AbortError'
  }
}
