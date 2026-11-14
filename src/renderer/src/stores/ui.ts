import { create } from 'zustand'
import type { ExecutionEvent } from '@shared/types'

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
}

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
    set((s) => ({ liveMissionEvents: { ...s.liveMissionEvents, [e.missionId]: [...(s.liveMissionEvents[e.missionId] ?? []), e] } })),
}))
