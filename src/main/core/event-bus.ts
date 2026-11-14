import type { InvalidateScope, OrbitEvent } from '@shared/ipc'

type Listener = (event: OrbitEvent) => void

/** In-process pub/sub. The main entry forwards every event to the renderer. */
export class EventBus {
  private listeners = new Set<Listener>()
  private pending = new Set<InvalidateScope>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  on(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: OrbitEvent): void {
    for (const l of this.listeners) l(event)
  }

  /** Coalesces invalidations over a short window to avoid refetch storms. */
  invalidate(...scopes: InvalidateScope[]): void {
    for (const s of scopes) this.pending.add(s)
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      const scopesNow = [...this.pending]
      this.pending.clear()
      this.emit({ type: 'invalidate', scopes: scopesNow })
    }, 40)
  }
}
