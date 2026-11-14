import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { localDateTimeInput } from '@shared/schedule'
import type { RemoteMachine } from '@shared/types'
import type { RuntimeTransport } from '../src/main/core/remote/client'
import { spawnLineProcess } from '../src/main/core/engine/process'
import { cleanup, makeDesk, remoteAgent, settled, type Desk } from './always-on-harness'
import { waitFor } from './helpers'

/**
 * Live validation against a real Linux runtime in a container (deploy/validate-linux.sh).
 *   ORBIT_LINUX_DOCKER=<container>      runtime reached through `docker exec -i … attach`
 *   ORBIT_LINUX_SSH_PORT / _SSH_KEY     same, through real SSH (pinned host key, forced command)
 * Not a VPS: the report says so.
 */
const C = process.env.ORBIT_LINUX_DOCKER
const HOME = process.env.ORBIT_LINUX_HOME ?? '/var/lib/orbit/runtime'
const SSH_PORT = process.env.ORBIT_LINUX_SSH_PORT
const SSH_KEY = process.env.ORBIT_LINUX_SSH_KEY

afterEach(cleanup)

let execCut: (() => void) | null = null
function dockerTransport(): RuntimeTransport {
  const p = spawnLineProcess({ command: 'docker', args: ['exec', '-i', C!, 'orbit-runtime', 'attach', '--home', HOME], cwd: process.env.HOME ?? '/', env: { PATH: process.env.PATH, HOME: process.env.HOME }, label: 'docker' })
  execCut = () => p.close(100)
  return { write: (l) => p.write(l), onLine: (cb) => p.onLine(cb), onClose: (cb) => p.onExit((r) => cb(p.stderrTail().trim().split('\n').pop() || r)), close: () => p.close(300) }
}

const sh = (...args: string[]) => execFileSync('docker', ['exec', C!, ...args], { encoding: 'utf8' })

async function pair(desk: Desk): Promise<RemoteMachine> {
  const m = desk.remote.register({ name: 'Linux (conteneur)', transport: 'local', host: null, user: null, port: 22, runtimeHome: HOME })
  await desk.remote.connect(m.id).catch(() => undefined)
  await desk.remote.confirmRuntimeIdentity(m.id, desk.remote.get(m.id).pendingRuntimeKey!.fingerprint)
  return desk.remote.get(m.id)
}

describe.skipIf(!C)('Linux réel (conteneur) — runtime piloté comme un VPS', () => {
  it('A — identité, version, mission de bout en bout sur Linux', async () => {
    const desk = makeDesk({ transport: () => dockerTransport() })
    const m = await pair(desk)
    expect(m.info?.Système).toMatch(/Linux/)
    expect(m.protocol).toBe(2)
    const atlas = remoteAgent(desk, m.id, { workingDirectory: 'linux-a' })
    const mission = desk.core.missions.create({ title: 'Linux', description: 'Bonjour depuis le Mac [mark]', agentId: atlas.id, priority: 'normal', startNow: true })
    await settled(desk, mission.id, 15_000)
    expect(desk.core.missions.get(mission.id).status).toBe('done')
    expect(desk.core.missions.get(mission.id).result).toContain('echo:')
    expect(sh('cat', `${HOME}/projects/linux-a/runs.log`).trim().split('\n')).toHaveLength(1)
    // State files on the Linux side: owner-only.
    expect(sh('stat', '-c', '%a %U', HOME, `${HOME}/token`, `${HOME}/state/runtime.db`, `${HOME}/identity/runtime.key`).trim().split('\n')).toEqual(['700 orbit', '600 orbit', '600 orbit', '600 orbit'])
  }, 60_000)

  it('B + F — Orbit fermé / transport coupé : la mission continue sur Linux, reprise sans doublon', async () => {
    const desk = makeDesk({ transport: () => dockerTransport() })
    const m = await pair(desk)
    const atlas = remoteAgent(desk, m.id, { workingDirectory: 'linux-b' })
    const mission = desk.core.missions.create({ title: 'Coupure', description: '[slow:3000] [mark]', agentId: atlas.id, priority: 'normal', startNow: true })
    await waitFor(() => desk.core.missions.get(mission.id).status === 'running', 15_000)
    execCut!()
    await waitFor(() => desk.remote.get(m.id).status !== 'online', 10_000)
    await new Promise((r) => setTimeout(r, 3500))
    await desk.remote.connect(m.id)
    await settled(desk, mission.id, 15_000)
    expect(desk.core.missions.get(mission.id).status).toBe('done')
    const ids = desk.core.missions.events(mission.id).map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(sh('cat', `${HOME}/projects/linux-b/runs.log`).trim().split('\n')).toHaveLength(1)
  }, 60_000)

  it('E — approbation depuis le Mac, refus jamais exécuté', async () => {
    const desk = makeDesk({ transport: () => dockerTransport() })
    const m = await pair(desk)
    const atlas = remoteAgent(desk, m.id, { workingDirectory: 'linux-e' })
    const ok = desk.core.missions.create({ title: 'Oui', description: '[approve]', agentId: atlas.id, priority: 'normal', startNow: true })
    await waitFor(() => desk.core.missions.approvals('pending').some((a) => a.missionId === ok.id), 15_000)
    desk.core.missions.resolveApproval(desk.core.missions.approvals('pending').find((a) => a.missionId === ok.id)!.id, false)
    await settled(desk, ok.id, 15_000)
    expect(() => sh('cat', `${HOME}/projects/linux-e/resultat.txt`)).toThrow()
    const yes = desk.core.missions.create({ title: 'Oui', description: '[approve]', agentId: atlas.id, priority: 'normal', startNow: true })
    await waitFor(() => desk.core.missions.approvals('pending').some((a) => a.missionId === yes.id), 15_000)
    desk.core.missions.resolveApproval(desk.core.missions.approvals('pending').find((a) => a.missionId === yes.id)!.id, true)
    await settled(desk, yes.id, 15_000)
    expect(sh('cat', `${HOME}/projects/linux-e/resultat.txt`)).toBe('écrit par echo\n')
  }, 60_000)

  it('C — automatisation planifiée sur Linux, déclenchée par le serveur pendant que le Mac est déconnecté', async () => {
    const desk = makeDesk({ transport: () => dockerTransport() })
    const m = await pair(desk)
    const nova = remoteAgent(desk, m.id, { name: 'Nova', workingDirectory: 'linux-c', autonomy: 'automated' })
    const at = localDateTimeInput(Math.ceil((Date.now() + 70_000) / 60_000) * 60_000, 'Europe/Paris')
    const a = desk.core.scheduler.create({ name: 'Rapport', description: '', targetKind: 'agent', targetId: nova.id, title: 'Rapport planifié', prompt: 'Rapport [mark]', recurrence: { kind: 'once', at }, timezone: 'Europe/Paris', missedPolicy: 'skip', maxRunsPerDay: null, triggers: [] })
    await desk.remote.transferAutomation(a.id, m.id)
    desk.remote.disconnect(m.id)
    // Server-side only: the Mac's scheduler isn't even running in this test.
    await waitFor(() => {
      try {
        return sh('cat', `${HOME}/projects/linux-c/runs.log`).trim().length > 0
      } catch {
        return false
      }
    }, 150_000)
    await desk.remote.connect(m.id)
    await waitFor(() => desk.core.scheduler.runs(a.id).some((r) => r.status === 'done' && r.machineId === m.id), 20_000)
    expect(desk.core.scheduler.get(a.id).status).toBe('completed')
  }, 200_000)

  it('G — redémarrage du conteneur : mission interrompue, jamais relancée ; le service revient seul', async () => {
    const desk = makeDesk({ transport: () => dockerTransport() })
    const m = await pair(desk)
    const atlas = remoteAgent(desk, m.id, { workingDirectory: 'linux-g' })
    const mission = desk.core.missions.create({ title: 'Longue', description: '[slow:60000] [mark]', agentId: atlas.id, priority: 'normal', startNow: true })
    await waitFor(() => desk.core.missions.get(mission.id).status === 'running', 15_000)
    desk.remote.disconnect(m.id)
    execFileSync('docker', ['restart', '-t', '0', C!]) // abrupt: SIGKILL, like a crash
    await waitFor(() => {
      try {
        return /prêt/.test(sh('orbit-runtime', 'health', '--home', HOME))
      } catch {
        return false
      }
    }, 30_000)
    await desk.remote.connect(m.id)
    await waitFor(() => ['failed', 'cancelled'].includes(desk.core.missions.get(mission.id).status), 15_000)
    expect(desk.core.missions.get(mission.id).error).toMatch(/redémarré/)
    await new Promise((r) => setTimeout(r, 1000))
    expect(sh('cat', `${HOME}/projects/linux-g/runs.log`).trim().split('\n')).toHaveLength(1)
  }, 90_000)

  it('Durcissement du conteneur : non-root, aucune capacité, système en lecture seule, pas de socket Docker', () => {
    expect(sh('id', '-u').trim()).toBe('10001')
    expect(sh('sh', '-c', 'grep CapEff /proc/self/status').trim()).toMatch(/0000000000000000$/)
    expect(() => sh('sh', '-c', 'echo x > /opt/orbit/pirate')).toThrow()
    expect(() => sh('sh', '-c', 'echo x > /etc/pirate')).toThrow()
    expect(() => sh('cat', '/etc/shadow')).toThrow()
    expect(sh('sh', '-c', 'test -e /var/run/docker.sock && echo present || echo absent').trim()).toBe('absent')
  })
})

describe.skipIf(!SSH_PORT || !SSH_KEY)('Linux réel (conteneur) — transport SSH réel', () => {
  it('clé d’hôte lue puis épinglée, clé limitée à attach, mission de bout en bout par SSH', async () => {
    const desk = makeDesk()
    const m0 = desk.remote.register({ name: 'SSH (conteneur)', transport: 'ssh', host: '127.0.0.1', user: 'orbit', port: Number(SSH_PORT), runtimeHome: HOME, identityFile: SSH_KEY })
    await expect(desk.remote.connect(m0.id)).rejects.toThrow('Clé d’hôte non confirmée')
    const fp = await desk.remote.scanHostKey(m0.id)
    expect(fp.fingerprint).toMatch(/^SHA256:/)
    desk.remote.confirmHostKey(m0.id, fp.fingerprint)
    await desk.remote.connect(m0.id).catch(() => undefined)
    await desk.remote.confirmRuntimeIdentity(m0.id, desk.remote.get(m0.id).pendingRuntimeKey!.fingerprint)
    const m = desk.remote.get(m0.id)
    expect(m.status).toBe('online')
    const atlas = remoteAgent(desk, m.id, { workingDirectory: 'linux-ssh' })
    const mission = desk.core.missions.create({ title: 'Par SSH', description: 'via ssh', agentId: atlas.id, priority: 'normal', startNow: true })
    await settled(desk, mission.id, 20_000)
    expect(desk.core.missions.get(mission.id).status).toBe('done')
    // The key can't open a shell: whatever is asked, the forced command runs `attach`.
    const out = execFileSync('/usr/bin/ssh', ['-o', 'BatchMode=yes', '-o', `UserKnownHostsFile=${desk.dataDir}/ssh/known_hosts`, '-o', 'StrictHostKeyChecking=yes', '-i', SSH_KEY!, '-o', 'IdentitiesOnly=yes', '-p', SSH_PORT!, 'orbit@127.0.0.1', 'id; cat /etc/passwd'], { encoding: 'utf8', input: '', timeout: 15_000 })
    expect(out).not.toContain('uid=')
    expect(out).not.toContain('root:')
  }, 60_000)
})
