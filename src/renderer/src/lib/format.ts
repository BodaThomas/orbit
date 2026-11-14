const usd = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const usdPrecise = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
const int = new Intl.NumberFormat('fr-FR')
const compact = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 })
const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto', style: 'short' })

export function money(n: number | null | undefined, precise = false): string {
  if (n == null) return '—'
  if (precise && n > 0 && n < 0.01) return `${usdPrecise.format(n)} $`
  return `${usd.format(n)} $`
}

/** Splits "327,91" and "$" so the currency can be styled smaller, like Hublot. */
export function moneyParts(n: number): { value: string; currency: string } {
  return { value: usd.format(n), currency: '$' }
}

export const integer = (n: number) => int.format(n)
export const compactNumber = (n: number) => compact.format(n)

export function relative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—'
  const diff = (new Date(iso).getTime() - now) / 1000
  const abs = Math.abs(diff)
  if (abs < 45) return 'à l’instant'
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour')
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day')
  return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
}

/** "16:40" today, "12 nov. 23:23" otherwise. */
export function clock(iso: string): string {
  const d = new Date(iso)
  const t = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === new Date().toDateString()) return t
  return `${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} ${t}`
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function longDate(d = new Date()): string {
  const s = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function duration(fromIso: string | null, toIso?: string | null, now = Date.now()): string {
  if (!fromIso) return '—'
  const s = Math.max(0, ((toIso ? new Date(toIso).getTime() : now) - new Date(fromIso).getTime()) / 1000)
  if (s < 60) return `${Math.round(s)} s`
  if (s < 3600) return `${Math.floor(s / 60)} min`
  const h = Math.floor(s / 3600)
  return `${h} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`
}

export function greeting(d = new Date()): string {
  const h = d.getHours()
  if (h < 5) return 'Bonne nuit'
  if (h < 18) return 'Bonjour'
  return 'Bonsoir'
}
