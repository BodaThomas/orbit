import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import os from 'node:os'
import { join } from 'node:path'
import { nextOccurrence, type Recurrence } from '../shared/schedule'
import type { AgentEngine, ApprovalAsk, EngineEvent } from '../main/core/engine/types'
import { isSafeProjectName, socketPathFor, PROTOCOL_VERSION, RUNTIME_VERSION, type HelloResult, type MissionSubmit, type RemoteEngineId, type RemoteMission, type RemoteSchedule, type RpcRequest, type RuntimeEvent } from './protocol'

/**
 * The runtime daemon: runs companions' missions on a (Linux) machine, independently of
 * the Mac. Persistent (missions, schedules, an append-only event log), reachable only
 * through a Unix socket owned by the user. Orbit reaches it through SSH.
 */
export interface DaemonOptions {
  home: string
  engines: Partial<Record<RemoteEngineId, AgentEngine>>
  maxParallel?: number
  now?: () => number
  log?: (line: string) => void
}

interface Conn {
  socket: Socket
  authed: boolean
  buffer: string
}

const json = (o: unknown) => JSON.stringify(o) + '\n'

export class RuntimeDaemon {
  private server: Server | null = null
  private conns = new Set<Conn>()
  private missions = new Map<string, RemoteMission>()
  private submits = new Map<string, MissionSubmit>()
  private schedules = new Map<string, RemoteSchedule>()
  private running = new Map<string, AbortController>()
  private queue: string[] = []
  private approvals = new Map<string, { missionId: string; resolve: (ok: boolean) => void }>()
  private seq = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private token = ''
  readonly socketPath: string
  private stateDir: string
  private now: () => number

  constructor(private opts: DaemonOptions) {
    this.socketPath = socketPathFor(opts.home, (s) => createHash('sha256').update(s).digest('hex'))
    this.stateDir = join(opts.home, 'state')
    this.now = opts.now ?? Date.now
  }

  // Lifecycle

  async start(): Promise<void> {
    for (const d of [this.opts.home, this.stateDir, join(this.opts.home, 'projects')]) mkdirSync(d, { recursive: true, mode: 0o700 })
    chmodSync(this.opts.home, 0o700)
    const tokenFile = join(this.opts.home, 'token')
    if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(32).toString('hex'), { mode: 0o600 })
    this.token = readFileSync(tokenFile, 'utf8').trim()
    this.load()
    // Work interrupted by a crash or reboot is never silently re-run.
    for (const m of this.missions.values()) {
      if (['running', 'queued', 'awaiting_approval'].includes(m.status)) {
        m.status = 'interrupted'
        m.error = 'Runtime redémarré pendant l’exécution : résultat incertain, rien n’est relancé automatiquement.'
        m.finishedAt = new Date(this.now()).toISOString()
        this.event('mission.status', m.id, { status: m.status, error: m.error })
      }
    }
    this.persist()
    this.event('runtime.started', null, { version: RUNTIME_VERSION })
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath)
    this.server = createServer((socket) => this.accept(socket))
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.socketPath, () => resolve())
    })
    chmodSync(this.socketPath, 0o600)
    writeFileSync(join(this.opts.home, 'socket'), this.socketPath, { mode: 0o600 })
    this.timer = setInterval(() => this.tickSchedules(), 15_000)
    this.timer.unref?.()
    this.tickSchedules()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    for (const c of this.running.values()) c.abort()
    for (const c of this.conns) c.socket.destroy()
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()))
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath)
  }

  // Persistence

  private load() {
    const read = <T>(f: string, d: T): T => {
      try {
        return JSON.parse(readFileSync(join(this.stateDir, f), 'utf8')) as T
      } catch {
        return d
      }
    }
    for (const m of read<RemoteMission[]>('missions.json', [])) this.missions.set(m.id, m)
    for (const s of read<MissionSubmit[]>('submits.json', [])) this.submits.set(s.id, s)
    for (const s of read<RemoteSchedule[]>('schedules.json', [])) this.schedules.set(s.id, s)
    try {
      const lines = readFileSync(join(this.stateDir, 'events.jsonl'), 'utf8').trim().split('\n')
      this.seq = lines.length && lines[0] ? (JSON.parse(lines[lines.length - 1]!) as RuntimeEvent).seq : 0
    } catch {
      this.seq = 0
    }
  }

  private persist() {
    const write = (f: string, data: unknown) => {
      const tmp = join(this.stateDir, `${f}.tmp`)
      writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
      renameSync(tmp, join(this.stateDir, f))
    }
    write('missions.json', [...this.missions.values()])
    // Prompts are kept only while needed to (re)run; finished ones are dropped.
    write('submits.json', [...this.submits.values()].filter((s) => ['queued', 'running', 'awaiting_approval'].includes(this.missions.get(s.id)?.status ?? '')))
    write('schedules.json', [...this.schedules.values()])
  }

  private event(kind: RuntimeEvent['kind'], missionId: string | null, data: Record<string, unknown>): RuntimeEvent {
    const e: RuntimeEvent = { seq: ++this.seq, at: new Date(this.now()).toISOString(), missionId, kind, data }
    appendFileSync(join(this.stateDir, 'events.jsonl'), json(e), { mode: 0o600 })
    for (const c of this.conns) if (c.authed) c.socket.write(json({ jsonrpc: '2.0', method: 'event', params: e }))
    return e
  }

  eventsSince(cursor: number, limit = 1000): RuntimeEvent[] {
    try {
      const out: RuntimeEvent[] = []
      for (const line of readFileSync(join(this.stateDir, 'events.jsonl'), 'utf8').split('\n')) {
        if (!line) continue
        const e = JSON.parse(line) as RuntimeEvent
        if (e.seq > cursor) out.push(e)
        if (out.length >= limit) break
      }
      return out
    } catch {
      return []
    }
  }

  // Connections

  private accept(socket: Socket) {
    const conn: Conn = { socket, authed: false, buffer: '' }
    this.conns.add(conn)
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      conn.buffer += chunk
      let i: number
      while ((i = conn.buffer.indexOf('\n')) >= 0) {
        const line = conn.buffer.slice(0, i).trim()
        conn.buffer = conn.buffer.slice(i + 1)
        if (line) void this.handle(conn, line)
      }
    })
    socket.on('close', () => this.conns.delete(conn))
    socket.on('error', () => this.conns.delete(conn))
  }

  private async handle(conn: Conn, line: string) {
    let req: RpcRequest
    try {
      req = JSON.parse(line) as RpcRequest
    } catch {
      return
    }
    const reply = (result: unknown) => req.id != null && conn.socket.write(json({ jsonrpc: '2.0', id: req.id, result }))
    const fail = (code: number, message: string) => req.id != null && conn.socket.write(json({ jsonrpc: '2.0', id: req.id, error: { code, message } }))
    if (!conn.authed) {
      const token = String((req.params as { token?: string } | undefined)?.token ?? '')
      const ok = req.method === 'auth' && token.length === this.token.length && timingSafeEqual(Buffer.from(token), Buffer.from(this.token))
      if (!ok) {
        conn.socket.end(json({ jsonrpc: '2.0', id: req.id ?? 0, error: { code: 401, message: 'Non authentifié.' } }))
        return
      }
      conn.authed = true
      return reply({ ok: true })
    }
    try {
      reply(await this.dispatch(req.method, (req.params ?? {}) as Record<string, unknown>))
    } catch (err) {
      fail(400, err instanceof Error ? err.message : String(err))
    }
  }

  async dispatch(method: string, p: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'hello': {
        if (Number(p.protocol) !== PROTOCOL_VERSION) throw new Error(`Protocole incompatible : Orbit ${p.protocol}, runtime ${PROTOCOL_VERSION}. Mettez à jour le runtime.`)
        const engines = await Promise.all(
          (Object.entries(this.opts.engines) as [RemoteEngineId, AgentEngine][]).map(async ([id, e]) => {
            const r = await e.checkReady(null).catch((err: unknown) => ({ ready: false, detail: String(err) }))
            return { id, available: r.ready, detail: r.detail }
          }),
        )
        const res: HelloResult = { protocol: PROTOCOL_VERSION, runtimeVersion: RUNTIME_VERSION, machine: { hostname: os.hostname(), platform: `${os.type()} ${os.release()}`, arch: os.arch(), node: process.versions.node, cpus: os.cpus().length, memoryGb: Math.round(os.totalmem() / 1024 ** 3) }, engines, lastSeq: this.seq }
        return res
      }
      case 'heartbeat':
        return { at: new Date(this.now()).toISOString(), uptimeSec: Math.round(process.uptime()), running: this.running.size, queued: this.queue.length, lastSeq: this.seq }
      case 'mission.submit':
        return this.submit(p as unknown as MissionSubmit, null)
      case 'mission.cancel': {
        const m = this.mustGet(String(p.id))
        const c = this.running.get(m.id)
        if (c) {
          for (const [id, a] of this.approvals) {
            if (a.missionId !== m.id) continue
            this.approvals.delete(id)
            a.resolve(false)
          }
          c.abort()
        } else if (m.status === 'queued') {
          this.queue = this.queue.filter((q) => q !== m.id)
          this.setStatus(m, 'cancelled')
        }
        return this.mustGet(m.id)
      }
      case 'mission.get':
        return this.mustGet(String(p.id))
      case 'mission.list':
        return [...this.missions.values()].slice(-200)
      case 'events.since':
        return { events: this.eventsSince(Number(p.cursor ?? 0), Number(p.limit ?? 1000)), lastSeq: this.seq }
      case 'approval.resolve': {
        const a = this.approvals.get(String(p.id))
        if (!a) throw new Error('Demande expirée ou inconnue.')
        this.approvals.delete(String(p.id))
        this.event('approval.resolved', a.missionId, { approvalId: p.id, approved: Boolean(p.approve) })
        a.resolve(Boolean(p.approve))
        return { ok: true }
      }
      case 'schedule.put': {
        const s = p as unknown as RemoteSchedule
        if (!s.id || !s.template) throw new Error('Planification invalide.')
        if (!isSafeProjectName(s.template.project)) throw new Error('Nom de projet invalide.')
        const next = s.enabled ? nextOccurrence(s.recurrence as Recurrence, s.timezone, this.now()) : null
        this.schedules.set(s.id, { ...s, nextRunAt: next?.toISOString() ?? null, lastRunAt: this.schedules.get(s.id)?.lastRunAt ?? null })
        this.persist()
        return this.schedules.get(s.id)
      }
      case 'schedule.delete':
        this.schedules.delete(String(p.id))
        this.persist()
        return { ok: true }
      case 'schedule.list':
        return [...this.schedules.values()]
      default:
        throw new Error(`Méthode inconnue : ${method}`)
    }
  }

  private mustGet(id: string): RemoteMission {
    const m = this.missions.get(id)
    if (!m) throw new Error('Mission inconnue.')
    return m
  }

  // Missions

  submit(s: MissionSubmit, scheduleId: string | null): { mission: RemoteMission; existing: boolean } {
    const existing = this.missions.get(s.id)
    if (existing) return { mission: existing, existing: true }
    if (!isSafeProjectName(s.project)) throw new Error('Nom de projet invalide.')
    if (!this.opts.engines[s.engine]) throw new Error(`Moteur « ${s.engine} » indisponible sur ce runtime.`)
    const m: RemoteMission = { id: s.id, engine: s.engine, project: s.project, status: 'queued', sessionId: s.sessionId, result: null, error: null, createdAt: new Date(this.now()).toISOString(), startedAt: null, finishedAt: null, scheduleId }
    this.missions.set(m.id, m)
    this.submits.set(s.id, s)
    this.queue.push(m.id)
    this.event('mission.status', m.id, { status: 'queued', engine: s.engine, project: s.project, scheduleId })
    this.persist()
    this.pump()
    return { mission: m, existing: false }
  }

  private pump() {
    while (this.running.size < (this.opts.maxParallel ?? 2) && this.queue.length) {
      const id = this.queue.shift()!
      void this.execute(id)
    }
  }

  private setStatus(m: RemoteMission, status: RemoteMission['status'], extra: Partial<RemoteMission> = {}) {
    Object.assign(m, extra, { status })
    if (['done', 'failed', 'cancelled', 'interrupted'].includes(status)) m.finishedAt = new Date(this.now()).toISOString()
    this.event('mission.status', m.id, { status, error: m.error, result: status === 'done' ? m.result : undefined, sessionId: m.sessionId })
    this.persist()
  }

  private async execute(id: string) {
    const m = this.mustGet(id)
    const s = this.submits.get(id)!
    const engine = this.opts.engines[s.engine]!
    const projects = realpathSync(join(this.opts.home, 'projects'))
    const workspace = join(projects, s.project)
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const controller = new AbortController()
    this.running.set(id, controller)
    this.setStatus(m, 'running', { startedAt: new Date(this.now()).toISOString() })
    try {
      const res = await engine.run(
        {
          runId: id,
          sessionId: s.sessionId,
          prompt: s.prompt,
          instructions: s.instructions,
          model: s.model,
          policy: { workspace, permissions: { readFiles: s.policy.readFiles, writeFiles: s.policy.writeFiles, runCommands: s.policy.runCommands, network: s.policy.network, manageProjects: false, externalActions: false }, autonomy: s.policy.autonomy, isolation: 'standard' },
          secret: null,
          budgetUsd: null,
          signal: controller.signal,
        },
        {
          emit: (e: EngineEvent) => {
            if (e.type === 'session') m.sessionId = e.sessionId
            this.event('engine', id, { event: e })
          },
          requestApproval: (ask: ApprovalAsk) => {
            if (controller.signal.aborted) return Promise.resolve(false)
            const approvalId = `${id}:${ask.externalId}`
            this.setStatus(m, 'awaiting_approval')
            this.event('approval.requested', id, { approvalId, summary: ask.summary, payload: ask.payload, tool: ask.tool })
            return new Promise<boolean>((resolve) =>
              this.approvals.set(approvalId, {
                missionId: id,
                resolve: (ok) => {
                  if (m.status === 'awaiting_approval') this.setStatus(m, 'running')
                  resolve(ok)
                },
              }),
            )
          },
        },
      )
      if (res.status === 'cancelled' || controller.signal.aborted) this.setStatus(m, 'cancelled', { result: res.finalText || null, sessionId: res.sessionId })
      else if (res.status === 'failed') this.setStatus(m, 'failed', { error: res.error?.message ?? 'Échec du moteur.', result: res.finalText || null, sessionId: res.sessionId })
      else this.setStatus(m, 'done', { result: res.finalText, sessionId: res.sessionId })
    } catch (err) {
      this.setStatus(m, 'failed', { error: err instanceof Error ? err.message : String(err) })
    } finally {
      this.running.delete(id)
      for (const [aid, a] of this.approvals) if (a.missionId === id) this.approvals.delete(aid)
      this.pump()
    }
  }

  // Schedules (work continues without the Mac)

  tickSchedules(): void {
    const now = this.now()
    for (const s of this.schedules.values()) {
      if (!s.enabled || !s.nextRunAt || Date.parse(s.nextRunAt) > now) continue
      const occurrence = s.nextRunAt
      try {
        const { existing } = this.submit({ ...s.template, id: `sched:${s.id}:${occurrence}` }, s.id)
        if (!existing) this.event('schedule.fired', `sched:${s.id}:${occurrence}`, { scheduleId: s.id, occurrence })
      } catch (err) {
        this.event('schedule.fired', null, { scheduleId: s.id, occurrence, error: err instanceof Error ? err.message : String(err) })
      }
      s.lastRunAt = new Date(now).toISOString()
      s.nextRunAt = nextOccurrence(s.recurrence as Recurrence, s.timezone, now)?.toISOString() ?? null
      this.persist()
    }
  }
}

/** Test-only engine: deterministic, no model, no network. Clearly labelled in `hello`. */
export function echoEngine(): AgentEngine {
  return {
    id: 'codex',
    name: 'Echo (test)',
    capabilities: { resume: true, approvals: true, interrupt: true, fileDiffs: false, budgetCap: false, usage: 'none', confinable: false, effort: false },
    checkReady: async () => ({ ready: true, detail: 'Moteur de test : répète la demande, sans modèle.', auth: 'none' }),
    run: async (req, io) => {
      io.emit({ type: 'session', sessionId: req.sessionId ?? `echo-${req.runId}`, model: 'echo' })
      if (req.prompt.includes('[approve]')) {
        const tool = { externalId: 't1', name: 'Write', kind: 'edit' as const, title: 'Écrit resultat.txt', input: {}, files: ['resultat.txt'] }
        io.emit({ type: 'tool.started', tool })
        const ok = await io.requestApproval({ externalId: 't1', tool, summary: tool.title, payload: { tool: 'Write', kind: 'edit', paths: ['resultat.txt'] } })
        io.emit({ type: 'tool.completed', tool: { externalId: 't1', status: ok ? 'completed' : 'denied' } })
        if (ok) writeFileSync(join(req.policy.workspace, 'resultat.txt'), 'écrit par echo\n')
      }
      const slow = /\[slow:(\d+)\]/.exec(req.prompt)
      if (slow) {
        await new Promise<void>((r) => {
          const t = setTimeout(r, Number(slow[1]))
          req.signal.addEventListener('abort', () => (clearTimeout(t), r()))
        })
      }
      if (req.signal.aborted) return { status: 'cancelled', finalText: '', error: null, sessionId: `echo-${req.runId}` }
      const text = `echo: ${req.prompt}`
      io.emit({ type: 'message', text })
      return { status: 'completed', finalText: text, error: null, sessionId: req.sessionId ?? `echo-${req.runId}` }
    },
  }
}
