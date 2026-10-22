type Level = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
  child(extra: Record<string, unknown>): Logger
}

export function createLogger(level: Level = 'info', base: Record<string, unknown> = {}): Logger {
  const write = (lvl: Level, message: string, extra?: Record<string, unknown>) => {
    if (LEVELS[lvl] < LEVELS[level]) return
    const line = {
      ts: new Date().toISOString(),
      level: lvl,
      msg: message,
      ...base,
      ...extra,
    }
    const output = JSON.stringify(line)
    if (lvl === 'error') console.error(output)
    else if (lvl === 'warn') console.warn(output)
    else console.log(output)
  }

  return {
    debug: (message, extra) => write('debug', message, extra),
    info: (message, extra) => write('info', message, extra),
    warn: (message, extra) => write('warn', message, extra),
    error: (message, extra) => write('error', message, extra),
    child: (extra) => createLogger(level, { ...base, ...extra }),
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)))
