import type { ProviderId } from '@shared/types'
import { cn } from '@/lib/cn'

/** Neutral monogram marks - Orbit does not ship third-party logos. */
const MARKS: Record<ProviderId, { glyph: string; bg: string; fg: string }> = {
  anthropic: { glyph: 'A', bg: '#3a2620', fg: '#E8957A' },
  openai: { glyph: 'O', bg: '#1f2a26', fg: '#9ED9C0' },
  'claude-agent': { glyph: 'Ag', bg: '#3a2620', fg: '#E8957A' },
  codex: { glyph: 'Cx', bg: '#1f2a26', fg: '#9ED9C0' },
  gemini: { glyph: 'G', bg: '#1f2433', fg: '#9DB4E8' },
  grok: { glyph: 'X', bg: '#26272d', fg: '#C9CBD6' },
  openrouter: { glyph: 'R', bg: '#262236', fg: '#B7ACFF' },
  ollama: { glyph: 'L', bg: '#26272d', fg: '#E3E5EE' },
  demo: { glyph: '✦', bg: '#262236', fg: '#B7ACFF' },
}

export function ProviderMark({ id, size = 20, className }: { id: ProviderId; size?: number; className?: string }) {
  const m = MARKS[id]
  return (
    <span
      aria-hidden
      className={cn('inline-flex shrink-0 items-center justify-center font-semibold tracking-tight', className)}
      style={{ width: size, height: size, borderRadius: size * 0.3, background: m.bg, color: m.fg, fontSize: size * (m.glyph.length > 1 ? 0.42 : 0.55), boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / 0.06)' }}
    >
      {m.glyph}
    </span>
  )
}
