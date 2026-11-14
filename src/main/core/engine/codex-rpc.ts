import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { ConfinementSpec } from '../security/seatbelt'
import { spawnLineProcess } from './process'
import { EngineError } from './types'

/**
 * Minimal client for `codex app-server`: JSON-RPC over stdio, one JSON object per line,
 * without the `jsonrpc` field (protocol generated with `codex app-server generate-ts`, v0.169).
 */

export interface RpcTransport {
  write(line: string): void
  onLine(cb: (line: string) => void): void
  onExit(cb: (reason: string) => void): void
  close(): void
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }

export interface RpcError {
  code: number
  message: string
}

export type ServerRequestHandler = (method: string, params: unknown) => Promise<unknown>
export type NotificationHandler = (method: string, params: unknown) => void

export class CodexRpc {
  private nextId = 1
  private pending = new Map<number, Pending>()
  private closed: string | null = null

  constructor(
    private transport: RpcTransport,
    private onNotification: NotificationHandler,
    private onServerRequest: ServerRequestHandler,
  ) {
    transport.onLine((line) => this.receive(line))
    transport.onExit((reason) => {
      this.closed = reason
      for (const p of this.pending.values()) p.reject(new EngineError('protocol', `Codex s’est arrêté pendant « ${p.method} » : ${reason}`))
      this.pending.clear()
    })
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new EngineError('protocol', `Codex n’est plus disponible (${this.closed}).`))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method })
      this.transport.write(JSON.stringify({ id, method, params }))
    })
  }

  notify(method: string, params?: unknown): void {
    if (!this.closed) this.transport.write(JSON.stringify(params === undefined ? { method } : { method, params }))
  }

  close(): void {
    this.transport.close()
  }

  private receive(line: string) {
    let msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: RpcError }
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.method && msg.id !== undefined) {
      const id = msg.id
      this.onServerRequest(msg.method, msg.params).then(
        (result) => this.transport.write(JSON.stringify({ id, result })),
        (err: unknown) => this.transport.write(JSON.stringify({ id, error: { code: -32601, message: err instanceof Error ? err.message : 'Non pris en charge par Orbit.' } })),
      )
      return
    }
    if (msg.method) {
      this.onNotification(msg.method, msg.params)
      return
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new EngineError('protocol', msg.error.message || `Erreur Codex (${p.method}).`))
      else p.resolve(msg.result)
    }
  }
}

const PLATFORM_PKG: Record<string, string> = {
  'darwin-arm64': '@openai/codex-darwin-arm64',
  'darwin-x64': '@openai/codex-darwin-x64',
  'linux-arm64': '@openai/codex-linux-arm64',
  'linux-x64': '@openai/codex-linux-x64',
}
const TRIPLE: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl',
}

/**
 * Finds the Codex binary: ORBIT_CODEX_PATH, then the version pinned in package.json
 * (bundled, matches the protocol Orbit was written against), then `codex` on PATH.
 */
export function resolveCodexBinary(): { path: string; source: 'env' | 'bundled' | 'path' } {
  if (process.env.ORBIT_CODEX_PATH) return { path: process.env.ORBIT_CODEX_PATH, source: 'env' }
  const key = `${process.platform}-${process.arch}`
  const pkg = PLATFORM_PKG[key]
  if (pkg) {
    try {
      const req = createRequire(import.meta.url)
      const root = dirname(req.resolve(`${pkg}/package.json`))
      const bin = join(root, 'vendor', TRIPLE[key]!, 'bin', 'codex').replace(`app.asar${'/'}`, `app.asar.unpacked${'/'}`)
      if (existsSync(bin)) return { path: bin, source: 'bundled' }
    } catch {
      /* not installed for this platform */
    }
  }
  return { path: 'codex', source: 'path' }
}

/** Spawns `codex app-server` with a minimal, explicit environment (optionally confined). */
export function spawnCodexTransport(cwd: string, confinement?: ConfinementSpec | null): RpcTransport {
  const { path } = resolveCodexBinary()
  const env: Record<string, string | undefined> = {}
  for (const k of ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'SHELL', 'CODEX_HOME', 'SSL_CERT_FILE']) env[k] = process.env[k]
  const proc = spawnLineProcess({ command: path, args: ['app-server'], cwd, env, confinement, label: 'codex' })
  return {
    write: (line) => proc.write(line),
    onLine: (cb) => proc.onLine(cb),
    onExit: (cb) => proc.onExit((reason) => cb(reason)),
    close: () => proc.close(),
  }
}
