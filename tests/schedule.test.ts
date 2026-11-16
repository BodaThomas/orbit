import { describe, expect, it } from 'vitest'
import { describeRecurrence, nextOccurrence, nextOccurrences, parseCron, validateRecurrence, zonedParts, zonedToUtc } from '@shared/schedule'

const PARIS = 'Europe/Paris'
const iso = (d: Date | null) => d?.toISOString() ?? null

describe('récurrences — fuseaux horaires et heure d’été', () => {
  it('quotidien à 08:00 Paris = 07:00 UTC en hiver, 06:00 UTC en été', () => {
    expect(iso(nextOccurrence({ kind: 'daily', time: '08:00' }, PARIS, Date.parse('2026-01-10T12:00:00Z')))).toBe('2026-01-11T07:00:00.000Z')
    expect(iso(nextOccurrence({ kind: 'daily', time: '08:00' }, PARIS, Date.parse('2026-07-10T12:00:00Z')))).toBe('2026-07-11T06:00:00.000Z')
    expect(iso(nextOccurrence({ kind: 'daily', time: '08:00' }, 'America/New_York', Date.parse('2026-01-10T12:00:00Z')))).toBe('2026-01-10T13:00:00.000Z')
  })
  it('passage à l’heure d’été : 02:30 n’existe pas → 03:30 heure locale', () => {
    const t = nextOccurrence({ kind: 'daily', time: '02:30' }, PARIS, Date.parse('2026-03-28T12:00:00Z'))!
    expect(t.toISOString()).toBe('2026-03-29T01:30:00.000Z')
    expect(zonedParts(t.getTime(), PARIS)).toMatchObject({ h: 3, mi: 30 })
  })
  it('passage à l’heure d’hiver : 02:30 arrive deux fois → une seule exécution, la première', () => {
    const times = nextOccurrences({ kind: 'daily', time: '02:30' }, PARIS, Date.parse('2026-10-24T12:00:00Z'), 2).map(iso)
    expect(times).toEqual(['2026-10-25T00:30:00.000Z', '2026-10-26T01:30:00.000Z'])
    expect(zonedToUtc(2026, 10, 25, 2, 30, PARIS)).toBe(Date.parse('2026-10-25T00:30:00Z'))
  })
  it('hebdomadaire, mensuel (31 → dernier jour), une fois, intervalle', () => {
    // Mondays and Fridays at 09:15
    expect(nextOccurrences({ kind: 'weekly', days: [1, 5], time: '09:15' }, PARIS, Date.parse('2026-11-14T12:00:00Z'), 2).map(iso)).toEqual(['2026-11-16T08:15:00.000Z', '2026-11-20T08:15:00.000Z'])
    expect(iso(nextOccurrence({ kind: 'monthly', day: 31, time: '10:00' }, PARIS, Date.parse('2027-02-01T00:00:00Z')))).toBe('2027-02-28T09:00:00.000Z')
    expect(iso(nextOccurrence({ kind: 'once', at: '2026-12-24T18:00' }, PARIS, Date.parse('2026-11-14T00:00:00Z')))).toBe('2026-12-24T17:00:00.000Z')
    expect(nextOccurrence({ kind: 'once', at: '2026-01-01T00:00' }, PARIS, Date.parse('2026-11-14T00:00:00Z'))).toBeNull()
    expect(iso(nextOccurrence({ kind: 'interval', minutes: 90, anchor: '2026-11-14T08:00:00.000Z' }, PARIS, Date.parse('2026-11-14T10:00:00Z')))).toBe('2026-11-14T11:00:00.000Z')
  })
  it('cron avancé', () => {
    expect(iso(nextOccurrence({ kind: 'cron', expr: '*/15 9-17 * * 1-5' }, PARIS, Date.parse('2026-11-14T12:00:00Z')))).toBe('2026-11-16T08:00:00.000Z') // Saturday → Monday 09:00
    expect(iso(nextOccurrence({ kind: 'cron', expr: '0 12 29 2 *' }, 'UTC', Date.parse('2026-11-14T00:00:00Z')))).toBe('2028-02-29T12:00:00.000Z')
    expect(() => parseCron('61 * * * *')).toThrow()
    expect(() => parseCron('* * *')).toThrow()
    expect(parseCron('0 0 * * 0').dow.has(7)).toBe(true)
  })
  it('validation et description en français', () => {
    expect(validateRecurrence({ kind: 'daily', time: '25:00' }, PARIS)).toBeTruthy()
    expect(validateRecurrence({ kind: 'daily', time: '08:00' }, 'Mars/Olympus')).toContain('Fuseau')
    expect(validateRecurrence({ kind: 'interval', minutes: 1, anchor: new Date().toISOString() }, PARIS)).toBeTruthy()
    expect(describeRecurrence({ kind: 'weekly', days: [1, 2, 3, 4, 5], time: '08:30' })).toBe('Chaque jour de semaine à 08:30')
  })
  it('validation avec « maintenant » : une récurrence qui ne se produit plus est refusée', () => {
    const now = Date.parse('2026-11-14T00:00:00Z')
    expect(validateRecurrence({ kind: 'cron', expr: '0 0 30 2 *' }, PARIS, now)).toContain('ne se produit jamais')
    expect(validateRecurrence({ kind: 'cron', expr: '0 0 30 2 *' }, PARIS)).toBeNull() // shape only
    expect(validateRecurrence({ kind: 'once', at: '2026-01-01T00:00' }, PARIS, now)).toContain('déjà passée')
    expect(validateRecurrence({ kind: 'once', at: '2026-12-24T18:00' }, PARIS, now)).toBeNull()
    expect(validateRecurrence({ kind: 'cron', expr: '0 12 29 2 *' }, 'UTC', now)).toBeNull()
  })
})
