import { eq } from 'drizzle-orm'
import type { OrbitSettings } from '@shared/types'
import type { OrbitDb } from '../infra/db/client'
import { settings } from '../infra/db/schema'
import { nowIso } from './util'

export const DEFAULT_SETTINGS: Omit<OrbitSettings, 'mode'> = {
  onboarded: false,
  userName: '',
  dailyLimitUsd: null,
  monthlyBudgetUsd: null,
  nativeNotifications: true,
  reduceMotion: 'system',
  locale: 'fr',
}

/** Key/value settings persisted per database (real and demo are isolated). */
export class SettingsStore {
  constructor(
    private db: OrbitDb,
    private mode: OrbitSettings['mode'],
  ) {}

  get(): OrbitSettings {
    const rows = this.db.select().from(settings).all()
    const stored = Object.fromEntries(rows.map((r) => [r.key, r.value])) as Partial<OrbitSettings>
    return { ...DEFAULT_SETTINGS, ...stored, mode: this.mode, locale: 'fr' }
  }

  update(patch: Partial<OrbitSettings>): OrbitSettings {
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'mode' || key === 'locale' || value === undefined) continue
      this.setRaw(key, value)
    }
    return this.get()
  }

  getRaw<T>(key: string): T | undefined {
    return this.db.select().from(settings).where(eq(settings.key, key)).get()?.value as T | undefined
  }

  setRaw(key: string, value: unknown): void {
    this.db
      .insert(settings)
      .values({ key, value, updatedAt: nowIso() })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: nowIso() } })
      .run()
  }
}
