import type { Db } from './db'

export interface TelemetryLogger {
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
}

interface TelemetryCharacter {
  accountId?: string | null
  name?: string | null
  teamId?: number | null
  type?: string | null
}

interface TelemetryDamageInfo {
  damageReason?: string | null
  damageCauserName?: string | null
  distance?: number | null
}

interface TelemetryKillEvent {
  _T?: string
  _D?: string
  isSuicide?: boolean
  killer?: TelemetryCharacter | null
  victim?: TelemetryCharacter | null
  finisher?: TelemetryCharacter | null
  killerDamageInfo?: TelemetryDamageInfo | null
  finishDamageInfo?: TelemetryDamageInfo | null
  damageCauserName?: string | null
}

export interface KillRecord {
  eventTime: string
  killerId: string | null
  killerName: string | null
  killerIsBot: boolean
  victimId: string | null
  victimName: string
  victimIsBot: boolean
  weapon: string | null
  damageReason: string | null
  distance: number | null
  finisherName: string | null
  isSuicide: boolean
  isTeamkill: boolean
}

export interface TelemetrySyncOptions {
  concurrency?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
  now?: () => Date
  logger?: TelemetryLogger
  onProgress?: (done: number, total: number, message: string) => void | Promise<void>
}

export interface TelemetrySyncResult {
  pending: number
  processed: number
  failed: number
  killEvents: number
}

interface StoredMatchRow {
  id: string
  telemetry_url: string | null
  raw_json: string | null
}

/** Bots are marked as user_ai/ai in telemetry and carry an ai.* account id. */
export function characterIsBot(character: TelemetryCharacter | null | undefined): boolean {
  if (!character) return false
  const type = (character.type ?? '').toLowerCase()
  if (type === 'user_ai' || type === 'ai') return true
  return (character.accountId ?? '').startsWith('ai.')
}

function finiteOrNull(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function distanceMeters(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = finiteOrNull(value)
    if (parsed !== null && parsed >= 0) return Math.round((parsed / 100) * 10) / 10
  }
  return null
}

export function parseKillEvents(events: unknown): KillRecord[] {
  if (!Array.isArray(events)) throw new Error('Telemetry payload is not an array')
  const kills: KillRecord[] = []

  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue
    const event = raw as TelemetryKillEvent
    if (event._T !== 'LogPlayerKillV2' && event._T !== 'LogPlayerKill') continue

    const victim = event.victim
    if (!victim) continue
    const killer = event.killer ?? null
    const finisher = event.finisher ?? null

    const killerId = killer?.accountId?.trim() || null
    const victimId = victim.accountId?.trim() || null
    const finisherId = finisher?.accountId?.trim() || null
    const killerInfo = event.killerDamageInfo ?? event.finishDamageInfo ?? null
    const finishInfo = event.finishDamageInfo ?? null

    const weapon =
      killerInfo?.damageCauserName?.trim() ||
      finishInfo?.damageCauserName?.trim() ||
      event.damageCauserName?.trim() ||
      null

    const isSuicide = event.isSuicide === true || (!!killerId && killerId === victimId)
    const isTeamkill =
      !isSuicide &&
      killer?.teamId !== null &&
      killer?.teamId !== undefined &&
      victim.teamId !== null &&
      victim.teamId !== undefined &&
      killer.teamId === victim.teamId &&
      killerId !== victimId

    kills.push({
      eventTime: typeof event._D === 'string' ? event._D : new Date(0).toISOString(),
      killerId,
      killerName: killer?.name?.trim() || null,
      killerIsBot: characterIsBot(killer),
      victimId,
      victimName: victim.name?.trim() || 'Unknown',
      victimIsBot: characterIsBot(victim),
      weapon,
      damageReason: killerInfo?.damageReason ?? finishInfo?.damageReason ?? null,
      distance: distanceMeters(killerInfo?.distance, finishInfo?.distance),
      finisherName:
        finisherId && finisherId !== killerId ? finisher?.name?.trim() || null : null,
      isSuicide,
      isTeamkill,
    })
  }

  return kills.sort((a, b) => a.eventTime.localeCompare(b.eventTime))
}

export function extractTelemetryUrl(doc: unknown): string | null {
  if (!doc || typeof doc !== 'object') return null
  const included = (doc as { included?: unknown }).included
  if (!Array.isArray(included)) return null
  for (const item of included) {
    if (!item || typeof item !== 'object') continue
    const resource = item as {
      type?: string
      attributes?: { name?: string; URL?: string }
    }
    if (resource.type !== 'asset') continue
    if (resource.attributes?.name !== 'telemetry') continue
    const url = resource.attributes?.URL?.trim()
    if (url) return url
  }
  return null
}

function storeKills(
  db: Db,
  matchId: string,
  url: string,
  kills: KillRecord[],
  fetchedAt: string,
): void {
  const insert = db.prepare(
    `INSERT INTO match_kills
       (match_id, event_time, killer_id, killer_name, killer_is_bot, victim_id, victim_name,
        victim_is_bot, weapon, damage_reason, distance, finisher_name, is_suicide, is_teamkill)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  const apply = db.transaction(() => {
    db.prepare('DELETE FROM match_kills WHERE match_id = ?').run(matchId)
    for (const kill of kills) {
      insert.run(
        matchId,
        kill.eventTime,
        kill.killerId,
        kill.killerName,
        kill.killerIsBot ? 1 : 0,
        kill.victimId,
        kill.victimName,
        kill.victimIsBot ? 1 : 0,
        kill.weapon,
        kill.damageReason,
        kill.distance,
        kill.finisherName,
        kill.isSuicide ? 1 : 0,
        kill.isTeamkill ? 1 : 0,
      )
    }
    db.prepare(
      `UPDATE matches
       SET telemetry_url = ?, telemetry_fetched_at = ?, telemetry_error = NULL
       WHERE id = ?`,
    ).run(url, fetchedAt, matchId)
  })
  apply()
}

function pendingMatches(db: Db, matchIds: string[]): StoredMatchRow[] {
  const rows: StoredMatchRow[] = []
  for (let offset = 0; offset < matchIds.length; offset += 200) {
    const chunk = matchIds.slice(offset, offset + 200)
    const placeholders = chunk.map(() => '?').join(', ')
    rows.push(
      ...(db
        .prepare(
          `SELECT id, telemetry_url, raw_json FROM matches
           WHERE id IN (${placeholders}) AND telemetry_fetched_at IS NULL`,
        )
        .all(...chunk) as StoredMatchRow[]),
    )
  }
  return rows
}

/**
 * Fetch and cache kill events for stored matches. Telemetry is public and not
 * rate-limited, so this does not consume PUBG API request slots.
 */
export async function ensureTelemetryForMatches(
  db: Db,
  matchIds: string[],
  options: TelemetrySyncOptions = {},
): Promise<TelemetrySyncResult> {
  const pending = pendingMatches(db, matchIds)
  const result: TelemetrySyncResult = {
    pending: pending.length,
    processed: 0,
    failed: 0,
    killEvents: 0,
  }
  if (pending.length === 0) return result

  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 60_000
  const clock = options.now ?? (() => new Date())
  const logger = options.logger
  let processedCount = 0

  const report = async () => {
    if (options.onProgress) {
      await options.onProgress(
        processedCount,
        pending.length,
        `Fetched kill events ${processedCount}/${pending.length}`,
      )
    }
  }

  const processOne = async (row: StoredMatchRow): Promise<void> => {
    let url = row.telemetry_url
    if (!url && row.raw_json) {
      try {
        url = extractTelemetryUrl(JSON.parse(row.raw_json))
      } catch {
        url = null
      }
    }

    if (!url) {
      db.prepare('UPDATE matches SET telemetry_error = ? WHERE id = ?').run(
        'No telemetry asset found for this match',
        row.id,
      )
      result.failed += 1
      processedCount += 1
      logger?.warn('telemetry asset missing', { matchId: row.id })
      await report()
      return
    }

    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) {
        throw new Error(`Telemetry request failed with HTTP ${response.status}`)
      }

      const payload: unknown = await response.json()
      const kills = parseKillEvents(payload)
      storeKills(db, row.id, url, kills, clock().toISOString())
      result.processed += 1
      result.killEvents += kills.length
      logger?.info('telemetry indexed', { matchId: row.id, kills: kills.length })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      db.prepare('UPDATE matches SET telemetry_error = ? WHERE id = ?').run(message, row.id)
      result.failed += 1
      logger?.warn('telemetry failed', { matchId: row.id, error: message })
    }

    processedCount += 1
    await report()
  }

  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, pending.length))
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      if (index >= pending.length) return
      cursor += 1
      await processOne(pending[index])
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return result
}
