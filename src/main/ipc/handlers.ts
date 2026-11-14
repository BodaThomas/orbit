import type { IpcChannel, IpcInput, IpcOutputs } from '@shared/ipc'
import type { Bootstrap, SecurityStatus } from '@shared/types'
import { seatbeltAvailable } from '../core/security/seatbelt'
import { scanClaudeLocalUsage } from '../core/claude-local-usage'
import { describeRecurrence, nextOccurrences, validateRecurrence } from '@shared/schedule'
import { claudeCodeProjectsDir } from '../core/engine/claude-code'
import { listWorkflows } from '../core/machines'
import type { OrbitRuntime } from '../core/runtime'
import { OrbitError } from '../core/util'

export interface HostApi {
  runtime(): OrbitRuntime
  bootstrap(): Bootstrap
  setMode(mode: 'real' | 'demo'): Promise<Bootstrap>
  openExternal(url: string): Promise<void>
  chooseDirectory(): Promise<string | null>
  /** Reads (no argument) or sets « open Orbit at login », always on an explicit user action. */
  launchAtLogin(enabled?: boolean): { enabled: boolean; supported: boolean }
}

type Handlers = {
  [C in IpcChannel]: (input: IpcInput<C>, host: HostApi) => IpcOutputs[C] | Promise<IpcOutputs[C]>
}

/** One handler per channel. Inputs are already validated by the router. */
export const handlers: Handlers = {
  'app.bootstrap': (_i, h) => h.bootstrap(),
  'app.setMode': (i, h) => h.setMode(i.mode),
  'app.openStatusPage': async (i, h) => {
    const page = h.runtime().providers.adapter(i.providerId).statusPage?.page
    if (!page) throw new OrbitError('not_found', 'Aucune page de statut pour ce fournisseur.')
    await h.openExternal(page)
  },
  'app.chooseDirectory': (_i, h) => h.chooseDirectory(),
  'settings.update': (i, h) => {
    const s = h.runtime().settings.update(i)
    h.runtime().bus.invalidate('settings', 'usage')
    return s
  },

  'agents.list': (_i, h) => h.runtime().agents.list(),
  'agents.create': (i, h) => h.runtime().agents.create(i),
  'agents.update': (i, h) => h.runtime().agents.update(i.id, i.patch),
  'agents.delete': (i, h) => h.runtime().agents.delete(i.id),
  'agents.duplicate': (i, h) => h.runtime().agents.duplicate(i.id),
  'agents.setEnabled': (i, h) => h.runtime().agents.setEnabled(i.id, i.enabled),

  'providers.list': (_i, h) => h.runtime().providers.list(),
  'providers.setKey': (i, h) => h.runtime().providers.setKey(i.providerId, i.apiKey),
  'providers.removeKey': (i, h) => h.runtime().providers.removeKey(i.providerId),
  'providers.validate': (i, h) => h.runtime().providers.validate(i.providerId),
  'providers.testEngine': (i, h) => h.runtime().providers.testEngine(i.providerId),
  'providers.health': (_i, h) => h.runtime().health.latest(),
  'providers.refreshHealth': (_i, h) => h.runtime().health.refresh(),

  'conversations.list': (i, h) => h.runtime().conversations.list(i.agentId),
  'conversations.create': (i, h) => h.runtime().conversations.create(i.agentId, i.title),
  'conversations.rename': (i, h) => h.runtime().conversations.rename(i.id, i.title),
  'conversations.delete': (i, h) => h.runtime().conversations.delete(i.id),
  'conversations.messages': (i, h) => h.runtime().conversations.messages(i.conversationId),
  'conversations.send': (i, h) => h.runtime().conversations.send(i.conversationId, i.content),
  'conversations.cancel': (i, h) => h.runtime().conversations.cancel(i.conversationId),
  'conversations.search': (i, h) => h.runtime().conversations.search(i.query),

  'missions.list': (i, h) => h.runtime().missions.list(i.agentId),
  'missions.get': (i, h) => h.runtime().missions.detail(i.id),
  'missions.create': (i, h) => h.runtime().missions.create(i),
  'missions.start': (i, h) => h.runtime().missions.start(i.id, 'user'),
  'missions.followUp': (i, h) => h.runtime().missions.followUp(i.id, i.prompt),
  'missions.cancel': (i, h) => h.runtime().missions.cancel(i.id),
  'missions.retry': (i, h) => h.runtime().missions.retry(i.id),
  'missions.duplicate': (i, h) => h.runtime().missions.duplicate(i.id),
  'missions.delete': (i, h) => h.runtime().missions.delete(i.id),

  'approvals.list': (i, h) => h.runtime().missions.approvals(i.status),
  'approvals.resolve': (i, h) => h.runtime().missions.resolveApproval(i.id, i.approve),

  'activity.list': (i, h) => h.runtime().journal.listActivity(i),
  'usage.summary': (_i, h) => h.runtime().usage.summary(),
  'usage.quotas': (_i, h) => h.runtime().usage.quotas(),
  'usage.localClaude': (_i, h) => localClaude(h.runtime()),
  'usage.setLocalClaude': (i, h) => {
    h.runtime().settings.setRaw('claudeLocalLogs', i.enabled)
    h.runtime().journal.audit({ actor: 'user', agentId: null, action: 'claudeLocalLogs', target: i.enabled ? 'on' : 'off', allowed: true, reason: 'Lecture seule des journaux locaux de Claude Code' })
    return localClaude(h.runtime())
  },
  'notifications.list': (_i, h) => h.runtime().journal.listNotifications(),
  'notifications.markRead': (i, h) => h.runtime().journal.markRead(i.id),

  'memory.list': (i, h) => h.runtime().memory.list(i.agentId),
  'memory.create': (i, h) => h.runtime().memory.create(i),
  'memory.update': (i, h) => h.runtime().memory.update(i.id, i),
  'memory.delete': (i, h) => h.runtime().memory.delete(i.id),

  'machines.list': (_i, h) => h.runtime().machines.list(),
  'workflows.list': (_i, h) => listWorkflows(h.runtime().handle.db),
  'audit.list': (i, h) => h.runtime().journal.listAudit(i.limit),

  'constellations.list': (_i, h) => h.runtime().constellations.list(),
  'constellations.create': (i, h) => h.runtime().constellations.create(i),
  'constellations.update': (i, h) => h.runtime().constellations.update(i.id, i.input),
  'constellations.delete': (i, h) => h.runtime().constellations.delete(i.id),
  'constellations.duplicate': (i, h) => h.runtime().constellations.duplicate(i.id, i.asTemplate),
  'constellations.launch': (i, h) => h.runtime().constellations.launch(i.id, i.goal, { origin: 'user' }),
  'constellations.runs': (i, h) => h.runtime().constellations.runs(i.constellationId),
  'constellations.run': (i, h) => h.runtime().constellations.detail(i.id),
  'constellations.cancel': (i, h) => h.runtime().constellations.cancel(i.id),
  'constellations.resume': (i, h) => h.runtime().constellations.resume(i.id),
  'constellations.workspaceDiff': (i, h) => h.runtime().constellations.workspaceDiff(i.id),
  'constellations.mergeWorkspace': (i, h) => h.runtime().constellations.mergeWorkspace(i.id),
  'constellations.discardWorkspace': (i, h) => h.runtime().constellations.discardWorkspace(i.id),

  'automations.list': (_i, h) => h.runtime().scheduler.list(),
  'automations.runs': (i, h) => h.runtime().scheduler.runs(i.automationId),
  'automations.create': (i, h) => h.runtime().scheduler.create(i),
  'automations.update': (i, h) => h.runtime().scheduler.update(i.id, i.input),
  'automations.delete': (i, h) => h.runtime().scheduler.delete(i.id),
  'automations.setStatus': (i, h) => h.runtime().scheduler.setStatus(i.id, i.status),
  'automations.runNow': (i, h) => h.runtime().scheduler.runNow(i.id),
  'automations.confirmRun': (i, h) => h.runtime().scheduler.confirmRun(i.id, i.approve),
  'automations.preview': (i) => {
    const error = validateRecurrence(i.recurrence, i.timezone)
    if (error) return { next: [], error, description: null }
    return { next: nextOccurrences(i.recurrence, i.timezone, Date.now(), i.count ?? 5).map((d) => d.toISOString()), error: null, description: describeRecurrence(i.recurrence) }
  },
  'app.launchAtLogin': (i, h) => h.launchAtLogin(i.enabled),

  'runtime.list': (_i, h) => h.runtime().remote.list(),
  'runtime.register': (i, h) => h.runtime().remote.register(i),
  'runtime.scanHostKey': (i, h) => h.runtime().remote.scanHostKey(i.id),
  'runtime.confirmHostKey': (i, h) => h.runtime().remote.confirmHostKey(i.id, i.fingerprint),
  'runtime.deployPlan': (i, h) => h.runtime().remote.deployPlan(i.id),
  'runtime.deploy': (i, h) => h.runtime().remote.deploy(i.id),
  'runtime.connect': (i, h) => h.runtime().remote.connect(i.id),
  'runtime.disconnect': (i, h) => h.runtime().remote.disconnect(i.id),
  'runtime.revoke': (i, h) => h.runtime().remote.revoke(i.id),

  'security.status': (_i, h) => securityStatus(h.runtime()),
  'security.selfTest': (_i, h) => {
    h.runtime().security.refreshProof()
    h.runtime().bus.invalidate('agents')
    return securityStatus(h.runtime())
  },
  'files.recent': (i, h) => h.runtime().missions.recentFiles(i.agentId, i.limit),
}

async function localClaude(rt: OrbitRuntime) {
  if (!rt.settings.getRaw<boolean>('claudeLocalLogs')) return { enabled: false, usage: null, error: null }
  try {
    return { enabled: true, usage: await scanClaudeLocalUsage(claudeCodeProjectsDir()), error: null }
  } catch (err) {
    return { enabled: true, usage: null, error: err instanceof Error ? err.message : String(err) }
  }
}

function securityStatus(rt: OrbitRuntime): SecurityStatus {
  const proof = rt.security.getProof()
  return {
    isolation: { available: seatbeltAvailable(), ok: rt.security.isolationProven(), checkedAt: proof.checkedAt, checks: proof.checks, error: proof.error },
    events: rt.security.list(100),
  }
}
