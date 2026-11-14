import { existsSync, readFileSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { localSocketTransport, RuntimeClient } from '../src/main/core/remote/client'
import { generateIdentity, nonce, signMessage, verifyMessage } from '../src/runtime/identity'
import { helloProofMessage, PROTOCOL_VERSION, sessionProofMessage, type HelloResult, type RuntimeEvent } from '../src/runtime/protocol'
import { cleanup, clock, count, makeDesk, pairDesk, remoteAgent, settled, startRuntime, stopRuntime, tmp } from './always-on-harness'
import { waitFor } from './helpers'

afterEach(cleanup)

/** A raw protocol client (no Orbit Desktop logic): to test the runtime's own defences. */
async function rawClient(home: string, opts: { pair?: boolean } = {}) {
  const c = new RuntimeClient(localSocketTransport(home))
  const n = nonce()
  const hello = await c.request<HelloResult>('hello', { protocol: PROTOCOL_VERSION, client: { id: null, name: 'test', version: '1' }, nonce: n })
  const g = generateIdentity()
  const clientId = `cl_${nonce().slice(0, 10)}`
  if (opts.pair !== false) await c.request('client.pair', { clientId, name: 'test', publicKey: g.identity.publicKey })
  return { c, hello, n, identity: g.identity, clientId }
}

const rawLines = (home: string, lines: object[]) =>
  new Promise<string>((resolve) => {
    const s = connect(readFileSync(join(home, 'socket'), 'utf8').trim())
    let out = ''
    s.on('connect', () => lines.forEach((l) => s.write(JSON.stringify(l) + '\n')))
    s.on('data', (d) => (out += d))
    s.on('close', () => resolve(out))
    setTimeout(() => s.end(), 300)
  })

describe('runtime — persistance et journal', () => {
  it('fichiers privés, base node:sqlite en WAL, journal alimenté par l’outbox transactionnel', async () => {
    const { host, home } = await startRuntime()
    expect(statSync(home).mode & 0o077).toBe(0)
    for (const f of ['token', 'identity/runtime.key', 'state/runtime.db']) expect(statSync(join(home, f)).mode & 0o077).toBe(0)
    expect(host.handle.driver).toBe('node:sqlite')
    expect((host.handle.sqlite.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
    // Every change of a replicated table produces exactly one event with the row's state.
    host.handle.sqlite.prepare("INSERT INTO activity_events (id, type, level, title) VALUES ('ev1', 'mission.created', 'info', 'test')").run()
    const out = host.flush()
    expect(out.map((e) => [e.table, e.key, e.deleted])).toEqual([['activity_events', 'ev1', false]])
    expect(out[0]!.row!.title).toBe('test')
    // Several changes of one row in a batch → one event at the first position, latest state.
    host.handle.sqlite.prepare("UPDATE activity_events SET title = 'v2' WHERE id = 'ev1'").run()
    host.handle.sqlite.prepare("UPDATE activity_events SET title = 'v3' WHERE id = 'ev1'").run()
    const out2 = host.flush()
    expect(out2).toHaveLength(1)
    expect(out2[0]!.row!.title).toBe('v3')
    expect(out2[0]!.seq).toBeGreaterThan(out[0]!.seq)
  })
})

describe('runtime — authentification et protocole', () => {
  it('jeton local faux refusé, rien d’autre n’est lu', async () => {
    const { home } = await startRuntime()
    const res = await rawLines(home, [{ jsonrpc: '2.0', id: 1, method: 'auth', params: { token: 'mauvais' } }, { jsonrpc: '2.0', id: 2, method: 'snapshot', params: {} }])
    expect(res).toContain('Non authentifié')
    expect(res).not.toContain('"id":2')
  })

  it('identité du runtime prouvée par signature ; version de protocole vérifiée', async () => {
    const { home, host } = await startRuntime()
    const { c, hello, n } = await rawClient(home, { pair: false })
    expect(verifyMessage(hello.runtimeKey, helloProofMessage(hello.runtimeId, n), hello.proof)).toBe(true)
    expect(verifyMessage(hello.runtimeKey, helloProofMessage(hello.runtimeId, 'autre-nonce-xxxxxxxx'), hello.proof)).toBe(false)
    expect(hello.runtimeKeyFingerprint).toBe(host.identity.fingerprint)
    await expect(c.request('hello', { protocol: 1, client: { id: null, name: 't', version: '1' }, nonce: nonce() })).rejects.toThrow('Protocole incompatible')
    c.close()
  })

  it('sans session : refus ; signature fausse refusée ; défi à usage unique ; session expirée ; client révoqué', async () => {
    const ck = clock()
    const { home } = await startRuntime({ now: ck.now })
    const { c, hello, identity, clientId } = await rawClient(home)
    await expect(c.request('snapshot')).rejects.toThrow('Session requise')
    await expect(c.request('session.open', { clientId, signature: signMessage(generateIdentity().identity, sessionProofMessage(hello.runtimeId, hello.challenge, clientId)) })).rejects.toThrow('Signature invalide')
    // The challenge was consumed by the failed attempt: replaying a valid signature is refused too.
    await expect(c.request('session.open', { clientId, signature: signMessage(identity, sessionProofMessage(hello.runtimeId, hello.challenge, clientId)) })).rejects.toThrow('Défi absent')
    const h2 = await c.request<HelloResult>('hello', { protocol: PROTOCOL_VERSION, client: { id: clientId, name: 't', version: '1' }, nonce: nonce() })
    expect(h2.paired).toBe(true)
    await c.request('session.open', { clientId, signature: signMessage(identity, sessionProofMessage(h2.runtimeId, h2.challenge, clientId)) })
    expect(await c.request('heartbeat')).toHaveProperty('lastSeq')
    ck.t += 13 * 3600_000
    await expect(c.request('heartbeat')).rejects.toThrow('Session expirée')
    ck.t -= 13 * 3600_000
    // Revoking a client cuts its open connections and refuses its future sessions.
    await expect(c.request('client.revoke', { requestId: 'rq_revoke_000001', clientId })).rejects.toThrow()
    const again = new RuntimeClient(localSocketTransport(home))
    const h3 = await again.request<HelloResult>('hello', { protocol: PROTOCOL_VERSION, client: { id: clientId, name: 't', version: '1' }, nonce: nonce() })
    expect(h3.paired).toBe(false)
    await expect(again.request('session.open', { clientId, signature: signMessage(identity, sessionProofMessage(h3.runtimeId, h3.challenge, clientId)) })).rejects.toThrow('révoqué')
    again.close()
    c.close()
  })

  it('paramètres validés : traversée de chemin, identifiants, méthode inconnue', async () => {
    const { host } = await startRuntime()
    const agent = { id: 'a1', version: '2026-01-01', name: 'X', role: '', description: '', appearance: {}, providerId: 'codex', model: 'm', instructions: '', autonomy: 'supervised', permissions: { readFiles: true, writeFiles: false, runCommands: false, network: false, manageProjects: false, externalActions: false }, project: '../etc', isolation: 'standard', effort: null, dailyBudgetUsd: null, enabled: true }
    await expect(host.local('agent.put', { requestId: 'rq_bad_project_1', agent })).rejects.toThrow('Nom de projet invalide')
    await expect(host.local('artifact.get', { id: '../../etc/passwd' })).rejects.toThrow('Paramètres invalides')
    await expect(host.local('mission.create' as never, { mission: { id: 'x' } })).rejects.toThrow('Paramètres invalides')
    await expect(host.dispatch(null, 'shell.exec', {})).rejects.toThrow('Méthode inconnue')
  })
})

describe('mission distante de bout en bout', () => {
  it('Orbit crée, le runtime exécute avec son propre cœur, la copie locale reflète l’état exact', async () => {
    const { home, host } = await startRuntime()
    const desk = makeDesk()
    const m = await pairDesk(desk, home)
    expect(m.status).toBe('online')
    expect(m.paired).toBe(true)
    expect(m.runtimeKeyFingerprint).toBe(host.identity.fingerprint)
    const atlas = remoteAgent(desk, m.id)
    const mission = desk.core.missions.create({ title: 'Météo', description: 'Prévisions [mark]', agentId: atlas.id, priority: 'normal', startNow: true })
    expect(mission.remoteMachineId).toBe(m.id)
    await settled(desk, mission.id)
    const local = desk.core.missions.get(mission.id)
    const remote = host.core.missions.get(mission.id)
    expect(local.status).toBe('done')
    expect(local.result).toBe(remote.result)
    expect(local.shortId).toBe(remote.shortId)
    // Same events on both sides, none duplicated.
    await waitFor(() => desk.core.missions.events(mission.id).length === host.core.missions.events(mission.id).length, 3000)
    expect(new Set(desk.core.missions.events(mission.id).map((e) => e.id)).size).toBe(host.core.missions.events(mission.id).length)
    // Executed once, in the runtime's own project folder, never a path from the Mac.
    expect(readFileSync(join(home, 'projects', 'meteo', 'runs.log'), 'utf8').trim().split('\n')).toHaveLength(1)
    expect(remote.workspace).toBe(join(home, 'projects', 'meteo'))
    expect(desk.notified.some((t) => t.includes('a terminé sur VPS de test'))).toBe(true)
  })

  it('annulation : commande au runtime, état final relu', async () => {
    const { home } = await startRuntime()
    const desk = makeDesk()
    const m = await pairDesk(desk, home)
    const atlas = remoteAgent(desk, m.id)
    const mission = desk.core.missions.create({ title: 'Long', description: '[slow:4000]', agentId: atlas.id, priority: 'normal', startNow: true })
    await waitFor(() => desk.core.missions.get(mission.id).status === 'running', 3000)
    desk.core.missions.cancel(mission.id)
    await settled(desk, mission.id)
    expect(desk.core.missions.get(mission.id).status).toBe('cancelled')
  })

  it('aucun secret d’Orbit n’est envoyé ; configuration minimale', async () => {
    const { home, host } = await startRuntime()
    const desk = makeDesk()
    desk.core.handle.sqlite.prepare("INSERT INTO provider_connections (provider_id, encrypted_secret) VALUES ('anthropic', ?)").run(`enc:${Buffer.from('sk-ant-SECRET-NE-DOIT-PAS-SORTIR').toString('base64')}`)
    const m = await pairDesk(desk, home)
    const atlas = remoteAgent(desk, m.id, { instructions: 'Sois bref.' })
    const mission = desk.core.missions.create({ title: 'x', description: 'y', agentId: atlas.id, priority: 'normal', startNow: true })
    await settled(desk, mission.id)
    const sent = JSON.stringify(desk.core.handle.sqlite.prepare('SELECT params FROM remote_commands').all())
    expect(sent).not.toContain('SECRET')
    expect(sent).not.toContain('sk-ant')
    expect(count(host.handle.sqlite, 'SELECT COUNT(*) AS n FROM provider_connections WHERE encrypted_secret IS NOT NULL')).toBe(0)
    expect(count(host.handle.sqlite, 'SELECT COUNT(*) AS n FROM conversations')).toBe(0)
    expect(host.core.agents.get(atlas.id).instructions).toBe('Sois bref.')
  })
})

describe('Orbit fermé pendant la mission', () => {
  it('la mission continue sur le runtime ; à la réouverture, tout est récupéré sans doublon', async () => {
    const { home, host } = await startRuntime()
    const dbFile = join(tmp('orb-desk-db-'), 'orbit.db')
    const dataDir = tmp('orb-desk-')
    const desk = makeDesk({ dbFile, dataDir })
    const m = await pairDesk(desk, home)
    const atlas = remoteAgent(desk, m.id)
    const mission = desk.core.missions.create({ title: 'Rapport', description: '[slow:600] [mark]', agentId: atlas.id, priority: 'normal', startNow: true })
    await waitFor(() => desk.core.missions.get(mission.id).status === 'running', 3000)
    // Orbit quits: its recovery must not touch the runtime-owned copy.
    desk.remote.disposeAll()
    desk.core.missions.recoverInterrupted()
    expect(desk.core.missions.get(mission.id).status).toBe('running')
    desk.core.handle.close()
    await waitFor(() => host.core.missions.get(mission.id).status === 'done', 5000)
    // Orbit reopens on the same database.
    const again = makeDesk({ dbFile, dataDir })
    again.remote.start()
    await waitFor(() => again.core.missions.get(mission.id).status === 'done', 5000)
    expect(again.core.missions.get(mission.id).result).toBe(host.core.missions.get(mission.id).result)
    expect(again.core.missions.events(mission.id).length).toBe(host.core.missions.events(mission.id).length)
    expect(readFileSync(join(home, 'projects', 'meteo', 'runs.log'), 'utf8').trim().split('\n')).toHaveLength(1)
    // Replaying the whole log again changes nothing (idempotent) and notifies nothing twice.
    const notifs = count(again.core.handle.sqlite, 'SELECT COUNT(*) AS n FROM notifications')
    again.remote.disconnect(m.id)
    again.core.handle.sqlite.prepare('UPDATE runtime_machines SET cursor = 0').run()
    await again.remote.connect(m.id)
    expect(again.core.missions.events(mission.id).length).toBe(host.core.missions.events(mission.id).length)
    expect(count(again.core.handle.sqlite, 'SELECT COUNT(*) AS n FROM notifications')).toBe(notifs)
  })

  it('journal élagué côté runtime : resynchronisation par instantané cohérent', async () => {
    const { home, host } = await startRuntime()
    const desk = makeDesk()
    const m = await pairDesk(desk, home)
    const atlas = remoteAgent(desk, m.id)
    await desk.remote.syncConfig(m.id)
    desk.remote.disconnect(m.id)
    // Work happens while Orbit is away… (submitted directly on the runtime, as a schedule would)
    await host.local('mission.create', { requestId: 'rq_direct_mission_1', mission: { id: 'mission-direct-1', shortId: 'M-900', title: 'Directe', description: 'x', agentId: atlas.id, priority: 'normal' }, origin: 'user' })
    await waitFor(() => host.core.missions.get('mission-direct-1').status === 'done', 3000)
    host.flush()
    // …and the runtime prunes its log past Orbit's cursor.
    const last = host.events.bounds().lastSeq
    host.handle.sqlite.prepare('DELETE FROM rt_events WHERE seq <= ?').run(last - 1)
    desk.core.handle.sqlite.prepare('UPDATE runtime_machines SET cursor = 1').run()
    await desk.remote.connect(m.id)
    expect(desk.core.missions.get('mission-direct-1').status).toBe('done')
    expect(desk.core.missions.get('mission-direct-1').remoteMachineId).toBe(m.id)
  })
})

describe('perte du transport', () => {
  it('coupure pendant la mission : le serveur continue, reprise sans perte ni doublon', async () => {
    const { home, host } = await startRuntime()
    let cut: (() => void) | null = null
    const desk = makeDesk({
      transport: (machine) => {
        const t = localSocketTransport(machine.runtimeHome)
        cut = () => t.close()
        return t
      },
    })
    const m = await pairDesk(desk, home)
    const atlas = remoteAgent(desk, m.id)
    const mission = desk.core.missions.create({ title: 'Réseau', description: '[slow:800]', agentId: atlas.id, priority: 'normal', startNow: true })
    await waitFor(() => desk.core.missions.get(mission.id).status === 'running', 3000)
    cut!()
    await waitFor(() => desk.remote.get(m.id).status === 'offline', 2000)
    // While offline: last known state, flagged stale; actions are refused, never queued blindly.
    expect(desk.remote.staleness(m.id).online).toBe(false)
    expect(() => desk.core.missions.cancel(mission.id)).toThrow('hors ligne')
    await waitFor(() => host.core.missions.get(mission.id).status === 'done', 4000)
    await desk.remote.connect(m.id)
    await settled(desk, mission.id)
    expect(desk.core.missions.get(mission.id).status).toBe('done')
    const ids = desk.core.missions.events(mission.id).map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBe(host.core.missions.events(mission.id).length)
  })

  it('réponse perdue : la commande est renvoyée avec le même identifiant et n’est exécutée qu’une fois', async () => {
    const { home, host } = await startRuntime()
    const desk = makeDesk()
    const m = await pairDesk(desk, home)
    const atlas = remoteAgent(desk, m.id)
    const params = { mission: { id: 'mission-lost-1', shortId: 'M-901', title: 'x', description: '[mark]', agentId: atlas.id, priority: 'normal' }, origin: 'user' }
    // The runtime ran it, but Orbit never got the answer (simulated: recorded as pending).
    await desk.remote.command(m.id, 'agent.put', { agent: (desk.remote as unknown as { agentSnapshot: (a: unknown) => unknown }).agentSnapshot(desk.core.agents.get(atlas.id)) })
    await host.local('mission.create', { requestId: 'rq_lost_answer_1', ...params })
    desk.core.handle.sqlite.prepare("INSERT INTO remote_commands (request_id, machine_id, method, params, status) VALUES ('rq_lost_answer_1', ?, 'mission.create', ?, 'pending')").run(m.id, JSON.stringify(params))
    desk.remote.disconnect(m.id)
    await desk.remote.connect(m.id)
    await waitFor(() => desk.core.handle.sqlite.prepare("SELECT status FROM remote_commands WHERE request_id = 'rq_lost_answer_1'").get() !== undefined && (desk.core.handle.sqlite.prepare("SELECT status FROM remote_commands WHERE request_id = 'rq_lost_answer_1'").get() as { status: string }).status === 'done', 3000)
    await waitFor(() => host.core.missions.get('mission-lost-1').status === 'done', 3000)
    expect(readFileSync(join(home, 'projects', 'meteo', 'runs.log'), 'utf8').trim().split('\n')).toHaveLength(1)
  })
})

describe('approbations distantes', () => {
  it('l’action attend sur le serveur ; accord depuis Orbit → exécutée ; refus → jamais exécutée ; rejeu refusé', async () => {
    const { home, host } = await startRuntime()
    const desk = makeDesk()
    const m = await pairDesk(desk, home)
    const atlas = remoteAgent(desk, m.id)
    const projectFile = join(home, 'projects', 'meteo', 'resultat.txt')

    const ok = desk.core.missions.create({ title: 'Écrire', description: '[approve]', agentId: atlas.id, priority: 'normal', startNow: true })
    await waitFor(() => desk.core.missions.approvals('pending').some((a) => a.missionId === ok.id), 4000)
    const ask = desk.core.missions.approvals('pending').find((a) => a.missionId === ok.id)!
    expect(ask.machineId).toBe(m.id)
    expect(desk.notified.some((t) => t.includes('Accord demandé sur VPS de test'))).toBe(true)
    expect(existsSync(projectFile)).toBe(false)
    desk.core.missions.resolveApproval(ask.id, true)
    await settled(desk, ok.id)
    expect(desk.core.missions.get(ok.id).status).toBe('done')
    expect(readFileSync(projectFile, 'utf8')).toBe('écrit par echo\n')
    const resolved = host.core.missions.approvals().find((a) => a.id === ask.id)!
    expect(resolved.status).toBe('approved')
    expect(resolved.resolvedBy).toMatch(/^orbit_/)
    // Single use: the same answer can't be replayed, even straight to the runtime.
    await expect(host.local('approval.resolve', { requestId: 'rq_replay_00001', id: ask.id, approve: true, scope: 'once', operationHash: resolved.operationHash })).rejects.toThrow('déjà été traitée')

    const no = desk.core.missions.create({ title: 'Écrire encore', description: '[approve]', agentId: atlas.id, priority: 'normal', startNow: true })
    await waitFor(() => desk.core.missions.approvals('pending').some((a) => a.missionId === no.id), 4000)
    const ask2 = desk.core.missions.approvals('pending').find((a) => a.missionId === no.id)!
    // An answer bound to another operation is refused and audited.
    await expect(host.local('approval.resolve', { requestId: 'rq_wrong_hash_1', id: ask2.id, approve: true, scope: 'once', operationHash: 'pas-la-bonne-operation' })).rejects.toThrow('L’opération a changé')
    const before = readFileSync(projectFile, 'utf8')
    desk.core.missions.resolveApproval(ask2.id, false)
    await settled(desk, no.id)
    expect(readFileSync(projectFile, 'utf8')).toBe(before)
    expect(host.core.missions.approvals().find((a) => a.id === ask2.id)!.status).toBe('denied')
    expect(count(host.handle.sqlite, "SELECT COUNT(*) AS n FROM security_audit_events WHERE action = 'approval.mismatch'")).toBe(1)
  })

  it('Orbit absent : la demande attend, n’est jamais approuvée par défaut, expire en refus', async () => {
    const ck = clock()
    const { home, host } = await startRuntime({ now: ck.now, approvalTtlMs: 3600_000 })
    const desk = makeDesk()
    const m = await pairDesk(desk, home)
    const atlas = remoteAgent(desk, m.id)
    const mission = desk.core.missions.create({ title: 'Écrire', description: '[approve]', agentId: atlas.id, priority: 'normal', startNow: true })
    await waitFor(() => host.core.missions.approvals('pending').length === 1, 4000)
    desk.remote.disconnect(m.id)
    ck.t += 2 * 3600_000
    ;(host as unknown as { housekeeping: () => void }).housekeeping()
    await waitFor(() => host.core.missions.get(mission.id).status !== 'running', 3000)
    expect(host.core.missions.approvals().find((a) => a.missionId === mission.id)!.status).toBe('expired')
    expect(existsSync(join(home, 'projects', 'meteo', 'resultat.txt'))).toBe(false)
  })
})

describe('identité du runtime', () => {
  it('première connexion : empreinte à confirmer ; identité changée : connexion refusée', async () => {
    const { home } = await startRuntime()
    const desk = makeDesk()
    const m = desk.remote.register({ name: 'VPS', transport: 'local', host: null, user: null, port: 22, runtimeHome: home })
    await expect(desk.remote.connect(m.id)).rejects.toThrow('Vérifiez l’empreinte')
    expect(desk.remote.get(m.id).status).not.toBe('online')
    await expect(desk.remote.confirmRuntimeIdentity(m.id, 'SHA256:fausse')).rejects.toThrow()
    await desk.remote.confirmRuntimeIdentity(m.id, desk.remote.get(m.id).pendingRuntimeKey!.fingerprint)
    expect(desk.remote.get(m.id).status).toBe('online')
    // Another runtime answers at the same place (server rebuilt, or worse): refused.
    desk.remote.disconnect(m.id)
    const other = await startRuntime()
    desk.core.handle.sqlite.prepare('UPDATE runtime_machines SET runtime_home = ? WHERE id = ?').run(other.home, m.id)
    await expect(desk.remote.connect(m.id)).rejects.toThrow('a changé')
    expect(desk.remote.get(m.id).pendingRuntimeKey?.changed).toBe(true)
  })
})

describe('événements', () => {
  it('curseurs : events.since est ordonné et sans trou', async () => {
    const { home, host } = await startRuntime()
    const desk = makeDesk()
    const m = await pairDesk(desk, home)
    const atlas = remoteAgent(desk, m.id)
    for (let i = 0; i < 3; i++) await settled(desk, desk.core.missions.create({ title: `n${i}`, description: 'x', agentId: atlas.id, priority: 'normal', startNow: true }).id)
    const all = host.events.since(0, 5000) as RuntimeEvent[]
    for (let i = 1; i < all.length; i++) expect(all[i]!.seq).toBe(all[i - 1]!.seq + 1)
    expect(desk.remote.get(m.id).lastSyncedAt).not.toBeNull()
    await stopRuntime(host)
  })
})
