import fs from 'node:fs'
import { SHARDS, type CrawlPhase, type Shard } from '@pubgstats/shared'
import { config } from './config'
import { getSchemaVersion, migrate, openDb, tableCount } from './db'
import { syncPlayer, syncSeasons } from './ingest'
import {
  claimJob,
  createJob,
  getHeartbeat,
  getJob,
  recentJobs,
  updateJob,
} from './jobs'
import { createLogger } from './logger'
import { PubgApiError, PubgClient } from './pubg/client'
import { RateLimiter } from './pubg/rate-limiter'

const USAGE = `Usage:
  tsx src/cli.ts sync --shard steam --name DarkNext3000 [--matches 20]
  tsx src/cli.ts status
  tsx src/cli.ts seasons sync --shard steam

Shards: ${SHARDS.join(', ')}`

interface ParsedArgs {
  command: string
  positionals: string[]
  flags: Map<string, string>
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] ?? 'help'
  const positionals: string[] = []
  const flags = new Map<string, string>()

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg.startsWith('--')) {
      const [rawKey, inlineValue] = arg.slice(2).split('=', 2)
      if (inlineValue !== undefined) {
        flags.set(rawKey, inlineValue)
      } else if (argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) {
        flags.set(rawKey, argv[index + 1])
        index += 1
      } else {
        flags.set(rawKey, 'true')
      }
    } else {
      positionals.push(arg)
    }
  }

  return { command, positionals, flags }
}

function shardFrom(value: string | undefined): Shard {
  const shard = value ?? 'steam'
  if (!SHARDS.includes(shard as Shard)) {
    throw new Error(`Unknown shard "${shard}". Expected one of: ${SHARDS.join(', ')}`)
  }
  return shard as Shard
}

function requireApiKey(): void {
  if (!config.apiKey) {
    throw new Error(
      'PUBG_API_KEY is not set. Add it to the repository .env file before syncing.',
    )
  }
}

function makeClient(db: ReturnType<typeof openDb>): PubgClient {
  const logger = createLogger(config.logLevel as 'debug' | 'info' | 'warn' | 'error', {
    app: 'crawler-cli',
  })
  const limiter = new RateLimiter(db, {
    rpm: config.rateLimitRpm,
    onWait: (waitMs) => logger.warn('rate limiter waiting', { waitMs }),
  })
  return new PubgClient({
    db,
    apiKey: config.apiKey,
    baseUrl: config.apiBaseUrl,
    rateLimiter: limiter,
    timeoutMs: config.requestTimeoutMs,
    logger,
  })
}

function printError(error: unknown): void {
  if (error instanceof PubgApiError) {
    console.error(`Error (${error.code}): ${error.message}`)
    if (error.hint) console.error(`Hint: ${error.hint}`)
  } else if (error instanceof Error) {
    console.error(`Error: ${error.message}`)
  } else {
    console.error(`Error: ${String(error)}`)
  }
}

async function runSync(args: ParsedArgs): Promise<number> {
  requireApiKey()
  const shard = shardFrom(args.flags.get('shard'))
  const name = args.flags.get('name')?.trim()
  if (!name) throw new Error('Missing --name')

  const matches = args.flags.get('matches')
  const matchLimit = matches === undefined ? config.matchLimit : Number(matches)
  if (!Number.isInteger(matchLimit) || matchLimit < 0) {
    throw new Error('--matches must be a non-negative integer')
  }

  const db = openDb(config.dbPath)
  try {
    migrate(db)
    const created = createJob(db, shard, name)
    if (created.status === 'running') {
      throw new Error(
        `Job ${created.id} is already running; wait for the crawler to finish it.`,
      )
    }
    const job = claimJob(db, created.id)
    if (!job) {
      throw new Error(`Could not claim job ${created.id}`)
    }

    const client = makeClient(db)
    const startedAt = new Date().toISOString()
    updateJob(db, job.id, {
      phase: 'resolving_player',
      progress: 0,
      message: 'Starting sync',
      started_at: startedAt,
      finished_at: null,
      error: null,
      error_code: null,
    })

    try {
      const result = await syncPlayer(
        db,
        client,
        {
          id: job.id,
          shard,
          player_name: name,
          player_id: job.playerId,
        },
        {
          matchLimit,
          matchConcurrency: config.matchConcurrency,
          seasonCacheHours: config.seasonCacheHours,
          telemetryConcurrency: config.telemetryConcurrency,
          telemetryTimeoutMs: config.telemetryTimeoutMs,
          onProgress: (update) => {
            process.stderr.write(
              `[${update.phase}] ${update.progress}%${update.message ? ` ${update.message}` : ''}\n`,
            )
            updateJob(db, job.id, {
              phase: update.phase as CrawlPhase,
              progress: update.progress,
              message: update.message ?? null,
            })
          },
        },
      )

      updateJob(db, job.id, {
        status: 'done',
        phase: 'done',
        progress: 100,
        message: `Synced ${result.matchesRequested} matches (${result.matchesFetched} fetched)`,
        error: null,
        error_code: null,
        player_id: result.playerId,
        finished_at: new Date().toISOString(),
      })
      console.log(JSON.stringify(result, null, 2))
      return 0
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      updateJob(db, job.id, {
        status: 'failed',
        phase: 'failed',
        message,
        error: message,
        error_code: error instanceof PubgApiError ? error.code : 'crawler_error',
        finished_at: new Date().toISOString(),
      })
      throw error
    }
  } finally {
    db.close()
  }
}

function runStatus(): number {
  const exists = fs.existsSync(config.dbPath)
  const db = openDb(config.dbPath)
  try {
    const schemaVersion = exists ? getSchemaVersion(db) : null
    const heartbeat = schemaVersion === null ? null : getHeartbeat(db)
    const jobs = schemaVersion === null ? [] : recentJobs(db, 5)
    const apiCalls =
      schemaVersion === null
        ? []
        : (db
            .prepare(
              'SELECT endpoint, status, called_at FROM api_calls WHERE called_at > ? ORDER BY called_at DESC',
            )
            .all(Date.now() - 60_000) as Array<{
            endpoint: string
            status: number | null
            called_at: number
          }>)

    console.log(`Database:        ${config.dbPath}`)
    console.log(`Schema version:  ${schemaVersion ?? 'not migrated'}`)
    console.log(`Players:         ${tableCount(db, 'players')}`)
    console.log(`Matches:         ${tableCount(db, 'matches')}`)
    console.log(`Kill events:     ${tableCount(db, 'match_kills')}`)
    const telemetry = db
      .prepare(
        `SELECT COUNT(*) AS total, COUNT(telemetry_fetched_at) AS fetched FROM matches`,
      )
      .get() as { total: number; fetched: number }
    console.log(`Telemetry:       ${telemetry.fetched}/${telemetry.total} matches indexed`)
    console.log(`Jobs:            ${tableCount(db, 'crawl_jobs')}`)
    console.log(`Heartbeat:       ${heartbeat ?? 'none'}`)
    console.log(
      `API calls (60s):  ${apiCalls.length}${apiCalls.length > 0 ? ` (${apiCalls.map((call) => `${call.endpoint}:${call.status ?? '?'}`).join(', ')})` : ''}`,
    )
    if (jobs.length > 0) {
      console.log('Recent jobs:')
      for (const job of jobs) {
        console.log(
          `  ${job.id.slice(0, 8)}  ${job.status.padEnd(7)} ${job.phase.padEnd(16)} ${String(job.progress).padStart(3)}%  ${job.playerName} (${job.shard})` +
            (job.error ? `  error=${job.error}` : ''),
        )
      }
    }
    return 0
  } finally {
    db.close()
  }
}

async function runSeasonsSync(args: ParsedArgs): Promise<number> {
  requireApiKey()
  const shard = shardFrom(args.flags.get('shard'))
  const db = openDb(config.dbPath)
  try {
    migrate(db)
    const client = makeClient(db)
    const seasonId = await syncSeasons(db, client, shard, { force: true })
    console.log(JSON.stringify({ shard, currentSeason: seasonId }, null, 2))
    return 0
  } finally {
    db.close()
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))

  if (args.command === 'help' || args.command === '--help' || args.command === '-h') {
    console.log(USAGE)
    return 0
  }

  if (args.command === 'sync') return runSync(args)
  if (args.command === 'status') return runStatus()
  if (args.command === 'seasons') {
    const subcommand = args.positionals[0]
    if (subcommand === 'sync') return runSeasonsSync(args)
    throw new Error('Expected: seasons sync --shard steam')
  }

  console.log(USAGE)
  return 1
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    printError(error)
    process.exit(1)
  })
