import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { and, eq } from 'drizzle-orm'
import type { Agent, RemoteMachine } from '@shared/types'
import type { OrbitDb } from '../../infra/db/client'
import { remoteMissions, runtimeEvents, runtimeMachines } from '../../infra/db/schema'
import { isSafeProjectName, PROTOCOL_VERSION, type HelloResult, type MissionSubmit, type RemoteEngineId, type RemoteMission, type RuntimeEvent } from '../../../runtime/protocol'
import type { AgentEngine, EngineEvent, EngineRunResult } from '../engine/types'
import { EngineError } from '../engine/types'
import type { EventBus } from '../event-bus'
import type { Journal } from '../journal'
import { newId, nowIso, OrbitError } from '../util'
import { localSocketTransport, RuntimeClient, sshArgs, sshTransport, type RuntimeTransport } from './client'

const run = promisify(execFile)
const RECONNECT_WAIT_MS = 120_000
const HEARTBEAT_MS = 30_000

export interface MachineInput {
  name: string
  transport: 'ssh' | 'local'
  host: string | null
  user: string | null
  port: number
  runtimeHome: string
}

interface Live {
  client: RuntimeClient
  heartbeat: ReturnType<typeof setInterval>
}

/**
 * Remote machines running `orbit-runtime`. Orbit connects through SSH with a host key the
 * user pinned, keeps a heartbeat, mirrors the runtime's event log (cursor, no duplicates)
 * and exposes each machine's engines as ordinary agent engines.
 *
 * Nothing touches a remote machine without an explicit user action (register, confirm the
 * host key, deploy after reviewing the exact commands, connect).
 */
export class RemoteMachineManager {
  private live = new Map<string, Live>()
  private connecting = new Map<string, Promise<RuntimeClient>>()
  private wanted = new Set<string>()
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private scanned = new Map<string, { line: string; fingerprint: string }>()
  /** Set when the runtime shuts down: late socket callbacks must not touch the closed database. */
  private disposed = false
  /** Called when a remote mission's outcome is learnt after Orbit lost track of it. */
  onRemoteOutcome: ((executionId: string, outcome: { status: string; result: string | null; error: string | null }) => void) | null = null

  constructor(
    private db: OrbitDb,
    private bus: EventBus,
    private journal: Journal,
    private dataDir: string,
    private bundlePath: () => string | null,
    private transportFactory?: (m: RemoteMachine) => RuntimeTransport,
  ) {}

  private get knownHosts() {
    const dir = join(this.dataDir, 'ssh')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const f = join(dir, 'known_hosts')
    if (!existsSync(f)) writeFileSync(f, '', { mode: 0o600 })
    return f
  }

  /** On launch nothing is connected yet: no machine may appear « online » from a past session. */
  resetOnBoot(): void {
    this.db.update(runtimeMachines).set({ status: 'offline' }).where(eq(runtimeMachines.status, 'online')).run()
  }

  // Registry

  list(): RemoteMachine[] {
    return this.db.select().from(runtimeMachines).all().filter((m) => m.status !== 'revoked').map((m) => this.toMachine(m))
  }

  get(id: string): RemoteMachine {
    const m = this.db.select().from(runtimeMachines).where(eq(runtimeMachines.id, id)).get()
    if (!m || m.status === 'revoked') throw new OrbitError('not_found', 'Machine introuvable.')
    return this.toMachine(m)
  }

  private toMachine(m: typeof runtimeMachines.$inferSelect): RemoteMachine {
    const running = this.db.select().from(remoteMissions).where(and(eq(remoteMissions.machineId, m.id))).all().filter((r) => ['queued', 'running', 'awaiting_approval'].includes(r.status)).length
    const { hostKey: _hostKey, cursor: _cursor, ...rest } = m
    return { ...rest, transport: m.transport === 'local' ? 'local' : 'ssh', status: m.status as RemoteMachine['status'], engines: m.engines ?? [], info: m.info ?? null, runningMissions: running }
  }

  register(input: MachineInput): RemoteMachine {
    if (input.transport === 'ssh' && (!input.host || !/^[A-Za-z0-9.-]+$/.test(input.host))) throw new OrbitError('validation', 'Hôte invalide (nom DNS ou adresse IP).')
    if (input.user && !/^[a-z_][a-z0-9_-]{0,31}$/i.test(input.user)) throw new OrbitError('validation', 'Utilisateur invalide.')
    if (!input.runtimeHome.startsWith('/') && !input.runtimeHome.startsWith('~')) throw new OrbitError('validation', 'Dossier du runtime : chemin absolu attendu.')
    const id = newId()
    this.db.insert(runtimeMachines).values({ id, name: input.name, transport: input.transport, host: input.host, user: input.user, port: input.port, runtimeHome: input.runtimeHome, status: input.transport === 'ssh' ? 'pending_host_key' : 'ready', createdAt: nowIso() }).run()
    this.journal.audit({ actor: 'user', agentId: null, action: 'machine.register', target: input.transport === 'ssh' ? `${input.user ?? ''}@${input.host}:${input.port}` : input.runtimeHome, allowed: true, reason: null })
    this.bus.invalidate('machines')
    return this.get(id)
  }

  /** Reads the host's public key (ssh-keyscan). Nothing is trusted until the user confirms it. */
  async scanHostKey(id: string): Promise<{ fingerprint: string; algorithm: string }> {
    const m = this.get(id)
    if (m.transport !== 'ssh' || !m.host) throw new OrbitError('validation', 'Machine locale : pas de clé d’hôte.')
    const { stdout } = await run('/usr/bin/ssh-keyscan', ['-T', '8', '-t', 'ed25519,ecdsa,rsa', '-p', String(m.port), m.host], { timeout: 15_000 }).catch((err: Error) => {
      throw new OrbitError('provider', `Hôte injoignable : ${err.message}`)
    })
    const line = stdout.split('\n').find((l) => l && !l.startsWith('#'))
    if (!line) throw new OrbitError('provider', 'Aucune clé d’hôte reçue.')
    const fp = await new Promise<string>((resolve, reject) => {
      const p = spawn('/usr/bin/ssh-keygen', ['-lf', '-'])
      let out = ''
      p.stdout.on('data', (d) => (out += d))
      p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error('ssh-keygen a échoué'))))
      p.stdin.end(line + '\n')
    })
    const fingerprint = fp.split(' ')[1] ?? fp
    this.scanned.set(id, { line, fingerprint })
    return { fingerprint, algorithm: line.split(' ')[1] ?? '' }
  }

  /** The user compared the fingerprint (e.g. with their provider's console) and accepts it. */
  confirmHostKey(id: string, fingerprint: string): RemoteMachine {
    const s = this.scanned.get(id)
    if (!s || s.fingerprint !== fingerprint) throw new OrbitError('conflict', 'Empreinte différente de celle lue : relancez la vérification.')
    const m = this.get(id)
    const entry = s.line.replace(/^\S+/, m.port === 22 ? m.host! : `[${m.host}]:${m.port}`)
    const kept = readFileSync(this.knownHosts, 'utf8').split('\n').filter((l) => l && !l.startsWith(`${m.port === 22 ? m.host : `[${m.host}]:${m.port}`} `))
    writeFileSync(this.knownHosts, [...kept, entry].join('\n') + '\n', { mode: 0o600 })
    this.db.update(runtimeMachines).set({ hostKey: entry, hostKeyFingerprint: fingerprint, status: 'ready', lastError: null }).where(eq(runtimeMachines.id, id)).run()
    this.journal.audit({ actor: 'user', agentId: null, action: 'machine.pinHostKey', target: m.name, allowed: true, reason: fingerprint })
    this.bus.invalidate('machines')
    return this.get(id)
  }

  /** Exact commands Orbit would run to install the runtime: shown before any deployment. */
  deployPlan(id: string): string[] {
    const m = this.get(id)
    const h = m.runtimeHome
    return [
      `ssh ${m.user ? `${m.user}@` : ''}${m.host} -p ${m.port} "mkdir -p ${h}/bin && chmod 700 ${h}"`,
      `ssh … "cat > ${h}/bin/orbit-runtime.mjs" < orbit-runtime.mjs (${this.bundlePath() ? 'fourni avec Orbit' : 'à construire : npm run build:runtime'})`,
      `ssh … "printf '#!/bin/sh\\nexec node ${h}/bin/orbit-runtime.mjs \\"\\$@\\"\\n' > ${h}/bin/orbit-runtime && chmod 700 ${h}/bin/orbit-runtime"`,
      `ssh … "mkdir -p ~/.config/systemd/user && ${h}/bin/orbit-runtime unit --home ${h} > ~/.config/systemd/user/orbit-runtime.service"`,
      `ssh … "systemctl --user daemon-reload && systemctl --user enable --now orbit-runtime"`,
      `Prérequis sur le serveur : Node.js 20+, et pour les moteurs : « codex login » et/ou « claude » + /login faits par vous, sur le serveur. Pour que le service tourne sans session ouverte : « loginctl enable-linger » (peut demander les droits administrateur).`,
    ]
  }

  /** Runs the plan above. Only called after the user confirmed the exact commands. */
  async deploy(id: string): Promise<RemoteMachine> {
    const m = this.get(id)
    if (m.transport !== 'ssh' || !m.hostKeyFingerprint) throw new OrbitError('validation', 'Confirmez d’abord la clé d’hôte de la machine.')
    const bundle = this.bundlePath()
    if (!bundle || !existsSync(bundle)) throw new OrbitError('validation', 'Bundle du runtime introuvable (npm run build:runtime).')
    const target = { host: m.host!, user: m.user, port: m.port, runtimeHome: m.runtimeHome, knownHostsFile: this.knownHosts }
    const sh = async (cmd: string, stdin?: Buffer) =>
      new Promise<void>((resolve, reject) => {
        const p = spawn('/usr/bin/ssh', sshArgs(target, cmd))
        let err = ''
        p.stderr.on('data', (d) => (err += d))
        p.on('close', (code) => (code === 0 ? resolve() : reject(new OrbitError('provider', `Déploiement interrompu : ${err.trim().split('\n').pop() ?? code}`))))
        p.stdin.end(stdin)
      })
    const h = m.runtimeHome
    this.journal.audit({ actor: 'user', agentId: null, action: 'machine.deploy', target: m.name, allowed: true, reason: h })
    await sh(`mkdir -p ${h}/bin && chmod 700 ${h}`)
    await sh(`cat > ${h}/bin/orbit-runtime.mjs`, readFileSync(bundle))
    await sh(`printf '#!/bin/sh\\nexec node ${h}/bin/orbit-runtime.mjs "$@"\\n' > ${h}/bin/orbit-runtime && chmod 700 ${h}/bin/orbit-runtime`)
    await sh(`mkdir -p ~/.config/systemd/user && ${h}/bin/orbit-runtime unit --home ${h} > ~/.config/systemd/user/orbit-runtime.service`)
    await sh('systemctl --user daemon-reload && systemctl --user enable --now orbit-runtime')
    return this.get(id)
  }

  revoke(id: string): void {
    const m = this.get(id)
    this.disconnect(id)
    if (m.transport === 'ssh' && m.host) {
      const host = m.port === 22 ? m.host : `[${m.host}]:${m.port}`
      writeFileSync(this.knownHosts, readFileSync(this.knownHosts, 'utf8').split('\n').filter((l) => l && !l.startsWith(`${host} `)).join('\n') + '\n', { mode: 0o600 })
    }
    this.db.update(runtimeMachines).set({ status: 'revoked', hostKey: null }).where(eq(runtimeMachines.id, id)).run()
    this.journal.audit({ actor: 'user', agentId: null, action: 'machine.revoke', target: m.name, allowed: true, reason: 'Clé d’hôte retirée ; retirez aussi la clé SSH d’Orbit de authorized_keys sur le serveur.' })
    this.bus.invalidate('machines')
  }

  // Connection

  async connect(id: string): Promise<RemoteMachine> {
    this.wanted.add(id)
    await this.ensureClient(id)
    return this.get(id)
  }

  disconnect(id: string): void {
    this.wanted.delete(id)
    clearTimeout(this.reconnectTimers.get(id))
    const l = this.live.get(id)
    if (l) {
      clearInterval(l.heartbeat)
      l.client.close()
      this.live.delete(id)
    }
    this.setStatus(id, 'offline', null)
  }

  disposeAll(): void {
    this.disposed = true
    this.wanted.clear()
    for (const id of [...this.live.keys()]) {
      this.wanted.delete(id)
      const l = this.live.get(id)!
      clearInterval(l.heartbeat)
      l.client.close()
    }
    this.live.clear()
    for (const t of this.reconnectTimers.values()) clearTimeout(t)
  }

  isOnline(id: string): boolean {
    return this.live.has(id)
  }

  private setStatus(id: string, status: RemoteMachine['status'], error: string | null, extra: Partial<typeof runtimeMachines.$inferInsert> = {}) {
    if (this.disposed) return
    const before = this.db.select({ s: runtimeMachines.status }).from(runtimeMachines).where(eq(runtimeMachines.id, id)).get()?.s
    if (before === 'revoked') return
    this.db.update(runtimeMachines).set({ status, lastError: error, ...extra }).where(eq(runtimeMachines.id, id)).run()
    if (before !== status && (status === 'online' || before === 'online')) {
      const name = this.db.select({ n: runtimeMachines.name }).from(runtimeMachines).where(eq(runtimeMachines.id, id)).get()?.n
      this.journal.activity({ type: status === 'online' ? 'runtime.connected' : 'runtime.disconnected', level: status === 'online' ? 'success' : 'warning', title: `${name} ${status === 'online' ? 'est connectée' : 'est déconnectée'}`, detail: error })
    }
    this.bus.invalidate('machines')
  }

  async ensureClient(id: string): Promise<RuntimeClient> {
    if (this.disposed) throw new OrbitError('conflict', 'Orbit se ferme.')
    const l = this.live.get(id)
    if (l && !l.client.closed) return l.client
    const pending = this.connecting.get(id)
    if (pending) return pending
    const p = this.open(id).finally(() => this.connecting.delete(id))
    this.connecting.set(id, p)
    return p
  }

  private async open(id: string): Promise<RuntimeClient> {
    const m = this.get(id)
    if (m.transport === 'ssh' && !m.hostKeyFingerprint) throw new OrbitError('validation', 'Clé d’hôte non confirmée : Orbit refuse de se connecter.')
    const transport = this.transportFactory ? this.transportFactory(m) : m.transport === 'local' ? localSocketTransport(m.runtimeHome) : sshTransport({ host: m.host!, user: m.user, port: m.port, runtimeHome: m.runtimeHome, knownHostsFile: this.knownHosts })
    const client = new RuntimeClient(transport)
    try {
      const hello = await client.request<HelloResult>('hello', { protocol: PROTOCOL_VERSION, client: 'orbit' }, 15_000)
      this.setStatus(id, 'online', null, {
        runtimeVersion: hello.runtimeVersion,
        protocol: hello.protocol,
        lastHeartbeatAt: nowIso(),
        engines: hello.engines,
        info: { Hôte: hello.machine.hostname, Système: hello.machine.platform, Architecture: hello.machine.arch, Node: hello.machine.node, Processeurs: `${hello.machine.cpus} cœurs`, Mémoire: `${hello.machine.memoryGb} Go` },
      })
    } catch (err) {
      client.close()
      const msg = err instanceof Error ? err.message : String(err)
      this.setStatus(id, 'error', msg)
      this.scheduleReconnect(id)
      throw new OrbitError('provider', `Connexion impossible à ${m.name} : ${msg}`)
    }
    client.onEvent((e) => this.record(id, e))
    const heartbeat = setInterval(() => {
      client
        .request<{ at: string }>('heartbeat', {}, 10_000)
        .then(() => this.db.update(runtimeMachines).set({ lastHeartbeatAt: nowIso() }).where(eq(runtimeMachines.id, id)).run())
        .then(() => this.bus.invalidate('machines'))
        .catch(() => client.close())
    }, HEARTBEAT_MS)
    heartbeat.unref?.()
    this.live.set(id, { client, heartbeat })
    client.onClose((reason) => {
      clearInterval(heartbeat)
      if (this.live.get(id)?.client === client) this.live.delete(id)
      this.setStatus(id, 'offline', reason)
      this.scheduleReconnect(id)
    })
    await this.catchUp(id, client)
    return client
  }

  private scheduleReconnect(id: string, delay = 5_000) {
    if (this.disposed || !this.wanted.has(id) || this.reconnectTimers.has(id)) return
    const t = setTimeout(() => {
      this.reconnectTimers.delete(id)
      this.ensureClient(id).catch(() => this.scheduleReconnect(id, Math.min(60_000, delay * 2)))
    }, delay)
    t.unref?.()
    this.reconnectTimers.set(id, t)
  }

  /** Replays events missed while disconnected, from the stored cursor: each applied once. */
  private async catchUp(id: string, client: RuntimeClient) {
    for (let guard = 0; guard < 50; guard++) {
      const cursor = this.db.select({ c: runtimeMachines.cursor }).from(runtimeMachines).where(eq(runtimeMachines.id, id)).get()?.c ?? 0
      const res = await client.request<{ events: RuntimeEvent[]; lastSeq: number }>('events.since', { cursor, limit: 1000 })
      for (const e of res.events) this.record(id, e)
      if (!res.events.length || res.events.at(-1)!.seq >= res.lastSeq) break
    }
  }

  /** Persists an event exactly once (unique machine+seq) and updates remote mission state. */
  private record(id: string, e: RuntimeEvent) {
    if (this.disposed) return
    const inserted = this.db.insert(runtimeEvents).values({ machineId: id, seq: e.seq, kind: e.kind, missionId: e.missionId, data: e.data, at: e.at }).onConflictDoNothing().run()
    const cursor = this.db.select({ c: runtimeMachines.cursor }).from(runtimeMachines).where(eq(runtimeMachines.id, id)).get()?.c ?? 0
    if (e.seq > cursor) this.db.update(runtimeMachines).set({ cursor: e.seq }).where(eq(runtimeMachines.id, id)).run()
    if (!inserted.changes || e.kind !== 'mission.status' || !e.missionId) return
    const status = String(e.data.status)
    const row = this.db.select().from(remoteMissions).where(eq(remoteMissions.id, e.missionId)).get()
    const patch = { status, result: (e.data.result as string | undefined) ?? row?.result ?? null, error: (e.data.error as string | null | undefined) ?? null, updatedAt: nowIso() }
    if (row) this.db.update(remoteMissions).set(patch).where(eq(remoteMissions.id, e.missionId)).run()
    else this.db.insert(remoteMissions).values({ id: e.missionId, machineId: id, missionId: null, ...patch }).run()
    if (['done', 'failed', 'cancelled', 'interrupted'].includes(status)) this.onRemoteOutcome?.(e.missionId, { status, result: patch.result, error: patch.error })
    this.bus.invalidate('machines')
  }

  /** Events Orbit has observed for one remote mission (survives reconnections and restarts). */
  missionEvents(executionId: string): RuntimeEvent[] {
    return this.db.select().from(runtimeEvents).where(eq(runtimeEvents.missionId, executionId)).all().map((r) => ({ seq: r.seq, at: r.at, missionId: r.missionId, kind: r.kind as RuntimeEvent['kind'], data: r.data ?? {} }))
  }

  // Engines

  engineFor(agent: Agent): AgentEngine {
    const machineId = agent.machineId
    if (!machineId) throw new OrbitError('validation', `${agent.name} n’a pas de machine distante.`)
    const engineId = agent.providerId as RemoteEngineId
    const machine = this.get(machineId)
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const mgr = this
    return {
      id: agent.providerId === 'claude-code' ? 'claude-code' : 'codex',
      name: `${agent.providerId === 'claude-code' ? 'Claude Code' : 'Codex'} sur ${machine.name}`,
      capabilities: { resume: true, approvals: true, interrupt: true, fileDiffs: false, budgetCap: false, usage: 'official', confinable: false, effort: false },
      checkReady: async () => {
        const e = mgr.get(machineId).engines.find((x) => x.id === engineId)
        return { ready: Boolean(e?.available) && mgr.isOnline(machineId), detail: e?.detail ?? 'Machine hors ligne.', auth: 'unknown' }
      },
      run: (req, io) => mgr.runRemote(machineId, engineId, req, io),
    }
  }

  private async runRemote(machineId: string, engineId: RemoteEngineId, req: Parameters<AgentEngine['run']>[0], io: Parameters<AgentEngine['run']>[1]): Promise<EngineRunResult> {
    const project = req.policy.workspace
    if (!isSafeProjectName(project)) return { status: 'failed', finalText: '', error: new EngineError('protocol', 'Nom de projet distant invalide.'), sessionId: req.sessionId }
    let client: RuntimeClient
    try {
      client = await this.ensureClient(machineId)
    } catch (err) {
      return { status: 'failed', finalText: '', error: new EngineError('network', err instanceof Error ? err.message : String(err)), sessionId: req.sessionId }
    }
    // No Orbit secret ever leaves the Mac: remote engines use the server's own logins.
    const submit: MissionSubmit = {
      id: req.runId,
      engine: engineId,
      model: req.model,
      project,
      prompt: req.prompt,
      instructions: req.instructions,
      sessionId: req.sessionId,
      policy: { readFiles: req.policy.permissions.readFiles, writeFiles: req.policy.permissions.writeFiles, runCommands: req.policy.permissions.runCommands, network: req.policy.permissions.network, autonomy: req.policy.autonomy },
    }
    this.db.insert(remoteMissions).values({ id: req.runId, machineId, status: 'queued', updatedAt: nowIso() }).onConflictDoNothing().run()
    let sessionId = req.sessionId
    let lastSeq = 0
    let settle: (r: EngineRunResult) => void = () => {}
    const done = new Promise<EngineRunResult>((r) => (settle = r))
    const handled = new Set<number>()
    const apply = (e: RuntimeEvent) => {
      if (e.missionId !== req.runId || handled.has(e.seq)) return
      handled.add(e.seq)
      lastSeq = Math.max(lastSeq, e.seq)
      if (e.kind === 'engine') {
        const ev = e.data.event as EngineEvent
        if (ev.type === 'session') sessionId = ev.sessionId
        io.emit(ev)
      } else if (e.kind === 'approval.requested') {
        const d = e.data as { approvalId: string; summary: string; payload: never; tool: never }
        void io.requestApproval({ externalId: d.approvalId, tool: d.tool, summary: d.summary, payload: d.payload }).then((ok) => this.ensureClient(machineId).then((c) => c.request('approval.resolve', { id: d.approvalId, approve: ok })).catch(() => undefined))
      } else if (e.kind === 'mission.status') {
        const s = String(e.data.status)
        const text = (e.data.result as string | undefined) ?? ''
        if (s === 'done') settle({ status: 'completed', finalText: text, error: null, sessionId: (e.data.sessionId as string | null) ?? sessionId })
        else if (s === 'cancelled') settle({ status: 'cancelled', finalText: text, error: null, sessionId })
        else if (s === 'failed' || s === 'interrupted') settle({ status: 'failed', finalText: text, error: new EngineError('unknown', String(e.data.error ?? 'Échec sur la machine distante.')), sessionId })
      }
    }
    let unsub = client.onEvent(apply)
    const onAbort = () => void this.ensureClient(machineId).then((c) => c.request('mission.cancel', { id: req.runId })).catch(() => undefined)
    req.signal.addEventListener('abort', onAbort)
    // Connection lost mid-run: the mission keeps running remotely; Orbit waits for the
    // reconnection, then replays the events it missed (no duplicates thanks to seq).
    const watchClose = (c: RuntimeClient) =>
      c.onClose(() => {
        unsub()
        const deadline = Date.now() + RECONNECT_WAIT_MS
        const retry = async () => {
          if (Date.now() > deadline) {
            settle({ status: 'failed', finalText: '', error: new EngineError('network', 'Connexion perdue : la mission continue sur la machine distante. Orbit récupérera son résultat à la reconnexion.'), sessionId })
            return
          }
          try {
            const nc = await this.ensureClient(machineId)
            unsub = nc.onEvent(apply)
            watchClose(nc)
            const res = await nc.request<{ events: RuntimeEvent[] }>('events.since', { cursor: lastSeq })
            for (const e of res.events) apply(e)
          } catch {
            setTimeout(() => void retry(), 3000).unref?.()
          }
        }
        setTimeout(() => void retry(), 1000).unref?.()
      })
    watchClose(client)
    try {
      const res = await client.request<{ mission: RemoteMission; existing: boolean }>('mission.submit', submit)
      io.emit({ type: 'status', phase: 'thinking', label: res.existing ? 'Reprend le suivi sur la machine distante' : 'Démarre sur la machine distante' })
      if (res.existing) {
        const ev = await client.request<{ events: RuntimeEvent[] }>('events.since', { cursor: 0, limit: 5000 })
        for (const e of ev.events) apply(e)
      }
      return await done
    } catch (err) {
      return { status: 'failed', finalText: '', error: new EngineError('network', err instanceof Error ? err.message : String(err)), sessionId }
    } finally {
      unsub()
      req.signal.removeEventListener('abort', onAbort)
    }
  }
}
