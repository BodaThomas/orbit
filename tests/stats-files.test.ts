import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { companionState, leaders, missionCounts, rankAgents, stateContext, teamCounts } from '@shared/stats'
import type { Agent, ApprovalRequest, Mission } from '@shared/types'
import { unifiedDiff } from '../src/main/core/files/diff'
import { takeSnapshot } from '../src/main/core/files/snapshot'
import { listMigrations, runMigrations } from '../src/main/infra/db/client'
import { makeCore, novaInput } from './helpers'

const agent = (id: string, status: Agent['status'] = 'available', enabled = true) => ({ id, status, enabled })
const mission = (agentId: string, status: Mission['status']) => ({ agentId, status })
const approval = (agentId: string): Pick<ApprovalRequest, 'agentId' | 'status'> => ({ agentId, status: 'pending' })

describe('statistiques — règles métier uniques', () => {
  it('« Occupés » distingue en mission et en attente d’approbation', () => {
    const agents = [agent('nova', 'working'), agent('milo', 'working'), agent('atlas', 'awaiting_approval'), agent('echo')]
    const missions = [mission('nova', 'running'), mission('milo', 'running'), mission('atlas', 'approval_required')]
    const c = teamCounts(agents, missions, [approval('atlas')])
    expect(c).toMatchObject({ total: 4, inMission: 2, awaitingApproval: 1, busy: 3, available: 1 })
  })
  it('l’état est dérivé des missions, pas d’un statut périmé', () => {
    const ctx = stateContext([mission('nova', 'done')], [])
    expect(companionState(agent('nova', 'done'), ctx)).toBe('available')
    expect(companionState(agent('nova', 'awaiting_approval'), ctx)).toBe('available')
    expect(companionState(agent('nova', 'error'), ctx)).toBe('error')
    expect(companionState(agent('nova', 'available', false), ctx)).toBe('offline')
    // Pending approval wins over running.
    expect(companionState(agent('nova'), stateContext([mission('nova', 'running')], [approval('nova')]))).toBe('awaiting_approval')
  })
  it('les missions annulées sont exclues du taux de réussite', () => {
    const c = missionCounts([{ status: 'done' }, { status: 'done' }, { status: 'failed' }, { status: 'cancelled' }, { status: 'running' }])
    expect(c).toMatchObject({ total: 5, done: 2, failed: 1, cancelled: 1, active: 1 })
    expect(c.successRate).toBeCloseTo(2 / 3)
    expect(missionCounts([{ status: 'cancelled' }]).successRate).toBeNull()
  })
  it('classement : le plus sollicité est celui qui a le plus de requêtes, ex æquo inclus', () => {
    const rows = [
      { agentId: 'nova', requests: 23, knownCost: 5, tokens: 1 },
      { agentId: 'milo', requests: 24, knownCost: 1, tokens: 1 },
      { agentId: 'atlas', requests: 24, knownCost: 1, tokens: 1 },
    ]
    expect(leaders(rows, 'requests').map((r) => r.agentId)).toEqual(['atlas', 'milo'])
    expect(rankAgents(rows, 'cost')[0]!.agentId).toBe('nova')
  })
  it('cohérence : Analytics (usage.summary) et l’écran Missions comptent pareil', () => {
    const core = makeCore()
    const a = core.agents.create(novaInput())
    const ids = ['done', 'done', 'failed', 'cancelled', 'todo'].map((status) => {
      const m = core.missions.create({ title: status, description: '', agentId: a.id, priority: 'normal', startNow: false })
      core.handle.sqlite.prepare('UPDATE missions SET status = ? WHERE id = ?').run(status, m.id)
      return m.id
    })
    expect(ids).toHaveLength(5)
    const s = core.usage.summary()
    expect(s.missionCounts).toEqual(missionCounts(core.missions.list()))
    expect(s.missionsCancelled).toBe(1)
    for (let i = 0; i < 3; i++) core.usage.record({ agentId: a.id, providerId: 'codex', model: 'gpt', inputTokens: 100, outputTokens: 50, source: 'mission', cost: { costUsd: null, costKind: 'subscription', pricingVersion: null }, equivalentUsd: 0.01 })
    const s2 = core.usage.summary()
    expect(s2.subscriptionMonth).toMatchObject({ requests: 3, tokens: 450 })
    expect(s2.subscriptionMonth.equivalentUsd).toBeCloseTo(0.03)
    // The equivalent is never added to spend.
    expect(s2.month.official + s2.month.estimated).toBe(0)
    expect(s2.byAgentMonth[0]).toMatchObject({ agentId: a.id, requests: 3, tokens: 450 })
  })
})

function gitRepo() {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-git-')))
  const g = (...args: string[]) => execFileSync('git', args, { cwd: ws, encoding: 'utf8' })
  g('init', '-q')
  g('config', 'user.email', 'test@example.invalid')
  g('config', 'user.name', 'Test')
  writeFileSync(join(ws, 'a.txt'), 'un\ndeux\n')
  writeFileSync(join(ws, 'b.txt'), 'b\n')
  writeFileSync(join(ws, '.gitignore'), 'secret.log\n')
  g('add', '-A')
  g('commit', '-qm', 'init')
  return { ws, g }
}

describe('fichiers modifiés — instantanés', () => {
  it('Git : détecte les modifications faites par le shell, sans toucher à l’index ni au stash', async () => {
    const { ws, g } = gitRepo()
    writeFileSync(join(ws, 'a.txt'), 'un\ndeux\ntrois\n') // pre-existing, uncommitted change
    const statusBefore = g('status', '--porcelain')
    const snap = await takeSnapshot(ws)
    expect(snap!.method).toBe('git')
    // « Agent » work via the shell:
    writeFileSync(join(ws, 'nouveau.txt'), 'créé\n')
    writeFileSync(join(ws, 'b.txt'), 'b modifié\n')
    writeFileSync(join(ws, 'secret.log'), 'ignored\n')
    const res = await snap!.diff()
    const byPath = Object.fromEntries(res.changes.map((c) => [c.path.replace(`${ws}/`, ''), c]))
    expect(Object.keys(byPath).sort()).toEqual(['b.txt', 'nouveau.txt'])
    expect(byPath['nouveau.txt']!.kind).toBe('add')
    expect(byPath['b.txt']!.diff).toContain('+b modifié')
    // Pre-existing change to a.txt is not attributed to the agent.
    expect(byPath['a.txt']).toBeUndefined()
    // Ignored file → the inventory says it is not exhaustive.
    expect(res.complete).toBe(false)
    expect(res.notes.join(' ')).toContain('.gitignore')
    // User state untouched (only the agent's own files are new).
    unlinkSync(join(ws, 'nouveau.txt'))
    writeFileSync(join(ws, 'b.txt'), 'b\n')
    expect(g('status', '--porcelain')).toBe(statusBefore)
    expect(g('stash', 'list')).toBe('')
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('un\ndeux\ntrois\n')
  })
  it('hors Git : empreintes avant/après, suppression comprise', async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-scan-')))
    writeFileSync(join(ws, 'x.txt'), 'x\n')
    writeFileSync(join(ws, 'y.txt'), 'y\n')
    const snap = await takeSnapshot(ws)
    expect(snap!.method).toBe('scan')
    writeFileSync(join(ws, 'x.txt'), 'x2\n')
    rmSync(join(ws, 'y.txt'))
    writeFileSync(join(ws, 'z.txt'), 'z\n')
    const res = await snap!.diff()
    expect(res.changes.map((c) => `${c.kind}:${c.path.replace(`${ws}/`, '')}`).sort()).toEqual(['add:z.txt', 'delete:y.txt', 'update:x.txt'])
    expect(res.complete).toBe(true)
    expect(res.changes.find((c) => c.kind === 'update')!.diff).toContain('-x\n+x2')
  })
  it('diff unifié minimal', () => {
    expect(unifiedDiff('f', 'a\nb\nc', 'a\nB\nc')).toContain('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c')
  })
})

describe('migrations', () => {
  it('appliquent les nouvelles tables sur une base existante sans perte de données', () => {
    const sqlite = new Database(':memory:')
    sqlite.exec('CREATE TABLE __orbit_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)')
    // Simulate a phase-2 database: only the first two migrations applied, with data.
    for (const m of listMigrations().slice(0, 2)) {
      for (const stmt of m.sql.split('--> statement-breakpoint').map((x) => x.trim()).filter(Boolean)) sqlite.exec(stmt)
      sqlite.prepare('INSERT INTO __orbit_migrations VALUES (?, ?)').run(m.name, 'x')
    }
    sqlite.prepare(`INSERT INTO agents (id, name, provider_id, model, permissions) VALUES ('a1', 'Nova', 'anthropic', 'm', '{}')`).run()
    sqlite.prepare(`INSERT INTO usage_records (id, provider_id, model, cost_kind, source) VALUES ('u1', 'anthropic', 'm', 'estimated', 'mission')`).run()
    const ran = runMigrations(sqlite)
    expect(ran.length).toBe(listMigrations().length - 2)
    expect(sqlite.prepare('SELECT name, isolation FROM agents').get()).toEqual({ name: 'Nova', isolation: 'standard' })
    expect(sqlite.prepare('SELECT count(*) AS n FROM usage_records').get()).toEqual({ n: 1 })
    // Idempotent.
    expect(runMigrations(sqlite)).toEqual([])
  })
})
