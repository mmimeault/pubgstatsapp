import { describe, expect, it } from 'vitest'
import { computeRefreshCooldown } from '../src/cooldown'

const NOW = Date.parse('2026-10-21T12:00:00.000Z')
const secondsAgo = (seconds: number) => new Date(NOW - seconds * 1000).toISOString()

describe('computeRefreshCooldown', () => {
  it('allows a refresh when there is no activity', () => {
    expect(computeRefreshCooldown(null, null, 60, NOW)).toEqual({
      availableAt: null,
      remainingSeconds: 0,
    })
  })

  it('counts down from the last successful sync', () => {
    const result = computeRefreshCooldown(secondsAgo(30), null, 60, NOW)
    expect(result.remainingSeconds).toBe(30)
    expect(result.availableAt).toBe(new Date(NOW + 30_000).toISOString())
  })

  it('uses the most recent activity, including failed job attempts', () => {
    const result = computeRefreshCooldown(secondsAgo(40), secondsAgo(10), 60, NOW)
    expect(result.remainingSeconds).toBe(50)
    expect(result.availableAt).toBe(new Date(NOW + 50_000).toISOString())
  })

  it('is available once the window has elapsed', () => {
    const result = computeRefreshCooldown(secondsAgo(70), secondsAgo(90), 60, NOW)
    expect(result.remainingSeconds).toBe(0)
    expect(result.availableAt).toBe(new Date(NOW - 10_000).toISOString())
  })
})
