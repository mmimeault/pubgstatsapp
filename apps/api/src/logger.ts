type Level = 'info' | 'warn' | 'error'

const LEVELS: Record<Level, number> = { info: 20, warn: 30, error: 40 }

export interface Logger {
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
}

export function createLogger(level: Level = 'info'): Logger {
  const write = (lvl: Level, message: string, extra?: Record<string, unknown>) => {
    if (LEVELS[lvl] < LEVELS[level]) return
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: lvl,
      service: 'api',
      msg: message,
      ...extra,
    })
    if (lvl === 'error') console.error(line)
    else if (lvl === 'warn') console.warn(line)
    else console.log(line)
  }
  return {
    info: (message, extra) => write('info', message, extra),
    warn: (message, extra) => write('warn', message, extra),
    error: (message, extra) => write('error', message, extra),
  }
}
