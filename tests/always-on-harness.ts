import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_PERMISSIONS } from '@shared/catalog'
import type { AgentPermissions, RemoteMachine } from '@shared/types'
import { composeCore, type Core } from '../src/main/core/compose'
import type { AgentEngine, EngineId } from '../src/main/core/engine/types'
import { EventBus } from '../src/main/core/event-bus'
import type { PlatformServices } from '../src/main/core/platform'
import type { RuntimeTransport } from '../src/main/core/remote/client'
import { RemoteMachineManager } from '../src/main/core/remote/manager'
import { openNodeSqliteDatabase } from '../src/main/infra/db/node-sqlite'
import { RuntimeHost } from '../src/runtime/host'
import { echoEngine } from '../src/runtime/test-engine'
import { novaInput, openTestDatabase, waitFor } from './helpers'

export const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)))
export const WRITE: AgentPermissions = { ...DEFAULT_PERMISSIONS, readFiles: true, writeFiles: true, runCommands: false, network: false }

const hosts: RuntimeHost[] = []
const desks: Desk[] = []

export async function cleanup() {
  for (const d of desks.splice(0)) d.remote.disposeAll()
  for (const h of hosts.splice(0)) await h.stop().catch(() => undefined)
}

export interface Clock {
  t: number
  now: () => number
}
export const clock = (start = Date.now()): Clock => {
  const c: Clock = { t: start, now: () => c.t }
  return c
}

export async function startRuntime(opts: { home?: string; engines?: Partial<Record<EngineId, AgentEngine>>; now?: () => number; approvalTtlMs?: number } = {}) {
  const home = opts.home ?? tmp('orb-rt-')
  const host = new RuntimeHost({ home, engines: opts.engines ?? { codex: echoEngine() }, openDb: openNodeSqliteDatabase, now: opts.now, flushIntervalMs: 20, approvalTtlMs: opts.approvalTtlMs })
  await host.start()
  hosts.push(host)
  return { host, home }
}

export async function stopRuntime(host: RuntimeHost) {
  const i = hosts.indexOf(host)
  if (i >= 0) hosts.splice(i, 1)
  await host.stop()
}

export interface Desk {
  core: Core
  bus: EventBus
  remote: RemoteMachineManager
  dataDir: string
  notified: string[]
}

/** Orbit Desktop's core + remote manager on its own database (better-sqlite3 like the app). */
export function makeDesk(opts: { dataDir?: string; dbFile?: string; engines?: Partial<Record<EngineId, AgentEngine>>; transport?: (m: RemoteMachine) => RuntimeTransport; now?: () => number } = {}): Desk {
  const dataDir = opts.dataDir ?? tmp('orb-desk-')
  const handle = openTestDatabase(opts.dbFile ?? ':memory:')
  const bus = new EventBus()
  const notified: string[] = []
  const platform: PlatformServices = {
    secrets: { available: () => true, encrypt: (s) => `enc:${Buffer.from(s).toString('base64')}`, decrypt: (c) => Buffer.from(c.slice(4), 'base64').toString() },
    nativeNotify: (title) => notified.push(title),
    fetch,
    appVersion: '0.0.0-test',
  }
  const core = composeCore({ mode: 'real', handle, bus, platform, engines: opts.engines ?? { codex: { ...echoEngine(), name: 'Codex (local)' } }, worktreeRoot: join(dataDir, 'wt'), now: opts.now })
  const remote = new RemoteMachineManager(handle, bus, core.journal, dataDir, () => null, opts.transport, platform.secrets)
  remote.attach({ missions: core.missions, constellations: core.constellations, scheduler: core.scheduler, agents: core.agents })
  const d = { core, bus, remote, dataDir, notified }
  desks.push(d)
  return d
}

/** Registers the runtime, verifies and pins its identity, connects. */
export async function pairDesk(desk: Desk, home: string, name = 'VPS de test'): Promise<RemoteMachine> {
  const m = desk.remote.register({ name, transport: 'local', host: null, user: null, port: 22, runtimeHome: home })
  await desk.remote.connect(m.id).catch(() => undefined)
  const pending = desk.remote.get(m.id).pendingRuntimeKey
  if (!pending) throw new Error('identité du runtime non présentée')
  await desk.remote.confirmRuntimeIdentity(m.id, pending.fingerprint)
  return desk.remote.get(m.id)
}

export function remoteAgent(desk: Desk, machineId: string, over: Partial<Parameters<Core['agents']['create']>[0]> = {}) {
  return desk.core.agents.create(novaInput({ name: 'Atlas', providerId: 'codex', model: 'default', runtime: 'remote', machineId, workingDirectory: 'meteo', autonomy: 'supervised', permissions: WRITE, ...over }))
}

export const settled = (desk: Desk, missionId: string, ms = 6000) => waitFor(() => ['done', 'failed', 'cancelled'].includes(desk.core.missions.get(missionId).status), ms)

export const count = (sqlite: { prepare(s: string): { get(...a: unknown[]): unknown } }, sql: string, ...args: unknown[]) => Number((sqlite.prepare(sql).get(...args) as { n: number }).n)

/** Status of a mission on the runtime, or null while the command hasn't landed yet. */
export const hostStatus = (host: RuntimeHost, id: string): string | null => {
  try {
    return host.core.missions.get(id).status
  } catch {
    return null
  }
}
