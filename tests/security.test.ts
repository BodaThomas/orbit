import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PERMISSIONS } from '@shared/catalog'
import { effectivePermissions } from '@shared/permissions-matrix'
import type { AgentPermissions } from '@shared/types'
import { allowedClaudeTools } from '../src/main/core/engine/claude-agent'
import { codexSandbox } from '../src/main/core/engine/codex'
import { evaluateTool } from '../src/main/core/engine/policy'
import { liveEngineProcessCount, spawnLineProcess } from '../src/main/core/engine/process'
import type { RunPolicy } from '../src/main/core/engine/types'
import { buildProfile, confine, seatbeltAvailable, selfTest } from '../src/main/core/security/seatbelt'
import { commandTouchesSensitive, isSensitivePath, redactSecrets } from '../src/main/core/security/sensitive'

const ALL: AgentPermissions = { readFiles: true, writeFiles: true, runCommands: true, network: true, manageProjects: false, externalActions: false }

/** Throw-away world: a fake home with fake secrets, a workspace inside it. Never real files. */
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-sec-')))
  const home = join(root, 'home')
  const ws = join(home, 'projet')
  mkdirSync(join(home, '.ssh'), { recursive: true })
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'FAKE\n')
  writeFileSync(join(home, 'notes.txt'), 'FAKE-SECRET\n')
  writeFileSync(join(ws, 'app.ts'), 'export {}\n')
  writeFileSync(join(ws, '.env'), 'API_TOKEN=fake\n')
  writeFileSync(join(ws, '.env.example'), 'API_TOKEN=\n')
  symlinkSync(join(home, 'notes.txt'), join(ws, 'raccourci.txt'))
  return { root, home, ws }
}
const pol = (ws: string, permissions = ALL, autonomy: RunPolicy['autonomy'] = 'supervised'): RunPolicy => ({ workspace: ws, permissions, autonomy, isolation: 'standard' })

describe('niveau 1 — politique d’Orbit', () => {
  const { home, ws } = world()

  it('lecture autorisée dans le dossier', () => {
    expect(evaluateTool(pol(ws), { kind: 'read', name: 'Read', paths: [join(ws, 'app.ts')] }).decision).toBe('allow')
  })
  it('écriture : demande d’accord (supervisé), refus sans permission', () => {
    expect(evaluateTool(pol(ws), { kind: 'edit', name: 'Write', paths: [join(ws, 'app.ts')] }).decision).toBe('ask')
    expect(evaluateTool(pol(ws, { ...ALL, writeFiles: false }), { kind: 'edit', name: 'Write', paths: [join(ws, 'app.ts')] }).decision).toBe('deny')
  })
  it('accès hors du dossier refusé, y compris par ../', () => {
    expect(evaluateTool(pol(ws), { kind: 'read', name: 'Read', paths: [join(home, 'notes.txt')] }).decision).toBe('deny')
    expect(evaluateTool(pol(ws), { kind: 'read', name: 'Read', paths: ['../notes.txt'] }).decision).toBe('deny')
  })
  it('lien symbolique vers l’extérieur refusé', () => {
    const v = evaluateTool(pol(ws), { kind: 'read', name: 'Read', paths: [join(ws, 'raccourci.txt')] })
    expect(v.decision).toBe('deny')
  })
  it('.env demande toujours un accord, même en automatique ; .env.example reste lisible', () => {
    expect(evaluateTool(pol(ws, ALL, 'automated'), { kind: 'read', name: 'Read', paths: [join(ws, '.env')] }).decision).toBe('ask')
    expect(evaluateTool(pol(ws, ALL, 'automated'), { kind: 'read', name: 'Read', paths: [join(ws, '.env.example')] }).decision).toBe('allow')
  })
  it('commandes touchant des secrets ou des chemins extérieurs : accord humain', () => {
    expect(evaluateTool(pol(ws, ALL, 'automated'), { kind: 'command', name: 'Bash', paths: [], command: 'cat ~/.ssh/id_ed25519' }).decision).toBe('ask')
    expect(evaluateTool(pol(ws, ALL, 'automated'), { kind: 'command', name: 'Bash', paths: [], command: 'cat /Users/quelquun/notes.txt' }).decision).toBe('ask')
    expect(evaluateTool(pol(ws, ALL, 'automated'), { kind: 'command', name: 'Bash', paths: [], command: 'printenv' }).decision).toBe('ask')
    expect(evaluateTool(pol(ws, ALL, 'automated'), { kind: 'command', name: 'Bash', paths: [], command: 'npm test && /usr/bin/env node -v' }).decision).toBe('allow')
  })
  it('sous-processus destructeur : accord humain même en automatique', () => {
    expect(evaluateTool(pol(ws, ALL, 'automated'), { kind: 'command', name: 'Bash', paths: [], command: 'sh -c "rm -rf build"' }).decision).toBe('ask')
  })
  it('réseau refusé sans permission', () => {
    expect(evaluateTool(pol(ws, { ...ALL, network: false }), { kind: 'web', name: 'WebFetch', paths: [] }).decision).toBe('deny')
  })
  it('détection des chemins sensibles', () => {
    expect(isSensitivePath('/x/.aws/credentials')).toBe(true)
    expect(isSensitivePath('/x/server.pem')).toBe(true)
    expect(isSensitivePath('/x/src/env.ts')).toBe(false)
    expect(commandTouchesSensitive('security find-generic-password -s x')).toBeTruthy()
  })
  it('les secrets sont masqués avant un transfert de contexte', () => {
    const r = redactSecrets('clé sk-ant-api03-abcdefghijklmnopqrstuvwxyz et\nDB_PASSWORD=hunter2\nnormal=ok')
    expect(r.text).not.toContain('abcdefghijkl')
    expect(r.text).not.toContain('hunter2')
    expect(r.text).toContain('normal=ok')
    expect(r.redactions).toBe(2)
  })
})

describe('niveau 2 — bac à sable des moteurs', () => {
  it('Codex : lecture seule en supervisé, réseau coupé sans permission, « untrusted » sans commandes', () => {
    const s = codexSandbox(pol('/tmp/ws', { ...ALL, network: false }))
    expect(s.sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false })
    expect(codexSandbox(pol('/tmp/ws', { ...ALL, runCommands: false })).approvalPolicy).toBe('untrusted')
    expect(codexSandbox(pol('/tmp/ws', ALL, 'automated')).sandboxPolicy).toMatchObject({ type: 'workspaceWrite', writableRoots: ['/tmp/ws'] })
  })
  it('Claude : seuls les outils permis existent', () => {
    expect(allowedClaudeTools(pol('/tmp', { ...ALL, network: false, runCommands: false }))).not.toContain('Bash')
    expect(allowedClaudeTools(pol('/tmp', { ...ALL, network: false }))).not.toContain('WebFetch')
  })
  it('matrice : une permission refusée n’est jamais présentée comme bloquante si une action équivalente passe', () => {
    const codexNoCmd = effectivePermissions({ providerId: 'codex', autonomy: 'supervised', isolation: 'standard', permissions: { ...DEFAULT_PERMISSIONS, readFiles: true, runCommands: false } }, { isolationProven: false })
    expect(codexNoCmd.find((r) => r.key === 'commands')!.effective).toBe('partial')
    const outside = effectivePermissions({ providerId: 'codex', autonomy: 'supervised', isolation: 'standard', permissions: ALL }, { isolationProven: false }).find((r) => r.key === 'outside')!
    expect(outside.effective).toBe('partial')
    const strict = effectivePermissions({ providerId: 'codex', autonomy: 'supervised', isolation: 'strict', permissions: ALL }, { isolationProven: true }).find((r) => r.key === 'outside')!
    expect(strict.effective).toBe('denied')
    // Strict requested but not proven: never shown as denied.
    expect(effectivePermissions({ providerId: 'codex', autonomy: 'supervised', isolation: 'strict', permissions: ALL }, { isolationProven: false }).find((r) => r.key === 'outside')!.effective).toBe('partial')
  })
})

describe.runIf(seatbeltAvailable())('niveau 3 — confinement Seatbelt (réel, fichiers factices)', () => {
  it('auto-test complet', () => {
    const proof = selfTest()
    expect(proof.error).toBeNull()
    for (const c of proof.checks) expect(c, c.label).toMatchObject({ ok: true })
    expect(proof.ok).toBe(true)
  })
  it('un processus confiné ne lit ni la clé SSH factice ni le lien, et ne sort pas en écriture', () => {
    const { home, ws } = world()
    const spec = { workspace: ws, readable: [], writable: [], workspaceWritable: true, home }
    const run = (cmd: string) => {
      const c = confine('/bin/sh', ['-c', cmd], spec)
      return spawnSync(c.command, c.args, { cwd: ws, encoding: 'utf8' })
    }
    expect(run('cat app.ts').status).toBe(0)
    expect(run(`cat ${join(home, '.ssh', 'id_ed25519')}`).status).not.toBe(0)
    expect(run('cat raccourci.txt').status).not.toBe(0)
    expect(run(`echo x > ${join(home, 'x.txt')}`).status).not.toBe(0)
    expect(buildProfile(spec)).toContain('(deny file-read* file-write*')
  })
})

describe('processus des moteurs', () => {
  it('l’arrêt d’une exécution ne laisse aucun sous-processus orphelin', async () => {
    const marker = `orbit-orphan-${Date.now()}`
    const p = spawnLineProcess({ command: '/bin/sh', args: ['-c', `sleep 30 & sleep 31 & echo ready; wait # ${marker}`], cwd: tmpdir(), env: { PATH: process.env.PATH }, label: 'test' })
    await new Promise<void>((r) => p.onLine(() => r()))
    const exited = new Promise<void>((r) => p.onExit(() => r()))
    p.kill()
    await exited
    await new Promise((r) => setTimeout(r, 150))
    const ps = execFileSync('ps', ['-axo', 'pgid,command'], { encoding: 'utf8' })
    expect(ps.split('\n').filter((l) => l.includes(`${p.pid}`) && l.includes('sleep 3'))).toEqual([])
    expect(liveEngineProcessCount()).toBe(0)
  })
})
