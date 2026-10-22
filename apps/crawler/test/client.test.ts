import fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { Db } from '../src/db'
import type { Logger } from '../src/logger'
import { PubgApiError, PubgClient } from '../src/pubg/client'
import type { RateLimiter } from '../src/pubg/rate-limiter'
import type { MatchResponse, PlayerSearchResponse } from '../src/pubg/types'

const fixture = (name: string): string =>
  fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

const playerSearch = JSON.parse(fixture('player-search.json')) as PlayerSearchResponse
const match = JSON.parse(fixture('match.json')) as MatchResponse

function silentLogger(): Logger {
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  }
  return logger
}

function fakeLimiter() {
  return {
    acquire: vi.fn(async () => 7),
    recordStatus: vi.fn(),
  }
}

describe('PubgClient', () => {
  it('waits for X-RateLimit-Reset and retries a 429', async () => {
    let now = 1_700_000_000_000
    const resetAt = Math.floor(now / 1000) + 2
    const sleeps: number[] = []
    const limiter = fakeLimiter()
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: [{ title: 'Too Many Requests' }] }), {
          status: 429,
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(resetAt),
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(playerSearch), { status: 200 }),
      )

    const client = new PubgClient({
      db: null as unknown as Db,
      apiKey: 'test-key',
      rateLimiter: limiter as unknown as RateLimiter,
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms)
        now += ms
      },
    })

    const player = await client.getPlayerByName('steam', 'DarkNext3000')

    expect(player.id).toBe('account.46fd37b1d82a4607b43ebe7aa02841dc')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleeps).toHaveLength(1)
    expect(sleeps[0]).toBeGreaterThanOrEqual(250)
    expect(sleeps[0]).toBeLessThanOrEqual(90_000)
    expect(limiter.acquire).toHaveBeenCalledTimes(2)
    expect(limiter.acquire).toHaveBeenNthCalledWith(1, 'players?filter=playerNames')
    expect(limiter.recordStatus).toHaveBeenCalledTimes(2)
    expect(limiter.recordStatus.mock.calls[0]).toEqual([
      7,
      429,
      { remaining: 0, resetAt },
    ])
  })

  it('maps a 404 on player lookup to player_not_found', async () => {
    const limiter = fakeLimiter()
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          errors: [{ title: 'Not Found', detail: 'Player not found' }],
        }),
        { status: 404 },
      ),
    )

    const client = new PubgClient({
      db: null as unknown as Db,
      apiKey: 'test-key',
      rateLimiter: limiter as unknown as RateLimiter,
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    })

    const error = await client.getPlayerByName('steam', 'darknext3000').catch(
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(PubgApiError)
    expect(error).toMatchObject({
      status: 404,
      code: 'player_not_found',
    })
    expect((error as PubgApiError).hint).toContain('case-sensitive')
  })

  it('does not consume rate limiter slots for match fetches', async () => {
    const limiter = fakeLimiter()
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(match), { status: 200 }),
    )
    const client = new PubgClient({
      db: null as unknown as Db,
      apiKey: 'test-key',
      rateLimiter: limiter as unknown as RateLimiter,
      logger: silentLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    })

    const doc = await client.getMatch('steam', match.data.id)

    expect(doc.data.id).toBe(match.data.id)
    expect(limiter.acquire).not.toHaveBeenCalled()
    expect(limiter.recordStatus).not.toHaveBeenCalled()
  })
})
