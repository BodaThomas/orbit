import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentPermissions, ConstellationLimits } from '@shared/types'
import { ConstellationEngine, DEFAULT_LIMITS } from '../src/main/core/constellations/engine'
import { findCycle, normalizeWrites, scopesOverlap, validatePlan } from '../src/main/core/constellations/protocol'
import type { AgentEngine, EngineId, EngineRunRequest } from '../src/main/core/engine/types'
import { formatAnswers, looksYesNo, normalizeQuestion } from '@shared/plan-questions'
import { makeCore, novaInput, waitFor } from './helpers'

const ALL: AgentPermissions = { readFiles: true, writeFiles: true, runCommands: true, network: false, manageProjects: false, externalActions: false }
const plan = (tasks: unknown[]) => `Voici mon plan.\n\n\`\`\`orbit-plan\n${JSON.stringify({ tasks })}\n\`\`\``
const result = (summary: string) => `Travail fait.\n\n\`\`\`orbit-result\n${JSON.stringify({ status: 'done', summary, files: [] })}\n\`\`\``

type Script = (req: EngineRunRequest, call: number) => { text: string; delayMs?: number; tokens?: number } | Promise<{ text: string; delayMs?: number; tokens?: number }>

/** Scripted agent engine. Records every prompt and concurrency. */
function scripted(id: EngineId, script: Script) {
  const log: { prompt: string; perms: AgentPermissions; workspace: string; writeScopes: string[] | undefined; at: number }[] = []
  let live = 0
  let maxLive = 0
  let calls = 0
  const engine: AgentEngine = {
    id,
    name: id === 'codex' ? 'Codex' : 'Claude Code',
    capabilities: { resume: true, approvals: true, interrupt: true, fileDiffs: false, budgetCap: false, usage: 'official', confinable: true, effort: true },
    checkReady: async () => ({ ready: true, detail: 'ok', auth: 'subscription' }),
    run: async (req, io) => {
      live++
      maxLive = Math.max(maxLive, live)
      log.push({ prompt: req.prompt, perms: req.policy.permissions, workspace: req.policy.workspace, writeScopes: req.policy.writeScopes, at: Date.now() })
      try {
        const r = await script(req, calls++)
        io.emit({ type: 'session', sessionId: `s-${req.runId}`, model: 'm' })
        if (r.delayMs) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, r.delayMs)
            req.signal.addEventListener('abort', () => {
              clearTimeout(t)
              resolve()
            })
          })
        }
        if (req.signal.aborted) return { status: 'cancelled', finalText: '', error: null, sessionId: req.sessionId }
        io.emit({ type: 'usage', usage: { model: 'm', inputTokens: r.tokens ?? 100, outputTokens: 50, cachedInputTokens: 0, costUsd: null, costKind: 'subscription' } })
        return { status: 'completed', finalText: r.text, error: null, sessionId: req.sessionId ?? `s-${req.runId}` }
      } finally {
        live--
      }
    },
  }
  return { engine, log, maxLive: () => maxLive }
}

/** The coordinator plans on its first call, then synthesises. Members answer with a result. */
function team(opts: { plan: unknown[] | ((call: number, req: EngineRunRequest) => string); member?: Script; limits?: Partial<ConstellationLimits>; permissions?: AgentPermissions; mode?: 'shared' | 'worktrees'; coordinatorCanDelegate?: boolean; planApproval?: 'auto' | 'writes' | 'always' }) {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-const-')))
  let coordCalls = 0
  const isCoord = (req: EngineRunRequest) => /tu coordonnes|Résultats des sous-missions|a refusé ton plan|Reprends la planification|Poursuis la coordination|@coord/.test(req.prompt)
  const claude = scripted('claude-code', (req) => {
    if (isCoord(req)) {
      const n = coordCalls++
      if (typeof opts.plan === 'function') return { text: opts.plan(n, req) }
      return { text: n === 0 ? plan(opts.plan) : 'Synthèse finale : tout est prêt.\n\n```orbit-plan\n{"tasks":[]}\n```' }
    }
    return opts.member ? opts.member(req, 0) : { text: result(`fait par claude`) }
  })
  const codex = scripted('codex', (req, c) => (opts.member ? opts.member(req, c) : { text: result(`fait par codex`) }))
  const core = makeCore(undefined, { 'claude-code': claude.engine, codex: codex.engine })
  const nova = core.agents.create(novaInput({ name: 'Nova', providerId: 'claude-code', model: 'default', permissions: ALL, workingDirectory: ws }))
  const milo = core.agents.create(novaInput({ name: 'Milo', providerId: 'claude-code', model: 'default', permissions: ALL, workingDirectory: ws }))
  const atlas = core.agents.create(novaInput({ name: 'Atlas', providerId: 'codex', model: 'default', permissions: ALL, workingDirectory: ws }))
  const def = core.constellations.create({
    name: 'Développement Orbit',
    description: '',
    objective: 'Faire avancer Orbit',
    coordinatorAgentId: nova.id,
    members: [
      { agentId: nova.id, role: 'Coordinatrice', responsibilities: '', canDelegate: opts.coordinatorCanDelegate ?? true },
      { agentId: milo.id, role: 'Recherche', responsibilities: '', canDelegate: false },
      { agentId: atlas.id, role: 'Développement', responsibilities: '', canDelegate: false },
    ],
    workspace: ws,
    workspaceMode: opts.mode ?? 'shared',
    permissions: opts.permissions ?? ALL,
    limits: { ...DEFAULT_LIMITS, ...opts.limits },
    isTemplate: false,
    planApproval: opts.planApproval ?? 'auto',
  })
  /** Settled: final, or waiting for the user, with the drive loop stopped. */
  const done = (runId: string) => waitFor(() => !core.constellations.isActive(runId) && ['completed', 'failed', 'cancelled', 'blocked', 'awaiting_approval', 'paused'].includes(core.constellations.run(runId).status), 5000)
  return { core, ws, nova, milo, atlas, def, claude, codex, done }
}

describe('constellations — protocole', () => {
  it('lit les questions à choix et les anciennes questions en texte', () => {
    const agents = [{ id: 'n', name: 'Nova', enabled: true }]
    const ctx = { definition: { coordinatorAgentId: 'n', members: [{ agentId: 'n', role: '', responsibilities: '', canDelegate: true }], limits: { ...DEFAULT_LIMITS } }, agents, coordinatorCanDelegate: true }
    const block = (q: unknown) => '```orbit-plan\n' + JSON.stringify({ tasks: [], questions: q }) + '\n```'
    const v = validatePlan(block(['1. Garder le slogan ?', { question: 'Canaux ?', options: ['LinkedIn', 'Instagram', 'LinkedIn'], multiple: true }, { question: 'Prix ?', options: ['39 €'], multiple: true }]), ctx)
    expect(v.errors).toEqual([])
    expect(v.questions).toEqual([
      { text: 'Garder le slogan ?', options: [], multiple: false },
      { text: 'Canaux ?', options: ['LinkedIn', 'Instagram'], multiple: true },
      { text: 'Prix ?', options: ['39 €'], multiple: false },
    ])
    expect(normalizeQuestion('2) Palette sombre ?').text).toBe('Palette sombre ?')
  })
  it('propose oui / non seulement pour une question fermée', () => {
    expect(looksYesNo('Acceptez-vous de la mettre en ligne dès que la liste est passée ?')).toBe(true)
    expect(looksYesNo('Lesquels acceptez-vous ? Et quel est l’ordre de grandeur ?')).toBe(false)
    expect(looksYesNo('Combien de restaurants ?')).toBe(false)
  })
  it('formate les décisions question par question et signale les oublis', () => {
    const qs = [normalizeQuestion('Palette sombre ?'), normalizeQuestion({ question: 'Canaux ?', options: ['A', 'B'], multiple: true }), normalizeQuestion('Slogan ?')]
    const text = formatAnswers(qs, [{ choices: ['Oui'], note: '' }, { choices: ['A', 'B'], note: 'B en priorité' }, undefined], 'Merci')
    expect(text).toBe('1. Palette sombre ?\n   → Oui\n2. Canaux ?\n   → A, B · B en priorité\n3. Slogan ?\n   → Pas de réponse : ne tranche pas seul, redemande si c’est bloquant.\nCommentaire général : Merci')
  })
  it('détecte les cycles', () => {
    expect(findCycle([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }, { id: 'c', dependsOn: [] }]).sort()).toEqual(['a', 'b'])
    expect(findCycle([{ id: 'a', dependsOn: [] }, { id: 'b', dependsOn: ['a'] }])).toEqual([])
  })
  it('refuse : membre inconnu, non-membre, auto-délégation, cycle, dépassement, délégation non autorisée', () => {
    const agents = [{ id: 'n', name: 'Nova', enabled: true }, { id: 'm', name: 'Milo', enabled: true }, { id: 'x', name: 'Xéna', enabled: true }]
    const definition = { coordinatorAgentId: 'n', members: [{ agentId: 'n', role: '', responsibilities: '', canDelegate: true }, { agentId: 'm', role: '', responsibilities: '', canDelegate: false }], limits: { ...DEFAULT_LIMITS, maxSubtasks: 2 } }
    const ctx = { definition, agents, alreadyCreated: 0, existingKeys: [], coordinatorCanDelegate: true }
    expect(validatePlan(plan([{ id: 'a', assignee: 'Zorg', objective: 'x' }]), ctx).errors[0]).toContain('n’existe pas')
    expect(validatePlan(plan([{ id: 'a', assignee: 'Xéna', objective: 'x' }]), ctx).errors[0]).toContain('ne fait pas partie')
    expect(validatePlan(plan([{ id: 'a', assignee: 'Nova', objective: 'x' }]), ctx).errors[0]).toContain('boucle')
    expect(validatePlan(plan([{ id: 'a', assignee: 'Milo', objective: 'x', dependsOn: ['b'] }, { id: 'b', assignee: 'Milo', objective: 'y', dependsOn: ['a'] }]), ctx).errors.join()).toContain('circulaires')
    expect(validatePlan(plan([1, 2, 3].map((i) => ({ id: `t${i}`, assignee: 'Milo', objective: 'x' }))), ctx).errors.join()).toContain('Trop de sous-missions')
    expect(validatePlan(plan([{ id: 'a', assignee: 'Milo', objective: 'x' }]), { ...ctx, coordinatorCanDelegate: false }).errors[0]).toContain('pas autorisé')
    expect(validatePlan('Je réponds seul.', ctx).noDelegation).toBe(true)
    expect(validatePlan(plan([{ id: 'a', assignee: 'Milo', objective: 'x' }]), ctx).tasks[0]!.agentId).toBe('m')
  })

  it('zones d’écriture : chemins relatifs normalisés, sorties du dossier refusées', () => {
    expect(normalizeWrites(['./docs/qa/', 'docs/qa', 'maquettes', 'maquettes/v4'])).toEqual({ writes: ['docs/qa', 'maquettes'], error: null })
    expect(normalizeWrites(['docs', '.']).writes).toEqual([])
    expect(normalizeWrites(['../ailleurs']).error).toContain('sort du dossier')
    expect(normalizeWrites(['/etc']).error).toContain('relatif')
    expect(scopesOverlap(['docs/qa'], ['maquettes'])).toBe(false)
    expect(scopesOverlap(['docs'], ['docs/qa'])).toBe(true)
    expect(scopesOverlap(['docs-old'], ['docs'])).toBe(false)
    expect(scopesOverlap([], ['docs'])).toBe(true)
    const agents = [{ id: 'n', name: 'Nova', enabled: true }, { id: 'm', name: 'Milo', enabled: true }]
    const definition = { coordinatorAgentId: 'n', members: [{ agentId: 'n', role: '', responsibilities: '', canDelegate: true }, { agentId: 'm', role: '', responsibilities: '', canDelegate: false }], limits: DEFAULT_LIMITS }
    const ctx = { definition, agents, coordinatorCanDelegate: true }
    expect(validatePlan(plan([{ id: 'a', assignee: 'Milo', objective: 'x', writes: ['../hors'] }]), ctx).errors[0]).toContain('sort du dossier')
    expect(validatePlan(plan([{ id: 'a', assignee: 'Milo', objective: 'x', writes: ['docs/'] }]), ctx).tasks[0]!.writes).toEqual(['docs'])
    expect(validatePlan(plan([{ id: 'a', assignee: 'Milo', objective: 'x', readOnly: true, writes: ['docs'] }]), ctx).tasks[0]!.writes).toEqual([])
  })
})

describe('constellations — orchestration', () => {
  it('création : le coordinateur doit être membre', () => {
    const t = team({ plan: [] })
    expect(() => t.core.constellations.create({ ...t.def, coordinatorAgentId: 'inconnu' })).toThrow()
    expect(t.core.constellations.list()).toHaveLength(1)
  })

  it('workflow complet multi-moteurs : délégation, dépendance, transmission du résultat, synthèse', async () => {
    const t = team({
      plan: [
        { id: 'recherche', assignee: 'Milo', objective: 'Analyser le projet', readOnly: true },
        { id: 'dev', assignee: 'Atlas', objective: 'Modifier le fichier', dependsOn: ['recherche'] },
      ],
      member: (req) => ({ text: result(req.prompt.includes('Analyser') ? 'Le projet utilise TypeScript.' : 'Fichier modifié.') }),
    })
    const signals: string[] = []
    t.core.bus.on((e) => e.type === 'constellation.signal' && signals.push(`${e.signal.kind}`))
    const run = t.core.constellations.launch(t.def.id, 'Analyse puis modifie le projet')
    await t.done(run.id)
    const d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('completed')
    expect(d.run.synthesis).toContain('Synthèse finale')
    expect(d.run.synthesis).not.toContain('orbit-plan')
    expect(d.tasks.map((x) => [x.spec.key, x.status])).toEqual([['recherche', 'done'], ['dev', 'done']])
    // Milo ran on Claude Code, Atlas on Codex; Atlas received Milo's result.
    const atlasPrompt = t.codex.log[0]!.prompt
    expect(atlasPrompt).toContain('Le projet utilise TypeScript.')
    expect(t.codex.log[0]!.at).toBeGreaterThanOrEqual(t.claude.log.find((l) => l.prompt.includes('Analyser'))!.at)
    // Read-only delegation lowers permissions.
    expect(t.claude.log.find((l) => l.prompt.includes('Analyser'))!.perms).toMatchObject({ writeFiles: false, runCommands: false })
    expect(d.tasks[0]!.structured).toMatchObject({ summary: 'Le projet utilise TypeScript.' })
    expect(d.handoffs.map((h) => h.kind)).toEqual(['delegation', 'result', 'delegation', 'result', 'synthesis'])
    expect(signals).toEqual(expect.arrayContaining(['delegation', 'result', 'synthesis', 'status']))
    // The coordinator synthesised in the same session (resume).
    expect(t.core.missions.get(d.run.coordinatorMissionId!).sessionId).toBeTruthy()
  })

  it('exécution parallèle bornée et verrou d’écriture dans le dossier partagé', async () => {
    const readers = team({ plan: [1, 2, 3].map((i) => ({ id: `r${i}`, assignee: 'Milo', objective: `lecture ${i}`, readOnly: true })), member: () => ({ text: result('ok'), delayMs: 60 }), limits: { maxParallel: 2 } })
    const r = readers.core.constellations.launch(readers.def.id, 'trois lectures')
    await readers.done(r.id)
    expect(readers.core.constellations.run(r.id).status).toBe('completed')
    expect(readers.claude.maxLive()).toBe(2 + 0) // never more than maxParallel members at once (coordinator idle meanwhile)

    const writers = team({ plan: [1, 2].map((i) => ({ id: `w${i}`, assignee: 'Atlas', objective: `écriture ${i}` })), member: () => ({ text: result('ok'), delayMs: 40 }), limits: { maxParallel: 2 } })
    const w = writers.core.constellations.launch(writers.def.id, 'deux écritures')
    await writers.done(w.id)
    expect(writers.codex.maxLive()).toBe(1)
  })

  it('zones d’écriture distinctes : les rédacteurs travaillent en parallèle, les zones qui se recouvrent attendent', async () => {
    const files = { ...ALL, runCommands: false }
    const apart = team({ plan: [{ id: 'qa', assignee: 'Milo', objective: 'rapport', writes: ['docs/qa'] }, { id: 'ui', assignee: 'Milo', objective: 'maquette', writes: ['maquettes'] }], member: () => ({ text: result('ok'), delayMs: 60 }), limits: { maxParallel: 2 }, permissions: files })
    const a = apart.core.constellations.launch(apart.def.id, 'deux zones')
    await apart.done(a.id)
    expect(apart.core.constellations.run(a.id).status).toBe('completed')
    expect(apart.claude.maxLive()).toBe(2)
    const scopes = apart.claude.log.map((l) => l.writeScopes).filter(Boolean)
    expect(scopes).toContainEqual([join(apart.ws, 'docs/qa')])
    expect(scopes).toContainEqual([join(apart.ws, 'maquettes')])

    const nested = team({ plan: [{ id: 'a', assignee: 'Milo', objective: 'tout docs', writes: ['docs'] }, { id: 'b', assignee: 'Milo', objective: 'docs/qa', writes: ['docs/qa'] }], member: () => ({ text: result('ok'), delayMs: 40 }), limits: { maxParallel: 2 }, permissions: files })
    const n = nested.core.constellations.launch(nested.def.id, 'zones imbriquées')
    await nested.done(n.id)
    expect(nested.claude.maxLive()).toBe(1)
  })

  it('zones d’écriture ignorées par l’ordonnanceur quand les commandes ne sont pas confinées', async () => {
    // Codex without a command sandbox Orbit configures: its commands could write anywhere in the folder.
    const t = team({ plan: [{ id: 'a', assignee: 'Atlas', objective: 'un', writes: ['a'] }, { id: 'b', assignee: 'Atlas', objective: 'deux', writes: ['b'] }], member: () => ({ text: result('ok'), delayMs: 40 }), limits: { maxParallel: 2 } })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await t.done(run.id)
    expect(t.codex.maxLive()).toBe(1)
  })

  it('les permissions ne s’élargissent jamais par délégation', async () => {
    const t = team({ plan: [{ id: 'dev', assignee: 'Atlas', objective: 'écrire' }], permissions: { ...ALL, writeFiles: false } })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await t.done(run.id)
    expect(t.codex.log[0]!.perms.writeFiles).toBe(false)
  })

  it('plan invalide : correction demandée une fois, puis échec clair', async () => {
    const t = team({ plan: () => plan([{ id: 'a', assignee: 'Fantôme', objective: 'x' }]) })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await t.done(run.id)
    const r = t.core.constellations.run(run.id)
    expect(r.status).toBe('failed')
    expect(r.error).toContain('Plan refusé')
    expect(t.claude.log.filter((l) => l.prompt.includes('a refusé ton plan'))).toHaveLength(1)
  })

  it('délégation interdite au coordinateur → aucune sous-mission créée, refus journalisé', async () => {
    const t = team({ plan: [{ id: 'a', assignee: 'Milo', objective: 'x' }], coordinatorCanDelegate: false })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await t.done(run.id)
    const d = t.core.constellations.detail(run.id)
    expect(d.tasks).toHaveLength(0)
    expect(d.handoffs[0]!.payload).toContain('pas autorisé à déléguer')
  })

  it('une dépendance en échec : la constellation est bloquée (rien n’est jeté), puis poursuivie sans elle sur décision', async () => {
    const t = team({
      plan: [
        { id: 'a', assignee: 'Milo', objective: 'échoue', readOnly: true },
        { id: 'b', assignee: 'Atlas', objective: 'dépend', dependsOn: ['a'] },
      ],
      member: (req) => (req.prompt.includes('échoue') ? Promise.reject(new Error('panne')) : { text: result('ok') }),
    })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await t.done(run.id)
    let d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('blocked')
    expect(d.run.error).toContain('en échec')
    expect(d.tasks.map((x) => x.status)).toEqual(['failed', 'todo'])
    expect(d.actions).toEqual(expect.arrayContaining(['retry', 'resume', 'cancel']))
    expect(d.progress).toMatchObject({ total: 2, failed: 1, blocked: 1 })
    t.core.constellations.resume(run.id, { skipFailed: true })
    await t.done(run.id)
    d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('completed')
    expect(d.tasks.map((x) => x.status)).toEqual(['cancelled', 'cancelled'])
    expect(t.codex.log).toHaveLength(0)
  })

  it('limite de jetons : les sous-missions restantes ne démarrent pas', async () => {
    const t = team({ plan: [1, 2, 3].map((i) => ({ id: `t${i}`, assignee: 'Milo', objective: `tâche ${i}`, readOnly: true })), member: () => ({ text: result('ok'), tokens: 5000 }), limits: { maxParallel: 1, maxTokens: 6000 } })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await t.done(run.id)
    let d = t.core.constellations.detail(run.id)
    expect(d.tasks.filter((x) => x.status === 'done').length).toBeLessThan(3)
    expect(d.run.status).toBe('blocked')
    expect(d.run.error).toContain('Limite de jetons')
    // Remaining tasks are kept to do (not dropped): raise the limit, resume, they run.
    expect(d.tasks.some((x) => x.status === 'todo')).toBe(true)
    t.core.constellations.updateLimits(run.id, { maxTokens: 1_000_000 })
    t.core.constellations.resume(run.id)
    await t.done(run.id)
    d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('completed')
    expect(d.tasks.map((x) => x.status)).toEqual(['done', 'done', 'done'])
  })

  it('annulation : aucune sous-mission ne continue, les suivantes sont ignorées', async () => {
    const t = team({ plan: [{ id: 'long', assignee: 'Atlas', objective: 'long' }, { id: 'apres', assignee: 'Milo', objective: 'après', dependsOn: ['long'], readOnly: true }], member: () => ({ text: result('ok'), delayMs: 5000 }) })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await waitFor(() => t.codex.log.length === 1, 3000)
    t.core.constellations.cancel(run.id)
    await t.done(run.id)
    await waitFor(() => t.core.constellations.detail(run.id).tasks.every((x) => !t.core.missions.isRunning(x.missionId)), 3000)
    const d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('cancelled')
    expect(d.tasks.map((x) => x.status)).toEqual(['cancelled', 'cancelled'])
  })

  it('plusieurs tours, bornés par la profondeur maximale', async () => {
    const t = team({
      plan: (n) => (n === 0 ? plan([{ id: 'a', assignee: 'Milo', objective: 'tour 1', readOnly: true }]) : n === 1 ? plan([{ id: 'b', assignee: 'Milo', objective: 'tour 2', readOnly: true }]) : 'Synthèse après deux tours.'),
      limits: { maxDepth: 2 },
    })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await t.done(run.id)
    const d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('completed')
    expect(d.tasks.map((x) => x.spec.round)).toEqual([1, 2])
    expect(d.run.synthesis).toBe('Synthèse après deux tours.')
  })

  it('accepte plus de cinq tours de délégation', async () => {
    const t = team({
      plan: (n) => (n < 7 ? plan([{ id: `t${n}`, assignee: 'Milo', objective: `tour ${n + 1}`, readOnly: true }]) : 'Synthèse après sept tours.'),
      limits: { maxDepth: 7, maxSubtasks: 10 },
    })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await t.done(run.id)
    const d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('completed')
    expect(d.tasks.map((x) => x.spec.round)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('reprise après interruption : les résultats acquis sont conservés', async () => {
    const t = team({ plan: [{ id: 'a', assignee: 'Milo', objective: 'premier', readOnly: true }, { id: 'b', assignee: 'Atlas', objective: 'second', dependsOn: ['a'] }], member: (req) => ({ text: result('ok'), delayMs: req.prompt.includes('second') ? 3000 : 0 }) })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await waitFor(() => t.codex.log.length === 1, 3000)
    // Simulate a crash: everything stops, then the boot recovery marks the run interrupted.
    t.core.constellations.cancel(run.id)
    await waitFor(() => !t.core.constellations.isActive(run.id) && !t.core.constellations.detail(run.id).tasks.some((x) => t.core.missions.isRunning(x.missionId)), 3000)
    t.core.handle.sqlite.prepare("UPDATE constellation_runs SET status = 'running' WHERE id = ?").run(run.id)
    t.core.constellations.recoverInterrupted()
    expect(t.core.constellations.run(run.id).status).toBe('paused')
    const miloCalls = t.claude.log.filter((l) => l.prompt.includes('premier')).length
    // « second » was interrupted while it could write: never re-run without an explicit choice.
    t.core.constellations.resume(run.id)
    let d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('blocked')
    expect(d.retryable.map((r) => [r.key, r.canWrite, r.interrupted])).toEqual([['b', true, true]])
    t.core.constellations.retryTasks(run.id, [d.retryable[0]!.missionId])
    await t.done(run.id)
    d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('completed')
    expect(t.claude.log.filter((l) => l.prompt.includes('premier')).length).toBe(miloCalls) // not re-run
    expect(d.tasks.map((x) => x.status)).toEqual(['done', 'done'])
  })

  it('idempotence : la même clé ne lance pas deux exécutions', () => {
    const t = team({ plan: [] })
    const a = t.core.constellations.launch(t.def.id, 'x', { idempotencyKey: 'auto:1:2026-11-14T08:00' })
    const b = t.core.constellations.launch(t.def.id, 'x', { idempotencyKey: 'auto:1:2026-11-14T08:00' })
    expect(a.id).toBe(b.id)
  })
})

const FINAL = 'Synthèse finale : tout est prêt.\n\n```orbit-plan\n{"tasks":[]}\n```'
const planWith = (tasks: unknown[], extra: Record<string, unknown> = {}) => `Voici mon plan.\n\n\`\`\`orbit-plan\n${JSON.stringify({ tasks, ...extra })}\n\`\`\``

describe('constellations — cycle de vie persistant', () => {
  it('1. plan simple : validé par Orbit, exécuté, terminé ; historique des événements', async () => {
    const t = team({ plan: [{ id: 'a', assignee: 'Milo', objective: 'lire', readOnly: true }] })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await t.done(run.id)
    const d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('completed')
    expect(d.plans.map((p) => [p.version, p.status, p.decidedBy])).toEqual([[1, 'approved', 'policy']])
    expect(d.events.map((e) => e.kind)).toEqual(expect.arrayContaining(['run.started', 'plan.approved', 'plan.applied', 'task.done', 'round.done', 'run.completed']))
    // Finished: the only thing left is to give the coordinator a new instruction.
    expect(d.actions).toEqual(['continue'])
  })

  it('2 & 3. plan à approuver : rien ne démarre avant l’accord structuré, puis reprise automatique', async () => {
    const t = team({ plan: [{ id: 'dev', assignee: 'Atlas', objective: 'modifier' }], planApproval: 'writes' })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await t.done(run.id)
    let d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('awaiting_approval')
    expect(d.tasks).toHaveLength(0)
    expect(t.codex.log).toHaveLength(0)
    expect(d.pendingPlan?.approvalReason).toContain('modifier des fichiers')
    expect(d.actions).toEqual(expect.arrayContaining(['approve', 'reject', 'answer', 'cancel']))
    // A stale hash (plan changed after display) is refused.
    expect(() => t.core.constellations.approvePlan(run.id, d.pendingPlan!.id, 'autre-hash')).toThrow('a changé')
    t.core.constellations.approvePlan(run.id, d.pendingPlan!.id, d.pendingPlan!.hash)
    await t.done(run.id)
    d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('completed')
    expect(d.tasks.map((x) => x.status)).toEqual(['done'])
    expect(d.events.some((e) => e.kind === 'decision.approve' && e.actor === 'user')).toBe(true)
  })

  it('le coordinateur demande des décisions : la mission collective reste ouverte, la réponse relance le travail', async () => {
    const t = team({
      plan: (n) => (n === 0 ? 'Avant de déléguer, deux décisions.\n\n```orbit-plan\n{"tasks":[],"questions":["Palette sombre ?","Garder le slogan ?"]}\n```' : n === 1 ? plan([{ id: 'a', assignee: 'Milo', objective: 'lire', readOnly: true }]) : FINAL),
    })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await t.done(run.id)
    let d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('awaiting_approval') // never « terminée » while the coordinator waits
    expect(d.pendingPlan?.questions).toHaveLength(2)
    expect(d.actions).toContain('answer')
    expect(d.actions).not.toContain('approve')
    t.core.constellations.answer(run.id, 'Oui aux deux.')
    await t.done(run.id)
    d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('completed')
    expect(t.claude.log.some((l) => l.prompt.includes('Oui aux deux.') && l.prompt.includes('Palette sombre ?'))).toBe(true)
    expect(d.tasks.map((x) => x.status)).toEqual(['done'])
  })

  it('une approbation vaut pour une étape : un nouveau tour de délégation redemande l’accord', async () => {
    const t = team({
      planApproval: 'always',
      plan: (n) => (n === 0 ? plan([{ id: 'a', assignee: 'Milo', objective: 'tour 1', readOnly: true }]) : n === 1 ? plan([{ id: 'b', assignee: 'Milo', objective: 'tour 2', readOnly: true }]) : FINAL),
    })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await t.done(run.id)
    t.core.constellations.approvePlan(run.id, t.core.constellations.detail(run.id).pendingPlan!.id)
    await t.done(run.id)
    const d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('awaiting_approval')
    expect(d.pendingPlan?.tasks.map((x) => x.id)).toEqual(['b'])
    expect(d.tasks.map((x) => x.spec.key)).toEqual(['a'])
  })

  it('4. pause puis reprise manuelle : rien de nouveau ne démarre, la tâche terminée n’est pas relancée', async () => {
    const t = team({ plan: [{ id: 'a', assignee: 'Milo', objective: 'premier', readOnly: true }, { id: 'b', assignee: 'Milo', objective: 'second', dependsOn: ['a'], readOnly: true }], member: () => ({ text: result('ok'), delayMs: 150 }) })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await waitFor(() => t.claude.log.some((l) => l.prompt.includes('premier')), 3000)
    t.core.constellations.pause(run.id)
    expect(t.core.constellations.detail(run.id).run.status).toBe('paused')
    await t.done(run.id)
    let d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('paused')
    expect(d.tasks.map((x) => x.status)).toEqual(['done', 'todo']) // the running one finished normally
    expect(t.claude.log.some((l) => l.prompt.includes('second'))).toBe(false)
    expect(d.actions).toContain('resume')
    t.core.constellations.resume(run.id)
    expect(() => t.core.constellations.resume(run.id)).toThrow() // double click
    await t.done(run.id)
    d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('completed')
    expect(t.claude.log.filter((l) => l.prompt.includes('premier'))).toHaveLength(1)
  })

  it('5 & 6. plan identique reçu plusieurs fois, double clic : aucune sous-mission en double', async () => {
    const tasks = [{ id: 'a', assignee: 'Milo', objective: 'lire', readOnly: true }]
    const t = team({ plan: (n) => (n <= 2 ? planWith(tasks, { requestApproval: true }) : FINAL) })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await t.done(run.id)
    const coordId = t.core.constellations.run(run.id).coordinatorMissionId!
    // The user chats with the coordinator, which sends the very same plan again (twice).
    t.core.missions.followUp(coordId, '@coord tu peux lancer ?')
    await waitFor(() => !t.core.missions.isRunning(coordId), 3000)
    t.core.missions.followUp(coordId, '@coord alors ?')
    await waitFor(() => !t.core.missions.isRunning(coordId), 3000)
    let d = t.core.constellations.detail(run.id)
    expect(d.plans.filter((p) => p.status === 'proposed')).toHaveLength(1)
    expect(d.events.filter((e) => e.kind === 'plan.recognized')).toHaveLength(2)
    const p = d.pendingPlan!
    t.core.constellations.approvePlan(run.id, p.id, p.hash)
    t.core.constellations.approvePlan(run.id, p.id, p.hash) // double click: no-op
    await t.done(run.id)
    d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('completed')
    expect(d.tasks).toHaveLength(1)
    expect(t.claude.log.filter((l) => l.prompt.includes('Sous-mission confiée'))).toHaveLength(1)
    // Database guard: the same key cannot be created twice in a run.
    expect(() => t.core.missions.create({ title: 'dup', description: '', agentId: t.milo.id, priority: 'normal', startNow: false, constellationRunId: run.id, depth: 1, subtask: d.tasks[0]!.spec })).toThrow()
  })

  it('plan modifié après validation : différences présentées, nouvelle approbation', async () => {
    const t = team({ planApproval: 'always', plan: [{ id: 'a', assignee: 'Milo', objective: 'lire', readOnly: true }, { id: 'b', assignee: 'Milo', objective: 'puis', dependsOn: ['a'], readOnly: true }], member: (req) => ({ text: result('ok'), delayMs: req.prompt.includes('lire') ? 100 : 0 }) })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await t.done(run.id)
    t.core.constellations.approvePlan(run.id, t.core.constellations.detail(run.id).pendingPlan!.id)
    await waitFor(() => t.claude.log.some((l) => l.prompt.includes('lire')), 3000)
    t.core.constellations.pause(run.id)
    await t.done(run.id)
    // « a » is finished: it can no longer be changed; « b » can, « c » is added.
    expect(() => t.core.constellations.editPlan(run.id, [{ id: 'a', assignee: 'Milo', objective: 'autre chose', readOnly: true }])).toThrow('terminée')
    const v = t.core.constellations.editPlan(run.id, [
      { id: 'a', assignee: 'Milo', objective: 'lire', readOnly: true },
      { id: 'b', assignee: 'Atlas', objective: 'puis autrement', dependsOn: ['a'], readOnly: true },
      { id: 'c', assignee: 'Milo', objective: 'en plus', dependsOn: ['a'], readOnly: true },
    ])
    expect(v.diff).toMatchObject({ added: ['c'], changed: ['b'], unchanged: ['a'] })
    let d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('awaiting_approval')
    t.core.constellations.approvePlan(run.id, v.id, v.hash)
    await t.done(run.id)
    d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('completed')
    expect(d.tasks.map((x) => [x.spec.key, x.agentId === t.atlas.id, x.status])).toEqual(expect.arrayContaining([['a', false, 'done'], ['b', true, 'done'], ['c', false, 'done']]))
    expect(d.tasks).toHaveLength(3)
    expect(d.plans.map((p) => p.status)).toEqual(['approved', 'approved'])
  })

  it('7. sous-mission échouée puis relancée : seules les sélectionnées repartent, les autres résultats restent', async () => {
    let attempts = 0
    const t = team({
      plan: [{ id: 'ok', assignee: 'Milo', objective: 'réussit', readOnly: true }, { id: 'ko', assignee: 'Atlas', objective: 'fragile' }, { id: 'suite', assignee: 'Milo', objective: 'après', dependsOn: ['ko'], readOnly: true }],
      member: (req) => (req.prompt.includes('fragile') && attempts++ === 0 ? Promise.reject(new Error('panne réseau')) : { text: result('ok') }),
    })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await t.done(run.id)
    let d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('blocked')
    expect(d.tasks.map((x) => x.status)).toEqual(['done', 'failed', 'todo'])
    const ko = d.retryable.find((r) => r.key === 'ko')!
    expect(ko).toMatchObject({ executions: 1, fileChanges: 0, canWrite: true })
    expect(() => t.core.constellations.retryTasks(run.id, [d.tasks[0]!.missionId])).toThrow('pas en échec')
    t.core.constellations.retryTasks(run.id, [ko.missionId])
    await t.done(run.id)
    d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('completed')
    expect(d.tasks.map((x) => x.status)).toEqual(['done', 'done', 'done'])
    expect(t.claude.log.filter((l) => l.prompt.includes('réussit'))).toHaveLength(1)
  })

  it('8. dépendances entre plusieurs compagnons (losange) : ordre respecté, résultats transmis', async () => {
    const t = team({
      plan: [
        { id: 'src', assignee: 'Milo', objective: 'collecte', readOnly: true },
        { id: 'g', assignee: 'Atlas', objective: 'gauche', dependsOn: ['src'] },
        { id: 'd', assignee: 'Milo', objective: 'droite', dependsOn: ['src'], readOnly: true },
        { id: 'fin', assignee: 'Atlas', objective: 'assemble', dependsOn: ['g', 'd'] },
      ],
      member: (req) => ({ text: result(`fait:${req.prompt.match(/## Ton objectif\n(\w+)/)?.[1]}`), delayMs: 20 }),
      limits: { maxParallel: 3 },
    })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await t.done(run.id)
    const d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('completed')
    const at = (word: string) => [...t.claude.log, ...t.codex.log].find((l) => l.prompt.includes(`## Ton objectif\n${word}`))!.at
    expect(at('gauche')).toBeGreaterThanOrEqual(at('collecte'))
    expect(at('assemble')).toBeGreaterThanOrEqual(Math.max(at('gauche'), at('droite')))
    const fin = t.codex.log.find((l) => l.prompt.includes('assemble'))!.prompt
    expect(fin).toContain('fait:gauche')
    expect(fin).toContain('fait:droite')
  })

  it('9. fermeture et réouverture d’Orbit : état, plan, décisions conservés ; reprise sans doublon', async () => {
    const t = team({ planApproval: 'always', plan: [{ id: 'a', assignee: 'Milo', objective: 'rapide', readOnly: true }, { id: 'b', assignee: 'Atlas', objective: 'long' }], member: (req) => ({ text: result('ok'), delayMs: req.prompt.includes('long') ? 3000 : 0 }), limits: { maxParallel: 1 } })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await t.done(run.id)
    t.core.constellations.approvePlan(run.id, t.core.constellations.detail(run.id).pendingPlan!.id)
    await waitFor(() => t.codex.log.length === 1, 3000)
    // Quit: the loops stop, the running mission is interrupted.
    t.core.constellations.cancelAll()
    t.core.missions.cancelAll()
    await waitFor(() => !t.core.constellations.detail(run.id).tasks.some((x) => t.core.missions.isRunning(x.missionId)), 3000)
    // Reopen: a fresh engine on the same database.
    const reopened = new ConstellationEngine(t.core.db, t.core.bus, t.core.journal, t.core.agents, t.core.missions, t.core.providers, join(tmpdir(), 'orbit-wt-reopen'))
    t.core.missions.recoverInterrupted()
    reopened.recoverInterrupted()
    let d = reopened.detail(run.id)
    expect(d.run.status).toBe('paused')
    expect(d.run.error).toContain('Orbit a été fermé')
    expect(d.plans.map((p) => p.status)).toEqual(['approved'])
    expect(d.events.some((e) => e.kind === 'decision.approve')).toBe(true)
    expect(reopened.unfinished().map((r) => r.id)).toContain(run.id)
    expect(d.tasks.map((x) => x.status)).toEqual(['done', 'cancelled'])
    reopened.resume(run.id)
    d = reopened.detail(run.id)
    expect(d.run.status).toBe('blocked') // the interrupted writer is never relaunched blindly
    reopened.retryTasks(run.id, [d.retryable[0]!.missionId])
    await waitFor(() => !reopened.isActive(run.id) && reopened.run(run.id).status === 'completed', 6000)
    expect(reopened.detail(run.id).tasks).toHaveLength(2)
    expect(t.claude.log.filter((l) => l.prompt.includes('rapide'))).toHaveLength(1)
  }, 10_000)

  it('9b. une validation en attente survit au redémarrage', async () => {
    const t = team({ planApproval: 'always', plan: [{ id: 'a', assignee: 'Milo', objective: 'lire', readOnly: true }] })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await t.done(run.id)
    t.core.constellations.cancelAll()
    const reopened = new ConstellationEngine(t.core.db, t.core.bus, t.core.journal, t.core.agents, t.core.missions, t.core.providers, join(tmpdir(), 'orbit-wt-reopen'))
    reopened.recoverInterrupted()
    const d = reopened.detail(run.id)
    expect(d.run.status).toBe('awaiting_approval')
    reopened.approvePlan(run.id, d.pendingPlan!.id, d.pendingPlan!.hash)
    await waitFor(() => !reopened.isActive(run.id) && reopened.run(run.id).status === 'completed', 4000)
  })

  it('10. permissions : compagnon désactivé avant le démarrage, plafond abaissé, jamais contournés par une reprise', async () => {
    const t = team({ planApproval: 'always', plan: [{ id: 'dev', assignee: 'Atlas', objective: 'écrire' }, { id: 'lit', assignee: 'Milo', objective: 'lire', readOnly: true }] })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await t.done(run.id)
    // After the plan was proposed: Atlas is disabled, and the ceiling no longer allows writes.
    t.core.agents.setEnabled(t.atlas.id, false)
    t.core.constellations.update(t.def.id, { ...t.def, permissions: { ...ALL, writeFiles: false, runCommands: false } })
    expect(() => t.core.constellations.approvePlan(run.id, t.core.constellations.detail(run.id).pendingPlan!.id)).toThrow('désactivé')
    t.core.agents.setEnabled(t.atlas.id, true)
    t.core.constellations.approvePlan(run.id, t.core.constellations.detail(run.id).pendingPlan!.id)
    await t.done(run.id)
    expect(t.codex.log[0]!.perms).toMatchObject({ writeFiles: false, runCommands: false })
    // Disabled between approval and start of a retry: refused, nothing executed.
    const t2 = team({ plan: [{ id: 'dev', assignee: 'Atlas', objective: 'écrire' }], member: () => Promise.reject(new Error('panne')) })
    const r2 = t2.core.constellations.launch(t2.def.id, 'x')
    await t2.done(r2.id)
    t2.core.agents.setEnabled(t2.atlas.id, false)
    const calls = t2.codex.log.length
    t2.core.constellations.retryTasks(r2.id, [t2.core.constellations.detail(r2.id).retryable[0]!.missionId])
    await t2.done(r2.id)
    const d2 = t2.core.constellations.detail(r2.id)
    expect(d2.run.status).toBe('blocked')
    expect(d2.tasks[0]!.error).toContain('désactivé')
    expect(t2.codex.log.length).toBe(calls)
  })

  it('11. bloc orbit-plan invalide : erreur affichée (jamais ignorée), y compris hors orchestration', async () => {
    const broken = 'Plan :\n\n```orbit-plan\n{"tasks":[{"id":"a",,]}\n```'
    expect(validatePlan(broken, { definition: { coordinatorAgentId: 'n', members: [], limits: { maxSubtasks: 8 } }, agents: [], existing: [], coordinatorCanDelegate: true }).errors[0]).toContain('JSON valide')
    const t = team({ plan: (n) => (n === 0 ? FINAL : broken) })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await t.done(run.id)
    expect(t.core.constellations.run(run.id).status).toBe('completed')
    t.core.missions.followUp(t.core.constellations.run(run.id).coordinatorMissionId!, '@coord encore une chose')
    await waitFor(() => t.core.constellations.run(run.id).status === 'blocked', 3000)
    const d = t.core.constellations.detail(run.id)
    expect(d.run.error).toContain('JSON valide')
    expect(d.plans.at(-1)!.status).toBe('invalid')
    expect(d.events.some((e) => e.kind === 'plan.invalid' && e.level === 'error')).toBe(true)
  })

  it('12. coordinateur terminé alors que des sous-missions restent : jamais « terminée »', async () => {
    const t = team({
      plan: (n) => (n === 0 ? plan([{ id: 'ko', assignee: 'Atlas', objective: 'fragile' }, { id: 'suite', assignee: 'Milo', objective: 'après', dependsOn: ['ko'], readOnly: true }]) : 'Tout est bon pour moi.\n\n```orbit-plan\n{"tasks":[]}\n```'),
      member: (req) => (req.prompt.includes('fragile') ? Promise.reject(new Error('panne')) : { text: result('ok'), delayMs: 300 }),
    })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await t.done(run.id)
    expect(t.core.constellations.run(run.id).status).toBe('blocked')
    t.core.constellations.answer(run.id, 'On peut conclure ?')
    await t.done(run.id)
    const d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('blocked')
    expect(d.run.error).toContain('restent à faire')
    expect(d.events.some((e) => e.kind === 'run.incoherent')).toBe(true)
  })

  it('pendant l’exécution, la discussion directe avec le coordinateur est refusée (les actions de la constellation s’appliquent)', async () => {
    const t = team({ plan: [{ id: 'a', assignee: 'Milo', objective: 'long', readOnly: true }], member: () => ({ text: result('ok'), delayMs: 400 }) })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await waitFor(() => t.claude.log.some((l) => l.prompt.includes('Sous-mission')), 3000)
    expect(() => t.core.missions.followUp(t.core.constellations.run(run.id).coordinatorMissionId!, '@coord lance tout')).toThrow('constellation est en cours')
    await t.done(run.id)
    expect(t.core.constellations.run(run.id).status).toBe('completed')
  })

  it('synthèse qui demande une validation, « lance les sous-missions » en discussion → plan capturé, limites, approbation, exécution sans doublon', async () => {
    const round1 = [
      { id: 'nova-audit', assignee: 'Milo', objective: 'audit technique', readOnly: true },
      { id: 'pixel-da', assignee: 'Atlas', objective: 'direction artistique' },
    ]
    const impl = Array.from({ length: 8 }, (_, i) => ({ id: `impl-${i + 1}`, assignee: i % 2 ? 'Milo' : 'Atlas', objective: `implémentation ${i + 1}`, dependsOn: i ? [`impl-${i}`] : ['nova-audit'], readOnly: i % 2 === 1 }))
    const t = team({
      limits: { maxSubtasks: 8, maxDepth: 2, maxParallel: 2 },
      plan: (n, req) => {
        if (n === 0) return plan(round1)
        if (n === 1) return 'Synthèse. Me répondre sur les décisions 1 à 8 ; une fois validé je lancerai la phase d’implémentation.\n\n```orbit-plan\n{"tasks":[]}\n```'
        if (req.prompt.includes('@coord')) return `Je ne peux pas lancer moi-même les sous-missions : c’est l’orchestrateur Orbit.\n\n${planWith(impl)}`
        return FINAL
      },
    })
    const run = t.core.constellations.launch(t.def.id, 'refonte landing')
    await t.done(run.id)
    expect(t.core.constellations.run(run.id).status).toBe('completed')
    const coordId = t.core.constellations.run(run.id).coordinatorMissionId!
    t.core.missions.followUp(coordId, '@coord OK pour les recommandations. Je te laisse lancer les sous-missions')
    await waitFor(() => t.core.constellations.run(run.id).status === 'blocked', 3000)
    let d = t.core.constellations.detail(run.id)
    // The plan is not lost: kept, with the reason it cannot start yet (2 + 8 > 8).
    expect(d.pendingPlan?.tasks).toHaveLength(8)
    expect(d.run.error).toContain('Trop de sous-missions : 10')
    expect(d.actions).toContain('raise_limits')
    t.core.constellations.updateLimits(run.id, { maxSubtasks: 10 })
    d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('awaiting_approval') // a chat reply never counts as approval
    expect(d.pendingPlan?.approvalReason).toContain('conversationnelle')
    t.core.constellations.approvePlan(run.id, d.pendingPlan!.id, d.pendingPlan!.hash)
    await waitFor(() => !t.core.constellations.isActive(run.id) && t.core.constellations.run(run.id).status === 'completed', 8000)
    d = t.core.constellations.detail(run.id)
    expect(d.tasks).toHaveLength(10)
    expect(d.tasks.every((x) => x.status === 'done')).toBe(true)
    expect(t.claude.log.filter((l) => l.prompt.includes('audit technique') && l.prompt.includes('Sous-mission'))).toHaveLength(1)
    expect(d.tasks.filter((x) => x.spec.key.startsWith('impl')).every((x) => x.spec.round === 2)).toBe(true)
  }, 15_000)

  it('récupération d’une exécution antérieure au cycle de vie (« done » + plan resté dans la discussion)', async () => {
    const t = team({ plan: [{ id: 'audit', assignee: 'Milo', objective: 'audit', readOnly: true }] })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await t.done(run.id)
    const sql = t.core.handle.sqlite
    const coordId = t.core.constellations.run(run.id).coordinatorMissionId!
    // Rewind to the legacy state (before run lifecycles): status « done », no plans, no read marker, a later chat reply holding a plan.
    sql.prepare("UPDATE constellation_runs SET status = 'done', last_ingested_execution_id = NULL, finished_at = '2026-11-14T19:46:56.329Z' WHERE id = ?").run(run.id)
    sql.prepare('DELETE FROM constellation_plans WHERE run_id = ?').run(run.id)
    sql.prepare('INSERT INTO mission_executions (id, mission_id, idempotency_key, status, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)').run('legacy-exec', coordId, `${coordId}:99`, 'done', '2026-11-14T19:51:33.442Z', '2026-11-14T19:52:10.750Z')
    sql.prepare('UPDATE missions SET result = ? WHERE id = ?').run(`Je ne peux pas lancer les sous-missions moi-même.\n\n${planWith([{ id: 'impl', assignee: 'Atlas', objective: 'implémenter', dependsOn: ['audit'] }])}`, coordId)
    t.core.constellations.recoverInterrupted()
    t.core.constellations.recoverInterrupted() // idempotent at every boot
    const d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('awaiting_approval')
    expect(d.plans.map((p) => [p.version, p.status, p.source])).toEqual([[1, 'approved', 'coordinator'], [2, 'proposed', 'conversation']])
    expect(d.pendingPlan?.diff).toMatchObject({ added: ['impl'] })
    expect(d.events.some((e) => e.kind === 'plan.recovered')).toBe(true)
    expect(d.tasks).toHaveLength(1) // nothing executed automatically
  })
})

describe('constellations — correctifs de fiabilité', () => {
  it('plan hors limites puis limites relevées : la validation exigée par la politique reste exigée', async () => {
    const t = team({ planApproval: 'always', limits: { maxSubtasks: 1 }, plan: [{ id: 'a', assignee: 'Milo', objective: 'lire', readOnly: true }, { id: 'b', assignee: 'Milo', objective: 'lire encore', readOnly: true }] })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await t.done(run.id)
    expect(t.core.constellations.run(run.id).status).toBe('blocked')
    t.core.constellations.updateLimits(run.id, { maxSubtasks: 2 })
    const d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('awaiting_approval')
    expect(d.pendingPlan?.approvalReason).toContain('chaque plan')
    expect(d.tasks).toHaveLength(0)
  })

  it('modifier une sous-mission échouée : la modification est appliquée et la relance utilise le nouvel objectif', async () => {
    const t = team({ plan: [{ id: 'ko', assignee: 'Atlas', objective: 'fragile' }], member: (req) => (req.prompt.includes('fragile') ? Promise.reject(new Error('panne')) : { text: result('ok') }) })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await t.done(run.id)
    expect(t.core.constellations.detail(run.id).tasks[0]!.status).toBe('failed')
    // Already attempted by Atlas: its companion can no longer change.
    expect(() => t.core.constellations.editPlan(run.id, [{ id: 'ko', assignee: 'Milo', objective: 'robuste' }])).toThrow('déjà été tentée')
    const v = t.core.constellations.editPlan(run.id, [{ id: 'ko', assignee: 'Atlas', objective: 'robuste' }])
    t.core.constellations.approvePlan(run.id, v.id, v.hash)
    await t.done(run.id)
    let d = t.core.constellations.detail(run.id)
    expect(d.tasks[0]!.spec.objective).toBe('robuste')
    t.core.constellations.retryTasks(run.id, [d.tasks[0]!.missionId])
    await t.done(run.id)
    d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('completed')
    expect(t.codex.log.at(-1)!.prompt).toContain('robuste')
  })

  it('un identifiant déjà terminé ne peut pas désigner un nouveau travail : correction demandée, identifiants listés', async () => {
    const t = team({
      limits: { maxDepth: 2 },
      plan: (n) => (n === 0 ? plan([{ id: 'a', assignee: 'Milo', objective: 'tour 1', readOnly: true }]) : n === 1 ? plan([{ id: 'a', assignee: 'Milo', objective: 'autre travail', readOnly: true }]) : n === 2 ? plan([{ id: 'b', assignee: 'Milo', objective: 'tour 2', readOnly: true }]) : FINAL),
    })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await t.done(run.id)
    const d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('completed')
    expect(d.tasks.map((x) => [x.spec.key, x.spec.objective, x.status])).toEqual([['a', 'tour 1', 'done'], ['b', 'tour 2', 'done']])
    expect(t.claude.log.some((l) => l.prompt.includes('Résultats des sous-missions') && l.prompt.includes('Identifiants déjà utilisés dans cette exécution : a'))).toBe(true)
    expect(t.claude.log.some((l) => l.prompt.includes('a refusé ton plan') && l.prompt.includes('nouvel identifiant'))).toBe(true)
    // Re-sending the finished task unchanged stays allowed.
    const agents = [{ id: 'n', name: 'Nova', enabled: true }, { id: 'm', name: 'Milo', enabled: true }]
    const definition = { coordinatorAgentId: 'n', members: [{ agentId: 'n', role: '', responsibilities: '', canDelegate: true }, { agentId: 'm', role: '', responsibilities: '', canDelegate: false }], limits: { maxSubtasks: 8 } }
    const existing = [{ key: 'a', agentId: 'm', status: 'done', spec: { objective: 'x', expected: '', context: '', dependsOn: [], readOnly: true } }]
    expect(validatePlan(plan([{ id: 'a', assignee: 'Milo', objective: 'x', readOnly: true }]), { definition, agents, existing, coordinatorCanDelegate: true }).errors).toEqual([])
  })

  it('« poursuivre sans elles » ignore aussi une sous-mission interrompue (et ses dépendantes)', async () => {
    const t = team({ plan: [{ id: 'long', assignee: 'Atlas', objective: 'long' }, { id: 'apres', assignee: 'Milo', objective: 'après', dependsOn: ['long'], readOnly: true }], member: (req) => ({ text: result('ok'), delayMs: req.prompt.includes('## Ton objectif\nlong') ? 3000 : 0 }) })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await waitFor(() => t.codex.log.length === 1, 3000)
    t.core.constellations.cancelAll()
    t.core.missions.cancelAll()
    await waitFor(() => !t.core.constellations.detail(run.id).tasks.some((x) => t.core.missions.isRunning(x.missionId)), 3000)
    const reopened = new ConstellationEngine(t.core.db, t.core.bus, t.core.journal, t.core.agents, t.core.missions, t.core.providers, join(tmpdir(), 'orbit-wt-reopen'))
    t.core.missions.recoverInterrupted()
    reopened.recoverInterrupted()
    reopened.resume(run.id, { skipFailed: true })
    await waitFor(() => !reopened.isActive(run.id) && reopened.run(run.id).status === 'completed', 4000)
    expect(reopened.detail(run.id).tasks.map((x) => x.status)).toEqual(['cancelled', 'cancelled'])
    expect(t.claude.log.some((l) => l.prompt.includes('## Ton objectif\naprès'))).toBe(false)
  })

  it('une relance ne peut viser qu’une sous-mission du plan en cours', async () => {
    let tries = 0
    const t = team({
      plan: (n) => (n === 0 ? plan([{ id: 'a', assignee: 'Milo', objective: 'fragile', readOnly: true }]) : n === 1 ? plan([{ id: 'b', assignee: 'Milo', objective: 'tour 2', readOnly: true }]) : FINAL),
      member: (req) => ((req.prompt.includes('fragile') && tries++ === 0) || req.prompt.includes('tour 2') ? Promise.reject(new Error('panne')) : { text: result('ok') }),
    })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await t.done(run.id)
    const a = t.core.constellations.detail(run.id).tasks[0]!
    t.core.constellations.resume(run.id, { skipFailed: true })
    await t.done(run.id)
    const d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('blocked')
    expect(d.tasks.map((x) => x.spec.key)).toEqual(['a', 'b'])
    // « a » belongs to round 1; the plan being executed is round 2's.
    expect(d.retryable.map((x) => x.key)).toEqual(['b'])
    expect(() => t.core.constellations.retryTasks(run.id, [a.missionId])).toThrow('plan en cours')
  })

  it('la limite de durée ne réécrit jamais l’état d’une exécution annulée ou terminée', async () => {
    const t = team({ plan: [{ id: 'a', assignee: 'Milo', objective: 'lire', readOnly: true }] })
    const timeLimit = (e: ConstellationEngine, id: string) => (e as unknown as { timeLimit(id: string): void }).timeLimit(id)
    const done = t.core.constellations.launch(t.def.id, 'x')
    await t.done(done.id)
    timeLimit(t.core.constellations, done.id)
    expect(t.core.constellations.run(done.id).status).toBe('completed')
    const cancelled = t.core.constellations.launch(t.def.id, 'y')
    t.core.constellations.cancel(cancelled.id)
    await t.done(cancelled.id)
    timeLimit(t.core.constellations, cancelled.id)
    expect(t.core.constellations.run(cancelled.id).status).toBe('cancelled')
    expect(t.core.constellations.events(cancelled.id).some((e) => e.kind === 'limit.duration')).toBe(false)
  })

  it('une sous-mission en attente d’approbation après un redémarrage est attendue puis exploitée', async () => {
    const t = team({ plan: [{ id: 'dev', assignee: 'Atlas', objective: 'écrire' }] })
    const sql = t.core.handle.sqlite
    const pending = () => sql.prepare("SELECT id FROM approval_requests WHERE status = 'pending' AND kind = 'mission_start'").all() as { id: string }[]
    const approveAll = () => {
      for (const a of pending()) t.core.missions.resolveApproval(a.id, true)
    }
    // Automation origin + supervised companions with write permissions: every start needs approval.
    const run = t.core.constellations.launch(t.def.id, 'x', { origin: 'automation' })
    await waitFor(() => {
      if (!t.core.constellations.detail(run.id).tasks.length) approveAll() // the coordinator only
      return t.core.constellations.detail(run.id).tasks[0]?.status === 'approval_required'
    }, 4000)
    // Quit while it waits, reopen.
    t.core.constellations.cancelAll()
    const reopened = new ConstellationEngine(t.core.db, t.core.bus, t.core.journal, t.core.agents, t.core.missions, t.core.providers, join(tmpdir(), 'orbit-wt-reopen'))
    reopened.recoverInterrupted()
    reopened.resume(run.id)
    await new Promise((r) => setTimeout(r, 100))
    expect(reopened.run(run.id).status).toBe('running') // not « blocked: cannot start »
    await waitFor(() => {
      approveAll()
      return !reopened.isActive(run.id) && reopened.run(run.id).status === 'completed'
    }, 8000)
    const d = reopened.detail(run.id)
    expect(d.tasks[0]!.structured).toMatchObject({ summary: 'fait par codex' })
    expect(d.events.some((e) => e.kind === 'task.done')).toBe(true)
    expect(t.codex.log).toHaveLength(1)
  }, 15_000)

  it('budget : réservation appliquée même sans coût mesuré (coordinateur sur abonnement)', async () => {
    const t = team({ plan: [], limits: { maxSubtasks: 1, maxBudgetUsd: 1 } })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await t.done(run.id)
    const overBudget = (n: number) => (t.core.constellations as unknown as { overBudget(id: string, n: number): { over: boolean } }).overBudget(run.id, n)
    expect(overBudget(1).over).toBe(false)
    expect(overBudget(2).over).toBe(true)
  })
})

describe('constellations — worktrees Git (réel)', () => {
  it('écrivains parallèles isolés, conflit détecté, fusion refusée si dossier sale, puis fusion contrôlée', async () => {
    const { execFileSync } = await import('node:child_process')
    const { writeFileSync, readFileSync, existsSync } = await import('node:fs')
    const t = team({
      plan: [
        { id: 'w1', assignee: 'Atlas', objective: 'écrit A' },
        { id: 'w2', assignee: 'Milo', objective: 'écrit B' },
      ],
      mode: 'worktrees',
      limits: { maxParallel: 2 },
      member: (req) => {
        // The « agent » edits the same file differently in its own checkout.
        writeFileSync(join(req.policy.workspace, 'README.md'), req.prompt.includes('écrit A') ? 'version A\n' : 'version B\n')
        return { text: result('modifié'), delayMs: 30 }
      },
    })
    const g = (...a: string[]) => execFileSync('git', a, { cwd: t.ws, encoding: 'utf8' })
    g('init', '-q')
    g('config', 'user.email', 't@example.invalid')
    g('config', 'user.name', 'T')
    writeFileSync(join(t.ws, 'README.md'), 'origine\n')
    g('add', '-A')
    g('commit', '-qm', 'init')
    const run = t.core.constellations.launch(t.def.id, 'deux propositions')
    await t.done(run.id)
    const d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('completed')
    const wts = d.workspaces.filter((w) => w.kind === 'worktree')
    expect(wts).toHaveLength(2)
    // Separate checkouts, the user's folder untouched.
    expect(readFileSync(join(t.ws, 'README.md'), 'utf8')).toBe('origine\n')
    expect(wts.every((w) => w.path !== t.ws && w.branch?.startsWith('orbit/'))).toBe(true)
    // Incompatible proposals are detected, never merged silently.
    expect(wts.every((w) => w.status === 'conflict' && w.conflictWith.length === 1)).toBe(true)
    // Dirty user folder → merge refused.
    writeFileSync(join(t.ws, 'README.md'), 'travail en cours\n')
    await expect(t.core.constellations.mergeWorkspace(wts[0]!.id)).rejects.toThrow('non enregistrées')
    expect(readFileSync(join(t.ws, 'README.md'), 'utf8')).toBe('travail en cours\n')
    g('checkout', '--', 'README.md')
    // Discard one proposal, merge the other.
    await t.core.constellations.discardWorkspace(wts[1]!.id)
    expect(existsSync(wts[1]!.path)).toBe(false)
    const merged = await t.core.constellations.mergeWorkspace(wts[0]!.id)
    expect(merged.status).toBe('merged')
    expect(readFileSync(join(t.ws, 'README.md'), 'utf8')).toMatch(/version [AB]/)
  })
})
