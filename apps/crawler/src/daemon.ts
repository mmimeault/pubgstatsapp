import fs from 'node:fs'
import path from 'node:path'
import type { CrawlPhase, Shard } from '@pubgstats/shared'
import { config } from './config'
import { migrate, openDb } from './db'
import { syncPlayer, syncSeason, syncSeasonScan } from './ingest'
import {
  clearHeartbeat,
  claimNextJob,
  createSeasonScanJob,
  requeueInterruptedJobs,
  updateJob,
  writeHeartbeat,
} from './jobs'
import { createLogger, sleep } from './logger'
import { PubgApiError, PubgClient } from './pubg/client'
import { RateLimiter } from './pubg/rate-limiter'

const logger = createLogger(
  config.logLevel as 'debug' | 'info' | 'warn' | 'error',
  { app: 'crawler', pid: process.pid },
)

function writePidFile(): void {
  fs.mkdirSync(path.dirname(config.pidPath), { recursive: true })
  fs.writeFileSync(config.pidPath, `${process.pid}\n`, 'utf8')
}

function removePidFile(): void {
  try {
    const contents = fs.readFileSync(config.pidPath, 'utf8').trim()
    if (contents === String(process.pid)) fs.unlinkSync(config.pidPath)
  } catch {
    // PID file may already be gone.
  }
}

if (!config.apiKey) {
  console.error(
    'PUBG_API_KEY is not set. Add it to the repository .env file (see .env.example) before starting the crawler.',
  )
  process.exit(1)
}

const db = openDb(config.dbPath)
const version = migrate(db)
const requeued = requeueInterruptedJobs(db)
if (requeued.requeued > 0 || requeued.failed > 0) {
  logger.info('requeued interrupted jobs', {
    requeued: requeued.requeued,
    failed: requeued.failed,
  })
}

writePidFile()
writeHeartbeat(db)

const limiter = new RateLimiter(db, {
  rpm: config.rateLimitRpm,
  onWait: (waitMs) => logger.warn('rate limiter waiting', { waitMs }),
})
const client = new PubgClient({
  db,
  apiKey: config.apiKey,
  baseUrl: config.apiBaseUrl,
  rateLimiter: limiter,
  timeoutMs: config.requestTimeoutMs,
  logger,
})

let stopping = false
let runningJobId: string | null = null

function requestShutdown(signal: string): void {
  if (stopping) {
    logger.warn('shutdown already in progress', { signal, runningJobId })
    return
  }
  stopping = true
  logger.info('shutdown requested; finishing current job', { signal, runningJobId })
}

process.on('SIGINT', () => requestShutdown('SIGINT'))
process.on('SIGTERM', () => requestShutdown('SIGTERM'))

const heartbeatTimer = setInterval(() => {
  try {
    writeHeartbeat(db)
  } catch (error) {
    logger.error('failed to write heartbeat', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}, config.heartbeatIntervalMs)

function markFailed(jobId: string, error: unknown): void {
  const finishedAt = new Date().toISOString()
  const isApiError = error instanceof PubgApiError
  const message = error instanceof Error ? error.message : String(error)
  updateJob(db, jobId, {
    status: 'failed',
    phase: 'failed',
    message,
    error: message,
    error_code: isApiError ? error.code : 'crawler_error',
    finished_at: finishedAt,
  })
}

async function runLoop(): Promise<void> {
  while (!stopping) {
    const job = claimNextJob(db)
    if (!job) {
      await sleep(config.pollIntervalMs)
      continue
    }

    runningJobId = job.id
    const jobLogger = logger.child({ jobId: job.id, player: job.playerName })
    jobLogger.info('job claimed', { shard: job.shard, attempt: job.attempts })

    try {
      const onProgress = (update: {
        phase: string
        progress: number
        message?: string | null
      }) => {
        updateJob(db, job.id, {
          phase: update.phase as CrawlPhase,
          progress: update.progress,
          message: update.message ?? null,
        })
      }

      if (job.kind === 'season_scan') {
        const result = await syncSeasonScan(
          db,
          client,
          {
            id: job.id,
            shard: job.shard as Shard,
            player_name: job.playerName,
            player_id: job.playerId,
          },
          {
            limit: config.seasonScanLimit,
            batchSize: config.seasonScanBatchSize,
            onProgress,
          },
        )
        updateJob(db, job.id, {
          status: 'done',
          phase: 'done',
          progress: 100,
          message: `Scanned ${result.scanned}/${result.total} seasons (${result.played} played)`,
          error: null,
          error_code: null,
          player_id: result.playerId,
          finished_at: new Date().toISOString(),
        })
        jobLogger.info('season scan batch done', {
          playerId: result.playerId,
          scanned: result.scanned,
          total: result.total,
          played: result.played,
          more: result.more,
        })
        if (result.more) {
          const runAfter = new Date(
            Date.now() + config.seasonScanIntervalSeconds * 1000,
          ).toISOString()
          createSeasonScanJob(db, job.shard as Shard, job.playerName, job.playerId, runAfter)
          jobLogger.info('season scan batch scheduled', { runAfter })
        }
      } else if (job.kind === 'season_sync' && job.seasonId) {
        const result = await syncSeason(
          db,
          client,
          {
            id: job.id,
            shard: job.shard as Shard,
            player_name: job.playerName,
            player_id: job.playerId,
            season_id: job.seasonId,
          },
          { onProgress },
        )
        updateJob(db, job.id, {
          status: 'done',
          phase: 'done',
          progress: 100,
          message: `Synced ${result.seasonId} (${result.modes} modes)`,
          error: null,
          error_code: null,
          player_id: result.playerId,
          finished_at: new Date().toISOString(),
        })
        jobLogger.info('season job done', {
          playerId: result.playerId,
          seasonId: result.seasonId,
          modes: result.modes,
        })
      } else {
        const result = await syncPlayer(
          db,
          client,
          {
            id: job.id,
            shard: job.shard as Shard,
            player_name: job.playerName,
            player_id: job.playerId,
          },
          {
            matchLimit: config.matchLimit,
            matchConcurrency: config.matchConcurrency,
            seasonCacheHours: config.seasonCacheHours,
            telemetryConcurrency: config.telemetryConcurrency,
            telemetryTimeoutMs: config.telemetryTimeoutMs,
            logger,
            onProgress,
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
        jobLogger.info('job done', {
          playerId: result.playerId,
          seasonId: result.seasonId,
          matchesRequested: result.matchesRequested,
          matchesFetched: result.matchesFetched,
          statsModes: result.statsModes,
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      jobLogger.error('job failed', {
        error: message,
        code: error instanceof PubgApiError ? error.code : 'crawler_error',
        hint: error instanceof PubgApiError ? error.hint : undefined,
      })
      markFailed(job.id, error)
    } finally {
      runningJobId = null
    }
  }
}

async function main(): Promise<void> {
  logger.info('crawler started', {
    db: config.dbPath,
    schemaVersion: version,
    pollIntervalMs: config.pollIntervalMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
  })

  try {
    await runLoop()
  } finally {
    clearInterval(heartbeatTimer)
    try {
      clearHeartbeat(db)
    } catch {
      // best effort
    }
    removePidFile()
    db.close()
    logger.info('crawler stopped')
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    logger.error('crawler crashed', {
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    })
    clearInterval(heartbeatTimer)
    removePidFile()
    try {
      db.close()
    } catch {
      // ignore
    }
    process.exit(1)
  })
