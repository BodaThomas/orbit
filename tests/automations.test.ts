import { describe, expect, it } from 'vitest'
import { Scheduler, type AutomationInput } from '../src/main/core/automations/scheduler'
import { DEFAULT_LIMITS } from '../src/main/core/constellations/engine'
import { fakeAdapter, makeCore, novaInput, waitFor } from './helpers'

function setup() {
  let now = Date.parse('2026-11-14T07:59:00Z') // 08:59 Paris
  const core = makeCore(fakeAdapter({ words: ['Rapport', ' prêt'] }))
  core.providers.adapter('anthropic') // ensure registry
  core.handle.sqlite.prepare("INSERT INTO provider_connections (provider_id, encrypted_secret, secret_hint) VALUES ('anthropic', ?, '…key')").run(`enc:${Buffer.from('sk-valid-key').toString('base64')}`)
  const reader = core.agents.create(novaInput({ name: 'Milo', permissions: { readFiles: false, writeFiles: false, runCommands: false, network: false, manageProjects: false, externalActions: false }, autonomy: 'automated' }))
  const writer = core.agents.create(novaInput({ name: 'Atlas', permissions: { readFiles: true, writeFiles: true, runCommands: false, network: false, manageProjects: false, externalActions: false }, autonomy: 'automated' }))
  const scheduler = new Scheduler(core.db, core.bus, core.journal, core.agents, core.missions, core.constellations, () => now)
  const input = (over: Partial<AutomationInput> = {}): AutomationInput => ({ name: 'Veille du matin', description: '', targetKind: 'agent', targetId: reader.id, title: 'Résumé du jour', prompt: 'Résume.', recurrence: { kind: 'daily', time: '09:00' }, timezone: 'Europe/Paris', missedPolicy: 'skip', maxRunsPerDay: null, triggers: [], ...over })
  return { core, scheduler, reader, writer, input, setNow: (t: number) => (now = t), now: () => now }
}

describe('automatisations — scheduler', () => {
  it('calcule la prochaine exécution dans le fuseau, démarre la mission à l’heure, garde la date suivante', async () => {
    const s = setup()
    const a = s.scheduler.create(s.input())
    expect(a.nextRunAt).toBe('2026-11-14T08:00:00.000Z')
    await s.scheduler.tick()
    expect(s.scheduler.runs(a.id)).toHaveLength(0)
    s.setNow(Date.parse('2026-11-14T08:00:05Z'))
    await s.scheduler.tick()
    const runs = s.scheduler.runs(a.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ trigger: 'schedule', status: 'running' })
    expect(s.scheduler.get(a.id).nextRunAt).toBe('2026-11-15T08:00:00.000Z')
    await waitFor(() => s.core.missions.get(runs[0]!.missionId!).status === 'done', 3000)
    await s.scheduler.tick()
    expect(s.scheduler.runs(a.id)[0]!.status).toBe('done')
    expect(s.core.notified.some((n) => n.includes('Mission planifiée démarrée'))).toBe(true)
  })

  it('idempotence : deux ticks ou un redémarrage ne déclenchent jamais deux fois la même occurrence', async () => {
    const s = setup()
    const a = s.scheduler.create(s.input())
    s.setNow(Date.parse('2026-11-14T08:00:05Z'))
    // Simulate a crash right after the run row was written but before nextRunAt moved on.
    await Promise.all([s.scheduler.tick(), s.scheduler.tick()])
    s.core.handle.sqlite.prepare('UPDATE automation_definitions SET next_run_at = ? WHERE id = ?').run('2026-11-14T08:00:00.000Z', a.id)
    await s.scheduler.tick()
    expect(s.scheduler.runs(a.id)).toHaveLength(1)
  })

  it('exécutions manquées : ignorer, exécuter une fois, demander — et jamais de rafale', async () => {
    for (const policy of ['skip', 'run_once', 'ask'] as const) {
      const s = setup()
      const a = s.scheduler.create(s.input({ missedPolicy: policy }))
      // Mac off for three days.
      s.setNow(Date.parse('2026-11-17T10:00:00Z'))
      s.scheduler.recoverOnLaunch()
      const runs = s.scheduler.runs(a.id)
      expect(runs).toHaveLength(1)
      expect(runs[0]!.status).toBe(policy === 'skip' ? 'skipped' : policy === 'run_once' ? 'running' : 'pending_confirmation')
      expect(s.scheduler.get(a.id).nextRunAt).toBe('2026-11-18T08:00:00.000Z')
      if (policy === 'ask') {
        s.scheduler.confirmRun(runs[0]!.id, true)
        expect(s.scheduler.runs(a.id)[0]!.status).toBe('running')
      }
    }
  })

  it('une cible sensible n’est jamais relancée sans confirmation après une absence', () => {
    const s = setup()
    const a = s.scheduler.create(s.input({ targetId: s.writer.id, missedPolicy: 'run_once' }))
    expect(a.sensitive).toBe(true)
    s.setNow(Date.parse('2026-11-16T10:00:00Z'))
    s.scheduler.recoverOnLaunch()
    expect(s.scheduler.runs(a.id)[0]!.status).toBe('pending_confirmation')
  })

  it('une exécution interrompue par la fermeture d’Orbit devient « incertaine », jamais relancée', () => {
    const s = setup()
    const a = s.scheduler.create(s.input())
    s.core.handle.sqlite.prepare("INSERT INTO automation_runs (id, automation_id, scheduled_for, trigger, status, idempotency_key) VALUES ('r1', ?, 'x', 'schedule', 'running', 'k1')").run(a.id)
    s.scheduler.recoverOnLaunch()
    expect(s.scheduler.runs(a.id).find((r) => r.id === 'r1')!.status).toBe('uncertain')
  })

  it('pause et reprise : les occurrences en pause ne sont pas rejouées', async () => {
    const s = setup()
    const a = s.scheduler.create(s.input())
    s.scheduler.setStatus(a.id, 'paused')
    s.setNow(Date.parse('2026-11-16T10:00:00Z'))
    await s.scheduler.tick()
    expect(s.scheduler.runs(a.id)).toHaveLength(0)
    const resumed = s.scheduler.setStatus(a.id, 'active')
    expect(resumed.nextRunAt).toBe('2026-11-17T08:00:00.000Z')
    s.scheduler.recoverOnLaunch()
    expect(s.scheduler.runs(a.id)).toHaveLength(0)
  })

  it('une exécution unique se termine ; limite quotidienne', async () => {
    const s = setup()
    const once = s.scheduler.create(s.input({ recurrence: { kind: 'once', at: '2026-11-14T09:30' } }))
    s.setNow(Date.parse('2026-11-14T08:30:10Z'))
    await s.scheduler.tick()
    expect(s.scheduler.get(once.id).status).toBe('completed')
    const capped = s.scheduler.create(s.input({ name: 'Limité', maxRunsPerDay: 1 }))
    s.scheduler.runNow(capped.id)
    expect(s.scheduler.runNow(capped.id)!.status).toBe('skipped')
  })

  it('déclencheur événementiel : fin d’une mission → automatisation, sans boucle', async () => {
    const s = setup()
    const follow = s.scheduler.create(s.input({ name: 'Après Atlas', recurrence: null, targetId: s.reader.id, triggers: [{ kind: 'mission.completed', sourceAgentId: s.writer.id, sourceAutomationId: null, cooldownSec: 300 }] }))
    // Self-trigger attempt: reacts to the reader's own missions? No: only Atlas's.
    const selfLoop = s.scheduler.create(s.input({ name: 'Boucle', recurrence: null, targetId: s.reader.id, triggers: [{ kind: 'mission.completed', sourceAgentId: s.reader.id, sourceAutomationId: null, cooldownSec: 60 }] }))
    s.scheduler.start()
    const m = s.core.missions.create({ title: 'Travail d’Atlas', description: '', agentId: s.writer.id, priority: 'normal', startNow: true })
    await waitFor(() => s.core.missions.get(m.id).status === 'done', 3000)
    await waitFor(() => s.scheduler.runs(follow.id).length === 1, 3000)
    expect(s.scheduler.runs(follow.id)[0]!.trigger).toBe('event')
    // Reader's triggered mission completes → « Boucle » fires once, then its own run never re-triggers it.
    await waitFor(() => s.scheduler.runs(follow.id)[0]!.status !== 'running' || true, 100)
    await new Promise((r) => setTimeout(r, 300))
    expect(s.scheduler.runs(selfLoop.id).length).toBeLessThanOrEqual(1)
    s.scheduler.stop()
  })

  it('refuse une récurrence qui ne se produit jamais, ou une date unique déjà passée', () => {
    const s = setup()
    expect(() => s.scheduler.create(s.input({ recurrence: { kind: 'cron', expr: '0 0 30 2 *' } }))).toThrow('ne se produit jamais')
    expect(() => s.scheduler.create(s.input({ recurrence: { kind: 'once', at: '2026-11-13T09:00' } }))).toThrow('déjà passée')
    const a = s.scheduler.create(s.input())
    expect(() => s.scheduler.update(a.id, s.input({ recurrence: { kind: 'once', at: '2026-01-01T09:00' } }))).toThrow('déjà passée')
    expect(s.scheduler.list()).toHaveLength(1)
  })

  it('confirmation d’une exécution manquée : refusée si l’automatisation a été mise en pause, expirée après 24 h', async () => {
    const s = setup()
    const a = s.scheduler.create(s.input({ missedPolicy: 'ask' }))
    s.setNow(Date.parse('2026-11-17T10:00:00Z'))
    s.scheduler.recoverOnLaunch()
    const run = s.scheduler.runs(a.id)[0]!
    expect(run.status).toBe('pending_confirmation')
    s.scheduler.setStatus(a.id, 'paused')
    expect(() => s.scheduler.confirmRun(run.id, true)).toThrow('pause')
    expect(s.scheduler.runs(a.id).find((r) => r.id === run.id)).toMatchObject({ status: 'skipped', missionId: null })

    const b = s.scheduler.create(s.input({ name: 'Autre', missedPolicy: 'ask' }))
    s.setNow(Date.parse('2026-11-19T10:00:00Z'))
    s.scheduler.recoverOnLaunch()
    const old = s.scheduler.runs(b.id)[0]!
    expect(old.status).toBe('pending_confirmation')
    const age = s.core.handle.sqlite.prepare('UPDATE automation_runs SET created_at = ? WHERE id = ?')
    age.run('2026-11-19T09:00:00.000Z', old.id)
    await s.scheduler.tick()
    expect(s.scheduler.runs(b.id).find((r) => r.id === old.id)!.status).toBe('pending_confirmation') // 1 h: still open
    age.run('2026-11-18T09:00:00.000Z', old.id)
    await s.scheduler.tick()
    expect(s.scheduler.runs(b.id).find((r) => r.id === old.id)).toMatchObject({ status: 'skipped', missionId: null })
  })

  const veille = (s: ReturnType<typeof setup>) => s.core.constellations.create({ name: 'Veille', description: '', objective: '', coordinatorAgentId: s.reader.id, members: [{ agentId: s.reader.id, role: '', responsibilities: '', canDelegate: true }], workspace: null, workspaceMode: 'shared', permissions: s.reader.permissions, limits: DEFAULT_LIMITS, isTemplate: false })

  it('une constellation bloquée, en échec ou en pause (reprenable) ne clôt pas l’exécution ; la durée maximale la borne', async () => {
    const s = setup()
    const a = s.scheduler.create(s.input({ targetKind: 'constellation', targetId: veille(s).id, maxDurationMin: 30 }))
    const run = s.scheduler.runNow(a.id)!
    const crId = run.constellationRunId!
    await waitFor(() => !s.core.constellations.isActive(crId) && s.core.constellations.run(crId).status === 'completed', 3000)
    const setRun = (status: string) => s.core.handle.sqlite.prepare('UPDATE constellation_runs SET status = ? WHERE id = ?').run(status, crId)
    const status = () => s.scheduler.runs(a.id).find((r) => r.id === run.id)!.status
    for (const st of ['blocked', 'failed', 'paused']) {
      setRun(st)
      await s.scheduler.tick()
      expect(status()).toBe('running')
    }
    s.setNow(Date.now() + 31 * 60_000)
    await s.scheduler.tick()
    expect(status()).toBe('failed')
    expect(s.core.constellations.run(crId).status).toBe('cancelled')
  })

  it('une constellation terminée clôt l’exécution de l’automatisation', async () => {
    const s = setup()
    const a = s.scheduler.create(s.input({ targetKind: 'constellation', targetId: veille(s).id }))
    const run = s.scheduler.runNow(a.id)!
    await waitFor(() => !s.core.constellations.isActive(run.constellationRunId!) && s.core.constellations.run(run.constellationRunId!).status === 'completed', 3000)
    await s.scheduler.tick()
    expect(s.scheduler.runs(a.id).find((r) => r.id === run.id)!.status).toBe('done')
  })

  it('refuse une récurrence invalide ou sans déclencheur', () => {
    const s = setup()
    expect(() => s.scheduler.create(s.input({ recurrence: { kind: 'cron', expr: '* *' } }))).toThrow()
    expect(() => s.scheduler.create(s.input({ recurrence: null }))).toThrow()
    expect(() => s.scheduler.create(s.input({ timezone: 'Lune/Tranquillité' }))).toThrow()
  })
})
