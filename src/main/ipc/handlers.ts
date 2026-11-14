import type { IpcChannel, IpcInput, IpcOutputs } from '@shared/ipc'
import type { Bootstrap } from '@shared/types'
import { listWorkflows } from '../core/machines'
import type { OrbitRuntime } from '../core/runtime'
import { OrbitError } from '../core/util'

export interface HostApi {
  runtime(): OrbitRuntime
  bootstrap(): Bootstrap
  setMode(mode: 'real' | 'demo'): Promise<Bootstrap>
  openExternal(url: string): Promise<void>
  chooseDirectory(): Promise<string | null>
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
  'missions.get': (i, h) => ({ mission: h.runtime().missions.get(i.id), events: h.runtime().missions.events(i.id) }),
  'missions.create': (i, h) => h.runtime().missions.create(i),
  'missions.start': (i, h) => h.runtime().missions.start(i.id, 'user'),
  'missions.cancel': (i, h) => h.runtime().missions.cancel(i.id),
  'missions.retry': (i, h) => h.runtime().missions.retry(i.id),
  'missions.duplicate': (i, h) => h.runtime().missions.duplicate(i.id),
  'missions.delete': (i, h) => h.runtime().missions.delete(i.id),

  'approvals.list': (i, h) => h.runtime().missions.approvals(i.status),
  'approvals.resolve': (i, h) => h.runtime().missions.resolveApproval(i.id, i.approve),

  'activity.list': (i, h) => h.runtime().journal.listActivity(i),
  'usage.summary': (_i, h) => h.runtime().usage.summary(),
  'notifications.list': (_i, h) => h.runtime().journal.listNotifications(),
  'notifications.markRead': (i, h) => h.runtime().journal.markRead(i.id),

  'memory.list': (i, h) => h.runtime().memory.list(i.agentId),
  'memory.create': (i, h) => h.runtime().memory.create(i),
  'memory.update': (i, h) => h.runtime().memory.update(i.id, i),
  'memory.delete': (i, h) => h.runtime().memory.delete(i.id),

  'machines.list': (_i, h) => h.runtime().machines.list(),
  'workflows.list': (_i, h) => listWorkflows(h.runtime().handle.db),
  'audit.list': (i, h) => h.runtime().journal.listAudit(i.limit),
}
