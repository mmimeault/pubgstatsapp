import fs from 'node:fs'
import Database from 'better-sqlite3'
import type { Db } from './types'

export class DatabaseNotReadyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DatabaseNotReadyError'
  }
}

/**
 * The API opens the crawler-owned SQLite file read/write only because it enqueues
 * crawl jobs. It never writes stats tables and never runs migrations.
 */
export function openDatabase(dbPath: string, requiredVersion: number): Db {
  if (!fs.existsSync(dbPath)) {
    throw new DatabaseNotReadyError(
      `Database not found at ${dbPath}. Start the crawler once to initialize it.`,
    )
  }

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')

  let version: number | null = null
  try {
    const row = db
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version: number | null } | undefined
    version = row?.version ?? null
  } catch {
    version = null
  }

  if (!version || version < requiredVersion) {
    db.close()
    throw new DatabaseNotReadyError(
      `Database schema is not initialized (found ${version ?? 'none'}, need ${requiredVersion}). Start the crawler once.`,
    )
  }

  return db as unknown as Db
}

export function schemaVersion(db: Db): number | null {
  try {
    const row = db
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version: number | null } | undefined
    return row?.version ?? null
  } catch {
    return null
  }
}
