import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

try {
  process.loadEnvFile(path.join(repoRoot, '.env'))
} catch {
  // optional in production; env vars can be supplied directly
}

function numberFromEnv(key: string, fallback: number): number {
  const value = Number(process.env[key])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export const config = {
  repoRoot,
  port: numberFromEnv('PORT', 3001),
  host: process.env.HOST ?? '127.0.0.1',
  dbPath: process.env.PUBG_DB_PATH
    ? path.resolve(repoRoot, process.env.PUBG_DB_PATH)
    : path.join(repoRoot, 'data', 'pubg.db'),
  crawlerEntry: path.join(repoRoot, 'apps', 'crawler', 'src', 'daemon.ts'),
  crawlerPidPath: path.join(repoRoot, 'data', 'crawler.pid'),
  crawlerLogPath: path.join(repoRoot, 'data', 'crawler.log'),
  crawlerAutostart: (process.env.CRAWLER_AUTOSTART ?? 'true') !== 'false',
  heartbeatTimeoutMs: numberFromEnv('CRAWLER_HEARTBEAT_TIMEOUT_MS', 10_000),
  staleAfterSeconds: numberFromEnv('PROFILE_STALE_AFTER_SECONDS', 900),
  recentMatchLimit: numberFromEnv('PROFILE_RECENT_MATCH_LIMIT', 20),
  refreshCooldownSeconds: numberFromEnv('REFRESH_COOLDOWN_SECONDS', 60),
  seasonScanLimit: numberFromEnv('SEASON_SCAN_LIMIT', 10),
  seasonScanIntervalSeconds: numberFromEnv('SEASON_SCAN_INTERVAL_SECONDS', 60),
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  schemaVersionRequired: 5,
} as const
