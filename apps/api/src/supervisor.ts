import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { config } from './config'
import { getHeartbeat, heartbeatAgeMs } from './jobs'
import type { Db } from './types'

export interface SupervisorLogger {
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
}

let lastSpawnAt = 0

function pidAlive(pidPath: string): boolean {
  try {
    const pid = Number(fs.readFileSync(pidPath, 'utf8').trim())
    if (!Number.isFinite(pid) || pid <= 0) return false
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Best-effort local supervisor: the API may start the crawler daemon if it is not
 * already running. In production these would be separate services.
 */
export function ensureCrawler(getDb: () => Db | null, logger: SupervisorLogger): boolean {
  if (!config.crawlerAutostart) return false

  const db = getDb()
  if (db) {
    const age = heartbeatAgeMs(getHeartbeat(db))
    if (age !== null && age < config.heartbeatTimeoutMs) return true
  }

  if (pidAlive(config.crawlerPidPath)) return true

  // Avoid spawning repeatedly while a child is booting.
  if (Date.now() - lastSpawnAt < 5_000) return false
  lastSpawnAt = Date.now()

  if (!process.env.PUBG_API_KEY) {
    logger.warn('Crawler autostart skipped: PUBG_API_KEY is not set')
    return false
  }

  try {
    fs.mkdirSync(config.repoRoot + '/data', { recursive: true })
    const logFd = fs.openSync(config.crawlerLogPath, 'a')
    const child = spawn(process.execPath, ['--import', 'tsx', config.crawlerEntry], {
      cwd: config.repoRoot,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    })
    child.unref()
    logger.info('Spawned crawler daemon', { pid: child.pid })
    return true
  } catch (error) {
    logger.error('Failed to spawn crawler daemon', {
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}
