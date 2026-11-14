import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { toast } from 'sonner'
import type { InvalidateScope, IpcChannel, IpcInput, IpcOutputs } from '@shared/ipc'
import type { ActivityLevel, Message } from '@shared/types'
import { navigate } from '@/stores/router'
import { useUi } from '@/stores/ui'
import { ApiError, call } from './api'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
  },
})

const SCOPE_KEYS: Record<Exclude<InvalidateScope, 'all'>, string[]> = {
  agents: ['agents'],
  providers: ['providers'],
  health: ['health'],
  conversations: ['conversations', 'messages', 'search'],
  missions: ['missions', 'mission'],
  approvals: ['approvals'],
  activity: ['activity'],
  usage: ['usage'],
  notifications: ['notifications'],
  memory: ['memory'],
  settings: ['bootstrap'],
  workflows: ['workflows'],
}

/** Wires main-process push events into the query cache and the UI store. */
export function useOrbitEvents(): void {
  const qc = useQueryClient()
  useEffect(() => {
    if (!window.orbit) return
    return window.orbit.onEvent((evt) => {
      switch (evt.type) {
        case 'invalidate':
          if (evt.scopes.includes('all')) void qc.invalidateQueries()
          else for (const s of evt.scopes) for (const key of SCOPE_KEYS[s as Exclude<InvalidateScope, 'all'>] ?? []) void qc.invalidateQueries({ queryKey: [key] })
          break
        case 'message.delta':
          useUi.getState().appendDraft(evt.messageId, evt.delta)
          break
        case 'message.updated':
          qc.setQueryData<Message[]>(['messages', evt.message.conversationId], (list) =>
            list?.map((m) => (m.id === evt.message.id ? evt.message : m)),
          )
          useUi.getState().clearDraft(evt.message.id)
          break
        case 'mission.event':
          useUi.getState().pushMissionEvent(evt.event)
          break
        case 'navigate':
          navigate(evt.route)
          break
        case 'activity':
          break
      }
    })
  }, [qc])
}

const useOrbitQuery = <C extends IpcChannel>(key: unknown[], channel: C, input?: IpcInput<C>, enabled = true) =>
  useQuery({
    queryKey: key,
    queryFn: () => (call as (c: C, i?: IpcInput<C>) => Promise<IpcOutputs[C]>)(channel, input),
    enabled,
  })

export const useBootstrap = () => useOrbitQuery(['bootstrap'], 'app.bootstrap')
export const useAgents = () => useOrbitQuery(['agents'], 'agents.list')
export function useAgent(id: string | undefined) {
  const agents = useAgents()
  return { ...agents, data: agents.data?.find((a) => a.id === id) }
}
export const useProviders = () => useOrbitQuery(['providers'], 'providers.list')
export const useHealth = () => useOrbitQuery(['health'], 'providers.health')
export const useConversations = (agentId: string | undefined) => useOrbitQuery(['conversations', agentId], 'conversations.list', { agentId: agentId ?? '' }, Boolean(agentId))
export const useMessages = (conversationId: string | undefined) =>
  useOrbitQuery(['messages', conversationId], 'conversations.messages', { conversationId: conversationId ?? '' }, Boolean(conversationId))
export const useMissions = (agentId?: string) => useOrbitQuery(['missions', agentId ?? 'all'], 'missions.list', { agentId })
export const useMission = (id: string | undefined) => useOrbitQuery(['mission', id], 'missions.get', { id: id ?? '' }, Boolean(id))
export const useApprovals = () => useOrbitQuery(['approvals', 'pending'], 'approvals.list', { status: 'pending' })
export const useActivity = (opts: { agentId?: string; query?: string; level?: ActivityLevel; limit?: number } = {}) =>
  useOrbitQuery(['activity', opts], 'activity.list', opts)
export const useUsage = () => useOrbitQuery(['usage'], 'usage.summary')
export const useNotifications = () => useOrbitQuery(['notifications'], 'notifications.list')
export const useMemory = (agentId: string | undefined) => useOrbitQuery(['memory', agentId], 'memory.list', { agentId: agentId ?? '' }, Boolean(agentId))
export const useMachines = () => useOrbitQuery(['machines'], 'machines.list')
export const useWorkflows = () => useOrbitQuery(['workflows'], 'workflows.list')
export const useAudit = () => useOrbitQuery(['audit'], 'audit.list', { limit: 200 })

/** Mutation helper: calls the bridge, toasts errors, optional success toast. */
export function useAction<C extends IpcChannel>(channel: C, opts: { success?: string | ((out: IpcOutputs[C]) => string); onSuccess?: (out: IpcOutputs[C]) => void } = {}) {
  return useMutation({
    mutationFn: (input: IpcInput<C>) => (call as (c: C, i: IpcInput<C>) => Promise<IpcOutputs[C]>)(channel, input),
    onSuccess: (out) => {
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(out) : opts.success)
      opts.onSuccess?.(out)
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Une erreur est survenue.'),
  })
}
