import { describe, expect, it } from 'vitest'
import { migrate, openDb, type Db } from '../src/db'
import { ensureTelemetryForMatches, extractTelemetryUrl, parseKillEvents } from '../src/telemetry'

const ME = 'account.me'
const OTHER = 'account.other'

const events = [
  {
    _T: 'LogPlayerKillV2',
    _D: '2026-10-19T03:01:00.000Z',
    killer: { name: 'DarkNext3000', accountId: ME, teamId: 1, type: 'user' },
    victim: { name: 'BotOne', accountId: 'ai.1', teamId: 200, type: 'user_ai' },
    finisher: { name: 'DarkNext3000', accountId: ME, teamId: 1, type: 'user' },
    killerDamageInfo: { damageReason: 'TorsoShot', damageCauserName: 'WeapM24_C', distance: 6348 },
    finishDamageInfo: { damageReason: 'TorsoShot', damageCauserName: 'WeapM24_C', distance: 6348 },
    isSuicide: false,
  },
  {
    _T: 'LogPlayerKillV2',
    _D: '2026-10-19T03:02:00.000Z',
    killer: { name: 'DarkNext3000', accountId: ME, teamId: 1, type: 'user' },
    victim: { name: 'HumanVictim', accountId: OTHER, teamId: 2, type: 'user' },
    finisher: { name: 'Teammate', accountId: 'account.teammate', teamId: 1, type: 'user' },
    killerDamageInfo: { damageReason: 'HeadShot', damageCauserName: 'WeapKar98k_C', distance: 1200 },
    finishDamageInfo: { damageReason: 'TorsoShot', damageCauserName: 'WeapM416_C', distance: 2500 },
    isSuicide: false,
  },
  {
    _T: 'LogPlayerKillV2',
    _D: '2026-10-19T03:03:00.000Z',
    killer: { name: 'BotKiller', accountId: 'ai.2', teamId: 300, type: 'user_ai' },
    victim: { name: 'DarkNext3000', accountId: ME, teamId: 1, type: 'user' },
    finisher: { name: 'BotKiller', accountId: 'ai.2', teamId: 300, type: 'user_ai' },
    killerDamageInfo: { damageReason: 'TorsoShot', damageCauserName: 'WeapUMP_C', distance: 800 },
    finishDamageInfo: { damageReason: 'TorsoShot', damageCauserName: 'WeapUMP_C', distance: 800 },
    isSuicide: false,
  },
  {
    _T: 'LogPlayerKillV2',
    _D: '2026-10-19T03:04:00.000Z',
    killer: { name: 'DarkNext3000', accountId: ME, teamId: 1, type: 'user' },
    victim: { name: 'DarkNext3000', accountId: ME, teamId: 1, type: 'user' },
    killerDamageInfo: { damageReason: 'Fall', damageCauserName: null, distance: -1 },
    finishDamageInfo: null,
    isSuicide: true,
  },
  {
    _T: 'LogPlayerKillV2',
    _D: '2026-10-19T03:05:00.000Z',
    killer: { name: 'DarkNext3000', accountId: ME, teamId: 1, type: 'user' },
    victim: { name: 'Teammate', accountId: 'account.teammate', teamId: 1, type: 'user' },
    finisher: { name: 'DarkNext3000', accountId: ME, teamId: 1, type: 'user' },
    killerDamageInfo: { damageReason: 'TorsoShot', damageCauserName: 'WeapAK47_C', distance: 400 },
    finishDamageInfo: { damageReason: 'TorsoShot', damageCauserName: 'WeapAK47_C', distance: 400 },
    isSuicide: false,
  },
  {
    _T: 'LogPlayerPosition',
    _D: '2026-10-19T03:06:00.000Z',
  },
]

function matchDoc(telemetryUrl: string | null) {
  return {
    included: telemetryUrl
      ? [{ type: 'asset', attributes: { name: 'telemetry', URL: telemetryUrl } }]
      : [],
  }
}

function setup(raw: unknown): Db {
  const db = openDb(':memory:')
  migrate(db)
  const now = new Date('2026-10-20T00:00:00.000Z').toISOString()
  db.prepare(
    `INSERT INTO matches
       (id, shard, map_name, game_mode, match_type, created_at, raw_json, fetched_at)
     VALUES ('match-1', 'steam', 'Baltic_Main', 'duo-fpp', 'official', ?, ?, ?)`,
  ).run('2026-10-19T03:00:00.000Z', JSON.stringify(raw), now)
  return db
}

describe('parseKillEvents', () => {
  it('maps victims, bots, weapons and distances', () => {
    const kills = parseKillEvents(events)

    expect(kills).toHaveLength(5)
    expect(kills[0]).toMatchObject({
      victimName: 'BotOne',
      victimIsBot: true,
      killerIsBot: false,
      weapon: 'WeapM24_C',
      distance: 63.5,
      isSuicide: false,
      isTeamkill: false,
    })
    expect(kills[1]).toMatchObject({
      victimIsBot: false,
      weapon: 'WeapKar98k_C',
      distance: 12,
      finisherName: 'Teammate',
      damageReason: 'HeadShot',
    })
    expect(kills[2]).toMatchObject({
      killerName: 'BotKiller',
      killerIsBot: true,
      victimIsBot: false,
    })
    expect(kills[3]).toMatchObject({ isSuicide: true, isTeamkill: false })
    expect(kills[4]).toMatchObject({ isTeamkill: true, victimName: 'Teammate' })
  })
})

describe('ensureTelemetryForMatches', () => {
  it('stores kill events once and reuses them on later syncs', async () => {
    const db = setup(matchDoc('https://example.test/telemetry.json'))
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return new Response(JSON.stringify(events), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const first = await ensureTelemetryForMatches(db, ['match-1'], {
      fetchImpl,
      concurrency: 1,
      now: () => new Date('2026-10-20T00:00:00.000Z'),
    })

    expect(first).toMatchObject({ pending: 1, processed: 1, failed: 0, killEvents: 5 })
    expect(calls).toBe(1)
    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM match_kills').get() as { count: number }).count,
    ).toBe(5)

    const botKill = db
      .prepare("SELECT * FROM match_kills WHERE victim_id = 'ai.1'")
      .get() as { victim_is_bot: number; killer_id: string; distance: number }
    expect(botKill.victim_is_bot).toBe(1)
    expect(botKill.killer_id).toBe(ME)
    expect(botKill.distance).toBeCloseTo(63.5)

    const row = db
      .prepare('SELECT telemetry_url, telemetry_fetched_at, telemetry_error FROM matches WHERE id = ?')
      .get('match-1') as {
      telemetry_url: string
      telemetry_fetched_at: string
      telemetry_error: string | null
    }
    expect(row.telemetry_url).toBe('https://example.test/telemetry.json')
    expect(row.telemetry_fetched_at).toBe('2026-10-20T00:00:00.000Z')
    expect(row.telemetry_error).toBeNull()

    const second = await ensureTelemetryForMatches(db, ['match-1'], {
      fetchImpl: (async () => {
        throw new Error('should not fetch again')
      }) as typeof fetch,
    })
    expect(second).toMatchObject({ pending: 0, processed: 0, failed: 0 })
    expect(calls).toBe(1)
    db.close()
  })

  it('records a telemetry error without throwing when the URL is missing', async () => {
    const db = setup({ included: [] })
    const result = await ensureTelemetryForMatches(db, ['match-1'], {
      fetchImpl: (async () => new Response('[]')) as typeof fetch,
    })

    expect(result).toMatchObject({ pending: 1, processed: 0, failed: 1 })
    const row = db
      .prepare('SELECT telemetry_error, telemetry_fetched_at FROM matches WHERE id = ?')
      .get('match-1') as { telemetry_error: string; telemetry_fetched_at: string | null }
    expect(row.telemetry_error).toContain('No telemetry asset')
    expect(row.telemetry_fetched_at).toBeNull()
    db.close()
  })
})

describe('extractTelemetryUrl', () => {
  it('finds the telemetry asset URL', () => {
    expect(extractTelemetryUrl(matchDoc('https://example.test/x.json'))).toBe(
      'https://example.test/x.json',
    )
    expect(extractTelemetryUrl({ included: [] })).toBeNull()
    expect(extractTelemetryUrl(null)).toBeNull()
  })
})
