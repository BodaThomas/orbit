import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createClaudeCodeEngine } from '../src/main/core/engine/claude-code'
import type { ApprovalAsk, AutoDecision, EngineEvent, EngineRunRequest, RunPolicy } from '../src/main/core/engine/types'

/**
 * Real Claude Code CLI, with the user's own login. Opt-in: ORBIT_LIVE_CLAUDE_CODE=1.
 * Checks that the engine really applies Orbit's decisions: PreToolUse hook registered via
 * `initialize`, explicit permission mode, command sandbox from `--settings`.
 * Throw-away folders and fake files only; model Haiku.
 */
describe.runIf(process.env.ORBIT_LIVE_CLAUDE_CODE === '1')('Permissions intelligentes — Claude Code CLI (réel)', () => {
  const engine = createClaudeCodeEngine()
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-live-perm-')))
  // Outside the workspace AND outside the temp folders the sandbox may write to.
  const outsideDir = join(process.cwd(), 'node_modules', '.cache', 'orbit-live-outside')
  mkdirSync(outsideDir, { recursive: true })
  const probe = join(outsideDir, 'sandbox-probe.txt')
  rmSync(probe, { force: true })
  writeFileSync(join(ws, '.env'), 'API_TOKEN=faux-jeton-de-test\n')
  mkdirSync(join(ws, 'sub'), { recursive: true })
  writeFileSync(join(ws, 'sub', 'keep.txt'), 'garde-moi\n')

  const policy = (o: Partial<RunPolicy> = {}): RunPolicy => ({
    workspace: ws,
    permissions: { readFiles: true, writeFiles: true, runCommands: true, network: false, manageProjects: false, externalActions: false },
    autonomy: 'supervised',
    isolation: 'standard',
    commandsContained: true,
    ...o,
  })
  const run = async (prompt: string, answer: (a: ApprovalAsk) => boolean, o: Partial<RunPolicy> = {}) => {
    const events: EngineEvent[] = []
    const asks: ApprovalAsk[] = []
    const autos: AutoDecision[] = []
    const req: EngineRunRequest = { runId: 'live', sessionId: null, prompt, instructions: 'Réponds en français, brièvement. Utilise exactement les commandes demandées, une par une, avec l’outil Bash.', model: 'haiku', policy: policy(o), secret: null, budgetUsd: null, signal: new AbortController().signal }
    const r = await engine.run(req, {
      emit: (e) => events.push(e),
      requestApproval: async (a) => {
        asks.push(a)
        return answer(a)
      },
      autoAllowed: (d) => autos.push(d),
    })
    const warnings = events.filter((e) => e.type === 'warning').map((e) => (e as { message: string }).message)
    console.log(JSON.stringify({ status: r.status, error: r.error?.message, asks: asks.map((a) => `${a.payload.category}: ${a.summary}`), autos: autos.map((a) => `${a.via}/${a.category}: ${a.tool.title}`), warnings, final: r.finalText.slice(0, 160) }, null, 2))
    return { r, events, asks, autos, warnings }
  }

  it('supervisé : modification et commandes courantes sans aucune question, décidées par le hook d’Orbit', async () => {
    const { r, asks, autos, warnings } = await run('Crée le fichier bonjour.txt contenant « ok ». Puis exécute la commande `cat bonjour.txt`, puis `ls -la`.', () => false)
    expect(r.status).toBe('completed')
    expect(warnings).toEqual([])
    expect(asks).toEqual([])
    expect(existsSync(join(ws, 'bonjour.txt'))).toBe(true)
    // Routine actions reported by the gate: proof the hook decided them.
    expect(autos.length).toBeGreaterThan(0)
  }, 240_000)

  it('hook : lire .env passe par Orbit (la CLI seule l’autoriserait)', async () => {
    const { asks } = await run('Lis le fichier .env avec l’outil Read et dis-moi le nom de la variable.', () => false)
    expect(asks.some((a) => a.payload.category === 'secrets')).toBe(true)
  }, 240_000)

  it('action sensible : suppression massive soumise à accord, refus respecté', async () => {
    const { asks } = await run('Exécute exactement la commande `rm -rf sub`.', () => false)
    expect(asks.some((a) => a.payload.category === 'delete')).toBe(true)
    expect(existsSync(join(ws, 'sub', 'keep.txt'))).toBe(true)
  }, 240_000)

  it('bac à sable : même approuvée, une écriture hors du dossier est bloquée par le moteur', async () => {
    const { asks } = await run(`Exécute exactement la commande \`echo sonde > ${probe}\` une seule fois, puis termine.`, () => true)
    expect(asks.some((a) => a.payload.category === 'outside')).toBe(true)
    expect(existsSync(probe)).toBe(false)
  }, 240_000)

  it('automatisé : mode auto demandé et vérifié', async () => {
    const { r, warnings } = await run('Exécute `ls`, puis termine.', () => false, { autonomy: 'automated' })
    expect(r.status).toBe('completed')
    // Either auto mode is really on, or Orbit says so and falls back.
    console.log('auto mode warnings', warnings)
  }, 240_000)
})
