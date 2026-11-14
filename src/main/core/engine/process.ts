import { spawn, type ChildProcess } from 'node:child_process'
import { confine, type ConfinementSpec } from '../security/seatbelt'

/**
 * A line-oriented child process (JSON-RPC / stream-json engines).
 *
 * The child is started in its own process group, so stopping it also stops every
 * command it launched: an interrupted mission never leaves orphan processes behind.
 * With `confinement`, the whole tree runs under Orbit's Seatbelt profile (level 3).
 */
export interface LineProcess {
  pid: number | undefined
  write(line: string): void
  onLine(cb: (line: string) => void): void
  onExit(cb: (reason: string, code: number | null) => void): void
  stderrTail(): string
  /** Graceful: closes stdin, then SIGTERM the group, then SIGKILL. */
  close(graceMs?: number): void
  /** Immediate: SIGKILL the whole group. */
  kill(): void
}

export interface LineProcessOptions {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string | undefined>
  confinement?: ConfinementSpec | null
  /** Human name of the binary for « introuvable » errors. */
  label: string
}

const live = new Set<ChildProcess>()

/** Called on app quit: no engine process may outlive Orbit. */
export function killAllEngineProcesses(): void {
  for (const c of live) killGroup(c, 'SIGKILL')
  live.clear()
}

export function liveEngineProcessCount(): number {
  return live.size
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid == null || child.exitCode != null) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      /* already gone */
    }
  }
}

export function spawnLineProcess(opts: LineProcessOptions): LineProcess {
  const wrapped = opts.confinement ? confine(opts.command, opts.args, opts.confinement) : { command: opts.command, args: opts.args }
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(opts.env)) if (v != null) env[k] = v
  const child = spawn(wrapped.command, wrapped.args, { cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
  live.add(child)
  let buffer = ''
  let stderr = ''
  let exited = false
  const lineListeners: ((l: string) => void)[] = []
  const exitListeners: ((r: string, code: number | null) => void)[] = []
  child.stdout!.setEncoding('utf8')
  child.stdout!.on('data', (chunk: string) => {
    buffer += chunk
    let i: number
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim()
      buffer = buffer.slice(i + 1)
      if (line) for (const l of lineListeners) l(line)
    }
  })
  child.stderr!.setEncoding('utf8')
  child.stderr!.on('data', (c: string) => (stderr = (stderr + c).slice(-4000)))
  child.stdin!.on('error', () => undefined)
  const exit = (reason: string, code: number | null) => {
    if (exited) return
    exited = true
    live.delete(child)
    // The leader is gone; make sure nothing it started survives.
    killGroup(child, 'SIGKILL')
    for (const l of exitListeners.splice(0)) l(reason, code)
  }
  child.on('error', (err: NodeJS.ErrnoException) => exit(err.code === 'ENOENT' ? `binaire ${opts.label} introuvable` : err.message, null))
  child.on('exit', (code, signal) => exit(signal ? `signal ${signal}` : `code ${code}${stderr ? ` — ${stderr.trim().split('\n').pop()}` : ''}`, code))
  return {
    pid: child.pid,
    write: (line) => {
      if (child.stdin!.writable) child.stdin!.write(line + '\n')
    },
    onLine: (cb) => lineListeners.push(cb),
    onExit: (cb) => exitListeners.push(cb),
    stderrTail: () => stderr,
    close: (graceMs = 1500) => {
      if (exited) return
      child.stdin!.end()
      setTimeout(() => !exited && killGroup(child, 'SIGTERM'), graceMs).unref()
      setTimeout(() => !exited && killGroup(child, 'SIGKILL'), graceMs + 3000).unref()
    },
    kill: () => killGroup(child, 'SIGKILL'),
  }
}
