import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentPermissions } from '@shared/types'
import type { AutomationInput } from '../src/main/core/automations/scheduler'
import { DEFAULT_LIMITS } from '../src/main/core/constellations/engine'
import type { AgentEngine, EngineRunRequest } from '../src/main/core/engine/types'
import { cleanup, clock, count, hostStatus, makeDesk, pairDesk, remoteAgent, settled, startRuntime, stopRuntime } from './always-on-harness'
import { novaInput, waitFor } from './helpers'

afterEach(cleanup)

const daily = (over: Partial<AutomationInput> = {}): AutomationInput => ({ name: 'Rapport quotidien', description: '', targetKind: 'agent', targetId: '', title: 'Préparer mon rapport', prompt: 'Rapport [mark]', recurrence: { kind: 'daily', time: '08:00' }, timezone: 'Europe/Paris', missedPolicy: 'ask', maxRunsPerDay: null, triggers: [], ...over })

/** 2026-11-16 07:59:30 Paris (UTC+1). */
const BEFORE_8AM = Date.parse('2026-11-16T06:59:30Z')

describe('planificateur autonome sur le runtime', () => {
  it('Nova sur le VPS chaque jour à 8 h (Paris) : enregistrée sur le serveur, déclenchée sans le Mac, résultat retrouvé', async () => {
    const rt = clock(BEFORE_8AM)
    const mac = clock(BEFORE_8AM)
    const { home, host } = await startRuntime({ now: rt.now })
    const desk = makeDesk({ now: mac.now })
    const m = await pairDesk(desk, home)
    const nova = remoteAgent(desk, m.id, { name: 'Nova', autonomy: 'automated' })
    const a = desk.core.scheduler.create(daily({ targetId: nova.id }))
    expect(a.schedulerOwner).toBe('local')
    const moved = await desk.remote.transferAutomation(a.id, m.id)
    expect(moved.schedulerOwner).toBe(m.id)
    expect(moved.ownerState).toBe('active')
    // Registered on the server, with the server-computed next run (08:00 Paris = 07:00 UTC).
    expect(host.core.scheduler.get(a.id).nextRunAt).toBe('2026-11-16T07:00:00.000Z')
    expect(moved.nextRunAt).toBe('2026-11-16T07:00:00.000Z')

    // The Mac is closed.
    desk.remote.disconnect(m.id)
    // 08:00:10 Paris: the Mac's scheduler (if it were running) must not fire a runtime-owned automation.
    mac.t = rt.t = Date.parse('2026-11-16T07:00:10Z')
    await desk.core.scheduler.tick()
    expect(desk.core.scheduler.runs(a.id)).toHaveLength(0)
    await host.core.scheduler.tick()
    const runs = host.core.scheduler.runs(a.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.trigger).toBe('schedule')
    await waitFor(() => host.core.missions.get(runs[0]!.missionId!).status === 'done', 4000)
    // Ticking again (restart, double timer) never fires the same occurrence twice.
    await host.core.scheduler.tick()
    expect(host.core.scheduler.runs(a.id)).toHaveLength(1)
    expect(readFileSync(join(home, 'projects', 'meteo', 'runs.log'), 'utf8').trim().split('\n')).toHaveLength(1)

    // The Mac comes back: history, report and next run are there.
    await desk.remote.connect(m.id)
    await waitFor(() => desk.core.scheduler.runs(a.id).some((r) => r.status === 'done'), 4000)
    const run = desk.core.scheduler.runs(a.id)[0]!
    expect(run.machineId).toBe(m.id)
    expect(desk.core.missions.get(run.missionId!).result).toContain('echo:')
    expect(desk.core.scheduler.get(a.id).nextRunAt).toBe('2026-11-17T07:00:00.000Z')
  })

  it('pause, reprise et « exécuter maintenant » passent par le serveur ; modification versionnée', async () => {
    const { home, host } = await startRuntime()
    const desk = makeDesk()
    const m = await pairDesk(desk, home)
    const nova = remoteAgent(desk, m.id, { autonomy: 'automated' })
    const a = desk.core.scheduler.create(daily({ targetId: nova.id }))
    await desk.remote.transferAutomation(a.id, m.id)
    desk.core.scheduler.setStatus(a.id, 'paused')
    await waitFor(() => host.core.scheduler.get(a.id).status === 'paused', 3000)
    await waitFor(() => desk.core.scheduler.get(a.id).status === 'paused', 3000)
    desk.core.scheduler.setStatus(a.id, 'active')
    await waitFor(() => host.core.scheduler.get(a.id).status === 'active', 3000)
    expect(desk.core.scheduler.runNow(a.id)).toBeNull()
    await waitFor(() => host.core.scheduler.runs(a.id).some((r) => r.trigger === 'manual'), 3000)
    desk.core.scheduler.update(a.id, { ...daily({ targetId: nova.id }), recurrence: { kind: 'daily', time: '09:30' } })
    await waitFor(() => host.core.scheduler.get(a.id).configVersion === 2, 3000)
    expect(host.core.scheduler.get(a.id).recurrence).toEqual({ kind: 'daily', time: '09:30' })
    // An older version never overwrites a newer one.
    const stale = await host.local('automation.put', { requestId: 'rq_stale_version_1', automation: { ...JSON.parse(JSON.stringify(desk.core.handle.sqlite.prepare('SELECT 1').get())), id: a.id, version: 1, name: 'Vieux', description: '', targetKind: 'agent', targetId: nova.id, title: 't', prompt: 'p', recurrence: { kind: 'daily', time: '07:00' }, timezone: 'Europe/Paris', missedPolicy: 'ask', maxRunsPerDay: null, triggers: [], status: 'active', maxDurationMin: null, budgetUsd: null, failurePolicy: 'notify' } })
    expect((stale as { applied: boolean }).applied).toBe(false)
    expect(host.core.scheduler.get(a.id).recurrence).toEqual({ kind: 'daily', time: '09:30' })
  })

  it('propriété unique : transfert retour vers le Mac, jamais deux planificateurs actifs', async () => {
    const rt = clock(BEFORE_8AM)
    const mac = clock(BEFORE_8AM)
    const { home, host } = await startRuntime({ now: rt.now })
    const desk = makeDesk({ now: mac.now })
    const m = await pairDesk(desk, home)
    const nova = remoteAgent(desk, m.id, { autonomy: 'automated' })
    const a = desk.core.scheduler.create(daily({ targetId: nova.id }))
    await desk.remote.transferAutomation(a.id, m.id)
    const back = await desk.remote.transferAutomation(a.id, 'local')
    expect(back.schedulerOwner).toBe('local')
    expect(host.core.scheduler.get(a.id).schedulerOwner).toBe('released')
    rt.t = mac.t = Date.parse('2026-11-16T07:00:10Z')
    await host.core.scheduler.tick()
    expect(host.core.scheduler.runs(a.id)).toHaveLength(0)
  })

  it('transfert interrompu : état « transfert » neutre (personne ne déclenche), réconcilié à la reconnexion', async () => {
    const rt = clock(BEFORE_8AM)
    const mac = clock(BEFORE_8AM)
    const { home, host } = await startRuntime({ now: rt.now })
    const desk = makeDesk({ now: mac.now })
    const m = await pairDesk(desk, home)
    const nova = remoteAgent(desk, m.id, { autonomy: 'automated' })
    const a = desk.core.scheduler.create(daily({ targetId: nova.id }))
    await desk.remote.syncConfig(m.id)
    // The registration reaches the runtime but its answer is lost.
    const realCommand = desk.remote.command.bind(desk.remote)
    desk.remote.command = (async (id: string, method: string, params: Record<string, unknown>, entity?: { kind: string; id: string }, requestId?: string) => {
      if (method === 'automation.put') {
        await realCommand(id, method, params, entity, requestId)
        throw new Error('Connexion perdue : réponse perdue')
      }
      return realCommand(id, method, params, entity, requestId)
    }) as typeof desk.remote.command
    await expect(desk.remote.transferAutomation(a.id, m.id)).rejects.toThrow('réponse perdue')
    desk.remote.command = realCommand
    expect(desk.core.scheduler.get(a.id).ownerState).toBe('transferring')
    // During the uncertainty the Mac doesn't fire it…
    mac.t = Date.parse('2026-11-16T07:00:10Z')
    await desk.core.scheduler.tick()
    expect(desk.core.scheduler.runs(a.id)).toHaveLength(0)
    expect(() => desk.core.scheduler.setStatus(a.id, 'paused')).toThrow('Transfert en cours')
    // …and the reconnection reads the server's real state, then finishes the move.
    desk.remote.disconnect(m.id)
    await desk.remote.connect(m.id)
    await waitFor(() => desk.core.scheduler.get(a.id).ownerState === 'active', 3000)
    expect(desk.core.scheduler.get(a.id).schedulerOwner).toBe(m.id)
    expect(host.core.scheduler.get(a.id).schedulerOwner).toBe('local')
  })

  it('transfert refusé : machine hors ligne, cible non placée sur la machine', async () => {
    const { home } = await startRuntime()
    const desk = makeDesk()
    const m = await pairDesk(desk, home)
    const local = desk.core.agents.create(novaInput({ name: 'Locale', providerId: 'codex', model: 'default', workingDirectory: desk.dataDir }))
    const a = desk.core.scheduler.create(daily({ targetId: local.id }))
    await expect(desk.remote.transferAutomation(a.id, m.id)).rejects.toThrow('n’est pas placée')
    desk.remote.disconnect(m.id)
    const nova = remoteAgent(desk, m.id)
    const b = desk.core.scheduler.create(daily({ targetId: nova.id }))
    await expect(desk.remote.transferAutomation(b.id, m.id)).rejects.toThrow('hors ligne')
    expect(desk.core.scheduler.get(a.id).ownerState).toBe('active')
    expect(desk.core.scheduler.get(b.id).schedulerOwner).toBe('local')
  })
})

describe('redémarrage du runtime', () => {
  it('occurrence manquée pendant l’arrêt : cible sensible jamais rejouée sans confirmation ; confirmée depuis Orbit', async () => {
    const rt = clock(BEFORE_8AM)
    const { home, host } = await startRuntime({ now: rt.now })
    const desk = makeDesk()
    const m = await pairDesk(desk, home)
    const nova = remoteAgent(desk, m.id, { autonomy: 'automated' }) // can write files → sensitive
    const a = desk.core.scheduler.create(daily({ targetId: nova.id, missedPolicy: 'run_once' }))
    await desk.remote.transferAutomation(a.id, m.id)
    desk.remote.disconnect(m.id)
    await stopRuntime(host)
    // The server is down at 08:00 and comes back at 10:00.
    rt.t = Date.parse('2026-11-16T09:00:00Z')
    const { host: again } = await startRuntime({ home, now: rt.now })
    const runs = again.core.scheduler.runs(a.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).toBe('pending_confirmation')
    expect(runs[0]!.note).toContain('runtime arrêté')
    expect(count(again.handle.sqlite, 'SELECT COUNT(*) AS n FROM missions')).toBe(0)
    await desk.remote.connect(m.id)
    await waitFor(() => desk.core.scheduler.runs(a.id).some((r) => r.status === 'pending_confirmation'), 3000)
    expect(desk.notified.some((t) => t.includes('Exécution manquée'))).toBe(true)
    desk.core.scheduler.confirmRun(runs[0]!.id, true)
    await waitFor(() => again.core.scheduler.runs(a.id)[0]!.status !== 'pending_confirmation', 3000)
    await waitFor(() => desk.core.scheduler.runs(a.id).some((r) => r.status === 'done'), 5000)
  })

  it('mission en cours lors d’un redémarrage : marquée interrompue, jamais relancée ; reprise explicite possible', async () => {
    const { home, host } = await startRuntime()
    const desk = makeDesk()
    const m = await pairDesk(desk, home)
    const atlas = remoteAgent(desk, m.id)
    const mission = desk.core.missions.create({ title: 'Longue', description: '[slow:3000] [mark]', agentId: atlas.id, priority: 'normal', startNow: true })
    await waitFor(() => hostStatus(host, mission.id) === 'running', 3000)
    desk.remote.disconnect(m.id)
    await stopRuntime(host) // controlled stop: cancelled, recorded
    const { host: again } = await startRuntime({ home })
    expect(['cancelled', 'failed']).toContain(again.core.missions.get(mission.id).status)
    await new Promise((r) => setTimeout(r, 300))
    expect(readFileSync(join(home, 'projects', 'meteo', 'runs.log'), 'utf8').trim().split('\n')).toHaveLength(1)
    await desk.remote.connect(m.id)
    await settled(desk, mission.id)
    // The user may continue it explicitly (same engine session).
    desk.core.missions.followUp(mission.id, 'Reprends [mark]')
    await waitFor(() => again.core.missions.get(mission.id).status === 'done', 4000)
    expect(readFileSync(join(home, 'projects', 'meteo', 'runs.log'), 'utf8').trim().split('\n')).toHaveLength(2)
  })
})

describe('limites appliquées par le runtime', () => {
  it('concurrence : au-delà de la limite la mission attend, puis démarre seule', async () => {
    const { home, host } = await startRuntime()
    const desk = makeDesk()
    const m = await pairDesk(desk, home)
    await desk.remote.setLimits(m.id, { ...host.limits(), maxConcurrentMissions: 1 })
    const atlas = remoteAgent(desk, m.id)
    const first = desk.core.missions.create({ title: 'Un', description: '[slow:500]', agentId: atlas.id, priority: 'normal', startNow: true })
    await waitFor(() => hostStatus(host, first.id) === 'running', 3000)
    const second = desk.core.missions.create({ title: 'Deux', description: 'x', agentId: atlas.id, priority: 'normal', startNow: true })
    await waitFor(() => { try { return host.core.missions.events(second.id).some((e) => e.message.includes('En file d’attente')) } catch { return false } }, 3000)
    expect(host.core.missions.get(second.id).status).toBe('todo')
    await settled(desk, second.id, 6000)
    expect(desk.core.missions.get(second.id).status).toBe('done')
  })

  it('budget journalier du serveur : refus appliqué côté runtime quoi que demande le client', async () => {
    const { home, host } = await startRuntime()
    const desk = makeDesk()
    const m = await pairDesk(desk, home)
    await desk.remote.setLimits(m.id, { ...host.limits(), dailyBudgetUsd: 1 })
    host.handle.sqlite.prepare("INSERT INTO usage_records (id, provider_id, model, cost_usd, cost_kind, source) VALUES ('u1', 'anthropic', 'm', 2.5, 'official', 'mission')").run()
    const atlas = remoteAgent(desk, m.id)
    const mission = desk.core.missions.create({ title: 'Trop cher', description: 'x', agentId: atlas.id, priority: 'normal', startNow: true })
    await waitFor(() => desk.core.missions.get(mission.id).status === 'failed', 3000)
    expect(desk.core.missions.get(mission.id).error).toContain('Budget journalier de ce serveur')
  })
})

describe('artefacts', () => {
  it('rapport et fichiers produits : métadonnées synchronisées, contenu récupéré par identifiant et vérifié', async () => {
    const { home, host } = await startRuntime()
    const desk = makeDesk()
    const m = await pairDesk(desk, home)
    const atlas = remoteAgent(desk, m.id, { autonomy: 'automated' })
    const mission = desk.core.missions.create({ title: 'Écrire', description: '[approve]', agentId: atlas.id, priority: 'normal', startNow: true })
    await waitFor(() => desk.core.missions.approvals('pending').some((a) => a.missionId === mission.id), 4000)
    desk.core.missions.resolveApproval(desk.core.missions.approvals('pending').find((a) => a.missionId === mission.id)!.id, true)
    await settled(desk, mission.id)
    await waitFor(() => desk.remote.artifacts(mission.id).length >= 2, 3000)
    const list = desk.remote.artifacts(mission.id)
    expect(list.map((a) => [a.kind, a.name, a.status])).toEqual([['report', 'rapport.md', 'stored'], ['file', 'resultat.txt', 'stored']])
    const file = await desk.remote.fetchArtifact(list[1]!.id)
    expect(file.preview).toBe('écrit par echo\n')
    expect(readFileSync(file.path, 'utf8')).toBe('écrit par echo\n')
    // Tampered content on the server: rejected by hash.
    writeFileSync(join(host.artifacts.root, String((host.handle.sqlite.prepare('SELECT rel_path FROM rt_artifacts WHERE id = ?').get(list[0]!.id) as { rel_path: string }).rel_path)), 'altéré')
    await expect(host.local('artifact.get', { id: list[0]!.id })).rejects.toThrow('Intégrité')
    await expect(host.local('artifact.get', { id: 'inconnu' })).rejects.toThrow('inconnu')
  })
})

// Daily automation, end to end

const ALL: AgentPermissions = { readFiles: true, writeFiles: true, runCommands: true, network: false, manageProjects: false, externalActions: false }
const plan = (tasks: unknown[]) => `Voici mon plan.\n\n\`\`\`orbit-plan\n${JSON.stringify({ tasks })}\n\`\`\``
const result = (summary: string) => `Travail fait.\n\n\`\`\`orbit-result\n${JSON.stringify({ status: 'done', summary, files: [] })}\n\`\`\``

function scriptedEngine(id: 'claude-code' | 'codex', answer: (req: EngineRunRequest) => string): AgentEngine & { prompts: string[] } {
  const prompts: string[] = []
  return {
    prompts,
    id,
    name: id === 'codex' ? 'Codex (test)' : 'Claude Code (test)',
    capabilities: { resume: true, approvals: true, interrupt: true, fileDiffs: false, budgetCap: false, usage: 'official', confinable: true, effort: true },
    checkReady: async () => ({ ready: true, detail: 'ok (test)', auth: 'subscription' }),
    run: async (req, io) => {
      prompts.push(req.prompt)
      io.emit({ type: 'session', sessionId: `s-${req.runId}`, model: 'm' })
      io.emit({ type: 'usage', usage: { model: 'm', inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, costUsd: null, costKind: 'subscription' } })
      return { status: 'completed', finalText: answer(req), error: null, sessionId: `s-${req.runId}` }
    },
  }
}

describe('constellation distante', () => {
  it('coordinateur et membres sur le runtime, deux moteurs, délégation avec dépendance, synthèse ; continue sans le Mac', async () => {
    let coord = 0
    const isCoord = (r: EngineRunRequest) => /tu coordonnes|Résultats des sous-missions|a refusé ton plan|Reprends la planification/.test(r.prompt)
    const claude = scriptedEngine('claude-code', (r) => (isCoord(r) ? (coord++ === 0 ? plan([{ id: 'recherche', assignee: 'Milo', objective: 'Analyser le projet', readOnly: true }, { id: 'dev', assignee: 'Atlas', objective: 'Modifier le fichier', dependsOn: ['recherche'] }]) : 'Synthèse finale : tout est prêt.\n\n```orbit-plan\n{"tasks":[]}\n```') : result('Le projet utilise TypeScript.')))
    const codex = scriptedEngine('codex', () => result('Fichier modifié.'))
    const { home, host } = await startRuntime({ engines: { 'claude-code': claude, codex } })
    mkdirSync(join(home, 'projects'), { recursive: true })
    const desk = makeDesk({ engines: { 'claude-code': { ...claude, name: 'local' }, codex: { ...codex, name: 'local' } } })
    const m = await pairDesk(desk, home)
    const mk = (name: string, providerId: 'claude-code' | 'codex') => desk.core.agents.create(novaInput({ name, providerId, model: 'default', runtime: 'remote', machineId: m.id, workingDirectory: 'dev-orbit', autonomy: 'automated', permissions: ALL }))
    const nova = mk('Nova', 'claude-code')
    const milo = mk('Milo', 'claude-code')
    const atlas = mk('Atlas', 'codex')
    const def = desk.core.constellations.create({ name: 'Développement', description: '', objective: 'Faire avancer Orbit', coordinatorAgentId: nova.id, members: [{ agentId: nova.id, role: 'Coordinatrice', responsibilities: '', canDelegate: true }, { agentId: milo.id, role: 'Recherche', responsibilities: '', canDelegate: false }, { agentId: atlas.id, role: 'Développement', responsibilities: '', canDelegate: false }], workspace: 'dev-orbit', workspaceMode: 'shared', permissions: ALL, limits: DEFAULT_LIMITS, isTemplate: false })
    expect(desk.core.constellations.placement(def)).toBe(m.id)
    const run = desk.core.constellations.launch(def.id, 'Analyse puis modifie le projet')
    expect(run.machineId).toBe(m.id)
    // The Mac goes away as soon as the run is accepted: the runtime coordinates alone.
    await waitFor(() => { try { return host.core.constellations.run(run.id).status !== 'planning' } catch { return false } }, 4000)
    desk.remote.disconnect(m.id)
    await waitFor(() => ['done', 'failed'].includes(host.core.constellations.run(run.id).status), 6000)
    expect(host.core.constellations.run(run.id).status).toBe('done')
    expect(codex.prompts[0]).toContain('Le projet utilise TypeScript.')
    // Back on the Mac: the whole run, tasks, handoffs and synthesis, from the runtime.
    await desk.remote.connect(m.id)
    await waitFor(() => desk.core.constellations.run(run.id).status === 'done', 4000)
    const d = desk.core.constellations.detail(run.id)
    expect(d.run.synthesis).toContain('Synthèse finale')
    expect(d.tasks.map((t) => [t.spec.key, t.status])).toEqual([['recherche', 'done'], ['dev', 'done']])
    expect(d.handoffs.length).toBeGreaterThanOrEqual(3)
    expect(d.run.tokens).toBeGreaterThan(0)
    expect(desk.notified.some((t) => t.includes('Constellation terminée'))).toBe(true)
  })

  it('placement mixte Mac/serveur refusé avec un message clair', async () => {
    const { home } = await startRuntime()
    const desk = makeDesk()
    const m = await pairDesk(desk, home)
    const remote = remoteAgent(desk, m.id, { name: 'Nova' })
    const local = desk.core.agents.create(novaInput({ name: 'Milo', providerId: 'codex', model: 'default', workingDirectory: desk.dataDir }))
    const def = desk.core.constellations.create({ name: 'Mixte', description: '', objective: '', coordinatorAgentId: remote.id, members: [{ agentId: remote.id, role: '', responsibilities: '', canDelegate: true }, { agentId: local.id, role: '', responsibilities: '', canDelegate: false }], workspace: null, workspaceMode: 'shared', permissions: ALL, limits: DEFAULT_LIMITS, isTemplate: false })
    expect(() => desk.core.constellations.launch(def.id, 'x')).toThrow('au même endroit')
  })
})
