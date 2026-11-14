import type { ProviderId } from '@shared/types'
import { describeClaudeTool } from './claude-agent'
import { evaluateTool, type PolicyVerdict } from './policy'
import type { EngineIO, RunPolicy, ToolStart } from './types'

export type GateOutcome = { decision: 'allow' | 'deny'; reason: string } | { decision: 'defer'; reason: string }

/**
 * Orbit's single gate for Claude engines (Agent SDK and Claude Code CLI).
 *
 * Claude can consult the host twice for one tool call: the PreToolUse hook (always) and the
 * permission prompt (`canUseTool` / `can_use_tool`, only if the hook left the decision open).
 * The answer is computed once per tool_use id and reused, so the user is never asked twice.
 *
 * `defer` (hook only): an automated companion's unclassifiable command is left to Claude's
 * native `auto` mode classifier - verified active from the session's init message. If the
 * classifier cannot decide, the call comes back through the permission prompt and Orbit
 * asks the human; it never turns a sensitive action into an engine decision.
 */
export function createClaudeGate(o: {
  policy: RunPolicy
  io: EngineIO
  engine: Extract<ProviderId, 'claude-agent' | 'claude-code'>
  startTool: (id: string, name: string, input: unknown) => ToolStart
  /** True once the session reported `permissionMode: 'auto'`. */
  autoModeActive: () => boolean
}) {
  const decided = new Map<string, Promise<GateOutcome>>()
  const deferred = new Map<string, { tool: ToolStart; verdict: PolicyVerdict }>()

  const human = async (id: string, name: string, input: Record<string, unknown>, verdict: PolicyVerdict, engineReason?: string): Promise<GateOutcome> => {
    const { action } = describeClaudeTool(name, input, o.policy.workspace)
    const tool = o.startTool(id, name, input)
    const str = (v: unknown) => (typeof v === 'string' ? v : '')
    const approved = await o.io.requestApproval({
      externalId: id,
      tool,
      summary: tool.title,
      payload: {
        tool: name,
        kind: action.kind,
        command: action.command,
        paths: action.paths.filter(Boolean),
        diff: name === 'Edit' ? `- ${str(input.old_string)}\n+ ${str(input.new_string)}` : name === 'Write' ? str(input.content).slice(0, 4000) : undefined,
        reason: engineReason ? `${verdict.reason} · Claude : ${engineReason}` : verdict.reason,
        cwd: o.policy.workspace,
        engine: o.engine,
        category: verdict.category,
        rule: verdict.rule,
        grant: verdict.grant,
      },
    })
    if (!approved) {
      o.io.emit({ type: 'tool.completed', tool: { externalId: id, status: 'denied', output: 'Refusé par l’utilisateur.' } })
      return { decision: 'deny', reason: 'L’utilisateur a refusé cette action dans Orbit. Ne la retente pas ; propose une alternative ou termine.' }
    }
    return { decision: 'allow', reason: 'Approuvé dans Orbit.' }
  }

  const decide = async (id: string, name: string, input: Record<string, unknown>, mayDefer: boolean, engineReason?: string): Promise<GateOutcome> => {
    const { action } = describeClaudeTool(name, input, o.policy.workspace)
    const verdict = evaluateTool(o.policy, action)
    const tool = o.startTool(id, name, input)
    if (verdict.decision === 'deny') {
      o.io.emit({ type: 'tool.completed', tool: { externalId: id, status: 'denied', output: verdict.reason } })
      return { decision: 'deny', reason: `Refusé par Orbit : ${verdict.reason}` }
    }
    if (verdict.engineMayDecide && o.autoModeActive()) {
      if (mayDefer) {
        deferred.set(id, { tool, verdict })
        return { decision: 'defer', reason: verdict.reason }
      }
      // The classifier could not decide and the engine asks the host: a human answers.
      return human(id, name, input, { ...verdict, decision: 'ask' }, engineReason)
    }
    if (verdict.decision === 'allow') {
      if (verdict.routine) o.io.autoAllowed?.({ tool, via: 'policy', rule: verdict.rule, category: verdict.category, reason: verdict.reason })
      return { decision: 'allow', reason: verdict.reason }
    }
    return human(id, name, input, verdict, engineReason)
  }

  return {
    /** PreToolUse hook: may return `defer` (automated + auto mode only). */
    preToolUse(id: string, name: string, input: Record<string, unknown>): Promise<GateOutcome> {
      const known = decided.get(id)
      if (known) return known
      const p = decide(id, name, input, true)
      decided.set(id, p)
      return p
    },
    /** Permission prompt (canUseTool / can_use_tool): never defers, reuses a hook decision. */
    async permission(id: string, name: string, input: Record<string, unknown>, engineReason?: string): Promise<{ allow: boolean; reason: string }> {
      const known = decided.get(id)
      if (known) {
        const r = await known
        if (r.decision !== 'defer') return { allow: r.decision === 'allow', reason: r.reason }
        // Deferred to the classifier, which handed it back: now a human decides.
        deferred.delete(id)
        const p = decide(id, name, input, false, engineReason)
        decided.set(id, p)
        const r2 = await p
        return { allow: r2.decision === 'allow', reason: r2.reason }
      }
      const p = decide(id, name, input, false, engineReason)
      decided.set(id, p)
      const r = await p
      return { allow: r.decision === 'allow', reason: r.reason }
    },
    /** A tool result arrived: a deferred call that ran was allowed by the engine's classifier. */
    settled(id: string, ran: boolean): void {
      const d = deferred.get(id)
      if (!d) return
      deferred.delete(id)
      if (ran) o.io.autoAllowed?.({ tool: d.tool, via: 'engine', rule: d.verdict.rule, category: d.verdict.category, reason: 'Autorisé par le mode auto de Claude (classifieur du moteur), dans les limites d’Orbit.' })
    },
  }
}

export type ClaudeGate = ReturnType<typeof createClaudeGate>
