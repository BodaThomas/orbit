/**
 * Recurrences with explicit IANA time zones. Pure: used by the scheduler (main) and by
 * the planning assistant (renderer) to show the next computed runs.
 *
 * Daylight saving time rules (documented in docs/AUTOMATIONS.md):
 * - A wall-clock time that does not exist (spring forward, e.g. 02:30 in Paris on the
 *   last Sunday of March) runs at the first valid instant after the gap (03:30).
 * - A wall-clock time that happens twice (fall back) runs once, at its first occurrence.
 */

export type Recurrence =
  | { kind: 'once'; at: string } // local wall time 'YYYY-MM-DDTHH:mm' in the automation's zone
  | { kind: 'daily'; time: string } // 'HH:mm'
  | { kind: 'weekly'; days: number[]; time: string } // 1 = Monday … 7 = Sunday
  | { kind: 'monthly'; day: number; time: string } // 1–31, clamped to the month's last day
  | { kind: 'interval'; minutes: number; anchor: string } // ISO instant
  | { kind: 'cron'; expr: string } // 5 fields: minute hour day-of-month month day-of-week

interface Parts {
  y: number
  mo: number
  d: number
  h: number
  mi: number
  dow: number // 1 = Monday … 7 = Sunday
}

const fmtCache = new Map<string, Intl.DateTimeFormat>()
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' })
    fmtCache.set(tz, f)
  }
  return f
}

export function isValidTimeZone(tz: string): boolean {
  try {
    fmt(tz)
    return true
  } catch {
    return false
  }
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }

/** Wall-clock parts of an instant in a zone. */
export function zonedParts(t: number, tz: string): Parts {
  const p: Record<string, string> = {}
  for (const x of fmt(tz).formatToParts(new Date(t))) p[x.type] = x.value
  return { y: +p.year!, mo: +p.month!, d: +p.day!, h: +p.hour! % 24, mi: +p.minute!, dow: WEEKDAYS[p.weekday!] ?? 1 }
}

function offsetAt(t: number, tz: string): number {
  const p = zonedParts(t, tz)
  const s = new Date(t).getUTCSeconds()
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, s) - (t - (t % 1000))
}

/**
 * The instant at which a zone's clock shows y-mo-d h:mi. Gap → first instant after it;
 * overlap → earliest instant.
 */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  const candidates = [...new Set([offsetAt(guess - 12 * 3600_000, tz), offsetAt(guess + 12 * 3600_000, tz), offsetAt(guess, tz)])]
    .map((off) => guess - off)
    .filter((t) => {
      const p = zonedParts(t, tz)
      return p.y === y && p.mo === mo && p.d === d && p.h === h && p.mi === mi
    })
    .sort((a, b) => a - b)
  if (candidates.length) return candidates[0]!
  // Non-existent local time: use the offset before the transition → lands right after the gap.
  return guess - offsetAt(guess - 12 * 3600_000, tz)
}

const daysInMonth = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate()
const pad = (n: number) => String(n).padStart(2, '0')
const parseTime = (s: string): [number, number] => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (!m) throw new Error(`Heure invalide : ${s}`)
  const h = +m[1]!
  const mi = +m[2]!
  if (h > 23 || mi > 59) throw new Error(`Heure invalide : ${s}`)
  return [h, mi]
}

// Cron

export interface CronSpec {
  minutes: Set<number>
  hours: Set<number>
  dom: Set<number>
  months: Set<number>
  dow: Set<number> // 1–7
  domRestricted: boolean
  dowRestricted: boolean
}

function field(src: string, min: number, max: number, name: string): { set: Set<number>; restricted: boolean } {
  const set = new Set<number>()
  for (const part of src.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim())
    if (!m) throw new Error(`Champ « ${name} » invalide : ${part}`)
    const step = m[2] ? +m[2] : 1
    if (step < 1) throw new Error(`Pas invalide dans « ${name} »`)
    let lo = min
    let hi = max
    if (m[1] !== '*') {
      const [a, b] = m[1]!.split('-').map(Number)
      lo = a!
      hi = b ?? (m[2] ? max : a!)
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`Valeur hors bornes dans « ${name} » (${min}–${max})`)
    for (let v = lo; v <= hi; v += step) set.add(v)
  }
  return { set, restricted: src.trim() !== '*' }
}

export function parseCron(expr: string): CronSpec {
  const f = expr.trim().split(/\s+/)
  if (f.length !== 5) throw new Error('Une expression cron comporte 5 champs : minute heure jour mois jour-de-semaine.')
  const dowRaw = field(f[4]!, 0, 7, 'jour de semaine')
  const dow = new Set([...dowRaw.set].map((v) => (v === 0 ? 7 : v)))
  const dom = field(f[2]!, 1, 31, 'jour du mois')
  return { minutes: field(f[0]!, 0, 59, 'minute').set, hours: field(f[1]!, 0, 23, 'heure').set, dom: dom.set, months: field(f[3]!, 1, 12, 'mois').set, dow, domRestricted: dom.restricted, dowRestricted: dowRaw.restricted }
}

function cronDayMatches(c: CronSpec, y: number, mo: number, d: number): boolean {
  if (!c.months.has(mo)) return false
  const dow = ((new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7) + 1
  // Classic cron: when both day fields are restricted, either may match.
  if (c.domRestricted && c.dowRestricted) return c.dom.has(d) || c.dow.has(dow)
  if (c.domRestricted) return c.dom.has(d)
  if (c.dowRestricted) return c.dow.has(dow)
  return true
}

// Next occurrence

/**
 * Shape check, then - when `now` is given (creating or editing an automation) - that the
 * recurrence fires at least once more: `0 0 30 2 *` or a past one-shot would otherwise leave
 * an « active » automation that never runs.
 */
export function validateRecurrence(r: Recurrence, tz: string, now?: number): string | null {
  const shape = validateShape(r, tz)
  if (shape || now === undefined) return shape
  try {
    if (nextOccurrence(r, tz, now)) return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  return r.kind === 'once' ? 'Cette date est déjà passée : choisissez un moment à venir.' : 'Cette récurrence ne se produit jamais (par exemple un 30 février) : modifiez-la.'
}

function validateShape(r: Recurrence, tz: string): string | null {
  try {
    if (!isValidTimeZone(tz)) return `Fuseau horaire inconnu : ${tz}`
    switch (r.kind) {
      case 'once':
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(r.at)) return 'Date invalide.'
        parseTime(r.at.slice(11))
        return null
      case 'daily':
        parseTime(r.time)
        return null
      case 'weekly':
        parseTime(r.time)
        return r.days.length && r.days.every((d) => d >= 1 && d <= 7) ? null : 'Choisissez au moins un jour.'
      case 'monthly':
        parseTime(r.time)
        return r.day >= 1 && r.day <= 31 ? null : 'Jour du mois invalide.'
      case 'interval':
        return r.minutes >= 5 && r.minutes <= 60 * 24 * 31 ? (isNaN(Date.parse(r.anchor)) ? 'Point de départ invalide.' : null) : 'Intervalle entre 5 minutes et 31 jours.'
      case 'cron':
        parseCron(r.expr)
        return null
    }
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** First occurrence strictly after `after`. null when none (one-shot already past). */
export function nextOccurrence(r: Recurrence, tz: string, after: Date | number): Date | null {
  const t0 = typeof after === 'number' ? after : after.getTime()
  if (r.kind === 'interval') {
    const anchor = Date.parse(r.anchor)
    const step = r.minutes * 60_000
    if (t0 < anchor) return new Date(anchor)
    return new Date(anchor + (Math.floor((t0 - anchor) / step) + 1) * step)
  }
  if (r.kind === 'once') {
    const [h, mi] = parseTime(r.at.slice(11))
    const t = zonedToUtc(+r.at.slice(0, 4), +r.at.slice(5, 7), +r.at.slice(8, 10), h, mi, tz)
    return t > t0 ? new Date(t) : null
  }
  const start = zonedParts(t0, tz)
  const cron = r.kind === 'cron' ? parseCron(r.expr) : null
  // Walk local calendar days (≤ 4 years for sparse cron like Feb 29).
  for (let i = 0; i < 366 * 4 + 2; i++) {
    const day = new Date(Date.UTC(start.y, start.mo - 1, start.d + i))
    const y = day.getUTCFullYear()
    const mo = day.getUTCMonth() + 1
    const d = day.getUTCDate()
    const dow = ((day.getUTCDay() + 6) % 7) + 1
    let times: [number, number][] = []
    if (r.kind === 'daily') times = [parseTime(r.time)]
    else if (r.kind === 'weekly') times = r.days.includes(dow) ? [parseTime(r.time)] : []
    else if (r.kind === 'monthly') times = d === Math.min(r.day, daysInMonth(y, mo)) ? [parseTime(r.time)] : []
    else if (cron && cronDayMatches(cron, y, mo, d)) for (const h of [...cron.hours].sort((a, b) => a - b)) for (const mi of [...cron.minutes].sort((a, b) => a - b)) times.push([h, mi])
    for (const [h, mi] of times) {
      const t = zonedToUtc(y, mo, d, h, mi, tz)
      if (t > t0) return new Date(t)
    }
  }
  return null
}

export function nextOccurrences(r: Recurrence, tz: string, after: Date | number, count: number): Date[] {
  const out: Date[] = []
  let t = typeof after === 'number' ? after : after.getTime()
  for (let i = 0; i < count; i++) {
    const n = nextOccurrence(r, tz, t)
    if (!n) break
    out.push(n)
    t = n.getTime()
  }
  return out
}

const DAY_NAMES = ['', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche']

/** Plain French, for people who never wrote a cron line. */
export function describeRecurrence(r: Recurrence): string {
  switch (r.kind) {
    case 'once':
      return `Une fois, le ${new Date(`${r.at}:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })} à ${r.at.slice(11)}`
    case 'daily':
      return `Chaque jour à ${r.time}`
    case 'weekly': {
      const days = [...r.days].sort()
      const label = days.length === 5 && days.join() === '1,2,3,4,5' ? 'Chaque jour de semaine' : days.length === 7 ? 'Chaque jour' : `Chaque ${days.map((d) => DAY_NAMES[d]).join(', ')}`
      return `${label} à ${r.time}`
    }
    case 'monthly':
      return `Chaque mois, le ${r.day === 1 ? '1er' : r.day}${r.day > 28 ? ' (ou le dernier jour)' : ''} à ${r.time}`
    case 'interval':
      return r.minutes % 1440 === 0 ? `Tous les ${r.minutes / 1440} jours` : r.minutes % 60 === 0 ? `Toutes les ${r.minutes / 60} heures` : `Toutes les ${r.minutes} minutes`
    case 'cron':
      return `Expression cron « ${r.expr} »`
  }
}

export function localDateTimeInput(t: number, tz: string): string {
  const p = zonedParts(t, tz)
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`
}
