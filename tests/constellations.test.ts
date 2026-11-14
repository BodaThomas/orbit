import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentPermissions, ConstellationLimits } from '@shared/types'
import { DEFAULT_LIMITS } from '../src/main/core/constellations/engine'
import { findCycle, validatePlan } from '../src/main/core/constellations/protocol'
import type { AgentEngine, EngineId, EngineRunRequest } from '../src/main/core/engine/types'
import { makeCore, novaInput, waitFor } from './helpers'

const ALL: AgentPermissions = { readFiles: true, writeFiles: true, runCommands: true, network: false, manageProjects: false, externalActions: false }
const plan = (tasks: unknown[]) => `Voici mon plan.\n\n\`\`\`orbit-plan\n${JSON.stringify({ tasks })}\n\`\`\``
const result = (summary: string) => `Travail fait.\n\n\`\`\`orbit-result\n${JSON.stringify({ status: 'done', summary, files: [] })}\n\`\`\``

type Script = (req: EngineRunRequest, call: number) => { text: string; delayMs?: number; tokens?: number } | Promise<{ text: string; delayMs?: number; tokens?: number }>

/** Scripted agent engine. Records every prompt and concurrency. */
function scripted(id: EngineId, script: Script) {
  const log: { prompt: string; perms: AgentPermissions; workspace: string; at: number }[] = []
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
      log.push({ prompt: req.prompt, perms: req.policy.permissions, workspace: req.policy.workspace, at: Date.now() })
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
function team(opts: { plan: unknown[] | ((call: number) => string); member?: Script; limits?: Partial<ConstellationLimits>; permissions?: AgentPermissions; mode?: 'shared' | 'worktrees'; coordinatorCanDelegate?: boolean }) {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-const-')))
  let coordCalls = 0
  const isCoord = (req: EngineRunRequest) => /tu coordonnes|Résultats des sous-missions|a refusé ton plan|Reprends la planification/.test(req.prompt)
  const claude = scripted('claude-code', (req) => {
    if (isCoord(req)) {
      const n = coordCalls++
      if (typeof opts.plan === 'function') return { text: opts.plan(n) }
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
  })
  const done = (runId: string) => waitFor(() => ['done', 'failed', 'cancelled'].includes(core.constellations.run(runId).status), 5000)
  return { core, ws, nova, milo, atlas, def, claude, codex, done }
}

describe('constellations — protocole', () => {
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
    expect(d.run.status).toBe('done')
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
    expect(readers.core.constellations.run(r.id).status).toBe('done')
    expect(readers.claude.maxLive()).toBe(2 + 0) // never more than maxParallel members at once (coordinator idle meanwhile)

    const writers = team({ plan: [1, 2].map((i) => ({ id: `w${i}`, assignee: 'Atlas', objective: `écriture ${i}` })), member: () => ({ text: result('ok'), delayMs: 40 }), limits: { maxParallel: 2 } })
    const w = writers.core.constellations.launch(writers.def.id, 'deux écritures')
    await writers.done(w.id)
    expect(writers.codex.maxLive()).toBe(1)
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

  it('une dépendance en échec : les tâches dépendantes sont ignorées, la synthèse a lieu', async () => {
    const t = team({
      plan: [
        { id: 'a', assignee: 'Milo', objective: 'échoue', readOnly: true },
        { id: 'b', assignee: 'Atlas', objective: 'dépend', dependsOn: ['a'] },
      ],
      member: (req) => (req.prompt.includes('échoue') ? Promise.reject(new Error('panne')) : { text: result('ok') }),
    })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await t.done(run.id)
    const d = t.core.constellations.detail(run.id)
    expect(d.tasks.map((x) => x.status)).toEqual(['failed', 'cancelled'])
    expect(d.run.status).toBe('done')
    expect(t.codex.log).toHaveLength(0)
  })

  it('limite de jetons : les sous-missions restantes ne démarrent pas', async () => {
    const t = team({ plan: [1, 2, 3].map((i) => ({ id: `t${i}`, assignee: 'Milo', objective: `tâche ${i}`, readOnly: true })), member: () => ({ text: result('ok'), tokens: 5000 }), limits: { maxParallel: 1, maxTokens: 6000 } })
    const run = t.core.constellations.launch(t.def.id, 'x')
    await t.done(run.id)
    const d = t.core.constellations.detail(run.id)
    expect(d.tasks.filter((x) => x.status === 'done').length).toBeLessThan(3)
    expect(d.tasks.some((x) => x.error?.includes('Limite de jetons'))).toBe(true)
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
    expect(d.run.status).toBe('done')
    expect(d.tasks.map((x) => x.spec.round)).toEqual([1, 2])
    expect(d.run.synthesis).toBe('Synthèse après deux tours.')
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
    expect(t.core.constellations.run(run.id).status).toBe('interrupted')
    const miloCalls = t.claude.log.filter((l) => l.prompt.includes('premier')).length
    t.core.constellations.resume(run.id)
    await t.done(run.id)
    const d = t.core.constellations.detail(run.id)
    expect(d.run.status).toBe('done')
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
    expect(d.run.status).toBe('done')
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
