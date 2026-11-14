import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEngine } from '../main/core/engine/types'

/**
 * Test-only engine: deterministic, no model, no network. Enabled only with
 * ORBIT_RUNTIME_TEST_ENGINE=1 and always labelled « Echo (test) » - never presented as a
 * real engine. Markers in the prompt drive it:
 *   [approve]   asks to write resultat.txt (approval), writes it only if approved
 *   [slow:MS]   works for MS milliseconds (cancellable)
 *   [fail]      fails
 *   [mark]      appends one line to runs.log in its project (counts real executions)
 */
export function echoEngine(): AgentEngine {
  return {
    id: 'codex',
    name: 'Echo (test)',
    capabilities: { resume: true, approvals: true, interrupt: true, fileDiffs: false, budgetCap: false, usage: 'none', confinable: false, effort: false },
    checkReady: async () => ({ ready: true, detail: 'Moteur de test : répète la demande, sans modèle (version 0.0.0).', auth: 'none' }),
    run: async (req, io) => {
      const sessionId = req.sessionId ?? `echo-${req.runId}`
      io.emit({ type: 'session', sessionId, model: 'echo' })
      if (req.prompt.includes('[mark]')) writeFileSync(join(req.policy.workspace, 'runs.log'), `${req.runId}\n`, { flag: 'a' })
      if (req.prompt.includes('[approve]')) {
        const tool = { externalId: 't1', name: 'Write', kind: 'edit' as const, title: 'Écrit resultat.txt', input: { file_path: 'resultat.txt' }, files: ['resultat.txt'] }
        io.emit({ type: 'tool.started', tool })
        const ok = await io.requestApproval({ externalId: 't1', tool, summary: 'Écrire resultat.txt', payload: { tool: 'Write', kind: 'edit', paths: ['resultat.txt'] } as never })
        io.emit({ type: 'tool.completed', tool: { externalId: 't1', status: ok ? 'completed' : 'denied' } })
        if (ok) {
          writeFileSync(join(req.policy.workspace, 'resultat.txt'), 'écrit par echo\n')
          io.emit({ type: 'file.changed', change: { path: 'resultat.txt', kind: 'created', diff: null } as never })
        }
      }
      const slow = /\[slow:(\d+)\]/.exec(req.prompt)
      if (slow) {
        await new Promise<void>((r) => {
          const t = setTimeout(r, Number(slow[1]))
          req.signal.addEventListener('abort', () => (clearTimeout(t), r()))
        })
      }
      if (req.signal.aborted) return { status: 'cancelled', finalText: '', error: null, sessionId }
      if (req.prompt.includes('[fail]')) return { status: 'failed', finalText: '', error: Object.assign(new Error('Échec simulé.'), { kind: 'unknown' }) as never, sessionId }
      const text = `echo: ${req.prompt.split('\n').pop()}`
      io.emit({ type: 'message', text })
      return { status: 'completed', finalText: text, error: null, sessionId }
    },
  }
}
