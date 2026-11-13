type Level = 'debug' | 'info' | 'warn' | 'error'

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const threshold: Level = process.env.ORBIT_LOG_LEVEL === 'debug' ? 'debug' : 'info'

/** Never pass secrets to the logger. Keys are redacted defensively anyway. */
function redact(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-…redacted')
  return value
}

function write(level: Level, scope: string, msg: string, extra?: unknown) {
  if (order[level] < order[threshold]) return
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${redact(msg)}`
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  if (extra !== undefined) fn(line, redact(extra instanceof Error ? extra.message : extra))
  else fn(line)
}

export function createLogger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => write('debug', scope, m, e),
    info: (m: string, e?: unknown) => write('info', scope, m, e),
    warn: (m: string, e?: unknown) => write('warn', scope, m, e),
    error: (m: string, e?: unknown) => write('error', scope, m, e),
  }
}
export type Logger = ReturnType<typeof createLogger>
