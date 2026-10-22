import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

for (const envFile of [path.join(repoRoot, '.env'), path.join(repoRoot, 'apps/crawler/.env')]) {
  try {
    process.loadEnvFile(envFile)
  } catch {
    // env file is optional
  }
}

function numberFromEnv(key: string, fallback: number): number {
  const value = Number(process.env[key])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export const config = {
  repoRoot,
  dbPath: process.env.PUBG_DB_PATH
    ? path.resolve(repoRoot, process.env.PUBG_DB_PATH)
    : path.join(repoRoot, 'data', 'pubg.db'),
  pidPath: path.join(repoRoot, 'data', 'crawler.pid'),
  logPath: path.join(repoRoot, 'data', 'crawler.log'),
  apiKey: process.env.PUBG_API_KEY ?? '',
  apiBaseUrl: process.env.PUBG_API_BASE_URL ?? 'https://api.pubg.com',
  rateLimitRpm: numberFromEnv('PUBG_RATE_LIMIT_RPM', 10),
  // This caps match *details* (and their telemetry), never season aggregates.
  // PUBG exposes at most 32 recent match IDs within 14 days, so 32 is the
  // practical maximum we can cache. The API pages/loads these from SQLite.
  matchLimit: numberFromEnv('PUBG_MATCH_LIMIT', 32),
  matchConcurrency: numberFromEnv('PUBG_MATCH_CONCURRENCY', 5),
  telemetryConcurrency: numberFromEnv('PUBG_TELEMETRY_CONCURRENCY', 2),
  telemetryTimeoutMs: numberFromEnv('PUBG_TELEMETRY_TIMEOUT_MS', 60_000),
  seasonCacheHours: numberFromEnv('PUBG_SEASON_CACHE_HOURS', 24),
  seasonScanLimit: numberFromEnv('SEASON_SCAN_LIMIT', 10),
  seasonScanBatchSize: numberFromEnv('SEASON_SCAN_BATCH_SIZE', 2),
  seasonScanIntervalSeconds: numberFromEnv('SEASON_SCAN_INTERVAL_SECONDS', 60),
  requestTimeoutMs: numberFromEnv('PUBG_REQUEST_TIMEOUT_MS', 30_000),
  pollIntervalMs: numberFromEnv('CRAWLER_POLL_INTERVAL_MS', 500),
  heartbeatIntervalMs: numberFromEnv('CRAWLER_HEARTBEAT_MS', 2_000),
  logLevel: process.env.LOG_LEVEL ?? 'info',
} as const

export type Config = typeof config
