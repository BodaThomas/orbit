import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import type { LiveEvent, RuntimeEvent } from '../../../runtime/protocol'
import { spawnLineProcess } from '../engine/process'

/** A line transport to a runtime daemon: over SSH in real life, a local socket in tests. */
export interface RuntimeTransport {
  write(line: string): void
  onLine(cb: (line: string) => void): void
  onClose(cb: (reason: string) => void): void
  close(): void
}

export interface SshTarget {
  host: string
  user: string | null
  port: number
  runtimeHome: string
  /** Orbit's own known_hosts file: only the key the user pinned is accepted. */
  knownHostsFile: string
  /** A key reserved for Orbit: when set, it is the only identity offered. */
  identityFile?: string | null
}

/**
 * `ssh` with strict host checking against Orbit's pinned key, key-based auth only
 * (BatchMode: never a password prompt), no forwarding of agent, X11 or ports.
 */
export function sshArgs(t: SshTarget, remoteCommand: string): string[] {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${t.knownHostsFile}`,
    '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'ForwardAgent=no',
    '-o', 'ForwardX11=no',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=10',
    ...(t.identityFile ? ['-i', t.identityFile, '-o', 'IdentitiesOnly=yes'] : []),
    '-p', String(t.port),
    t.user ? `${t.user}@${t.host}` : t.host,
    remoteCommand,
  ]
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export function sshTransport(t: SshTarget): RuntimeTransport {
  const proc = spawnLineProcess({ command: '/usr/bin/ssh', args: sshArgs(t, `${shq(`${t.runtimeHome}/bin/orbit-runtime`)} attach --home ${shq(t.runtimeHome)}`), cwd: process.env.HOME ?? '/', env: { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK, LANG: 'C.UTF-8' }, label: 'ssh' })
  return {
    write: (l) => proc.write(l),
    onLine: (cb) => proc.onLine(cb),
    onClose: (cb) => proc.onExit((reason) => cb(proc.stderrTail().trim().split('\n').pop() || reason)),
    close: () => proc.close(500),
  }
}

/** Where the daemon listens: written by the daemon in <home>/socket (short path if needed). */
export function runtimeSocket(runtimeHome: string): string {
  try {
    return readFileSync(join(runtimeHome, 'socket'), 'utf8').trim()
  } catch {
    return join(runtimeHome, 'orbit.sock')
  }
}

/** Same as `orbit-runtime attach`, in-process: for a runtime on this Mac (tests, VM shares). */
export function localSocketTransport(runtimeHome: string): RuntimeTransport {
  const sock = connect(runtimeSocket(runtimeHome))
  const lines: ((l: string) => void)[] = []
  const closes: ((r: string) => void)[] = []
  let buffer = ''
  let closed = false
  const close = (r: string) => {
    if (closed) return
    closed = true
    for (const c of closes) c(r)
  }
  sock.setEncoding('utf8')
  // The auth line must be the very first thing on the wire: queue it before any request.
  let token = ''
  try {
    token = readFileSync(join(runtimeHome, 'token'), 'utf8').trim()
  } catch {
    /* the daemon will refuse */
  }
  sock.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'auth', params: { token } }) + '\n')
  sock.on('data', (c: string) => {
    buffer += c
    let i: number
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim()
      buffer = buffer.slice(i + 1)
      if (line) for (const l of lines) l(line)
    }
  })
  sock.on('error', (e) => close(e.message))
  sock.on('close', () => close('connexion fermée'))
  return { write: (l) => sock.writable && sock.write(l + '\n'), onLine: (cb) => lines.push(cb), onClose: (cb) => closes.push(cb), close: () => sock.end() }
}

/** A refusal from the runtime itself (definitive), as opposed to a lost connection (unknown outcome). */
export class RuntimeRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

/** JSON-RPC client. Requests time out; pushed events are delivered in order. */
export class RuntimeClient {
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private eventListeners = new Set<(e: RuntimeEvent) => void>()
  private liveListeners = new Set<(e: LiveEvent) => void>()
  private closeListeners = new Set<(reason: string) => void>()
  closed = false

  constructor(private transport: RuntimeTransport) {
    transport.onLine((line) => {
      let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message: string } }
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg.method === 'event') {
        for (const l of this.eventListeners) l(msg.params as RuntimeEvent)
        return
      }
      if (msg.method === 'live') {
        for (const l of this.liveListeners) l(msg.params as LiveEvent)
        return
      }
      if (msg.id == null) return
      if (msg.id === 0 && msg.error) {
        // Local token refused.
        for (const q of this.pending.values()) q.reject(new RuntimeRpcError(msg.error.code ?? 401, msg.error.message))
        return
      }
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new RuntimeRpcError(msg.error.code ?? 500, msg.error.message))
      else p.resolve(msg.result)
    })
    transport.onClose((reason) => {
      this.closed = true
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error(`Connexion perdue : ${reason}`))
      }
      this.pending.clear()
      for (const l of this.closeListeners) l(reason)
    })
  }

  request<T>(method: string, params: unknown = {}, timeoutMs = 20_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Connexion fermée.'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Pas de réponse du runtime (${method}).`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.transport.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  onEvent(cb: (e: RuntimeEvent) => void): () => void {
    this.eventListeners.add(cb)
    return () => this.eventListeners.delete(cb)
  }

  onLive(cb: (e: LiveEvent) => void): () => void {
    this.liveListeners.add(cb)
    return () => this.liveListeners.delete(cb)
  }

  onClose(cb: (reason: string) => void): () => void {
    this.closeListeners.add(cb)
    return () => this.closeListeners.delete(cb)
  }

  close(): void {
    this.transport.close()
  }
}
