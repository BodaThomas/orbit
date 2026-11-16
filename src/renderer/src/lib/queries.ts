import { keepPreviousData, QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { toast } from 'sonner'
import type { InvalidateScope, IpcChannel, IpcInput, IpcOutputs, OrbitEvent } from '@shared/ipc'
import type { ActivityLevel, Message, MissionDetail } from '@shared/types'
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
  missions: ['missions', 'mission', 'agents', 'files'],
  approvals: ['approvals', 'agents'],
  activity: ['activity'],
  usage: ['usage'],
  notifications: ['notifications'],
  memory: ['memory'],
  settings: ['bootstrap', 'security', 'audit'],
  workflows: ['workflows'],
  constellations: ['constellations', 'constellation-run', 'missions'],
  automations: ['automations'],
  machines: ['machines', 'runtime'],
  security: ['security', 'grants', 'auto-log', 'audit'],
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
        case 'mission.delta':
          useUi.getState().appendMissionDraft(evt.missionId, evt.delta)
          break
        case 'mission.activity':
          useUi.getState().setMissionActivity(evt.missionId, evt.activity)
          break
        case 'mission.tool':
          qc.setQueryData<MissionDetail>(['mission', evt.toolCall.missionId], (d) => {
            if (!d) return d
            const exists = d.toolCalls.some((t) => t.id === evt.toolCall.id)
            return { ...d, toolCalls: exists ? d.toolCalls.map((t) => (t.id === evt.toolCall.id ? evt.toolCall : t)) : [...d.toolCalls, evt.toolCall] }
          })
          break
        case 'navigate':
          navigate(evt.route)
          break
        case 'constellation.signal':
          useUi.getState().pushSignal(evt.signal)
          break
        case 'permission.auto':
          notifyAuto(evt)
          void qc.invalidateQueries({ queryKey: ['auto-log'] })
          break
        case 'activity':
          break
      }
    })
  }, [qc])
}

/**
 * Non-blocking notice for actions that ran without confirmation. Grouped per mission so a
 * busy companion shows one updating line instead of a stream of toasts.
 */
const autoCounts = new Map<string, { n: number; at: number }>()
function notifyAuto(evt: Extract<OrbitEvent, { type: 'permission.auto' }>) {
  const prev = autoCounts.get(evt.missionId)
  const fresh = !prev || Date.now() - prev.at > 60_000
  const n = fresh ? 1 : prev.n + 1
  autoCounts.set(evt.missionId, { n, at: Date.now() })
  const via = evt.via === 'grant' ? 'votre autorisation' : evt.via === 'engine' ? 'mode auto de Claude' : 'action courante'
  toast(`${evt.agentName} · ${evt.title}`, {
    id: `auto-${evt.missionId}`,
    description: n > 1 ? `${n} actions sans confirmation (dernière : ${via})` : `Sans confirmation · ${via}`,
    duration: 3500,
    action: { label: 'Historique', onClick: () => navigate(`/companions/${evt.agentId}/tools`) },
  })
}

const useOrbitQuery = <C extends IpcChannel>(key: unknown[], channel: C, input?: IpcInput<C>, enabled = true, keepPrevious = false) =>
  useQuery({
    queryKey: key,
    queryFn: () => (call as (c: C, i?: IpcInput<C>) => Promise<IpcOutputs[C]>)(channel, input),
    enabled,
    // Filtered lists keep showing the previous results while the next filter loads.
    placeholderData: keepPrevious ? keepPreviousData : undefined,
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
  useOrbitQuery(['activity', opts], 'activity.list', opts, true, true)
export const useUsage = () => useOrbitQuery(['usage'], 'usage.summary')
export const useLocalClaude = () => useOrbitQuery(['usage', 'localClaude'], 'usage.localClaude')
export const useQuotas = () => useOrbitQuery(['usage', 'quotas'], 'usage.quotas')
export const useNotifications = () => useOrbitQuery(['notifications'], 'notifications.list')
export const useMemory = (agentId: string | undefined) => useOrbitQuery(['memory', agentId], 'memory.list', { agentId: agentId ?? '' }, Boolean(agentId))
export const useMachines = () => useOrbitQuery(['machines'], 'machines.list')
export const useWorkflows = () => useOrbitQuery(['workflows'], 'workflows.list')
export const useAudit = () => useOrbitQuery(['audit'], 'audit.list', { limit: 200 })
export const useConstellations = () => useOrbitQuery(['constellations', 'defs'], 'constellations.list')
export const useConstellationRuns = (constellationId?: string) => useOrbitQuery(['constellations', 'runs', constellationId ?? 'all'], 'constellations.runs', { constellationId })
export const useConstellationRun = (id: string | undefined) => useOrbitQuery(['constellation-run', id], 'constellations.run', { id: id ?? '' }, Boolean(id))
export const useAutomations = () => useOrbitQuery(['automations', 'list'], 'automations.list')
export const useAutomationRuns = (automationId?: string) => useOrbitQuery(['automations', 'runs', automationId ?? 'all'], 'automations.runs', { automationId })
export const useRemoteMachines = () => useOrbitQuery(['machines', 'remote'], 'runtime.list')
export const useSecurity = () => useOrbitQuery(['security'], 'security.status')
export const useGrants = (agentId?: string) => useOrbitQuery(['grants', agentId ?? 'all'], 'permissions.grants', { agentId })
export const useAutoLog = (agentId?: string, limit = 60) => useOrbitQuery(['auto-log', agentId ?? 'all', limit], 'permissions.autoLog', { agentId, limit })
export const useRecentFiles = (agentId?: string) => useOrbitQuery(['files', agentId ?? 'all'], 'files.recent', { agentId, limit: 200 })

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
