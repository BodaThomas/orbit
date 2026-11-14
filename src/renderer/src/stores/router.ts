import { create } from 'zustand'

interface RouterState {
  path: string
  history: string[]
  navigate: (path: string) => void
  back: () => void
}

export const useRouter = create<RouterState>((set, get) => ({
  path: '/',
  history: [],
  navigate: (path) => {
    if (path === get().path) return
    set((s) => ({ path, history: [...s.history.slice(-30), s.path] }))
  },
  back: () => {
    const h = get().history
    if (!h.length) return
    set({ path: h[h.length - 1]!, history: h.slice(0, -1) })
  },
}))

export const navigate = (path: string) => useRouter.getState().navigate(path)

/** Matches "/companions/:id/:tab?" style patterns. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const pp = pattern.split('/').filter(Boolean)
  const sp = path.split('/').filter(Boolean)
  const params: Record<string, string> = {}
  for (let i = 0; i < pp.length; i++) {
    const p = pp[i]!
    const optional = p.endsWith('?')
    const seg = sp[i]
    if (p.startsWith(':')) {
      if (seg === undefined) {
        if (optional) continue
        return null
      }
      params[p.slice(1).replace('?', '')] = decodeURIComponent(seg)
    } else if (p !== seg) return null
  }
  if (sp.length > pp.length) return null
  return params
}
