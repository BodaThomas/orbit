import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMPANION_PRESETS } from '@shared/catalog'
import { OrbitRuntime } from '../src/main/core/runtime'
import { EventBus } from '../src/main/core/event-bus'

/**
 * End-to-end, with real engines: Nova (Claude Code) coordinates, Milo (Claude Code) researches
 * read-only, Atlas (Codex) modifies a throw-away project. Uses the user's own Claude Code
 * and Codex logins. The approvals Atlas asks for are granted by this harness on the
 * user's behalf (equivalent of clicking « Approuver ») and recorded as such.
 * Opt-in: ORBIT_LIVE_CONSTELLATION=1 ORBIT_LIVE_DATA_DIR=/path/to/data-dir
 */
describe.runIf(process.env.ORBIT_LIVE_CONSTELLATION === '1')('constellation réelle multi-moteurs', () => {
  it('Nova délègue à Milo puis Atlas, puis synthétise', async () => {
    const dir = process.env.ORBIT_LIVE_DATA_DIR!
    const project = join(dir, 'projet-meteo')
    mkdirSync(join(project, 'src'), { recursive: true })
    writeFileSync(join(project, 'package.json'), '{ "name": "meteo-cli", "type": "module", "scripts": { "test": "node --test" } }\n')
    writeFileSync(join(project, 'src', 'forecast.js'), "export const forecast = (city) => ['soleil', 'nuages', 'pluie'][city.length % 3]\n")
    writeFileSync(join(project, 'README.md'), '# meteo-cli\n\nMétéo fictive par ville.\n')
    writeFileSync(join(dir, 'orbit-state.json'), JSON.stringify({ mode: 'real' }))
    const bus = new EventBus()
    const rt = new OrbitRuntime('real', join(dir, 'orbit.db'), bus, {
      secrets: { available: () => false, encrypt: () => '', decrypt: () => '' },
      nativeNotify: () => {},
      fetch,
      appVersion: '0.0.0-test',
    })
    rt.settings.update({ onboarded: true, userName: 'Thomas' })
    for (const id of ['claude-code', 'codex'] as const) {
      const v = await rt.providers.validate(id)
      expect(v.ok, `${id}: ${v.error}`).toBe(true)
    }
    const preset = (name: string) => COMPANION_PRESETS.find((p) => p.name === name)!
    const perms = { readFiles: true, writeFiles: true, runCommands: true, network: false, manageProjects: false, externalActions: false }
    const mk = (name: string, providerId: 'claude-code' | 'codex', model: string, role: string) =>
      rt.agents.create({ name, role, description: preset(name).description, appearance: preset(name).appearance, providerId, model, instructions: preset(name).instructions, autonomy: 'supervised', permissions: perms, workingDirectory: project, dailyBudgetUsd: null })
    const nova = mk('Nova', 'claude-code', 'sonnet', 'Coordinatrice')
    const milo = mk('Milo', 'claude-code', 'haiku', 'Recherche')
    const atlas = mk('Atlas', 'codex', 'default', 'Développement')
    const def = rt.constellations.create({
      name: 'Développement Orbit',
      description: 'Analyse, développement et synthèse sur un projet de test.',
      objective: 'Faire évoluer le projet avec des changements petits et vérifiables.',
      coordinatorAgentId: nova.id,
      members: [
        { agentId: nova.id, role: 'Coordinatrice', responsibilities: 'Organise les missions et synthétise les résultats.', canDelegate: true },
        { agentId: milo.id, role: 'Recherche', responsibilities: 'Analyse le code et la documentation, sans rien modifier.', canDelegate: false },
        { agentId: atlas.id, role: 'Développement', responsibilities: 'Modifie les fichiers du projet.', canDelegate: false },
      ],
      workspace: project,
      workspaceMode: 'shared',
      permissions: perms,
      limits: { maxDepth: 1, maxSubtasks: 3, maxParallel: 2, maxDurationMin: 20, maxTokens: 3_000_000, maxBudgetUsd: null },
      isTemplate: false,
    })
    // Harness = the user clicking « Approuver » on each request, recorded in the audit log.
    const approved: string[] = []
    bus.on((e) => {
      if (e.type !== 'invalidate' || !e.scopes.includes('approvals')) return
      for (const a of rt.missions.approvals('pending')) {
        if (approved.includes(a.id)) continue
        approved.push(a.id)
        setTimeout(() => {
          try {
            rt.missions.resolveApproval(a.id, true)
          } catch {
            /* expired */
          }
        }, 800)
      }
    })
    const run = rt.constellations.launch(def.id, 'Analyse le projet meteo-cli (Milo, en lecture seule), puis fais ajouter par Atlas une fonction exportée `tomorrow(city)` dans src/forecast.js qui renvoie la prévision du lendemain (même logique, ville décalée), avec un commentaire JSDoc. Synthétise ensuite pour moi.')
    const t0 = Date.now()
    while (!['done', 'failed', 'cancelled'].includes(rt.constellations.run(run.id).status)) {
      if (Date.now() - t0 > 18 * 60_000) throw new Error('timeout')
      await new Promise((r) => setTimeout(r, 2000))
    }
    const d = rt.constellations.detail(run.id)
    console.log('STATUS', d.run.status, d.run.error)
    console.log('TASKS', d.tasks.map((t) => `${t.spec.key}:${rt.agents.get(t.agentId).name}:${t.status}:${t.spec.readOnly}`).join(' | '))
    console.log('HANDOFFS', d.handoffs.map((h) => h.summary.slice(0, 80)).join(' || '))
    console.log('APPROVALS', approved.length, 'TOKENS', d.run.tokens)
    console.log('SYNTHESIS', (d.run.synthesis ?? '').slice(0, 600))
    console.log('FILE', readFileSync(join(project, 'src', 'forecast.js'), 'utf8'))
    rt.dispose()
    expect(d.run.status).toBe('done')
    expect(d.tasks.some((t) => t.agentId === milo.id && t.status === 'done')).toBe(true)
    expect(d.tasks.some((t) => t.agentId === atlas.id && t.status === 'done')).toBe(true)
    expect(readFileSync(join(project, 'src', 'forecast.js'), 'utf8')).toContain('tomorrow')
  }, 20 * 60_000)
})
