import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { zonedParts } from '@shared/schedule'
import { EventBus } from '../src/main/core/event-bus'
import { OrbitRuntime } from '../src/main/core/runtime'

/**
 * End-to-end, with a real engine: a daily automation due in ~1 minute is fired by the scheduler,
 * Milo (Claude Code, read-only) runs the mission, the next date is kept.
 * Opt-in: ORBIT_LIVE_AUTOMATION=1 ORBIT_LIVE_DATA_DIR=<data dir of the constellation test>
 */
describe.runIf(process.env.ORBIT_LIVE_AUTOMATION === '1')('automatisation réelle', () => {
  it('le scheduler démarre la mission à l’heure et conserve la prochaine date', async () => {
    const dir = process.env.ORBIT_LIVE_DATA_DIR!
    const bus = new EventBus()
    const rt = new OrbitRuntime('real', join(dir, 'orbit.db'), bus, { secrets: { available: () => false, encrypt: () => '', decrypt: () => '' }, nativeNotify: () => {}, fetch, appVersion: '0.0.0-test' })
    const milo = rt.agents.list().find((a) => a.name === 'Milo')!
    for (const old of rt.scheduler.list().filter((x) => x.name === 'Revue quotidienne du projet')) rt.scheduler.delete(old.id)
    for (const ap of rt.missions.approvals('pending')) rt.missions.resolveApproval(ap.id, false)
    const tz = 'Europe/Paris'
    // First minute boundary at least 40 s away.
    const due = Math.ceil((Date.now() + 40_000) / 60_000) * 60_000
    const p = zonedParts(due, tz)
    const time = `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`
    const a = rt.scheduler.create({ name: 'Revue quotidienne du projet', description: '', targetKind: 'agent', targetId: milo.id, title: 'Résumer l’état du projet meteo-cli', prompt: 'Lis les fichiers du projet et résume son état en trois phrases, sans rien modifier.', recurrence: { kind: 'daily', time }, timezone: tz, missedPolicy: 'ask', maxRunsPerDay: 3, triggers: [] })
    console.log('CREATED next', a.nextRunAt, 'expected', new Date(due).toISOString())
    expect(a.nextRunAt).toBe(new Date(due).toISOString())
    rt.start()
    const t0 = Date.now()
    // The harness plays the user: Milo may modify files, so the scheduled start needs an approval.
    let approvals = 0
    while (!rt.scheduler.runs(a.id).some((r) => r.status === 'done' || r.status === 'failed')) {
      for (const ap of rt.missions.approvals('pending')) {
        rt.missions.resolveApproval(ap.id, true)
        approvals++
      }
      void rt.scheduler.tick()
      if (Date.now() - t0 > 6 * 60_000) throw new Error('timeout')
      await new Promise((r) => setTimeout(r, 2000))
    }
    const run = rt.scheduler.runs(a.id)[0]!
    const mission = rt.missions.get(run.missionId!)
    const after = rt.scheduler.get(a.id)
    console.log('RUN', run.status, run.trigger, run.startedAt, 'scheduled', run.scheduledFor)
    console.log('MISSION', mission.status, (mission.result ?? '').slice(0, 300))
    console.log('NEXT', after.nextRunAt, 'APPROVALS', approvals)
    rt.dispose()
    expect(run).toMatchObject({ status: 'done', trigger: 'schedule' })
    expect(Date.parse(run.startedAt!) - due).toBeLessThan(20_000)
    expect(Date.parse(after.nextRunAt!) - due).toBe(86_400_000)
  }, 8 * 60_000)
})
