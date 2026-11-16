import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import os from 'node:os'
import { join } from 'node:path'
import { and, desc, eq, gte, inArray, sql, sum } from 'drizzle-orm'
import type { OrbitEvent } from '@shared/ipc'
import type { ConstellationLimits } from '@shared/types'
import { composeCore, type Core } from '../main/core/compose'
import type { AgentEngine, EngineId } from '../main/core/engine/types'
import { EventBus } from '../main/core/event-bus'
import type { PlatformServices, SecretCipher } from '../main/core/platform'
import type { ConfinementProof } from '../main/core/security/seatbelt'
import { newId, nowIso, OrbitError } from '../main/core/util'
import { schemaVersion, type DatabaseHandle } from '../main/infra/db/core'
import { agentAppearances, agents, approvalRequests, automationDefinitions, constellationDefinitions, constellationMembers, fileChanges, missionExecutions, missions, providerConnections, usageRecords } from '../main/infra/db/schema'
import { ArtifactStore } from './artifacts'
import { EventLog } from './event-log'
import { fingerprintOf, generateIdentity, loadIdentity, nonce, signMessage, verifyMessage, type Identity } from './identity'
import { RuntimeLogger } from './logger'
import { operationHash } from './operation-hash'
import {
  DEFAULT_LIMITS,
  helloProofMessage,
  methods,
  OPEN_METHODS,
  PROTOCOL_VERSION,
  REPLICATED_TABLES,
  RPC_ERRORS,
  RUNTIME_VERSION,
  SESSION_TTL_MS,
  sessionProofMessage,
  socketPathFor,
  type AgentSync,
  type AutomationSync,
  type ConstellationSync,
  type EngineStatus,
  type HealthReport,
  type HelloResult,
  type LiveEvent,
  type MachineLimits,
  type Method,
  type RemoteEngineId,
  type RpcRequest,
  type RuntimeEvent,
} from './protocol'
import { detectEngines, measure } from './system'

export interface HostOptions {
  home: string
  engines: Partial<Record<EngineId, AgentEngine>>
  /** node:sqlite by default (no native module on the server). */
  openDb: (file: string) => DatabaseHandle
  now?: () => number
  logToStderr?: boolean
  /** Level-3 isolation self-test for this machine (bubblewrap on Linux); absent → never proven. */
  confinementSelfTest?: () => ConfinementProof
  /** Pending approvals older than this are refused and marked expired (default 24 h). */
  approvalTtlMs?: number
  flushIntervalMs?: number
}

interface Conn {
  socket: Socket
  authed: boolean
  buffer: string
  challenge: string | null
  session: { clientId: string; expiresAt: number } | null
}

/** Answered with an RPC error code (never stored as an idempotent result unless definitive). */
class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

const json = (o: unknown) => JSON.stringify(o) + '\n'

/** AES-256-GCM with a key file next to the database (0600). Protects a copied database, not the runtime user. */
export function fileCipher(keyFile: string): SecretCipher {
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 })
  const key = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'hex')
  return {
    available: () => true,
    encrypt: (plain) => {
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', key, iv)
      const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()])
      return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`
    },
    decrypt: (cipher) => {
      const [, iv, tag, data] = cipher.split(':')
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv!, 'base64'))
      d.setAuthTag(Buffer.from(tag!, 'base64'))
      return Buffer.concat([d.update(Buffer.from(data!, 'base64')), d.final()]).toString('utf8')
    },
  }
}

/**
 * Orbit Runtime: the shared execution core (missions, tool policy, approvals, budgets,
 * constellations, scheduler) hosted on a server, with its own SQLite database, an
 * append-only event log and an authenticated control socket. Works with no client.
 */
export class RuntimeHost {
  readonly bus = new EventBus()
  readonly log: RuntimeLogger
  core!: Core
  handle!: DatabaseHandle
  events!: EventLog
  artifacts!: ArtifactStore
  identity!: Identity
  runtimeId = ''
  readonly socketPath: string
  private server: Server | null = null
  private conns = new Set<Conn>()
  private token = ''
  private timers: ReturnType<typeof setInterval>[] = []
  private flushQueued = false
  private startedAt = 0
  private engineCache: { at: number; list: EngineStatus[] } | null = null
  private durationTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private stopping = false
  private now: () => number

  constructor(private opts: HostOptions) {
    this.now = opts.now ?? Date.now
    this.socketPath = socketPathFor(opts.home, (s) => createHash('sha256').update(s).digest('hex'))
    this.log = new RuntimeLogger(opts.home, { stderr: opts.logToStderr ?? false, now: this.now })
  }

  private dir(...p: string[]) {
    return join(this.opts.home, ...p)
  }

  get projectsDir() {
    return this.dir('projects')
  }

  // Lifecycle

  async start(): Promise<void> {
    this.startedAt = this.now()
    for (const d of [this.opts.home, this.dir('state'), this.dir('identity'), this.projectsDir, this.dir('worktrees')]) mkdirSync(d, { recursive: true, mode: 0o700 })
    chmodSync(this.opts.home, 0o700)
    // Local token: proves `attach` runs as this OS user.
    const tokenFile = this.dir('token')
    if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(32).toString('hex'), { mode: 0o600 })
    this.token = readFileSync(tokenFile, 'utf8').trim()
    // Runtime identity (Ed25519), created once.
    const keyFile = this.dir('identity', 'runtime.key')
    if (!existsSync(keyFile)) {
      const g = generateIdentity()
      writeFileSync(keyFile, g.privatePem, { mode: 0o600 })
      writeFileSync(this.dir('identity', 'runtime.id'), `rt_${randomBytes(9).toString('base64url')}`, { mode: 0o600 })
    }
    this.identity = loadIdentity(readFileSync(keyFile, 'utf8'))
    this.runtimeId = readFileSync(this.dir('identity', 'runtime.id'), 'utf8').trim()

    this.handle = this.opts.openDb(this.dir('state', 'runtime.db'))
    this.events = new EventLog(this.handle.sqlite, this.now)
    this.events.install()
    this.artifacts = new ArtifactStore(this.handle.sqlite, this.opts.home, undefined, this.now)
    const platform: PlatformServices = {
      secrets: fileCipher(this.dir('identity', 'secrets.key')),
      nativeNotify: () => undefined, // no desktop here: Orbit notifies from the synced state
      fetch,
      appVersion: RUNTIME_VERSION,
    }
    this.core = composeCore({
      mode: 'real',
      handle: this.handle,
      bus: this.bus,
      platform,
      engines: this.opts.engines,
      worktreeRoot: this.dir('worktrees'),
      // The runtime's own state (database, keys, token, artifacts) is out of reach of every tool.
      protectedPaths: [this.dir('state'), this.dir('identity'), this.dir('artifacts'), this.dir('token'), this.dir('logs')],
      now: this.opts.now,
      confinementSelfTest: this.opts.confinementSelfTest ?? (() => ({ ok: false, checkedAt: nowIso(), checks: [], error: 'Isolation par mission indisponible sur ce runtime.' })),
    })
    const c = this.core
    c.missions.interruptedNote = 'Interrompue : le runtime a redémarré pendant l’exécution. Rien n’est relancé automatiquement ; vous pouvez poursuivre la mission (la session est conservée).'
    c.constellations.interruptedNote = 'Interrompue : le runtime a redémarré pendant l’exécution. Les résultats déjà obtenus sont conservés.'
    c.scheduler.downtimeLabel = 'runtime arrêté'
    c.missions.admission = (agent, mission) => this.admit(agent.id, mission.id, mission.constellationRunId)
    c.conversations.recoverInterrupted()
    c.missions.recoverInterrupted()
    c.constellations.recoverInterrupted()
    c.agents.resetTransientStatuses()
    this.requeueDeferred()

    this.bus.on((e) => this.onBus(e))
    c.scheduler.start()
    this.events.append({ type: 'runtime.started', version: RUNTIME_VERSION, protocol: PROTOCOL_VERSION })
    this.flush()

    if (existsSync(this.socketPath)) unlinkSync(this.socketPath)
    this.server = createServer((s) => this.accept(s))
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.socketPath, () => resolve())
    })
    chmodSync(this.socketPath, 0o600)
    writeFileSync(this.dir('socket'), this.socketPath, { mode: 0o600 })

    const every = (ms: number, fn: () => void) => {
      const t = setInterval(() => {
        try {
          fn()
        } catch (err) {
          this.log.error('tâche périodique en échec', { error: String(err) })
        }
      }, ms)
      t.unref?.()
      this.timers.push(t)
    }
    every(this.opts.flushIntervalMs ?? 250, () => this.flush())
    every(30_000, () => this.housekeeping())
    this.log.info('runtime démarré', { version: RUNTIME_VERSION, socket: this.socketPath, runtimeId: this.runtimeId })
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    for (const t of this.timers) clearInterval(t)
    for (const t of this.durationTimers.values()) clearTimeout(t)
    this.core?.scheduler.stop()
    // Controlled stop: running work is cancelled and recorded; it is never silently re-run.
    this.core?.constellations.cancelAll()
    this.core?.missions.cancelAll()
    // Let cancelled work record its final state before the database closes (bounded wait).
    for (let i = 0; i < 100 && this.core && this.core.handle.db.select({ id: missions.id }).from(missions).where(eq(missions.status, 'running')).all().some((m) => this.core.missions.isRunning(m.id)); i++) await new Promise((r) => setTimeout(r, 50))
    await new Promise((r) => setTimeout(r, 50))
    try {
      this.flush()
    } catch {
      /* closing */
    }
    for (const c of this.conns) c.socket.destroy()
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()))
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath)
    this.closed = true
    this.handle?.close()
    this.log.info('runtime arrêté')
  }

  // Events

  private onBus(e: OrbitEvent) {
    if (this.closed) return
    if (e.type === 'mission.delta' || e.type === 'mission.activity' || e.type === 'constellation.signal') {
      const live: LiveEvent = { type: e.type, payload: e as unknown as Record<string, unknown>, at: new Date(this.now()).toISOString() }
      for (const c of this.conns) if (this.sessionValid(c)) c.socket.write(json({ jsonrpc: '2.0', method: 'live', params: live }))
    }
    if (e.type === 'mission.event' && ['completed', 'failed', 'cancelled', 'started'].includes(e.event.type)) this.onMissionLifecycle(e.event.missionId, e.event.type)
    if (!this.flushQueued) {
      this.flushQueued = true
      setImmediate(() => {
        this.flushQueued = false
        if (!this.closed) this.flush()
      })
    }
  }

  private closed = false

  flush(): RuntimeEvent[] {
    if (this.closed || !this.handle) return []
    const out = this.events.flush()
    if (out.length) this.push(out)
    return out
  }

  private push(events: RuntimeEvent[]) {
    for (const c of this.conns) {
      if (!this.sessionValid(c)) continue
      for (const e of events) c.socket.write(json({ jsonrpc: '2.0', method: 'event', params: e }))
    }
  }

  private runtimeEvent(data: Record<string, unknown>) {
    this.push([this.events.append(data)])
  }

  // Limits

  limits(): MachineLimits {
    const r = this.handle.sqlite.prepare("SELECT value FROM rt_settings WHERE key = 'limits'").get() as { value: string } | undefined
    return r ? { ...DEFAULT_LIMITS, ...(JSON.parse(r.value) as MachineLimits) } : DEFAULT_LIMITS
  }

  private apiSpend(sinceIso: string): number {
    const row = this.core.handle.db.select({ total: sum(usageRecords.costUsd) }).from(usageRecords).where(and(gte(usageRecords.createdAt, sinceIso), inArray(usageRecords.costKind, ['official', 'estimated']))).get()
    return Number(row?.total ?? 0)
  }

  /** Machine-wide admission, enforced here whatever the client asks: budgets, then capacity. */
  private admit(_agentId: string, missionId: string, constellationRunId: string | null): { defer: string } | { block: string } | null {
    const l = this.limits()
    const day = new Date(this.now())
    day.setUTCHours(0, 0, 0, 0)
    const month = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1))
    if (l.dailyBudgetUsd != null && this.apiSpend(day.toISOString()) >= l.dailyBudgetUsd) return { block: `Budget journalier de ce serveur atteint (${l.dailyBudgetUsd} $ de dépense API).` }
    if (l.monthlyBudgetUsd != null && this.apiSpend(month.toISOString()) >= l.monthlyBudgetUsd) return { block: `Budget mensuel de ce serveur atteint (${l.monthlyBudgetUsd} $ de dépense API).` }
    // Constellation sub-missions are bounded by the constellation's own parallelism (no deadlock).
    if (constellationRunId) return null
    const running = this.core.handle.db.select({ id: missions.id }).from(missions).where(eq(missions.status, 'running')).all().filter((m) => m.id !== missionId).length
    if (running >= l.maxConcurrentMissions) return { defer: `En file d’attente : ${running} mission(s) déjà en cours sur ce serveur (limite ${l.maxConcurrentMissions}).` }
    return null
  }

  /** Missions deferred before a restart never started: they are safe to admit again. */
  private requeueDeferred() {
    const rows = this.handle.sqlite.prepare("SELECT DISTINCT m.id FROM missions m JOIN execution_events e ON e.mission_id = m.id AND e.execution_id = 'queue' WHERE m.status = 'todo' AND NOT EXISTS (SELECT 1 FROM mission_executions x WHERE x.mission_id = m.id)").all() as { id: string }[]
    for (const r of rows) this.core.missions.deferred.set(r.id, { origin: 'user' })
  }

  private pumpDeferred() {
    for (const [id, d] of [...this.core.missions.deferred]) {
      try {
        const m = this.core.missions.get(id)
        if (m.status !== 'todo') {
          this.core.missions.deferred.delete(id)
          continue
        }
        const after = this.core.missions.start(id, d.origin, d.followUp)
        if (this.core.missions.deferred.has(id) && after.status === 'todo') break // still full
      } catch (err) {
        this.core.missions.deferred.delete(id)
        this.log.warn('mission en attente non démarrée', { missionId: id, error: String(err) })
      }
    }
  }

  private onMissionLifecycle(missionId: string, type: string) {
    if (type === 'started') {
      const max = this.limits().maxMissionDurationMin
      clearTimeout(this.durationTimers.get(missionId))
      const t = setTimeout(() => {
        this.durationTimers.delete(missionId)
        if (!this.core.missions.isRunning(missionId)) return
        this.log.warn('durée maximale atteinte : mission arrêtée', { missionId, max })
        this.runtimeEvent({ type: 'mission.timeout', missionId, maxMinutes: max })
        this.core.missions.cancel(missionId)
      }, max * 60_000)
      t.unref?.()
      this.durationTimers.set(missionId, t)
      return
    }
    clearTimeout(this.durationTimers.get(missionId))
    this.durationTimers.delete(missionId)
    setImmediate(() => {
      if (this.stopping) return
      this.collectArtifacts(missionId)
      this.pumpDeferred()
    })
  }

  private collectArtifacts(missionId: string) {
    try {
      const m = this.core.missions.get(missionId)
      if (!['done', 'failed', 'cancelled'].includes(m.status)) return
      const paths = this.core.handle.db.select({ p: fileChanges.path, k: fileChanges.kind }).from(fileChanges).where(eq(fileChanges.missionId, missionId)).all().filter((f) => f.k !== 'deleted').map((f) => f.p)
      const last = this.core.handle.db.select({ at: missionExecutions.startedAt }).from(missionExecutions).where(eq(missionExecutions.missionId, missionId)).orderBy(desc(missionExecutions.startedAt)).limit(1).get()
      const stored = this.artifacts.collect({ id: m.id, agentId: m.agentId, result: m.result, workspace: m.workspace }, paths, last?.at ?? null)
      for (const a of stored) if (a.status !== 'stored') this.log.warn('artefact non conservé', { missionId, name: a.name, status: a.status })
    } catch (err) {
      this.log.error('collecte des artefacts en échec', { missionId, error: String(err) })
    }
  }

  private housekeeping() {
    // Pending approvals expire: the paused operation is refused, never approved by default.
    const ttl = this.opts.approvalTtlMs ?? 24 * 3600_000
    const cutoff = new Date(this.now() - ttl).toISOString()
    const stale = this.core.handle.db.select().from(approvalRequests).where(and(eq(approvalRequests.status, 'pending'), sql`${approvalRequests.createdAt} < ${cutoff}`)).all()
    for (const a of stale) {
      this.core.runner.resolveApproval(a.id, false)
      this.core.handle.db.update(approvalRequests).set({ status: 'expired', resolvedAt: nowIso(), resolvedBy: 'runtime:expired' }).where(eq(approvalRequests.id, a.id)).run()
      if (a.kind === 'mission_start' && a.missionId) {
        try {
          const m = this.core.missions.get(a.missionId)
          if (m.status === 'approval_required') this.core.handle.db.update(missions).set({ status: 'cancelled', error: 'Demande d’accord expirée sans réponse.', finishedAt: nowIso(), updatedAt: nowIso() }).where(eq(missions.id, m.id)).run()
        } catch {
          /* gone */
        }
      }
      this.core.security.audit({ agentId: a.agentId, missionId: a.missionId, layer: 'approval', action: 'approval.expired', target: a.summary, decision: 'denied', reason: 'Sans réponse dans le délai.' })
    }
    this.pumpDeferred()
    if (new Date(this.now()).getUTCMinutes() === 0) {
      this.events.prune(30)
      // Answers to old commands: kept long enough for any resend from a Mac that was away.
      this.handle.sqlite.prepare('DELETE FROM rt_requests WHERE at < ?').run(new Date(this.now() - 90 * 86400_000).toISOString())
    }
  }

  // Connections

  private sessionValid(c: Conn): boolean {
    // Revocation from the CLI only touches the database: re-checked here so pushes stop at once.
    return Boolean(c.authed && c.session && c.session.expiresAt > this.now() && !this.clientRevoked(c.session.clientId))
  }

  private accept(socket: Socket) {
    const conn: Conn = { socket, authed: false, buffer: '', challenge: null, session: null }
    this.conns.add(conn)
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      conn.buffer += chunk
      if (conn.buffer.length > 8 * 1024 * 1024) {
        socket.destroy() // oversized line: never parsed
        return
      }
      let i: number
      while ((i = conn.buffer.indexOf('\n')) >= 0) {
        const line = conn.buffer.slice(0, i).trim()
        conn.buffer = conn.buffer.slice(i + 1)
        if (line) void this.handle_(conn, line)
      }
    })
    socket.on('close', () => this.conns.delete(conn))
    socket.on('error', () => this.conns.delete(conn))
  }

  private async handle_(conn: Conn, line: string) {
    let req: RpcRequest
    try {
      req = JSON.parse(line) as RpcRequest
    } catch {
      return
    }
    const reply = (result: unknown) => req.id != null && conn.socket.writable && conn.socket.write(json({ jsonrpc: '2.0', id: req.id, result }))
    const fail = (code: number, message: string) => req.id != null && conn.socket.writable && conn.socket.write(json({ jsonrpc: '2.0', id: req.id, error: { code, message } }))
    if (!conn.authed) {
      const token = String((req.params as { token?: string } | undefined)?.token ?? '')
      const ok = req.method === 'auth' && token.length === this.token.length && timingSafeEqual(Buffer.from(token), Buffer.from(this.token))
      if (!ok) {
        this.log.warn('connexion refusée : jeton local invalide')
        conn.socket.end(json({ jsonrpc: '2.0', id: req.id ?? 0, error: { code: RPC_ERRORS.unauthenticated, message: 'Non authentifié.' } }))
        return
      }
      conn.authed = true
      return reply({ ok: true })
    }
    try {
      reply(await this.dispatch(conn, req.method, req.params ?? {}))
    } catch (err) {
      if (err instanceof RpcError) return fail(err.code, err.message)
      if (err instanceof OrbitError) return fail(err.code === 'not_found' ? RPC_ERRORS.notFound : err.code === 'forbidden' || err.code === 'budget' ? RPC_ERRORS.forbidden : err.code === 'validation' ? RPC_ERRORS.invalid : RPC_ERRORS.conflict, err.message)
      this.log.error('erreur interne', { method: req.method, error: err instanceof Error ? err.message : String(err) })
      fail(RPC_ERRORS.internal, err instanceof Error ? err.message : String(err))
    }
  }

  /** Validates, authorises, deduplicates, then runs one method. Public for in-process tests. */
  async dispatch(conn: Conn | null, method: string, raw: unknown): Promise<unknown> {
    if (!(method in methods)) throw new RpcError(RPC_ERRORS.notFound, `Méthode inconnue : ${method}`)
    const m = method as Method
    const parsed = methods[m].safeParse(raw)
    if (!parsed.success) throw new RpcError(RPC_ERRORS.invalid, `Paramètres invalides (${m}) : ${parsed.error.issues.map((i) => `${i.path.join('.') || '·'} ${i.message}`).join(' ; ')}`)
    const p = parsed.data as Record<string, unknown>
    if (conn && !OPEN_METHODS.includes(m)) {
      if (!conn.session) throw new RpcError(RPC_ERRORS.unauthenticated, 'Session requise : appairez ce client puis ouvrez une session.')
      if (conn.session.expiresAt <= this.now()) throw new RpcError(RPC_ERRORS.sessionExpired, 'Session expirée.')
      if (this.clientRevoked(conn.session.clientId)) {
        conn.session = null
        throw new RpcError(RPC_ERRORS.forbidden, 'Ce client a été révoqué.')
      }
    }
    const requestId = typeof p.requestId === 'string' ? p.requestId : null
    if (requestId) {
      const done = this.handle.sqlite.prepare('SELECT result, error FROM rt_requests WHERE id = ?').get(requestId) as { result: string | null; error: string | null } | undefined
      if (done) {
        if (done.error) throw new RpcError(RPC_ERRORS.conflict, done.error)
        return done.result ? JSON.parse(done.result) : null
      }
      // Same request still running (resent before its answer): share its outcome, never run it twice.
      const running = this.inflight.get(requestId)
      if (running) return running
      const pending = this.execute(conn, m, p, requestId)
      this.inflight.set(requestId, pending)
      const clear = () => this.inflight.delete(requestId)
      pending.then(clear, clear)
      return pending
    }
    return this.execute(conn, m, p, null)
  }

  private inflight = new Map<string, Promise<unknown>>()

  private async execute(conn: Conn | null, m: Method, p: Record<string, unknown>, requestId: string | null): Promise<unknown> {
    try {
      const result = await this.run(conn, m, p)
      if (requestId) this.handle.sqlite.prepare('INSERT OR IGNORE INTO rt_requests (id, client_id, method, result, at) VALUES (?, ?, ?, ?, ?)').run(requestId, conn?.session?.clientId ?? null, m, JSON.stringify(result ?? null), nowIso())
      this.flush()
      return result
    } catch (err) {
      // Definitive refusals are remembered: resending the same command gets the same answer.
      if (requestId && (err instanceof OrbitError || err instanceof RpcError)) this.handle.sqlite.prepare('INSERT OR IGNORE INTO rt_requests (id, client_id, method, error, at) VALUES (?, ?, ?, ?, ?)').run(requestId, conn?.session?.clientId ?? null, m, err.message, nowIso())
      this.flush()
      throw err
    }
  }

  private clientRevoked(id: string): boolean {
    const r = this.handle.sqlite.prepare('SELECT revoked_at FROM rt_clients WHERE id = ?').get(id) as { revoked_at: string | null } | undefined
    return !r || Boolean(r.revoked_at)
  }

  private async run(conn: Conn | null, m: Method, p: Record<string, unknown>): Promise<unknown> {
    const c = this.core
    const db = c.handle.db
    switch (m) {
      case 'hello': {
        if (p.protocol !== PROTOCOL_VERSION) throw new RpcError(RPC_ERRORS.conflict, `Protocole incompatible : Orbit ${String(p.protocol)}, runtime ${PROTOCOL_VERSION}. Mettez à jour ${Number(p.protocol) > PROTOCOL_VERSION ? 'le runtime' : 'Orbit'}.`)
        const challenge = nonce()
        if (conn) conn.challenge = challenge
        const clientId = (p.client as { id: string | null }).id
        const b = this.events.bounds()
        const res: HelloResult = {
          protocol: PROTOCOL_VERSION,
          runtimeVersion: RUNTIME_VERSION,
          schemaVersion: schemaVersion(),
          runtimeId: this.runtimeId,
          runtimeKey: this.identity.publicKey,
          runtimeKeyFingerprint: this.identity.fingerprint,
          proof: signMessage(this.identity, helloProofMessage(this.runtimeId, String(p.nonce))),
          challenge,
          paired: Boolean(clientId && !this.clientRevoked(clientId)),
          machine: { hostname: os.hostname(), platform: `${os.type()} ${os.release()}`, arch: os.arch(), node: process.versions.node, cpus: os.cpus().length, memoryGb: Math.round(os.totalmem() / 1024 ** 3) },
          lastSeq: b.lastSeq,
          firstSeq: b.firstSeq,
        }
        return res
      }
      case 'client.pair': {
        const existing = this.handle.sqlite.prepare('SELECT public_key, revoked_at FROM rt_clients WHERE id = ?').get(p.clientId) as { public_key: string; revoked_at: string | null } | undefined
        if (existing?.revoked_at) throw new RpcError(RPC_ERRORS.forbidden, 'Ce client a été révoqué : créez une nouvelle identité.')
        if (existing && existing.public_key !== p.publicKey) throw new RpcError(RPC_ERRORS.conflict, 'Un autre client utilise déjà cet identifiant.')
        if (!existing) {
          this.handle.sqlite.prepare('INSERT INTO rt_clients (id, name, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?, ?)').run(p.clientId, p.name, p.publicKey, fingerprintOf(String(p.publicKey)), nowIso())
          this.log.info('client appairé', { clientId: p.clientId, name: p.name })
          this.runtimeEvent({ type: 'client.paired', clientId: p.clientId, name: p.name })
        }
        return { ok: true, fingerprint: fingerprintOf(String(p.publicKey)) }
      }
      case 'session.open': {
        const challenge = conn?.challenge
        if (conn) conn.challenge = null // one use, whatever happens
        if (!challenge) throw new RpcError(RPC_ERRORS.unauthenticated, 'Défi absent ou déjà utilisé : recommencez par hello.')
        const row = this.handle.sqlite.prepare('SELECT public_key, revoked_at FROM rt_clients WHERE id = ?').get(p.clientId) as { public_key: string; revoked_at: string | null } | undefined
        if (!row) throw new RpcError(RPC_ERRORS.unauthenticated, 'Client inconnu : appairez-le d’abord.')
        if (row.revoked_at) throw new RpcError(RPC_ERRORS.forbidden, 'Ce client a été révoqué.')
        if (!verifyMessage(row.public_key, sessionProofMessage(this.runtimeId, challenge, String(p.clientId)), String(p.signature))) {
          this.log.warn('signature de session invalide', { clientId: p.clientId })
          throw new RpcError(RPC_ERRORS.unauthenticated, 'Signature invalide.')
        }
        const expiresAt = this.now() + SESSION_TTL_MS
        if (conn) conn.session = { clientId: String(p.clientId), expiresAt }
        this.handle.sqlite.prepare('UPDATE rt_clients SET last_seen_at = ? WHERE id = ?').run(nowIso(), p.clientId)
        return { expiresAt: new Date(expiresAt).toISOString() }
      }
      case 'health.liveness':
        return { live: true, version: RUNTIME_VERSION }
      case 'heartbeat': {
        const b = this.events.bounds()
        return { at: new Date(this.now()).toISOString(), uptimeSec: Math.round((this.now() - this.startedAt) / 1000), lastSeq: b.lastSeq, running: db.select({ id: missions.id }).from(missions).where(eq(missions.status, 'running')).all().length, pendingApprovals: db.select({ id: approvalRequests.id }).from(approvalRequests).where(eq(approvalRequests.status, 'pending')).all().length, sessionExpiresAt: conn?.session ? new Date(conn.session.expiresAt).toISOString() : null }
      }
      case 'health':
        return this.health()
      case 'metrics':
        return measure(this.opts.home, db.select({ id: missions.id }).from(missions).where(eq(missions.status, 'running')).all().length)
      case 'engines':
        return this.engineStatus(Boolean(p.refresh))
      case 'events.since': {
        const events = this.events.since(Number(p.cursor), Number(p.limit ?? 1000))
        if (conn?.session) this.handle.sqlite.prepare('UPDATE rt_clients SET cursor = MAX(cursor, ?) WHERE id = ?').run(Number(p.cursor), conn.session.clientId)
        return { events, ...this.events.bounds() }
      }
      case 'snapshot':
        return this.events.snapshot((p.tables as string[] | undefined) ?? Object.keys(REPLICATED_TABLES), Number(p.limit ?? 5000))
      case 'client.list':
        return (this.handle.sqlite.prepare('SELECT id, name, fingerprint, created_at, last_seen_at, revoked_at FROM rt_clients ORDER BY created_at').all() as Record<string, unknown>[]).map((r) => ({ ...r }))
      case 'client.revoke': {
        this.handle.sqlite.prepare('UPDATE rt_clients SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(nowIso(), p.clientId)
        for (const k of this.conns) if (k.session?.clientId === p.clientId) k.socket.destroy()
        this.runtimeEvent({ type: 'client.revoked', clientId: p.clientId })
        return { ok: true }
      }
      case 'limits.put':
        this.handle.sqlite.prepare("INSERT INTO rt_settings (key, value) VALUES ('limits', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(p.limits))
        return this.limits()
      case 'agent.put':
        return this.putAgent(p.agent as AgentSync)
      case 'agent.delete': {
        // Disabled, never deleted: deleting would cascade to its missions and erase history.
        db.update(agents).set({ enabled: false, updatedAt: nowIso() }).where(eq(agents.id, String(p.id))).run()
        this.handle.sqlite.prepare("UPDATE rt_sync SET removed = 1, updated_at = ? WHERE kind = 'agent' AND id = ?").run(nowIso(), p.id)
        return { ok: true }
      }
      case 'constellation.put':
        return this.putConstellation(p.constellation as ConstellationSync)
      case 'constellation.delete':
        this.handle.sqlite.prepare("UPDATE rt_sync SET removed = 1, updated_at = ? WHERE kind = 'constellation' AND id = ?").run(nowIso(), p.id)
        return { ok: true }
      case 'mission.create': {
        const mi = p.mission as { id: string; shortId: string; title: string; description: string; agentId: string; priority: 'low' | 'normal' | 'high' | 'urgent' }
        const existing = db.select().from(missions).where(eq(missions.id, mi.id)).get()
        if (existing) return { missionId: mi.id, status: existing.status, existing: true }
        this.requireSynced('agent', mi.agentId)
        const created = c.missions.create({ id: mi.id, shortId: mi.shortId, title: mi.title, description: mi.description, agentId: mi.agentId, priority: mi.priority, startNow: true, origin: p.origin as 'user' | 'automation' })
        return { missionId: created.id, status: created.status, existing: false }
      }
      case 'mission.followUp': {
        const mm = c.missions.followUp(String(p.id), String(p.prompt))
        return { missionId: mm.id, status: mm.status }
      }
      case 'mission.cancel': {
        const cur = c.missions.get(String(p.id))
        if (['done', 'failed', 'cancelled'].includes(cur.status)) return { missionId: cur.id, status: cur.status }
        const mm = c.missions.cancel(cur.id)
        return { missionId: mm.id, status: mm.status }
      }
      case 'approval.resolve':
        return this.resolveApproval(conn, p)
      case 'constellation.launch': {
        this.requireSynced('constellation', String(p.constellationId))
        const def = c.constellations.get(String(p.constellationId))
        for (const mem of def.members) this.requireSynced('agent', mem.agentId)
        const run = c.constellations.launch(def.id, String(p.goal), { origin: p.origin as 'user' | 'automation', idempotencyKey: `req:${String(p.requestId)}`, id: typeof p.runId === 'string' ? p.runId : undefined })
        return { runId: run.id, status: run.status }
      }
      case 'constellation.cancel': {
        const run = c.constellations.cancel(String(p.runId))
        return { runId: run.id, status: run.status }
      }
      case 'automation.put':
        return this.putAutomation(p.automation as AutomationSync)
      case 'automation.get': {
        const a = c.scheduler.get(String(p.id))
        return { automation: a, owned: a.schedulerOwner === 'local' }
      }
      case 'automation.release': {
        const exists = db.select({ id: automationDefinitions.id }).from(automationDefinitions).where(eq(automationDefinitions.id, String(p.id))).get()
        if (!exists) return { released: true, automation: null }
        const a = c.scheduler.release(String(p.id))
        this.handle.sqlite.prepare("UPDATE rt_sync SET removed = 1, updated_at = ? WHERE kind = 'automation' AND id = ?").run(nowIso(), p.id)
        return { released: true, automation: a }
      }
      case 'automation.setStatus':
        return c.scheduler.setStatus(String(p.id), p.status as 'active' | 'paused')
      case 'automation.runNow':
        return c.scheduler.runNow(String(p.id))
      case 'automation.confirmRun':
        return c.scheduler.confirmRun(String(p.runId), Boolean(p.approve))
      case 'artifact.list':
        return this.artifacts.list(p.missionId as string | undefined)
      case 'artifact.get':
        return this.artifacts.read(String(p.id), Number(p.offset ?? 0))
    }
  }

  private requireSynced(kind: 'agent' | 'constellation' | 'automation', id: string) {
    const r = this.handle.sqlite.prepare('SELECT removed FROM rt_sync WHERE kind = ? AND id = ?').get(kind, id) as { removed: number } | undefined
    if (!r || r.removed) throw new OrbitError('validation', kind === 'agent' ? 'Ce compagnon n’est pas configuré sur ce serveur : synchronisez-le depuis Orbit.' : kind === 'constellation' ? 'Cette constellation n’est pas configurée sur ce serveur.' : 'Automatisation inconnue sur ce serveur.')
  }

  /** Version check: an older snapshot never overwrites a newer one. */
  private acceptVersion(kind: string, id: string, version: string, compare: (a: string, b: string) => number): boolean {
    const r = this.handle.sqlite.prepare('SELECT version, removed FROM rt_sync WHERE kind = ? AND id = ?').get(kind, id) as { version: string; removed: number } | undefined
    if (r && !r.removed && compare(version, r.version) < 0) return false
    this.handle.sqlite.prepare('INSERT INTO rt_sync (kind, id, version, removed, updated_at) VALUES (?, ?, ?, 0, ?) ON CONFLICT(kind, id) DO UPDATE SET version = excluded.version, removed = 0, updated_at = excluded.updated_at').run(kind, id, version, nowIso())
    return true
  }

  private projectPath(project: string | null): string | null {
    if (!project) return null
    const p = join(this.projectsDir, project)
    mkdirSync(p, { recursive: true, mode: 0o700 })
    return p
  }

  private putAgent(a: AgentSync) {
    const db = this.core.handle.db
    if (!this.acceptVersion('agent', a.id, a.version, (x, y) => x.localeCompare(y))) return { applied: false, reason: 'version plus ancienne' }
    const values = {
      name: a.name,
      role: a.role,
      description: a.description,
      providerId: a.providerId,
      model: a.model,
      instructions: a.instructions,
      autonomy: a.autonomy,
      permissions: a.permissions,
      // On the runtime, the project is a folder under <home>/projects, never a path from the Mac.
      workingDirectory: this.projectPath(a.project),
      isolation: a.isolation,
      effort: a.effort,
      runtime: 'local',
      machineId: null,
      dailyBudgetUsd: a.dailyBudgetUsd,
      enabled: a.enabled,
      updatedAt: nowIso(),
    }
    db.transaction((tx) => {
      const exists = tx.select({ id: agents.id }).from(agents).where(eq(agents.id, a.id)).get()
      if (exists) tx.update(agents).set(values).where(eq(agents.id, a.id)).run()
      else tx.insert(agents).values({ id: a.id, ...values, createdAt: nowIso() }).run()
      tx.insert(agentAppearances).values({ agentId: a.id, appearance: a.appearance as never }).onConflictDoUpdate({ target: agentAppearances.agentId, set: { appearance: a.appearance as never, updatedAt: nowIso() } }).run()
    })
    this.engineCache = null
    return { applied: true }
  }

  private putConstellation(k: ConstellationSync) {
    const db = this.core.handle.db
    for (const m of k.members) this.requireSynced('agent', m.agentId)
    if (!this.acceptVersion('constellation', k.id, k.version, (x, y) => x.localeCompare(y))) return { applied: false, reason: 'version plus ancienne' }
    const ts = nowIso()
    const values = { name: k.name, description: k.description, objective: k.objective, coordinatorAgentId: k.coordinatorAgentId, workspace: this.projectPath(k.project), workspaceMode: k.workspaceMode, permissions: k.permissions, limits: k.limits as ConstellationLimits, isTemplate: false, updatedAt: ts }
    db.transaction((tx) => {
      const exists = tx.select({ id: constellationDefinitions.id }).from(constellationDefinitions).where(eq(constellationDefinitions.id, k.id)).get()
      if (exists) tx.update(constellationDefinitions).set(values).where(eq(constellationDefinitions.id, k.id)).run()
      else tx.insert(constellationDefinitions).values({ id: k.id, ...values, createdAt: ts }).run()
      tx.delete(constellationMembers).where(eq(constellationMembers.constellationId, k.id)).run()
      k.members.forEach((m, i) => tx.insert(constellationMembers).values({ constellationId: k.id, agentId: m.agentId, role: m.role, responsibilities: m.responsibilities, canDelegate: m.canDelegate, sortOrder: i }).run())
    })
    return { applied: true }
  }

  private putAutomation(a: AutomationSync) {
    if (a.targetKind === 'agent') this.requireSynced('agent', a.targetId)
    else this.requireSynced('constellation', a.targetId)
    const r = this.handle.sqlite.prepare("SELECT version, removed FROM rt_sync WHERE kind = 'automation' AND id = ?").get(a.id) as { version: string; removed: number } | undefined
    if (r && !r.removed && Number(r.version) > a.version) return { applied: false, reason: 'version plus ancienne', automation: this.core.scheduler.get(a.id) }
    const auto = this.core.scheduler.upsertFromOrbit(a.id, {
      name: a.name,
      description: a.description,
      targetKind: a.targetKind,
      targetId: a.targetId,
      title: a.title,
      prompt: a.prompt,
      recurrence: a.recurrence as never,
      timezone: a.timezone,
      missedPolicy: a.missedPolicy,
      maxRunsPerDay: a.maxRunsPerDay,
      triggers: a.triggers,
      maxDurationMin: a.maxDurationMin,
      budgetUsd: a.budgetUsd,
      failurePolicy: a.failurePolicy,
      status: a.status,
      configVersion: a.version,
    })
    this.handle.sqlite.prepare("INSERT INTO rt_sync (kind, id, version, removed, updated_at) VALUES ('automation', ?, ?, 0, ?) ON CONFLICT(kind, id) DO UPDATE SET version = excluded.version, removed = 0, updated_at = excluded.updated_at").run(a.id, String(a.version), nowIso())
    return { applied: true, automation: auto }
  }

  /**
   * One answer, one operation: the approval must be pending, unexpired, and the client must
   * name the exact operation it saw (hash of id, kind, mission, tool call, summary, payload).
   */
  private resolveApproval(conn: Conn | null, p: Record<string, unknown>) {
    const db = this.core.handle.db
    const row = db.select().from(approvalRequests).where(eq(approvalRequests.id, String(p.id))).get()
    if (!row) throw new OrbitError('not_found', 'Demande inconnue sur ce serveur.')
    if (row.status !== 'pending') throw new OrbitError('conflict', `Cette demande a déjà été traitée (${row.status}).`)
    const expected = operationHash(row)
    if (p.approve && p.operationHash !== expected) {
      this.core.security.audit({ agentId: row.agentId, missionId: row.missionId, layer: 'approval', action: 'approval.mismatch', target: row.summary, decision: 'denied', reason: 'Empreinte de l’opération différente : accord refusé.' })
      throw new OrbitError('conflict', 'L’opération a changé depuis son affichage : accord refusé. Rouvrez la demande.')
    }
    const res = this.core.missions.resolveApproval(row.id, Boolean(p.approve), p.scope as 'once' | 'mission' | 'always')
    db.update(approvalRequests).set({ resolvedBy: conn?.session?.clientId ?? 'local', operationHash: expected }).where(eq(approvalRequests.id, row.id)).run()
    return { id: res.id, status: res.status }
  }

  private async engineStatus(refresh = false): Promise<EngineStatus[]> {
    if (!refresh && this.engineCache && this.now() - this.engineCache.at < 60_000) return this.engineCache.list
    const keys = this.core.handle.db.select({ id: providerConnections.providerId, s: providerConnections.encryptedSecret }).from(providerConnections).all()
    const has = (id: string) => keys.some((k) => k.id === id && k.s)
    const list = await detectEngines(this.opts.engines as Partial<Record<RemoteEngineId, AgentEngine>>, { anthropic: has('anthropic'), openai: has('openai') })
    this.engineCache = { at: this.now(), list }
    return list
  }

  health(): HealthReport {
    const db = this.core.handle.db
    const checks: HealthReport['checks'] = []
    let dbOk: boolean
    try {
      this.handle.sqlite.prepare('SELECT 1').get()
      const ic = this.handle.sqlite.prepare('PRAGMA quick_check').get() as Record<string, unknown>
      dbOk = Object.values(ic)[0] === 'ok'
      checks.push({ name: 'Base de données', ok: dbOk, detail: dbOk ? `SQLite (${this.handle.driver}), schéma ${schemaVersion()}` : 'Contrôle d’intégrité en échec' })
    } catch (err) {
      dbOk = false
      checks.push({ name: 'Base de données', ok: false, detail: String(err) })
    }
    const sched = this.core.scheduler
    const lastTick = sched.lastTickAt ? Date.parse(sched.lastTickAt) : 0
    const schedOk = sched.running && this.now() - lastTick < 90_000
    checks.push({ name: 'Planificateur', ok: schedOk, detail: schedOk ? `Dernier passage ${sched.lastTickAt}` : 'Aucun passage récent' })
    checks.push({ name: 'Socket de contrôle', ok: Boolean(this.server?.listening), detail: this.socketPath })
    const engines = this.engineCache?.list ?? []
    checks.push({ name: 'Moteurs', ok: engines.some((e) => e.ready) || !this.engineCache, detail: this.engineCache ? `${engines.filter((e) => e.ready).length} prêt(s)` : 'Détection au premier appel' })
    const since = new Date(this.now() - 86400_000).toISOString()
    const recent = db.select({ s: missions.status, u: missions.updatedAt }).from(missions).where(gte(missions.updatedAt, since)).all()
    const all = db.select({ s: missions.status }).from(missions).where(inArray(missions.status, ['running', 'todo', 'approval_required'])).all()
    const autos = db.select().from(automationDefinitions).where(and(eq(automationDefinitions.status, 'active'), eq(automationDefinitions.schedulerOwner, 'local'))).all()
    const next = autos.map((a) => a.nextRunAt).filter((x): x is string => Boolean(x)).sort()[0] ?? null
    const failures = this.handle.sqlite.prepare("SELECT COUNT(*) AS n FROM automation_runs WHERE status IN ('failed','uncertain') AND created_at >= ?").get(since) as { n: number }
    return {
      live: true,
      ready: dbOk && schedOk && Boolean(this.server?.listening),
      version: RUNTIME_VERSION,
      protocol: PROTOCOL_VERSION,
      schemaVersion: schemaVersion(),
      uptimeSec: Math.round((this.now() - this.startedAt) / 1000),
      checks,
      scheduler: { running: sched.running, lastTickAt: sched.lastTickAt, activeAutomations: autos.length, nextRunAt: next, recentFailures: failures.n },
      missions: { running: all.filter((m) => m.s === 'running').length, queued: this.core.missions.deferred.size, awaitingApproval: all.filter((m) => m.s === 'approval_required').length, failed24h: recent.filter((m) => m.s === 'failed').length, done24h: recent.filter((m) => m.s === 'done').length },
      lastErrors: this.log.errors.slice(-10),
    }
  }

  /** Runs a method in-process as a paired client would (CLI `orbit-runtime status`, tests). */
  async local(method: Method, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.dispatch(null, method, params)
  }
}

export const newRequestId = () => `rq_${newId()}${newId()}`
