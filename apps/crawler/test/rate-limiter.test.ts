import { describe, expect, it } from 'vitest'
import { migrate, openDb } from '../src/db'
import { RateLimiter } from '../src/pubg/rate-limiter'

function harness(rpm = 10) {
  const db = openDb(':memory:')
  migrate(db)
  let now = 1_700_000_000_000
  const sleeps: number[] = []
  const options = {
    rpm,
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      now += ms
    },
  }
  return {
    db,
    options,
    sleeps,
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

function assertNoWindowViolation(
  db: ReturnType<typeof harness>['db'],
  rpm: number,
): void {
  const rows = db
    .prepare('SELECT called_at FROM api_calls ORDER BY id ASC')
    .all() as Array<{ called_at: number }>
  const times = rows.map((row) => row.called_at)
  for (const time of times) {
    const inWindow = times.filter(
      (candidate) => candidate > time - 60_000 && candidate <= time,
    ).length
    expect(inWindow).toBeLessThanOrEqual(rpm)
  }
}

describe('RateLimiter', () => {
  it('never issues more than rpm calls inside a rolling 60s window', async () => {
    const env = harness(10)
    const limiter = new RateLimiter(env.db, env.options)

    for (let index = 0; index < 35; index += 1) {
      await limiter.acquire('players?filter=playerNames')
    }

    expect(env.sleeps.length).toBeGreaterThan(0)
    expect(env.sleeps.every((ms) => ms > 0)).toBe(true)
    assertNoWindowViolation(env.db, 10)
    expect(limiter.usedInWindow()).toBeLessThanOrEqual(10)
    env.db.close()
  })

  it('persists the ledger across limiter instances', async () => {
    const env = harness(10)
    const first = new RateLimiter(env.db, env.options)
    for (let index = 0; index < 10; index += 1) {
      await first.acquire('seasons')
    }
    expect(env.sleeps).toHaveLength(0)
    expect(first.usedInWindow()).toBe(10)

    // A brand new instance (simulating a process restart) must see the same
    // persisted calls and wait instead of bursting.
    const second = new RateLimiter(env.db, env.options)
    expect(second.usedInWindow()).toBe(10)
    await second.acquire('season-stats')

    expect(env.sleeps).toHaveLength(1)
    expect(env.sleeps[0]).toBe(60_050)
    assertNoWindowViolation(env.db, 10)
    expect(second.usedInWindow()).toBeLessThanOrEqual(10)
    env.db.close()
  })
})
