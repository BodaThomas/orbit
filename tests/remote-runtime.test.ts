import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RemoteMachineManager } from '../src/main/core/remote/manager'
import { localSocketTransport, RuntimeClient } from '../src/main/core/remote/client'
import { echoEngine, RuntimeDaemon } from '../src/runtime/daemon'
import { PROTOCOL_VERSION } from '../src/runtime/protocol'
import type { AgentEngine } from '../src/main/core/engine/types'
import { makeCore, novaInput, waitFor } from './helpers'

const daemons: RuntimeDaemon[] = []
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => undefined)
})

async function startDaemon(home = realpathSync(mkdtempSync(join(tmpdir(), 'orb-rt-'))), now?: () => number) {
  const d = new RuntimeDaemon({ home, engines: { codex: echoEngine() }, now })
  await d.start()
  daemons.push(d)
  return { d, home }
}

function orbitWithRemote(home: string) {
  const unused: AgentEngine = { ...echoEngine(), id: 'codex' }
  const core = makeCore(undefined, { codex: unused })
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'orb-data-')))
  const remote = new RemoteMachineManager(core.db, core.bus, core.journal, dataDir, () => null)
  core.missions.remoteEngine = (a) => remote.engineFor(a)
  remote.onRemoteOutcome = (id, o) => core.missions.applyRemoteOutcome(id, o)
  const machine = remote.register({ name: 'VPS de test', transport: 'local', host: null, user: null, port: 22, runtimeHome: home })
  const agent = core.agents.create(novaInput({ name: 'Atlas', providerId: 'codex', model: 'default', runtime: 'remote', machineId: machine.id, workingDirectory: 'meteo', autonomy: 'supervised', permissions: { readFiles: true, writeFiles: true, runCommands: false, network: false, manageProjects: false, externalActions: false } }))
  return { core, remote, machine, agent, dataDir }
}

const rawRequest = (home: string, lines: object[]) =>
  new Promise<string>((resolve) => {
    const s = connect(readFileSync(join(home, 'socket'), 'utf8').trim())
    let out = ''
    s.on('connect', () => lines.forEach((l) => s.write(JSON.stringify(l) + '\n')))
    s.on('data', (d) => (out += d))
    s.on('close', () => resolve(out))
    setTimeout(() => s.end(), 300)
  })

describe('runtime distant — démon', () => {
  it('dossier très long : socket court, retrouvé par Orbit', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'orb-rt-')))
    const long = join(base, 'un-dossier-volontairement-tres-long-pour-depasser-la-limite-des-sockets-unix', 'runtime')
    const { home } = await startDaemon(long)
    const sock = readFileSync(join(home, 'socket'), 'utf8').trim()
    expect(Buffer.byteLength(sock)).toBeLessThanOrEqual(100)
    const c = new RuntimeClient(localSocketTransport(home))
    expect((await c.request<{ protocol: number }>('hello', { protocol: PROTOCOL_VERSION })).protocol).toBe(PROTOCOL_VERSION)
    c.close()
  })

  it('authentification : jeton faux refusé, socket et fichiers privés', async () => {
    const { home } = await startDaemon()
    const res = await rawRequest(home, [{ jsonrpc: '2.0', id: 1, method: 'auth', params: { token: 'mauvais' } }, { jsonrpc: '2.0', id: 2, method: 'mission.list' }])
    expect(res).toContain('Non authentifié')
    expect(res).not.toContain('"id":2')
    expect(statSync(readFileSync(join(home, 'socket'), 'utf8').trim()).mode & 0o077).toBe(0)
    expect(statSync(join(home, 'token')).mode & 0o077).toBe(0)
    expect(statSync(home).mode & 0o077).toBe(0)
  })
  it('version de protocole incompatible refusée ; heartbeat', async () => {
    const { home } = await startDaemon()
    const c = new RuntimeClient(localSocketTransport(home))
    await expect(c.request('hello', { protocol: 99 })).rejects.toThrow('Protocole incompatible')
    const hb = await c.request<{ running: number }>('heartbeat')
    expect(hb.running).toBe(0)
    c.close()
  })
  it('projets isolés : pas de chemin ni de remontée', async () => {
    const { d } = await startDaemon()
    expect(() => d.submit({ id: 'x', engine: 'codex', model: null, project: '../etc', prompt: 'p', instructions: '', sessionId: null, policy: { readFiles: true, writeFiles: false, runCommands: false, network: false, autonomy: 'supervised' } }, null)).toThrow('invalide')
  })
  it('planification côté runtime : s’exécute sans aucun client connecté', async () => {
    let now = Date.parse('2026-11-14T08:00:00Z')
    const { d, home } = await startDaemon(undefined, () => now)
    await d.dispatch('schedule.put', { id: 's1', name: 'Veille', recurrence: { kind: 'interval', minutes: 60, anchor: '2026-11-14T08:30:00.000Z' }, timezone: 'UTC', enabled: true, template: { engine: 'codex', model: null, project: 'veille', prompt: 'résume', instructions: '', sessionId: null, policy: { readFiles: true, writeFiles: false, runCommands: false, network: false, autonomy: 'automated' } } })
    now = Date.parse('2026-11-14T08:31:00Z')
    d.tickSchedules()
    d.tickSchedules() // same occurrence: never twice
    await waitFor(() => d.eventsSince(0).some((e) => e.kind === 'mission.status' && e.data.status === 'done'), 3000)
    expect(d.eventsSince(0).filter((e) => e.kind === 'schedule.fired')).toHaveLength(1)
    expect(readFileSync(join(home, 'state', 'schedules.json'), 'utf8')).toContain('2026-11-14T09:30:00.000Z')
  })
  it('redémarrage du runtime : une mission en cours devient « interrompue », jamais relancée', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'orb-rt-')))
    const first = await startDaemon(home)
    first.d.submit({ id: 'm1', engine: 'codex', model: null, project: 'p', prompt: '[slow:5000]', instructions: '', sessionId: null, policy: { readFiles: true, writeFiles: false, runCommands: false, network: false, autonomy: 'automated' } }, null)
    await waitFor(() => readFileSync(join(home, 'state', 'missions.json'), 'utf8').includes('"running"'), 2000)
    // Crash: the process disappears without updating its state.
    const snapshot = readFileSync(join(home, 'state', 'missions.json'), 'utf8')
    await first.d.stop()
    daemons.splice(daemons.indexOf(first.d), 1)
    writeFileSync(join(home, 'state', 'missions.json'), snapshot)
    const second = await startDaemon(home)
    const m = (await second.d.dispatch('mission.get', { id: 'm1' })) as { status: string }
    expect(m.status).toBe('interrupted')
  })
})

describe('runtime distant — depuis Orbit', () => {
  it('connexion, disponibilité, mission, événements, résultat', async () => {
    const { home } = await startDaemon()
    const o = orbitWithRemote(home)
    const online = await o.remote.connect(o.machine.id)
    expect(online).toMatchObject({ status: 'online', protocol: PROTOCOL_VERSION })
    expect(online.engines.find((e) => e.id === 'codex')?.available).toBe(true)
    const m = o.core.missions.create({ title: 'Bonjour', description: 'dis bonjour', agentId: o.agent.id, priority: 'normal', startNow: true })
    expect(m.workspace).toBe('meteo')
    await waitFor(() => o.core.missions.get(m.id).status === 'done', 4000)
    expect(o.core.missions.get(m.id).result).toContain('echo:')
    const detail = o.core.missions.detail(m.id)
    expect(detail.events.some((e) => e.type === 'session')).toBe(true)
    expect(detail.inventories[0]!.note).toContain('Machine distante')
    o.remote.disposeAll()
  })

  it('approbation distante relayée dans Orbit, écriture dans le projet isolé', async () => {
    const { home } = await startDaemon()
    const o = orbitWithRemote(home)
    await o.remote.connect(o.machine.id)
    const m = o.core.missions.create({ title: 'Écrire', description: '[approve] écris', agentId: o.agent.id, priority: 'normal', startNow: true })
    await waitFor(() => o.core.missions.approvals('pending').length === 1, 4000)
    o.core.missions.resolveApproval(o.core.missions.approvals('pending')[0]!.id, true)
    await waitFor(() => o.core.missions.get(m.id).status === 'done', 4000)
    expect(readFileSync(join(home, 'projects', 'meteo', 'resultat.txt'), 'utf8')).toContain('echo')
    o.remote.disposeAll()
  })

  it('annulation propagée au runtime', async () => {
    const { d, home } = await startDaemon()
    const o = orbitWithRemote(home)
    await o.remote.connect(o.machine.id)
    const m = o.core.missions.create({ title: 'Long', description: '[slow:8000]', agentId: o.agent.id, priority: 'normal', startNow: true })
    await waitFor(() => d.eventsSince(0).some((e) => e.data.status === 'running'), 3000)
    o.core.missions.cancel(m.id)
    await waitFor(() => o.core.missions.get(m.id).status === 'cancelled', 4000)
    await waitFor(() => d.eventsSince(0).some((e) => e.data.status === 'cancelled'), 3000)
    o.remote.disposeAll()
  })

  it('déconnexion puis reconnexion : la mission continue, aucun événement en double', async () => {
    const { d, home } = await startDaemon()
    const o = orbitWithRemote(home)
    await o.remote.connect(o.machine.id)
    const m = o.core.missions.create({ title: 'Coupure', description: '[slow:1500] travail', agentId: o.agent.id, priority: 'normal', startNow: true })
    await waitFor(() => d.eventsSince(0).some((e) => e.data.status === 'running'), 3000)
    // Network cut: every connection of the daemon drops.
    for (const c of (d as unknown as { conns: Set<{ socket: { destroy(): void } }> }).conns) c.socket.destroy()
    await waitFor(() => o.core.missions.get(m.id).status === 'done', 15_000)
    const seqs = o.core.handle.sqlite.prepare('SELECT seq FROM runtime_events').all() as { seq: number }[]
    expect(new Set(seqs.map((s) => s.seq)).size).toBe(seqs.length)
    expect(o.remote.get(o.machine.id).status).toBe('online')
    o.remote.disposeAll()
  }, 20_000)

  it('résultat récupéré après reconnexion quand Orbit avait perdu la mission', async () => {
    const { d, home } = await startDaemon()
    const o = orbitWithRemote(home)
    // Orbit had started this execution, then was quit: the runtime kept working alone.
    const m = o.core.missions.create({ title: 'Nuit', description: 'tâche', agentId: o.agent.id, priority: 'normal', startNow: false })
    o.core.handle.sqlite.prepare("INSERT INTO mission_executions (id, mission_id, idempotency_key, status, started_at) VALUES ('exec-nuit', ?, 'k-nuit', 'running', ?)").run(m.id, new Date().toISOString())
    o.core.handle.sqlite.prepare("UPDATE missions SET status = 'running' WHERE id = ?").run(m.id)
    d.submit({ id: 'exec-nuit', engine: 'codex', model: null, project: 'meteo', prompt: '[slow:200] tâche de nuit', instructions: '', sessionId: null, policy: { readFiles: true, writeFiles: false, runCommands: false, network: false, autonomy: 'automated' } }, null)
    o.core.missions.recoverInterrupted()
    expect(o.core.missions.get(m.id).error).toContain('resynchronisation')
    await waitFor(() => d.eventsSince(0).some((e) => e.missionId === 'exec-nuit' && e.data.status === 'done'), 3000)
    // Orbit comes back: the event log is replayed from its cursor, the outcome applied once.
    await o.remote.connect(o.machine.id)
    await waitFor(() => o.core.missions.get(m.id).status === 'done', 4000)
    expect(o.core.missions.get(m.id).result).toContain('tâche de nuit')
    expect(o.core.missions.detail(m.id).events.some((e) => e.message.includes('machine distante'))).toBe(true)
    o.remote.disposeAll()
  })

  it('fermeture d’Orbit avec une machine connectée : aucune écriture après fermeture de la base', async () => {
    const { home } = await startDaemon()
    const o = orbitWithRemote(home)
    await o.remote.connect(o.machine.id)
    const errors: unknown[] = []
    const onErr = (e: unknown) => errors.push(e)
    process.on('uncaughtException', onErr)
    // Same order as OrbitRuntime.dispose(): remote first, then the database.
    o.remote.disposeAll()
    o.core.handle.close()
    await new Promise((r) => setTimeout(r, 300))
    process.off('uncaughtException', onErr)
    expect(errors).toEqual([])
  })

  it('protection des secrets : aucune clé d’Orbit n’atteint le runtime', async () => {
    const { home } = await startDaemon()
    const o = orbitWithRemote(home)
    o.core.handle.sqlite.prepare("INSERT INTO provider_connections (provider_id, encrypted_secret) VALUES ('anthropic', ?)").run(`enc:${Buffer.from('sk-ant-SECRET-NE-DOIT-PAS-SORTIR').toString('base64')}`)
    await o.remote.connect(o.machine.id)
    const m = o.core.missions.create({ title: 'x', description: 'rien', agentId: o.agent.id, priority: 'normal', startNow: true })
    await waitFor(() => o.core.missions.get(m.id).status === 'done', 4000)
    for (const f of readdirSync(join(home, 'state'))) expect(readFileSync(join(home, 'state', f), 'utf8')).not.toContain('SECRET-NE-DOIT-PAS-SORTIR')
    expect(existsSync(join(home, 'state', 'events.jsonl'))).toBe(true)
    o.remote.disposeAll()
  })
})

describe.runIf(existsSync(join(__dirname, '../out/runtime/orbit-runtime.mjs')))('runtime distant — binaire construit (daemon + attach)', () => {
  it('le binaire démarre, attach relaie le protocole comme via SSH', async () => {
    const { spawn } = await import('node:child_process')
    const { spawnLineProcess } = await import('../src/main/core/engine/process')
    const bundle = join(__dirname, '../out/runtime/orbit-runtime.mjs')
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'orb-bin-')))
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORBIT_RUNTIME_ECHO: '1' }
    const daemon = spawn(process.execPath, [bundle, 'daemon', '--home', home], { env, stdio: 'ignore' })
    try {
      await waitFor(() => existsSync(join(home, 'socket')), 5000)
      // Exactly what `ssh host orbit-runtime attach` runs on the server.
      const proc = spawnLineProcess({ command: process.execPath, args: [bundle, 'attach', '--home', home], cwd: home, env, label: 'attach' })
      const client = new RuntimeClient({ write: (l) => proc.write(l), onLine: (cb) => proc.onLine(cb), onClose: (cb) => proc.onExit((r) => cb(r)), close: () => proc.close(200) })
      const hello = await client.request<{ protocol: number; engines: { id: string }[] }>('hello', { protocol: PROTOCOL_VERSION })
      expect(hello.protocol).toBe(PROTOCOL_VERSION)
      expect(hello.engines.map((e) => e.id)).toContain('echo')
      const res = await client.request<{ mission: { id: string } }>('mission.submit', { id: 'bin-1', engine: 'echo', model: null, project: 'p', prompt: 'via binaire', instructions: '', sessionId: null, policy: { readFiles: true, writeFiles: false, runCommands: false, network: false, autonomy: 'automated' } })
      expect(res.mission.id).toBe('bin-1')
      await waitFor(() => readFileSync(join(home, 'state', 'events.jsonl'), 'utf8').includes('echo: via binaire'), 5000)
      client.close()
    } finally {
      daemon.kill('SIGTERM')
    }
  }, 20_000)
})
