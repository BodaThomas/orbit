import { createHash, randomBytes } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm'
import type { Agent, ApprovalRequest, Automation, ConstellationDefinition, ConstellationRun, GrantScope, Mission, RemoteMachine } from '@shared/types'
import type { DatabaseHandle } from '../../infra/db/core'
import { agents, approvalRequests, automationDefinitions, constellationRuns, missions, remoteArtifacts, remoteCommands, runtimeEvents, runtimeMachines } from '../../infra/db/schema'
import { generateIdentity, loadIdentity, nonce, signMessage, verifyMessage, type Identity } from '../../../runtime/identity'
import { operationHash } from '../../../runtime/operation-hash'
import {
  helloProofMessage,
  isSafeProjectName,
  PROTOCOL_VERSION,
  sessionProofMessage,
  type AgentSync,
  type ArtifactMeta,
  type AutomationSync,
  type ConstellationSync,
  type EngineStatus,
  type HealthReport,
  type HelloResult,
  type LiveEvent,
  type MachineLimits,
  type MetricsReport,
  type RuntimeEvent,
} from '../../../runtime/protocol'
import type { AgentManager } from '../agents'
import type { AutomationRemote, Scheduler } from '../automations/scheduler'
import type { ConstellationEngine, ConstellationRemote } from '../constellations/engine'
import type { EventBus } from '../event-bus'
import type { Journal } from '../journal'
import type { MissionManager, MissionRemote } from '../missions'
import type { SecretCipher } from '../platform'
import { newId, nowIso, OrbitError } from '../util'
import { localSocketTransport, RuntimeClient, RuntimeRpcError, sshArgs, sshTransport, type RuntimeTransport } from './client'
import { RemoteMirror } from './mirror'

const run = promisify(execFile)
const HEARTBEAT_MS = 30_000
const SUPERVISION_MS = 60_000

export interface MachineInput {
  name: string
  transport: 'ssh' | 'local'
  host: string | null
  user: string | null
  port: number
  runtimeHome: string
  identityFile?: string | null
}

interface Live {
  client: RuntimeClient
  timers: ReturnType<typeof setInterval>[]
  sessionExpiresAt: number
}

/** The runtime said no (definitive) - as opposed to an unknown outcome (connection lost). */
const definitive = (err: unknown) => err instanceof RuntimeRpcError && err.code !== 440

/**
 * Orbit Desktop's side of the remote runtimes: the control centre.
 *
 * - Connects over SSH (pinned host key) and authenticates both ways at the application level
 *   (runtime identity pinned by the user, this client's own key, expiring sessions).
 * - Keeps a synced copy of everything the runtime executes (event cursor, idempotent apply,
 *   snapshot resync when the log was pruned), and notifies from real transitions only.
 * - Turns every user action on runtime-owned work into a command with a request id that is
 *   persisted: a command whose answer was lost is resent, never executed twice.
 * - Pushes the minimal configuration companions need (never secrets, files or history).
 * - Moves automations between schedulers without ever leaving two of them active.
 *
 * Nothing touches a remote machine without an explicit user action.
 */
export class RemoteMachineManager {
  private live = new Map<string, Live>()
  private connecting = new Map<string, Promise<RuntimeClient>>()
  private wanted = new Set<string>()
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private scanned = new Map<string, { line: string; fingerprint: string }>()
  private pendingIdentity = new Map<string, { runtimeId: string; key: string; fingerprint: string; changed: boolean }>()
  private catchingUp = new Set<string>()
  /** Lost unexpectedly during this session (a reconnection is then announced). */
  private lost = new Set<string>()
  private syncTimer: ReturnType<typeof setTimeout> | null = null
  private unsubBus: (() => void) | null = null
  private disposed = false
  private mirror: RemoteMirror
  private parts: { missions: MissionManager; constellations: ConstellationEngine; scheduler: Scheduler; agents: AgentManager } | null = null
  private identityCache: Identity | null = null

  constructor(
    private handle: DatabaseHandle,
    private bus: EventBus,
    private journal: Journal,
    private dataDir: string,
    private bundlePath: () => string | null,
    private transportFactory?: (m: RemoteMachine) => RuntimeTransport,
    private secrets?: SecretCipher,
  ) {
    this.mirror = new RemoteMirror(handle.sqlite, {
      agent: (id) => this.db.select({ n: agents.name }).from(agents).where(eq(agents.id, id)).get()?.n ?? 'Un compagnon',
      machine: (id) => this.db.select({ n: runtimeMachines.name }).from(runtimeMachines).where(eq(runtimeMachines.id, id)).get()?.n ?? 'le serveur',
    })
  }

  private get db() {
    return this.handle.db
  }

  /** Wires the core: runtime-owned work is routed here. */
  attach(parts: { missions: MissionManager; constellations: ConstellationEngine; scheduler: Scheduler; agents: AgentManager }): void {
    this.parts = parts
    const missionRemote: MissionRemote = { submit: (m, o, f) => this.submitMission(m, o, f), cancel: (m) => this.cancelMission(m), resolveApproval: (r, a, s) => this.resolveApproval(r, a, s) }
    const constellationRemote: ConstellationRemote = { launch: (d, r, g, o) => this.launchRun(d, r, g, o), cancel: (r) => this.cancelRun(r) }
    const automationRemote: AutomationRemote = { push: (a) => this.pushAutomation(a), setStatus: (a, s) => this.setAutomationStatus(a, s), runNow: (a) => this.runAutomationNow(a), confirmRun: (a, r, ok) => this.confirmAutomationRun(a, r, ok), release: (a) => this.releaseAutomation(a) }
    parts.missions.remote = missionRemote
    parts.constellations.remote = constellationRemote
    parts.scheduler.remote = automationRemote
  }

  /** Reconnects machines that were connected, and keeps their configuration in sync. */
  start(): void {
    this.unsubBus = this.bus.on((e) => {
      if (e.type === 'invalidate' && (e.scopes.includes('agents') || e.scopes.includes('constellations') || e.scopes.includes('all'))) this.scheduleConfigSync()
    })
    for (const m of this.db.select().from(runtimeMachines).all()) {
      if (m.clientId && m.runtimeKeyFingerprint && m.status !== 'revoked') {
        this.wanted.add(m.id)
        this.scheduleReconnect(m.id, 500)
      }
    }
  }

  private get knownHosts() {
    const dir = join(this.dataDir, 'ssh')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const f = join(dir, 'known_hosts')
    if (!existsSync(f)) writeFileSync(f, '', { mode: 0o600 })
    return f
  }

  /** This Orbit Desktop's identity (Ed25519), its private key encrypted by the Keychain. */
  identity(): { clientId: string; identity: Identity } {
    const dir = join(this.dataDir, 'identity')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const keyFile = join(dir, 'client.key')
    const idFile = join(dir, 'client.id')
    if (!existsSync(keyFile)) {
      const g = generateIdentity()
      const stored = this.secrets?.available() ? `enc:${this.secrets.encrypt(g.privatePem)}` : g.privatePem
      writeFileSync(keyFile, stored, { mode: 0o600 })
      writeFileSync(idFile, `orbit_${randomBytes(9).toString('base64url')}`, { mode: 0o600 })
    }
    if (!this.identityCache) {
      const raw = readFileSync(keyFile, 'utf8')
      this.identityCache = loadIdentity(raw.startsWith('enc:') ? this.secrets!.decrypt(raw.slice(4)) : raw)
    }
    return { clientId: readFileSync(idFile, 'utf8').trim(), identity: this.identityCache }
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
    const running = this.db.select({ id: missions.id }).from(missions).where(and(eq(missions.remoteMachineId, m.id), inArray(missions.status, ['running', 'approval_required']))).all().length
    const pendingApprovals = this.db.select({ id: approvalRequests.id }).from(approvalRequests).where(and(eq(approvalRequests.machineId, m.id), eq(approvalRequests.status, 'pending'))).all().length
    const activeAutomations = this.db.select({ id: automationDefinitions.id }).from(automationDefinitions).where(and(eq(automationDefinitions.schedulerOwner, m.id), eq(automationDefinitions.status, 'active'))).all().length
    const remoteCompanions = this.db.select({ id: agents.id }).from(agents).where(and(eq(agents.runtime, 'remote'), eq(agents.machineId, m.id))).all().length
    const pending = this.pendingIdentity.get(m.id)
    const { hostKey: _h, cursor: _c, runtimeKey: _k, clientId, pairedAt, sshIdentityFile, ...rest } = m
    return {
      ...rest,
      sshIdentityFile,
      transport: m.transport === 'local' ? 'local' : 'ssh',
      status: m.status as RemoteMachine['status'],
      engines: (m.engines ?? []) as RemoteMachine['engines'],
      info: m.info ?? null,
      runningMissions: running,
      pendingRuntimeKey: pending ? { runtimeId: pending.runtimeId, fingerprint: pending.fingerprint, changed: pending.changed } : null,
      paired: Boolean(clientId && pairedAt),
      health: (m.health as unknown as HealthReport) ?? null,
      metrics: (m.metrics as unknown as MetricsReport) ?? null,
      limits: (m.limits as unknown as MachineLimits) ?? null,
      pendingApprovals,
      activeAutomations,
      remoteCompanions,
    }
  }

  register(input: MachineInput): RemoteMachine {
    if (input.transport === 'ssh' && (!input.host || !/^[A-Za-z0-9.-]+$/.test(input.host))) throw new OrbitError('validation', 'Hôte invalide (nom DNS ou adresse IP).')
    if (input.user && !/^[a-z_][a-z0-9_-]{0,31}$/i.test(input.user)) throw new OrbitError('validation', 'Utilisateur invalide.')
    if (!input.runtimeHome.startsWith('/')) throw new OrbitError('validation', 'Dossier du runtime : chemin absolu attendu (par exemple /var/lib/orbit).')
    if (input.identityFile && (!input.identityFile.startsWith('/') || !existsSync(input.identityFile))) throw new OrbitError('validation', 'Clé SSH : chemin absolu d’un fichier existant attendu.')
    const id = newId()
    this.db.insert(runtimeMachines).values({ id, name: input.name, transport: input.transport, host: input.host, user: input.user, port: input.port, runtimeHome: input.runtimeHome, status: input.transport === 'ssh' ? 'pending_host_key' : 'ready', sshIdentityFile: input.identityFile ?? null, createdAt: nowIso() }).run()
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

  /** Exact commands of the user-level installation, shown before anything runs. */
  deployPlan(id: string): string[] {
    const m = this.get(id)
    const h = m.runtimeHome
    return [
      `ssh ${m.user ? `${m.user}@` : ''}${m.host} -p ${m.port} "mkdir -p ${h}/bin && chmod 700 ${h}"`,
      `ssh … "cat > ${h}/bin/orbit-runtime.mjs" < orbit-runtime.mjs (${this.bundlePath() ? 'fourni avec Orbit' : 'à construire : npm run build:runtime'})`,
      `ssh … "printf '#!/bin/sh\\nexec node ${h}/bin/orbit-runtime.mjs \\"\\$@\\"\\n' > ${h}/bin/orbit-runtime && chmod 700 ${h}/bin/orbit-runtime"`,
      `ssh … "${h}/bin/orbit-runtime doctor --home ${h}"`,
      `ssh … "mkdir -p ~/.config/systemd/user && ${h}/bin/orbit-runtime unit --home ${h} > ~/.config/systemd/user/orbit-runtime.service"`,
      `ssh … "systemctl --user daemon-reload && systemctl --user enable --now orbit-runtime"`,
      `Prérequis à faire par vous sur le serveur : Node.js 22.16+ (LTS 24 recommandée), un utilisateur dédié sans droits d’administration, les connexions des moteurs (« claude » puis /login, « codex login ») faites sur le serveur, et « loginctl enable-linger » pour fonctionner sans session ouverte. Installation système recommandée (service sous un utilisateur dédié) : docs/REMOTE_SETUP.md.`,
    ]
  }

  /** Runs the plan above. Only called after the user confirmed the exact commands. */
  async deploy(id: string): Promise<RemoteMachine> {
    const m = this.get(id)
    if (m.transport !== 'ssh' || !m.hostKeyFingerprint) throw new OrbitError('validation', 'Confirmez d’abord la clé d’hôte de la machine.')
    const bundle = this.bundlePath()
    if (!bundle || !existsSync(bundle)) throw new OrbitError('validation', 'Bundle du runtime introuvable (npm run build:runtime).')
    const target = { host: m.host!, user: m.user, port: m.port, runtimeHome: m.runtimeHome, knownHostsFile: this.knownHosts, identityFile: m.sshIdentityFile }
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

  /** Forgets the machine: host key, runtime identity, connection. Its synced history stays readable. */
  async revoke(id: string): Promise<void> {
    const m = this.get(id)
    const owned = this.db.select({ id: automationDefinitions.id }).from(automationDefinitions).where(eq(automationDefinitions.schedulerOwner, id)).all()
    if (owned.length) throw new OrbitError('conflict', `${owned.length} automatisation(s) sont planifiées sur cette machine : ramenez-les sur ce Mac ou supprimez-les d’abord.`)
    // Best effort: tell the runtime to forget this client, so the key can't be reused.
    const l = this.live.get(id)
    if (l && m.status === 'online') {
      const { clientId } = this.identity()
      await l.client.request('client.revoke', { requestId: `revoke_${clientId}_${id}`, clientId }, 5000).catch(() => undefined)
    }
    this.disconnect(id)
    if (m.transport === 'ssh' && m.host) {
      const host = m.port === 22 ? m.host : `[${m.host}]:${m.port}`
      writeFileSync(this.knownHosts, readFileSync(this.knownHosts, 'utf8').split('\n').filter((l) => l && !l.startsWith(`${host} `)).join('\n') + '\n', { mode: 0o600 })
    }
    this.db.update(runtimeMachines).set({ status: 'revoked', hostKey: null, runtimeKey: null, runtimeKeyFingerprint: null, clientId: null, pairedAt: null }).where(eq(runtimeMachines.id, id)).run()
    this.journal.audit({ actor: 'user', agentId: null, action: 'machine.revoke', target: m.name, allowed: true, reason: 'Clé d’hôte et identité oubliées ; retirez aussi la clé SSH d’Orbit de authorized_keys sur le serveur.' })
    this.bus.invalidate('machines')
  }

  // Connection

  async connect(id: string): Promise<RemoteMachine> {
    this.wanted.add(id)
    await this.ensureClient(id)
    return this.get(id)
  }

  /** The user compared the runtime's identity fingerprint and accepts it (first time or after a change). */
  async confirmRuntimeIdentity(id: string, fingerprint: string): Promise<RemoteMachine> {
    const p = this.pendingIdentity.get(id)
    if (!p || p.fingerprint !== fingerprint) throw new OrbitError('conflict', 'Empreinte différente de celle présentée : reconnectez-vous.')
    this.db.update(runtimeMachines).set({ runtimeId: p.runtimeId, runtimeKey: p.key, runtimeKeyFingerprint: p.fingerprint, lastError: null }).where(eq(runtimeMachines.id, id)).run()
    this.pendingIdentity.delete(id)
    this.journal.audit({ actor: 'user', agentId: null, action: 'machine.pinRuntimeIdentity', target: this.get(id).name, allowed: true, reason: fingerprint })
    return this.connect(id)
  }

  disconnect(id: string): void {
    this.wanted.delete(id)
    clearTimeout(this.reconnectTimers.get(id))
    this.reconnectTimers.delete(id)
    const l = this.live.get(id)
    if (l) {
      for (const t of l.timers) clearInterval(t)
      l.client.close()
      this.live.delete(id)
    }
    this.setStatus(id, 'offline', null, {}, true)
  }

  disposeAll(): void {
    this.disposed = true
    this.unsubBus?.()
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.wanted.clear()
    for (const l of this.live.values()) {
      for (const t of l.timers) clearInterval(t)
      l.client.close()
    }
    this.live.clear()
    for (const t of this.reconnectTimers.values()) clearTimeout(t)
  }

  isOnline(id: string): boolean {
    const l = this.live.get(id)
    return Boolean(l && !l.client.closed)
  }

  private setStatus(id: string, status: RemoteMachine['status'], error: string | null, extra: Partial<typeof runtimeMachines.$inferInsert> = {}, userAction = false) {
    if (this.disposed) return
    const before = this.db.select({ s: runtimeMachines.status, n: runtimeMachines.name }).from(runtimeMachines).where(eq(runtimeMachines.id, id)).get()
    if (!before || before.s === 'revoked') return
    this.db.update(runtimeMachines).set({ status, lastError: error, ...extra }).where(eq(runtimeMachines.id, id)).run()
    if (before.s !== status && (status === 'online' || before.s === 'online')) {
      this.journal.activity({ type: status === 'online' ? 'runtime.connected' : 'runtime.disconnected', level: status === 'online' ? 'success' : 'warning', title: `${before.n} ${status === 'online' ? 'est connectée' : 'est déconnectée'}`, detail: error })
      // An unexpected loss is worth a notification, and so is its recovery - not a launch,
      // not the user's own click.
      const slot = Math.floor(Date.now() / 600_000)
      if (status !== 'online' && before.s === 'online' && !userAction) {
        this.lost.add(id)
        this.journal.notify('machine', `${before.n} est injoignable`, `Les missions continuent sur le serveur. ${error ?? ''}`.trim(), '/machines', `machine:${id}:lost:${slot}`)
      } else if (status === 'online' && this.lost.delete(id)) {
        this.journal.notify('machine', `${before.n} est de nouveau joignable`, 'Synchronisation en cours.', '/machines', `machine:${id}:back:${slot}`)
      }
    }
    this.bus.invalidate('machines')
  }

  async ensureClient(id: string): Promise<RuntimeClient> {
    if (this.disposed) throw new OrbitError('conflict', 'Orbit se ferme.')
    const l = this.live.get(id)
    if (l && !l.client.closed && l.sessionExpiresAt > Date.now() + 60_000) return l.client
    if (l && !l.client.closed) {
      // Session about to expire: reconnect cleanly.
      for (const t of l.timers) clearInterval(t)
      l.client.close()
      this.live.delete(id)
    }
    const pending = this.connecting.get(id)
    if (pending) return pending
    const p = this.open(id).finally(() => this.connecting.delete(id))
    this.connecting.set(id, p)
    return p
  }

  private transportFor(m: RemoteMachine): RuntimeTransport {
    if (this.transportFactory) return this.transportFactory(m)
    if (m.transport === 'local') return localSocketTransport(m.runtimeHome)
    return sshTransport({ host: m.host!, user: m.user, port: m.port, runtimeHome: m.runtimeHome, knownHostsFile: this.knownHosts, identityFile: m.sshIdentityFile })
  }

  private async open(id: string): Promise<RuntimeClient> {
    const m = this.get(id)
    if (m.transport === 'ssh' && !m.hostKeyFingerprint) throw new OrbitError('validation', 'Clé d’hôte non confirmée : Orbit refuse de se connecter.')
    const row = this.db.select().from(runtimeMachines).where(eq(runtimeMachines.id, id)).get()!
    const client = new RuntimeClient(this.transportFor(m))
    const { clientId, identity } = this.identity()
    let hello: HelloResult
    let sessionExpiresAt: number
    try {
      const n = nonce()
      hello = await client.request<HelloResult>('hello', { protocol: PROTOCOL_VERSION, client: { id: clientId, name: 'Orbit Desktop', version: PROTOCOL_VERSION.toString() }, nonce: n }, 15_000)
      // 1. The runtime proves it holds its key; 2. that key is the one the user pinned.
      if (!verifyMessage(hello.runtimeKey, helloProofMessage(hello.runtimeId, n), hello.proof)) throw new OrbitError('forbidden', 'Le runtime n’a pas prouvé son identité (signature invalide).')
      if (!row.runtimeKeyFingerprint || row.runtimeKey !== hello.runtimeKey || row.runtimeId !== hello.runtimeId) {
        this.pendingIdentity.set(id, { runtimeId: hello.runtimeId, key: hello.runtimeKey, fingerprint: hello.runtimeKeyFingerprint, changed: Boolean(row.runtimeKeyFingerprint) })
        client.close()
        this.wanted.delete(id)
        const msg = row.runtimeKeyFingerprint ? `L’identité du runtime a changé (${hello.runtimeKeyFingerprint}) : connexion refusée tant que vous ne l’avez pas vérifiée.` : 'Vérifiez l’empreinte du runtime pour terminer l’ajout.'
        this.setStatus(id, 'error', msg)
        throw new OrbitError('forbidden', msg)
      }
      if (!hello.paired) {
        await client.request('client.pair', { clientId, name: 'Orbit Desktop', publicKey: identity.publicKey })
        this.journal.audit({ actor: 'user', agentId: null, action: 'machine.pair', target: m.name, allowed: true, reason: identity.fingerprint })
      }
      const s = await client.request<{ expiresAt: string }>('session.open', { clientId, signature: signMessage(identity, sessionProofMessage(hello.runtimeId, hello.challenge, clientId)) })
      sessionExpiresAt = Date.parse(s.expiresAt)
      this.setStatus(id, 'online', null, {
        clientId,
        pairedAt: row.pairedAt ?? nowIso(),
        runtimeVersion: hello.runtimeVersion,
        protocol: hello.protocol,
        schemaVersion: hello.schemaVersion,
        lastHeartbeatAt: nowIso(),
        info: { Hôte: hello.machine.hostname, Système: hello.machine.platform, Architecture: hello.machine.arch, Node: hello.machine.node, Processeurs: `${hello.machine.cpus} cœurs`, Mémoire: `${hello.machine.memoryGb} Go` },
      })
    } catch (err) {
      client.close()
      const msg = err instanceof Error ? err.message : String(err)
      if (!(err instanceof OrbitError && err.code === 'forbidden')) {
        this.setStatus(id, 'error', msg)
        this.scheduleReconnect(id)
      }
      throw err instanceof OrbitError ? err : new OrbitError('provider', `Connexion impossible à ${m.name} : ${msg}`)
    }
    client.onEvent((e) => {
      if (!this.catchingUp.has(id)) this.applyEvents(id, [e], false)
    })
    client.onLive((e) => this.onLive(e))
    const timers = [
      setInterval(() => void this.beat(id, client), HEARTBEAT_MS),
      setInterval(() => void this.supervise(id, client), SUPERVISION_MS),
    ]
    for (const t of timers) t.unref?.()
    this.live.set(id, { client, timers, sessionExpiresAt })
    client.onClose((reason) => {
      for (const t of timers) clearInterval(t)
      if (this.live.get(id)?.client === client) this.live.delete(id)
      this.setStatus(id, 'offline', reason)
      this.scheduleReconnect(id)
    })
    await this.catchUp(id, client, hello.firstSeq)
    await this.resendPending(id)
    await this.syncConfig(id).catch((err: unknown) => this.db.update(runtimeMachines).set({ syncError: err instanceof Error ? err.message : String(err) }).where(eq(runtimeMachines.id, id)).run())
    await this.reconcileTransfers(id)
    void this.supervise(id, client)
    return client
  }

  private async beat(id: string, client: RuntimeClient) {
    try {
      await client.request('heartbeat', {}, 10_000)
      if (this.disposed) return
      this.db.update(runtimeMachines).set({ lastHeartbeatAt: nowIso() }).where(eq(runtimeMachines.id, id)).run()
      this.bus.invalidate('machines')
      if ((this.live.get(id)?.sessionExpiresAt ?? 0) < Date.now() + 5 * 60_000) {
        client.close() // renewed by the reconnection
      }
    } catch {
      client.close()
    }
  }

  /** Health, resources and engines: real values from the runtime, stored with their time. */
  private async supervise(id: string, client: RuntimeClient) {
    try {
      const [health, metrics, engines] = await Promise.all([client.request<HealthReport>('health', {}, 15_000), client.request<MetricsReport>('metrics', {}, 15_000), client.request<EngineStatus[]>('engines', {}, 30_000)])
      if (this.disposed) return
      const before = this.db.select({ h: runtimeMachines.health }).from(runtimeMachines).where(eq(runtimeMachines.id, id)).get()?.h as unknown as HealthReport | null
      this.db.update(runtimeMachines).set({ health: health as never, metrics: metrics as never, engines: engines.map((e) => ({ ...e, available: e.ready })) as never }).where(eq(runtimeMachines.id, id)).run()
      if (before?.scheduler.running && !health.scheduler.running) this.journal.notify('machine', `Planificateur indisponible sur ${this.get(id).name}`, 'Les automatisations de ce serveur ne se déclenchent plus.', '/machines', `machine:${id}:scheduler-down:${Math.floor(Date.now() / 3600_000)}`)
      this.bus.invalidate('machines')
    } catch {
      /* the heartbeat handles connectivity */
    }
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

  // Sync: runtime → Orbit

  private cursor(id: string): number {
    return this.db.select({ c: runtimeMachines.cursor }).from(runtimeMachines).where(eq(runtimeMachines.id, id)).get()?.c ?? 0
  }

  /**
   * Replays everything missed since the stored cursor, in order. If the runtime already
   * pruned part of it, a consistent snapshot replaces the copy first.
   */
  private async catchUp(id: string, client: RuntimeClient, firstSeq: number) {
    this.catchingUp.add(id)
    const notices: Parameters<RemoteMachineManager['notifyAll']>[1] = []
    try {
      let cursor = this.cursor(id)
      if (cursor > 0 && cursor < firstSeq - 1) {
        const snap = await client.request<{ tables: Record<string, Record<string, unknown>[]>; lastSeq: number }>('snapshot', {}, 120_000)
        const res = this.mirror.applySnapshot(id, snap.tables, nowIso())
        this.finishApply(id, res, snap.lastSeq, true)
        this.journal.activity({ type: 'runtime.connected', level: 'warning', title: `${this.get(id).name} : resynchronisation complète`, detail: 'Une partie de l’historique du serveur avait expiré ; l’état actuel a été rechargé.' })
        cursor = snap.lastSeq
      }
      for (let guard = 0; guard < 500; guard++) {
        const res = await client.request<{ events: RuntimeEvent[]; lastSeq: number }>('events.since', { cursor: this.cursor(id), limit: 1000 }, 60_000)
        notices.push(...this.applyEvents(id, res.events, true))
        if (!res.events.length || res.events.at(-1)!.seq >= res.lastSeq) break
      }
    } finally {
      this.catchingUp.delete(id)
    }
    this.notifyAll(id, notices, true)
    this.db.update(runtimeMachines).set({ lastSyncedAt: nowIso() }).where(eq(runtimeMachines.id, id)).run()
  }

  private applyEvents(id: string, events: RuntimeEvent[], catchingUp: boolean) {
    if (this.disposed || !events.length) return []
    const cursor = this.cursor(id)
    // Already applied (replay after reconnection): skipped by sequence number.
    const fresh = events.filter((e) => e.seq > cursor)
    if (!fresh.length) return []
    const res = this.mirror.apply(id, fresh)
    for (const e of fresh) if (e.kind === 'runtime' && e.data) this.db.insert(runtimeEvents).values({ machineId: id, seq: e.seq, kind: String(e.data.type ?? 'runtime'), missionId: (e.data.missionId as string) ?? null, data: e.data, at: e.at }).onConflictDoNothing().run()
    this.finishApply(id, res, fresh.at(-1)!.seq, catchingUp)
    if (!catchingUp) {
      for (const ev of res.executionEvents) this.bus.emit({ type: 'mission.event', event: ev })
      this.notifyAll(id, res.notices, false)
      return []
    }
    return res.notices
  }

  private finishApply(id: string, res: ReturnType<RemoteMirror['apply']>, seq: number, _catchingUp: boolean) {
    this.db.update(runtimeMachines).set({ cursor: seq, lastSyncedAt: nowIso(), syncError: res.errors.length ? `${res.errors.length} élément(s) non appliqué(s) : ${res.errors[0]}` : null }).where(eq(runtimeMachines.id, id)).run()
    if (res.scopes.size) this.bus.invalidate(...res.scopes, 'machines')
  }

  /** In-app notification for each fact; after an absence, one native summary instead of a burst. */
  private notifyAll(id: string, notices: { kind: Parameters<Journal['notify']>[0]; title: string; body: string; route: string | null; dedupeKey: string }[], summary: boolean) {
    const added = notices.filter((n) => this.journal.notify(n.kind, n.title, n.body, n.route, n.dedupeKey, { native: !summary || notices.length <= 3 }))
    if (summary && added.length > 3) {
      const name = this.get(id).name
      this.journal.notify('machine', `Pendant votre absence sur ${name}`, `${added.length} évènements : ${added.filter((n) => n.kind === 'mission_done').length} terminé(s), ${added.filter((n) => n.kind === 'mission_failed').length} échec(s), ${added.filter((n) => n.kind === 'approval').length} accord(s) demandé(s).`, '/machines', `machine:${id}:summary:${this.cursor(id)}`)
    }
  }

  private onLive(e: LiveEvent) {
    // Streaming text and pulses only while they are happening: never replayed as fake activity.
    if (Date.now() - Date.parse(e.at) > 10_000) return
    this.bus.emit(e.payload as never)
  }

  // Commands: Orbit → runtime

  /**
   * Sends a command with a persisted request id. Lost answer → stays pending and is resent
   * on reconnection (same id: the runtime returns its stored result). Refusal → failed.
   */
  async command<T>(id: string, method: string, params: Record<string, unknown>, entity?: { kind: string; id: string }, requestId = `rq_${newId()}${newId()}`): Promise<T> {
    const existing = this.db.select().from(remoteCommands).where(eq(remoteCommands.requestId, requestId)).get()
    if (existing?.status === 'done') return existing.result as T
    if (!existing) this.db.insert(remoteCommands).values({ requestId, machineId: id, method, params, entityKind: entity?.kind ?? null, entityId: entity?.id ?? null, createdAt: nowIso(), updatedAt: nowIso() }).run()
    if (!this.isOnline(id) && !this.wanted.has(id)) throw new OrbitError('provider', `${this.get(id).name} est hors ligne : connectez-la d’abord.`)
    try {
      const client = await this.ensureClient(id)
      this.db.update(remoteCommands).set({ attempts: (existing?.attempts ?? 0) + 1, updatedAt: nowIso() }).where(eq(remoteCommands.requestId, requestId)).run()
      const result = await client.request<T>(method, { ...params, requestId }, 60_000)
      this.db.update(remoteCommands).set({ status: 'done', result: result as never, error: null, updatedAt: nowIso() }).where(eq(remoteCommands.requestId, requestId)).run()
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (definitive(err)) {
        this.db.update(remoteCommands).set({ status: 'failed', error: msg, updatedAt: nowIso() }).where(eq(remoteCommands.requestId, requestId)).run()
        throw new OrbitError('conflict', msg)
      }
      this.db.update(remoteCommands).set({ error: msg, updatedAt: nowIso() }).where(eq(remoteCommands.requestId, requestId)).run()
      throw new OrbitError('provider', `Résultat inconnu (${msg}) : la commande sera renvoyée à la reconnexion, sans risque de double exécution.`)
    }
  }

  private async resendPending(id: string) {
    const rows = this.db.select().from(remoteCommands).where(and(eq(remoteCommands.machineId, id), eq(remoteCommands.status, 'pending'))).orderBy(asc(remoteCommands.createdAt)).all()
    for (const r of rows) {
      await this.command(id, r.method, r.params, r.entityKind ? { kind: r.entityKind, id: r.entityId! } : undefined, r.requestId)
        .then((res) => this.afterCommand(r.method, r.entityId, res, null))
        .catch((err: unknown) => this.afterCommand(r.method, r.entityId, null, err))
    }
  }

  /** What a definitive refusal means for the copy (e.g. a mission the runtime never accepted). */
  private afterCommand(method: string, entityId: string | null, _res: unknown, err: unknown) {
    if (!err || !entityId || !(err instanceof OrbitError) || err.code !== 'conflict') return
    if (method === 'mission.create') {
      this.db.update(missions).set({ status: 'failed', error: `Refusée par le serveur : ${err.message}`, finishedAt: nowIso(), updatedAt: nowIso() }).where(and(eq(missions.id, entityId), eq(missions.status, 'todo'))).run()
      this.bus.invalidate('missions')
    }
    if (method === 'constellation.launch') {
      this.db.update(constellationRuns).set({ status: 'failed', error: `Refusée par le serveur : ${err.message}`, finishedAt: nowIso() }).where(and(eq(constellationRuns.id, entityId), eq(constellationRuns.status, 'planning'))).run()
      this.bus.invalidate('constellations')
    }
  }

  private fire(id: string, method: string, params: Record<string, unknown>, entity?: { kind: string; id: string }, requestId?: string) {
    void this.command(id, method, params, entity, requestId)
      .then((res) => this.afterCommand(method, entity?.id ?? null, res, null))
      .catch((err: unknown) => {
        this.afterCommand(method, entity?.id ?? null, null, err)
        this.journal.activity({ type: 'runtime.error', level: 'error', title: `Commande ${method} : ${this.get(id).name}`, detail: err instanceof Error ? err.message : String(err) })
      })
  }

  private requireOnline(id: string) {
    if (!this.isOnline(id)) throw new OrbitError('provider', `${this.get(id).name} est hors ligne : dernier état connu affiché. Reconnectez-la pour agir.`)
  }

  // missions
  submitMission(m: Mission, origin: 'user' | 'automation', followUp?: string): void {
    const id = m.remoteMachineId!
    this.requireOnline(id)
    if (followUp) {
      const n = this.db.select({ id: remoteCommands.requestId }).from(remoteCommands).where(and(eq(remoteCommands.entityId, m.id), eq(remoteCommands.method, 'mission.followUp'))).all().length
      this.fire(id, 'mission.followUp', { id: m.id, prompt: followUp }, { kind: 'mission', id: m.id }, `fu_${m.id}_${n + 1}`)
      return
    }
    this.pushAgent(id, m.agentId)
    this.fire(id, 'mission.create', { mission: { id: m.id, shortId: m.shortId, title: m.title, description: m.description, agentId: m.agentId, priority: m.priority }, origin }, { kind: 'mission', id: m.id }, `mc_${m.id}`)
  }

  cancelMission(m: Mission): void {
    this.requireOnline(m.remoteMachineId!)
    this.fire(m.remoteMachineId!, 'mission.cancel', { id: m.id }, { kind: 'mission', id: m.id }, `mx_${m.id}`)
  }

  resolveApproval(row: ApprovalRequest, approve: boolean, scope: GrantScope): void {
    const id = row.machineId!
    this.requireOnline(id)
    if (row.expiresAt && Date.parse(row.expiresAt) < Date.now()) throw new OrbitError('conflict', 'Cette demande a expiré.')
    // Bound to the exact operation displayed: the runtime refuses if it changed.
    const raw = this.handle.sqlite.prepare('SELECT id, kind, mission_id, tool_call_id, summary, payload FROM approval_requests WHERE id = ?').get(row.id) as { id: string; kind: string; mission_id: string | null; tool_call_id: string | null; summary: string; payload: string | null }
    this.fire(id, 'approval.resolve', { id: row.id, approve, scope, operationHash: operationHash(raw) }, { kind: 'approval', id: row.id }, `ap_${row.id}`)
  }

  // constellations
  launchRun(def: ConstellationDefinition, run: ConstellationRun, goal: string, origin: 'user' | 'automation'): void {
    const id = run.machineId!
    this.requireOnline(id)
    for (const m of def.members) this.pushAgent(id, m.agentId)
    this.pushConstellation(id, def)
    this.fire(id, 'constellation.launch', { runId: run.id, constellationId: def.id, goal, origin }, { kind: 'run', id: run.id }, `cl_${run.id}`)
  }

  cancelRun(run: ConstellationRun): void {
    this.requireOnline(run.machineId!)
    this.fire(run.machineId!, 'constellation.cancel', { runId: run.id }, { kind: 'run', id: run.id }, `cx_${run.id}`)
  }

  // Configuration push (minimal, versioned)

  private agentSnapshot(a: Agent): AgentSync {
    if (a.workingDirectory && !isSafeProjectName(a.workingDirectory)) throw new OrbitError('validation', `Projet distant de ${a.name} invalide (nom simple, sans chemin).`)
    // Never sent: API keys, conversations, memory, files, Mac paths.
    return { id: a.id, version: a.updatedAt, name: a.name, role: a.role, description: a.description, appearance: a.appearance as unknown as Record<string, unknown>, providerId: a.providerId as AgentSync['providerId'], model: a.model, instructions: a.instructions, autonomy: a.autonomy, permissions: a.permissions, project: a.workingDirectory, isolation: a.isolation === 'strict' ? 'strict' : 'standard', effort: a.effort, dailyBudgetUsd: a.dailyBudgetUsd, enabled: a.enabled }
  }

  private pushAgent(id: string, agentId: string) {
    const a = this.parts!.agents.get(agentId)
    if (a.runtime !== 'remote' || a.machineId !== id) throw new OrbitError('validation', `${a.name} n’est pas placé sur cette machine.`)
    const snap = this.agentSnapshot(a)
    this.fire(id, 'agent.put', { agent: snap }, { kind: 'agent', id: a.id }, `ag_${a.id}_${createHash('sha1').update(snap.version).digest('hex').slice(0, 10)}`)
  }

  private constellationSnapshot(def: ConstellationDefinition): ConstellationSync {
    return { id: def.id, version: def.updatedAt, name: def.name, description: def.description, objective: def.objective, coordinatorAgentId: def.coordinatorAgentId, members: def.members.map((m) => ({ agentId: m.agentId, role: m.role, responsibilities: m.responsibilities, canDelegate: m.canDelegate })), project: def.workspace, workspaceMode: def.workspaceMode, permissions: def.permissions, limits: def.limits }
  }

  private pushConstellation(id: string, def: ConstellationDefinition) {
    const snap = this.constellationSnapshot(def)
    this.fire(id, 'constellation.put', { constellation: snap }, { kind: 'constellation', id: def.id }, `cn_${def.id}_${createHash('sha1').update(snap.version).digest('hex').slice(0, 10)}`)
  }

  private scheduleConfigSync() {
    if (this.syncTimer || this.disposed) return
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null
      for (const id of this.live.keys()) void this.syncConfig(id).catch(() => undefined)
    }, 800)
    this.syncTimer.unref?.()
  }

  /** Pushes the companions and constellations placed on this machine (idempotent per version). */
  async syncConfig(id: string): Promise<void> {
    if (!this.parts || !this.isOnline(id)) return
    const placed = this.parts.agents.list().filter((a) => a.runtime === 'remote' && a.machineId === id)
    for (const a of placed) {
      const snap = this.agentSnapshot(a)
      await this.command(id, 'agent.put', { agent: snap }, { kind: 'agent', id: a.id }, `ag_${a.id}_${createHash('sha1').update(snap.version).digest('hex').slice(0, 10)}`)
    }
    for (const def of this.parts.constellations.list()) {
      let where: string | null
      try {
        where = this.parts.constellations.placement(def)
      } catch {
        continue
      }
      if (where !== id || (def.workspace && !isSafeProjectName(def.workspace))) continue
      const snap = this.constellationSnapshot(def)
      await this.command(id, 'constellation.put', { constellation: snap }, { kind: 'constellation', id: def.id }, `cn_${def.id}_${createHash('sha1').update(snap.version).digest('hex').slice(0, 10)}`)
    }
  }

  async setLimits(id: string, limits: MachineLimits): Promise<RemoteMachine> {
    this.requireOnline(id)
    const res = await this.command<MachineLimits>(id, 'limits.put', { limits })
    this.db.update(runtimeMachines).set({ limits: res as never }).where(eq(runtimeMachines.id, id)).run()
    this.bus.invalidate('machines')
    return this.get(id)
  }

  async engines(id: string, refresh = false): Promise<EngineStatus[]> {
    const client = await this.ensureClient(id)
    const list = await client.request<EngineStatus[]>('engines', { refresh }, 60_000)
    this.db.update(runtimeMachines).set({ engines: list.map((e) => ({ ...e, available: e.ready })) as never }).where(eq(runtimeMachines.id, id)).run()
    this.bus.invalidate('machines')
    return list
  }

  async clients(id: string): Promise<{ id: string; name: string; fingerprint: string; created_at: string; last_seen_at: string | null; revoked_at: string | null; self: boolean }[]> {
    const client = await this.ensureClient(id)
    const { clientId } = this.identity()
    const list = await client.request<{ id: string; name: string; fingerprint: string; created_at: string; last_seen_at: string | null; revoked_at: string | null }[]>('client.list')
    return list.map((c) => ({ ...c, self: c.id === clientId }))
  }

  recentRuntimeEvents(id: string, limit = 50) {
    return this.db.select().from(runtimeEvents).where(eq(runtimeEvents.machineId, id)).orderBy(desc(runtimeEvents.seq)).limit(limit).all()
  }

  // Automations: one owner, coordinated transfers

  private automationSnapshot(a: Automation): AutomationSync {
    return { id: a.id, version: a.configVersion, name: a.name, description: a.description, targetKind: a.targetKind, targetId: a.targetId, title: a.title, prompt: a.prompt, recurrence: a.recurrence, timezone: a.timezone, missedPolicy: a.missedPolicy, maxRunsPerDay: a.maxRunsPerDay, triggers: a.triggers.map((t) => ({ kind: t.kind, sourceAgentId: t.sourceAgentId, sourceAutomationId: t.sourceAutomationId, cooldownSec: t.cooldownSec })), status: a.status === 'active' ? 'active' : 'paused', maxDurationMin: a.maxDurationMin, budgetUsd: a.budgetUsd, failurePolicy: a.failurePolicy }
  }

  private placementOf(a: Automation): string | null {
    if (a.targetKind === 'agent') {
      const ag = this.parts!.agents.get(a.targetId)
      return ag.runtime === 'remote' ? ag.machineId : null
    }
    return this.parts!.constellations.placement(this.parts!.constellations.get(a.targetId))
  }

  // automations (owned by a runtime)
  pushAutomation(a: Automation): void {
    this.requireOnline(a.schedulerOwner)
    this.fire(a.schedulerOwner, 'automation.put', { automation: this.automationSnapshot(a) }, { kind: 'automation', id: a.id }, `au_${a.id}_v${a.configVersion}`)
  }

  setAutomationStatus(a: Automation, status: 'active' | 'paused'): void {
    this.requireOnline(a.schedulerOwner)
    this.fire(a.schedulerOwner, 'automation.setStatus', { id: a.id, status }, { kind: 'automation', id: a.id })
  }

  runAutomationNow(a: Automation): void {
    this.requireOnline(a.schedulerOwner)
    this.fire(a.schedulerOwner, 'automation.runNow', { id: a.id }, { kind: 'automation', id: a.id })
  }

  confirmAutomationRun(a: Automation, runId: string, approve: boolean): void {
    this.requireOnline(a.schedulerOwner)
    this.fire(a.schedulerOwner, 'automation.confirmRun', { runId, approve }, { kind: 'autorun', id: runId }, `ac_${runId}`)
  }

  releaseAutomation(a: Automation): void {
    this.requireOnline(a.schedulerOwner)
    this.fire(a.schedulerOwner, 'automation.release', { id: a.id }, { kind: 'automation', id: a.id }, `ar_${a.id}_v${a.configVersion}`)
  }

  /**
   * Moves an automation to another scheduler (this Mac or a machine).
   *  1. checks: target reachable, companion(s) placed there, engine present;
   *  2. the current owner stops first (local: state « transferring »; runtime: release, confirmed);
   *  3. the new owner registers it and Orbit reads it back;
   *  4. only then the owner changes. Any doubt → « transferring »: nobody fires it until
   *     `reconcileTransfers` has read the real state of both sides.
   */
  async transferAutomation(automationId: string, to: string): Promise<Automation> {
    const s = this.parts!.scheduler
    let a = s.get(automationId)
    if (a.schedulerOwner === to && a.ownerState === 'active') return a
    if (a.ownerState === 'transferring' && a.pendingOwner !== to) throw new OrbitError('conflict', 'Un autre transfert est en cours : attendez sa confirmation ou annulez-le.')
    if (to !== 'local') {
      const m = this.get(to)
      this.requireOnline(to)
      if (this.placementOf(a) !== to) throw new OrbitError('validation', `La cible de « ${a.name} » n’est pas placée sur ${m.name} : déplacez d’abord le compagnon (ou toute la constellation) sur cette machine.`)
      const engine = a.targetKind === 'agent' ? this.parts!.agents.get(a.targetId).providerId : null
      const engines = m.engines.length ? m.engines : (await this.engines(to)).map((e) => ({ ...e, available: e.ready }))
      if (engine && !engines.find((e) => e.id === engine && e.available)) throw new OrbitError('validation', `Le moteur de ce compagnon n’est pas prêt sur ${m.name}.`)
    }
    const from = a.schedulerOwner
    if (from !== 'local') this.requireOnline(from)
    // Step 2: the current owner stops.
    this.db.update(automationDefinitions).set({ ownerState: 'transferring', pendingOwner: to, updatedAt: nowIso() }).where(eq(automationDefinitions.id, a.id)).run()
    this.bus.invalidate('automations')
    this.journal.audit({ actor: 'user', agentId: null, action: 'automation.transfer', target: a.name, allowed: true, reason: `${from} → ${to}` })
    if (from !== 'local') await this.command(from, 'automation.release', { id: a.id }, { kind: 'automation', id: a.id }, `ar_${a.id}_v${a.configVersion}`)
    // Step 3 & 4.
    await this.completeTransfer(a.id)
    a = s.get(a.id)
    this.journal.activity({ type: 'automation.transferred', level: 'success', title: `« ${a.name} » planifiée ${a.schedulerOwner === 'local' ? 'sur ce Mac' : `sur ${this.get(a.schedulerOwner).name}`}`, detail: null })
    return a
  }

  /** Activates on the pending owner once the previous one is known to be stopped. */
  private async completeTransfer(automationId: string) {
    const a = this.parts!.scheduler.get(automationId)
    const to = a.pendingOwner
    if (a.ownerState !== 'transferring' || !to) return
    if (to === 'local') {
      // Missed occurrences during the move are not replayed: the schedule restarts from now.
      this.db.update(automationDefinitions).set({ schedulerOwner: 'local', ownerState: 'active', pendingOwner: null, updatedAt: nowIso() }).where(eq(automationDefinitions.id, a.id)).run()
      this.parts!.scheduler.setStatus(a.id, a.status === 'paused' ? 'paused' : 'active')
      return
    }
    const snap = this.automationSnapshot(a)
    const placed = this.placementOf(a)
    if (placed !== to) throw new OrbitError('validation', 'La cible n’est plus placée sur cette machine : transfert suspendu.')
    if (a.targetKind === 'agent') await this.command(to, 'agent.put', { agent: this.agentSnapshot(this.parts!.agents.get(a.targetId)) }, { kind: 'agent', id: a.targetId })
    else {
      const def = this.parts!.constellations.get(a.targetId)
      for (const m of def.members) await this.command(to, 'agent.put', { agent: this.agentSnapshot(this.parts!.agents.get(m.agentId)) }, { kind: 'agent', id: m.agentId })
      await this.command(to, 'constellation.put', { constellation: this.constellationSnapshot(def) }, { kind: 'constellation', id: def.id })
    }
    await this.command(to, 'automation.put', { automation: snap }, { kind: 'automation', id: a.id }, `au_${a.id}_v${a.configVersion}_to_${to}`)
    const check = await this.command<{ automation: Automation; owned: boolean }>(to, 'automation.get', { id: a.id })
    if (!check.owned || check.automation.configVersion !== a.configVersion) throw new OrbitError('conflict', 'Le serveur n’a pas confirmé l’enregistrement : transfert suspendu.')
    this.db.update(automationDefinitions).set({ schedulerOwner: to, ownerState: 'active', pendingOwner: null, nextRunAt: check.automation.nextRunAt, updatedAt: nowIso() }).where(eq(automationDefinitions.id, a.id)).run()
    this.bus.invalidate('automations')
  }

  /** After a reconnection: finishes or rolls back transfers interrupted half-way. */
  async reconcileTransfers(machineId: string): Promise<void> {
    if (!this.parts) return
    const rows = this.db.select().from(automationDefinitions).where(eq(automationDefinitions.ownerState, 'transferring')).all()
    for (const r of rows) {
      if (r.schedulerOwner !== machineId && r.pendingOwner !== machineId) continue
      try {
        if (r.schedulerOwner !== 'local' && r.schedulerOwner !== r.pendingOwner) {
          if (!this.isOnline(r.schedulerOwner)) continue
          await this.command(r.schedulerOwner, 'automation.release', { id: r.id }, { kind: 'automation', id: r.id }, `ar_${r.id}_v${r.configVersion}`)
        }
        if (r.pendingOwner !== 'local' && !this.isOnline(r.pendingOwner!)) continue
        await this.completeTransfer(r.id)
      } catch (err) {
        this.journal.activity({ type: 'runtime.error', level: 'warning', title: `Transfert de « ${r.name} » en attente`, detail: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  /** User gives up a transfer: back to the previous owner, only once the target is known not to fire it. */
  async cancelTransfer(automationId: string): Promise<Automation> {
    const a = this.parts!.scheduler.get(automationId)
    if (a.ownerState !== 'transferring') return a
    const to = a.pendingOwner
    if (to && to !== 'local') {
      this.requireOnline(to)
      await this.command(to, 'automation.release', { id: a.id }, { kind: 'automation', id: a.id }, `ar_${a.id}_v${a.configVersion}_cancel`)
    }
    if (a.schedulerOwner !== 'local') {
      // The previous owner (a runtime) was released when the transfer began: it comes back to this Mac.
      this.db.update(automationDefinitions).set({ schedulerOwner: 'local', ownerState: 'active', pendingOwner: null, status: 'paused', updatedAt: nowIso() }).where(eq(automationDefinitions.id, a.id)).run()
    } else {
      this.db.update(automationDefinitions).set({ ownerState: 'active', pendingOwner: null, updatedAt: nowIso() }).where(eq(automationDefinitions.id, a.id)).run()
    }
    this.bus.invalidate('automations')
    return this.parts!.scheduler.get(a.id)
  }

  // Artifacts

  artifacts(missionId: string): (ArtifactMeta & { machineId: string; localPath: string | null })[] {
    return this.db
      .select()
      .from(remoteArtifacts)
      .where(eq(remoteArtifacts.missionId, missionId))
      .orderBy(asc(remoteArtifacts.createdAt))
      .all()
      .map((r) => ({ id: r.id, missionId: r.missionId, agentId: r.agentId, name: r.name, kind: r.kind as ArtifactMeta['kind'], size: r.size, sha256: r.sha256, status: r.status as ArtifactMeta['status'], createdAt: r.createdAt, machineId: r.machineId, localPath: r.localPath }))
  }

  /** Downloads by id (never by path), checks the SHA-256, keeps a private local copy. */
  async fetchArtifact(artifactId: string): Promise<{ path: string; preview: string | null }> {
    const row = this.db.select().from(remoteArtifacts).where(eq(remoteArtifacts.id, artifactId)).get()
    if (!row) throw new OrbitError('not_found', 'Artefact inconnu.')
    const safe = row.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80)
    const dir = join(this.dataDir, 'artifacts', row.machineId)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, `${row.id}-${safe}`)
    const preview = (b: Buffer) => (row.size <= 512 * 1024 && !b.subarray(0, 8000).includes(0) ? b.toString('utf8') : null)
    if (row.localPath && existsSync(row.localPath)) {
      const b = readFileSync(row.localPath)
      if (createHash('sha256').update(b).digest('hex') === row.sha256) return { path: row.localPath, preview: preview(b) }
    }
    const client = await this.ensureClient(row.machineId)
    const parts: Buffer[] = []
    let offset = 0
    for (let i = 0; i < 1000; i++) {
      const r = await client.request<{ data: string; size: number; done: boolean; sha256: string }>('artifact.get', { id: artifactId, offset }, 60_000)
      const chunk = Buffer.from(r.data, 'base64')
      parts.push(chunk)
      offset += chunk.length
      if (r.done) break
    }
    const buf = Buffer.concat(parts)
    if (createHash('sha256').update(buf).digest('hex') !== row.sha256) throw new OrbitError('conflict', 'Empreinte de l’artefact différente : fichier rejeté.')
    writeFileSync(path, buf, { mode: 0o600 })
    this.db.update(remoteArtifacts).set({ localPath: path }).where(eq(remoteArtifacts.id, artifactId)).run()
    return { path, preview: preview(buf) }
  }

  /** For UIs: is this runtime-owned item shown from a stale copy? */
  staleness(machineId: string): { online: boolean; lastSyncedAt: string | null } {
    const m = this.db.select({ s: runtimeMachines.lastSyncedAt }).from(runtimeMachines).where(eq(runtimeMachines.id, machineId)).get()
    return { online: this.isOnline(machineId), lastSyncedAt: m?.s ?? null }
  }

  /** Machines other than revoked ones (used by placement pickers). */
  activeIds(): string[] {
    return this.db.select({ id: runtimeMachines.id }).from(runtimeMachines).where(ne(runtimeMachines.status, 'revoked')).all().map((r) => r.id)
  }
}
