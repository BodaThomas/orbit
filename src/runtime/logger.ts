import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { redactSecrets } from '../main/core/security/sensitive'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * Structured JSON-lines logs: stderr (journald keeps and rotates them under systemd) and
 * <home>/logs/runtime.log, rotated by size (5 × 5 MB). Secrets are redacted before writing;
 * prompts and results are never logged.
 */
export class RuntimeLogger {
  private dir: string | null
  readonly errors: { at: string; message: string }[] = []
  private maxBytes = 5 * 1024 * 1024
  private keep = 5

  constructor(
    home: string | null,
    private opts: { stderr?: boolean; now?: () => number } = {},
  ) {
    this.dir = home ? join(home, 'logs') : null
    if (this.dir) mkdirSync(this.dir, { recursive: true, mode: 0o700 })
  }

  log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
    const at = new Date((this.opts.now ?? Date.now)()).toISOString()
    const clean = redactSecrets(msg).text
    const safeFields: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(fields)) safeFields[k] = typeof v === 'string' ? redactSecrets(v).text.slice(0, 500) : v
    const line = JSON.stringify({ at, level, msg: clean, ...safeFields }) + '\n'
    if (level === 'error') {
      this.errors.push({ at, message: clean.slice(0, 300) })
      if (this.errors.length > 20) this.errors.shift()
    }
    if (this.opts.stderr !== false) process.stderr.write(line)
    if (!this.dir) return
    const file = join(this.dir, 'runtime.log')
    try {
      if (existsSync(file) && statSync(file).size > this.maxBytes) this.rotate(file)
      appendFileSync(file, line, { mode: 0o600 })
    } catch {
      /* logging must never take the runtime down */
    }
  }

  private rotate(file: string) {
    rmSync(`${file}.${this.keep}`, { force: true })
    for (let i = this.keep - 1; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`)
    renameSync(file, `${file}.1`)
  }

  info = (msg: string, f?: Record<string, unknown>) => this.log('info', msg, f)
  warn = (msg: string, f?: Record<string, unknown>) => this.log('warn', msg, f)
  error = (msg: string, f?: Record<string, unknown>) => this.log('error', msg, f)
}
