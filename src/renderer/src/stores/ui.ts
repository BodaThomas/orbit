import { create } from 'zustand'
import type { ConstellationSignal, ExecutionEvent, LiveActivity } from '@shared/types'

interface UiState {
  paletteOpen: boolean
  setPaletteOpen: (open: boolean) => void
  newMissionFor: string | null | undefined
  openNewMission: (agentId?: string | null) => void
  closeNewMission: () => void
  /** Streaming text not yet persisted, keyed by message id. */
  drafts: Record<string, string>
  appendDraft: (messageId: string, delta: string) => void
  clearDraft: (messageId: string) => void
  liveMissionEvents: Record<string, ExecutionEvent[]>
  pushMissionEvent: (e: ExecutionEvent) => void
  /** Assistant text being streamed by an agent, keyed by mission; reset on each new message. */
  missionDrafts: Record<string, string>
  appendMissionDraft: (missionId: string, delta: string) => void
  clearMissionDraft: (missionId: string) => void
  /** What each companion is doing right now, from engine events only. */
  missionActivity: Record<string, LiveActivity | null>
  setMissionActivity: (missionId: string, activity: LiveActivity | null) => void
  /** Real constellation events (delegation, result…), newest last. Drives link pulses. */
  signals: (ConstellationSignal & { seq: number })[]
  pushSignal: (s: ConstellationSignal) => void
}

let signalSeq = 0
const LIVE_EVENTS_PER_MISSION = 500

export const useUi = create<UiState>((set) => ({
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  newMissionFor: undefined,
  openNewMission: (agentId = null) => set({ newMissionFor: agentId }),
  closeNewMission: () => set({ newMissionFor: undefined }),
  drafts: {},
  appendDraft: (id, delta) => set((s) => ({ drafts: { ...s.drafts, [id]: (s.drafts[id] ?? '') + delta } })),
  clearDraft: (id) =>
    set((s) => {
      const { [id]: _, ...rest } = s.drafts
      return { drafts: rest }
    }),
  liveMissionEvents: {},
  pushMissionEvent: (e) =>
    set((s) => ({
      // Capped: MissionDetail merges these with the persisted events by id, so older ones are not lost.
      liveMissionEvents: { ...s.liveMissionEvents, [e.missionId]: [...(s.liveMissionEvents[e.missionId] ?? []).slice(-(LIVE_EVENTS_PER_MISSION - 1)), e] },
      // A persisted assistant message or a new step replaces the streamed draft.
      missionDrafts: e.type === 'message' || e.type === 'tool' || e.type === 'completed' || e.type === 'failed' || e.type === 'cancelled' ? { ...s.missionDrafts, [e.missionId]: '' } : s.missionDrafts,
    })),
  missionDrafts: {},
  appendMissionDraft: (id, delta) => set((s) => ({ missionDrafts: { ...s.missionDrafts, [id]: (s.missionDrafts[id] ?? '') + delta } })),
  clearMissionDraft: (id) => set((s) => ({ missionDrafts: { ...s.missionDrafts, [id]: '' } })),
  missionActivity: {},
  setMissionActivity: (id, activity) => set((s) => ({ missionActivity: { ...s.missionActivity, [id]: activity } })),
  signals: [],
  pushSignal: (sig) => set((s) => ({ signals: [...s.signals.slice(-49), { ...sig, seq: ++signalSeq }] })),
}))
