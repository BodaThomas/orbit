import { create } from 'zustand'
import type { MissionStatus } from '@shared/types'

/** List filters that survive navigating away and back within a session. */
interface FiltersState {
  missions: { q: string; agent: string; status: MissionStatus | 'all'; view: 'list' | 'board' }
  setMissions: (patch: Partial<FiltersState['missions']>) => void
}

export const useFilters = create<FiltersState>((set) => ({
  missions: { q: '', agent: 'all', status: 'all', view: 'list' },
  setMissions: (patch) => set((s) => ({ missions: { ...s.missions, ...patch } })),
}))
