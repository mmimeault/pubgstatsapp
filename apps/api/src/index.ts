import Fastify, { type FastifyReply } from 'fastify'
import cors from '@fastify/cors'
import { SHARDS, type ApiErrorResponse, type CrawlingResponse, type HealthResponse, type NotFoundResponse, type Shard } from '@pubgstats/shared'
import { config } from './config'
import { computeRefreshCooldown } from './cooldown'
import { DatabaseNotReadyError, openDatabase, schemaVersion } from './db'
import {
  createJob,
  createSeasonJob,
  createSeasonScanJob,
  findPlayer,
  getActiveJob,
  getHeartbeat,
  getJob,
  getLatestJob,
  heartbeatAgeMs,
  mapJob,
  playerKey,
  queueCounts,
  seasonPlayerKey,
  seasonScanKey,
} from './jobs'
import {
  buildProfile,
  buildSeasonOptions,
  buildSeasonScan,
  buildSeasonStats,
  getSeasonFetch,
  listMatches,
  playerHasSeasonStats,
} from './profile'
import { buildMatchDetail } from './matches'
import { ensureCrawler } from './supervisor'
import { createLogger } from './logger'
import type { Db } from './types'

const log = createLogger()

let db: Db | null = null
let lastDbError: string | null = null

function getDb(): Db | null {
  if (db) return db
  try {
    db = openDatabase(config.dbPath, config.schemaVersionRequired)
    lastDbError = null
    log.info('Database opened', { path: config.dbPath })
  } catch (error) {
    lastDbError =
      error instanceof DatabaseNotReadyError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error)
  }
  return db
}

function requireDb(reply: FastifyReply): Db | null {
  const database = getDb()
  if (!database) {
    ensureCrawler(getDb, log)
    reply.code(503).send({
      error: 'database_not_ready',
      message: lastDbError ?? 'The crawler has not initialized the database yet.',
      hint: 'Start the crawler with `make crawl` or wait a moment for it to initialize.',
    } satisfies ApiErrorResponse)
    return null
  }
  return database
}

const shardSet = new Set<string>(SHARDS)

function parseShard(value: string): Shard | null {
  return shardSet.has(value) ? (value as Shard) : null
}

function parseName(value: string): string | null {
  const name = value.trim()
  if (!name || name.length > 64) return null
  return name
}

function crawlerOnline(database: Db): boolean {
  const age = heartbeatAgeMs(getHeartbeat(database))
  return age !== null && age < config.heartbeatTimeoutMs
}

const app = Fastify({ logger: false, bodyLimit: 1024 * 64 })

await app.register(cors, {
  origin: config.webOrigin === '*' ? true : config.webOrigin,
})

app.get('/api/health', async (): Promise<HealthResponse | Record<string, unknown>> => {
  const database = getDb()
  if (!database) {
    return {
      ok: false,
      message: lastDbError,
      database: {
        path: config.dbPath,
        schemaVersion: null,
        players: 0,
        matches: 0,
        kills: 0,
        lastSyncedAt: null,
      },
      crawler: { online: false, lastHeartbeat: null },
      queue: { pending: 0, running: 0, failed: 0 },
    }
  }

  const counts = database
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM players) AS players,
         (SELECT COUNT(*) FROM matches) AS matches,
         (SELECT COUNT(*) FROM match_kills) AS kills,
         (SELECT MAX(last_synced_at) FROM players) AS last_synced_at`,
    )
    .get() as { players: number; matches: number; kills: number; last_synced_at: string | null }

  const heartbeat = getHeartbeat(database)
  return {
    ok: true,
    database: {
      path: config.dbPath,
      schemaVersion: schemaVersion(database),
      players: counts.players,
      matches: counts.matches,
      kills: counts.kills,
      lastSyncedAt: counts.last_synced_at,
    },
    crawler: {
      online: crawlerOnline(database),
      lastHeartbeat: heartbeat,
    },
    queue: queueCounts(database),
  }
})

app.get<{ Params: { shard: string; name: string } }>(
  '/api/players/:shard/:name',
  async (request, reply) => {
    const database = requireDb(reply)
    if (!database) return

    const shard = parseShard(request.params.shard)
    if (!shard) {
      return reply.code(400).send({
        error: 'invalid_shard',
        message: `Unknown shard "${request.params.shard}".`,
        hint: `Use one of: ${SHARDS.join(', ')}`,
      } satisfies ApiErrorResponse)
    }

    const name = parseName(request.params.name)
    if (!name) {
      return reply.code(400).send({
        error: 'invalid_name',
        message: 'Player name must be between 1 and 64 characters.',
      } satisfies ApiErrorResponse)
    }

    const player = findPlayer(database, shard, name)

    // A first-time crawl stores stats early and matches incrementally. Keep the
    // client on the loader until the crawl is fully done so it never renders a
    // half-populated profile.
    if (player && !player.last_synced_at) {
      const active = getActiveJob(database, playerKey(player.shard, player.name))
      if (active) {
        ensureCrawler(getDb, log)
        return reply.code(202).send({
          status: 'crawling',
          job: mapJob(active),
          player: buildProfile(database, player).player,
        } satisfies CrawlingResponse)
      }
    }

    if (!player) {
      const key = playerKey(shard, name)
      const active = getActiveJob(database, key)
      if (active) {
        ensureCrawler(getDb, log)
        return reply.code(202).send({
          status: 'crawling',
          job: mapJob(active),
          player: null,
        } satisfies CrawlingResponse)
      }

      const latest = getLatestJob(database, key)
      const cooldown = computeRefreshCooldown(
        null,
        latest?.created_at ?? null,
        config.refreshCooldownSeconds,
      )
      const recentlyFailed =
        latest?.status === 'failed' &&
        latest.player_name === name &&
        cooldown.remainingSeconds > 0

      if (recentlyFailed) {
        if (cooldown.remainingSeconds > 0) {
          reply.header('Retry-After', String(cooldown.remainingSeconds))
        }
        return reply.code(404).send({
          error: 'player_not_found',
          message: latest.error ?? `No PUBG player found for "${name}".`,
          hint:
            latest.error_code === 'player_not_found'
              ? 'PUBG names are case-sensitive. Check the exact capitalization and platform.'
              : undefined,
          retryAfterSeconds: cooldown.remainingSeconds || undefined,
          job: mapJob(latest),
        } satisfies NotFoundResponse)
      }

      const { job } = createJob(database, shard, name)
      ensureCrawler(getDb, log)
      return reply.code(202).send({
        status: 'crawling',
        job: mapJob(job),
        player: null,
      } satisfies CrawlingResponse)
    }

    if (!playerHasSeasonStats(database, player.id) && !player.last_synced_at) {
      const active = getActiveJob(database, playerKey(player.shard, player.name))
      if (active) {
        ensureCrawler(getDb, log)
        return reply.code(202).send({
          status: 'crawling',
          job: mapJob(active),
          player: buildProfile(database, player).player,
        } satisfies CrawlingResponse)
      }

      const latest = getLatestJob(database, playerKey(player.shard, player.name))
      if (latest?.status !== 'failed') {
        const { job } = createJob(database, player.shard, player.name)
        ensureCrawler(getDb, log)
        return reply.code(202).send({
          status: 'crawling',
          job: mapJob(job),
          player: buildProfile(database, player).player,
        } satisfies CrawlingResponse)
      }
    }

    return buildProfile(database, player)
  },
)

app.get<{ Params: { shard: string; name: string } }>(
  '/api/players/:shard/:name/seasons',
  async (request, reply) => {
    const database = requireDb(reply)
    if (!database) return

    const shard = parseShard(request.params.shard)
    const name = parseName(request.params.name)
    if (!shard || !name) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: 'Invalid shard or player name.',
      } satisfies ApiErrorResponse)
    }

    const player = findPlayer(database, shard, name)
    if (!player) {
      return reply.code(404).send({
        error: 'player_not_found',
        message: `No cached player "${name}" on ${shard}.`,
        hint: 'Open the player profile first so the crawler can fetch it.',
      } satisfies NotFoundResponse)
    }

    let scan = buildSeasonScan(database, player)
    if (scan.status === 'idle') {
      const key = seasonScanKey(shard, player.name)
      const latest = getLatestJob(database, key)
      let runAfter: string | null = null
      if (latest?.status === 'failed' && latest.created_at) {
        const failedAt = new Date(latest.created_at).getTime()
        if (Date.now() - failedAt < config.seasonScanIntervalSeconds * 1000) {
          runAfter = new Date(
            failedAt + config.seasonScanIntervalSeconds * 1000,
          ).toISOString()
        }
      } else if (latest?.status === 'done' && latest.finished_at) {
        const finishedAt = new Date(latest.finished_at).getTime()
        const nextBatch = finishedAt + config.seasonScanIntervalSeconds * 1000
        if (nextBatch > Date.now()) {
          runAfter = new Date(nextBatch).toISOString()
        }
      }
      createSeasonScanJob(database, shard, player.name, player.id, runAfter)
      ensureCrawler(getDb, log)
      scan = buildSeasonScan(database, player)
    }

    return { seasons: buildSeasonOptions(database, player), scan }
  },
)

app.get<{ Params: { shard: string; name: string; seasonId: string } }>(
  '/api/players/:shard/:name/seasons/:seasonId',
  async (request, reply) => {
    const database = requireDb(reply)
    if (!database) return

    const shard = parseShard(request.params.shard)
    const name = parseName(request.params.name)
    const seasonId = request.params.seasonId.trim()
    if (!shard || !name || !seasonId || seasonId.length > 100) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: 'Invalid shard, player name or season id.',
      } satisfies ApiErrorResponse)
    }

    const player = findPlayer(database, shard, name)
    if (!player) {
      return reply.code(404).send({
        error: 'player_not_found',
        message: `No cached player "${name}" on ${shard}.`,
        hint: 'Open the player profile first so the crawler can fetch it.',
      } satisfies NotFoundResponse)
    }

    const seasonRow = database
      .prepare('SELECT id FROM seasons WHERE shard = ? AND id = ?')
      .get(shard, seasonId) as { id: string } | undefined
    if (!seasonRow) {
      return reply.code(404).send({
        error: 'season_not_found',
        message: `Season "${seasonId}" is not known for ${shard}.`,
      } satisfies ApiErrorResponse)
    }

    const fetchState = getSeasonFetch(database, player.id, seasonId)
    const statCount = (
      database
        .prepare(
          'SELECT COUNT(*) AS count FROM player_season_stats WHERE player_id = ? AND season_id = ?',
        )
        .get(player.id, seasonId) as { count: number }
    ).count
    const fetched =
      fetchState?.status === 'ok' ||
      fetchState?.status === 'empty' ||
      statCount > 0

    if (fetched) {
      const stats = buildSeasonStats(database, player, seasonId)
      if (!stats) {
        return reply.code(404).send({
          error: 'season_not_found',
          message: `No stats available for ${seasonId}.`,
        } satisfies ApiErrorResponse)
      }
      return stats
    }

    const key = seasonPlayerKey(shard, player.name, seasonId)
    const active = getActiveJob(database, key)
    if (active) {
      ensureCrawler(getDb, log)
      return reply.code(202).send({
        status: 'crawling',
        seasonId,
        job: mapJob(active),
      } satisfies import('@pubgstats/shared').SeasonCrawlingResponse)
    }

    const latest = getLatestJob(database, key)
    if (
      latest?.status === 'failed' &&
      Date.now() - new Date(latest.created_at).getTime() < config.refreshCooldownSeconds * 1000
    ) {
      reply.header('Retry-After', String(config.refreshCooldownSeconds))
      return reply.code(404).send({
        error: 'season_not_found',
        message: latest.error ?? `PUBG returned no stats for ${seasonId}.`,
        hint: 'This older season may not be available. Try again later.',
      } satisfies ApiErrorResponse)
    }

    const { job } = createSeasonJob(database, shard, player.name, seasonId)
    ensureCrawler(getDb, log)
    return reply.code(202).send({
      status: 'crawling',
      seasonId,
      job: mapJob(job),
    } satisfies import('@pubgstats/shared').SeasonCrawlingResponse)
  },
)

app.post<{ Params: { shard: string; name: string } }>(
  '/api/players/:shard/:name/refresh',
  async (request, reply) => {
    const database = requireDb(reply)
    if (!database) return

    const shard = parseShard(request.params.shard)
    if (!shard) {
      return reply.code(400).send({
        error: 'invalid_shard',
        message: `Unknown shard "${request.params.shard}".`,
        hint: `Use one of: ${SHARDS.join(', ')}`,
      } satisfies ApiErrorResponse)
    }

    const typedName = parseName(request.params.name)
    if (!typedName) {
      return reply.code(400).send({
        error: 'invalid_name',
        message: 'Player name must be between 1 and 64 characters.',
      } satisfies ApiErrorResponse)
    }

    const player = findPlayer(database, shard, typedName)
    const name = player?.name ?? typedName
    const key = playerKey(shard, name)

    const active = getActiveJob(database, key)
    if (active) {
      ensureCrawler(getDb, log)
      return reply.code(202).send({
        status: 'crawling',
        job: mapJob(active),
        player: player ? buildProfile(database, player).player : null,
      } satisfies CrawlingResponse)
    }

    const latest = getLatestJob(database, key)
    const cooldown = computeRefreshCooldown(
      player?.last_synced_at ?? null,
      latest?.created_at ?? null,
      config.refreshCooldownSeconds,
    )
    if (cooldown.remainingSeconds > 0) {
      reply.header('Retry-After', String(cooldown.remainingSeconds))
      return reply.code(429).send({
        error: 'refresh_cooldown',
        message: `Refresh available in ${cooldown.remainingSeconds}s. Each account can be refreshed once per minute.`,
        retryAfterSeconds: cooldown.remainingSeconds,
      } satisfies ApiErrorResponse)
    }

    const { job } = createJob(database, shard, name)
    ensureCrawler(getDb, log)

    return reply.code(202).send({
      status: 'crawling',
      job: mapJob(job),
      player: player ? buildProfile(database, player).player : null,
    } satisfies CrawlingResponse)
  },
)

app.get<{ Params: { id: string } }>('/api/jobs/:id', async (request, reply) => {
  const database = requireDb(reply)
  if (!database) return

  const job = getJob(database, request.params.id)
  if (!job) {
    return reply.code(404).send({
      error: 'job_not_found',
      message: 'Crawl job not found.',
    } satisfies ApiErrorResponse)
  }
  return mapJob(job)
})

app.get<{ Params: { shard: string; name: string }; Querystring: { limit?: string; offset?: string } }>(
  '/api/players/:shard/:name/matches',
  async (request, reply) => {
    const database = requireDb(reply)
    if (!database) return

    const shard = parseShard(request.params.shard)
    const name = parseName(request.params.name)
    if (!shard || !name) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: 'Invalid shard or player name.',
      } satisfies ApiErrorResponse)
    }

    const player = findPlayer(database, shard, name)
    if (!player) {
      return reply.code(404).send({
        error: 'player_not_found',
        message: `No cached player "${name}" on ${shard}.`,
        hint: 'Open the player profile first so the crawler can fetch it.',
      } satisfies NotFoundResponse)
    }

    const limit = Math.min(50, Math.max(1, Number(request.query.limit) || config.recentMatchLimit))
    const offset = Math.max(0, Number(request.query.offset) || 0)
    const total = (
      database
        .prepare('SELECT COUNT(*) AS count FROM match_participants WHERE player_id = ?')
        .get(player.id) as { count: number }
    ).count

    return {
      matches: listMatches(database, player.id, limit, offset),
      pagination: { limit, offset, count: Math.min(limit, Math.max(0, total - offset)), total },
    }
  },
)

app.get<{
  Params: { shard: string; name: string; matchId: string }
}>('/api/players/:shard/:name/matches/:matchId', async (request, reply) => {
  const database = requireDb(reply)
  if (!database) return

  const shard = parseShard(request.params.shard)
  const name = parseName(request.params.name)
  if (!shard || !name) {
    return reply.code(400).send({
      error: 'invalid_request',
      message: 'Invalid shard or player name.',
    } satisfies ApiErrorResponse)
  }

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.params.matchId)) {
    return reply.code(400).send({
      error: 'invalid_match_id',
      message: 'Match id must be a UUID.',
    } satisfies ApiErrorResponse)
  }

  const player = findPlayer(database, shard, name)
  if (!player) {
    return reply.code(404).send({
      error: 'player_not_found',
      message: `No cached player "${name}" on ${shard}.`,
      hint: 'Open the player profile first so the crawler can fetch it.',
    } satisfies NotFoundResponse)
  }

  const detail = buildMatchDetail(database, player, request.params.matchId)
  if (!detail) {
    return reply.code(404).send({
      error: 'match_not_found',
      message: 'That match is not stored for this player.',
      hint: 'Open the player profile and refresh their recent matches.',
    } satisfies ApiErrorResponse)
  }

  return detail
})

app.get<{ Params: { id: string } }>('/api/matches/:id', async (request, reply) => {
  const database = requireDb(reply)
  if (!database) return

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.params.id)) {
    return reply.code(400).send({
      error: 'invalid_match_id',
      message: 'Match id must be a UUID.',
    } satisfies ApiErrorResponse)
  }

  const match = database.prepare('SELECT * FROM matches WHERE id = ?').get(request.params.id) as
    | {
        id: string
        shard: string
        map_name: string
        game_mode: string
        match_type: string
        duration: number | null
        created_at: string
        season_state: string | null
      }
    | undefined

  if (!match) {
    return reply.code(404).send({
      error: 'match_not_found',
      message: 'Match not found in the local database.',
    } satisfies ApiErrorResponse)
  }

  const participants = database
    .prepare(
      `SELECT player_id, name, placement, kills, headshots, assists, dbno, damage,
              time_survived, walk_distance, ride_distance, death_type, team_id, is_bot
       FROM match_participants WHERE match_id = ?
       ORDER BY placement ASC, kills DESC`,
    )
    .all(match.id)

  const kills = database
    .prepare(
      `SELECT event_time, killer_id, killer_name, killer_is_bot, victim_id, victim_name,
              victim_is_bot, weapon, damage_reason, distance, finisher_name, is_suicide, is_teamkill
       FROM match_kills WHERE match_id = ? ORDER BY event_time ASC`,
    )
    .all(match.id)

  return { match, participants, kills }
})

app.setErrorHandler((error, request, reply) => {
  const message = error instanceof Error ? error.message : String(error)
  const statusCode =
    typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500
  log.error('Request failed', { url: request.url, error: message })
  if (reply.sent) return
  reply.code(statusCode).send({
    error: 'internal_error',
    message: 'Unexpected server error.',
  } satisfies ApiErrorResponse)
})

app.setNotFoundHandler((request, reply) => {
  reply.code(404).send({
    error: 'not_found',
    message: `No route for ${request.method} ${request.url}.`,
  } satisfies ApiErrorResponse)
})

const database = getDb()
ensureCrawler(getDb, log)

const supervisorTimer = setInterval(() => {
  const current = getDb()
  if (!current || !crawlerOnline(current)) ensureCrawler(getDb, log)
}, 10_000)
supervisorTimer.unref()

await app.listen({ port: config.port, host: config.host })
log.info('API listening', {
  url: `http://${config.host}:${config.port}`,
  db: config.dbPath,
  crawlerOnline: database ? crawlerOnline(database) : false,
})

async function shutdown(signal: string) {
  log.info('Shutting down', { signal })
  clearInterval(supervisorTimer)
  await app.close()
  if (db) db.close()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
