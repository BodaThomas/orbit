import { eq } from 'drizzle-orm'
import type { ModelInfo, ProviderId, ProviderInfo } from '@shared/types'
import type { OrbitDb } from '../infra/db/client'
import { providerConnections } from '../infra/db/schema'
import { ADAPTERS, ProviderError, type ProviderAdapter } from '../infra/providers'
import type { EventBus } from './event-bus'
import type { Journal } from './journal'
import type { SecretCipher } from './platform'
import type { SettingsStore } from './settings'
import { nowIso, OrbitError } from './util'

const ORDER: ProviderId[] = ['anthropic', 'openai', 'claude-agent', 'codex', 'gemini', 'grok', 'openrouter', 'ollama', 'demo']

export class ProviderRegistry {
  constructor(
    private db: OrbitDb,
    private bus: EventBus,
    private journal: Journal,
    private secrets: SecretCipher,
    private settings: SettingsStore,
    private mode: 'real' | 'demo',
    private adapters: Record<ProviderId, ProviderAdapter> = ADAPTERS,
  ) {}

  adapter(id: ProviderId): ProviderAdapter {
    return this.adapters[id]
  }

  /** Decrypts the secret for a provider. Main-process only, never crosses IPC. */
  secretFor(id: ProviderId): string | null {
    const row = this.db.select().from(providerConnections).where(eq(providerConnections.providerId, id)).get()
    if (!row?.encryptedSecret) return null
    try {
      return this.secrets.decrypt(row.encryptedSecret)
    } catch {
      throw new OrbitError('provider', 'Impossible de déchiffrer la clé. Re-saisissez-la dans les paramètres.')
    }
  }

  list(): ProviderInfo[] {
    const rows = new Map(this.db.select().from(providerConnections).all().map((r) => [r.providerId, r]))
    return ORDER.filter((id) => (this.mode === 'demo' ? true : id !== 'demo')).map((id) => {
      const a = this.adapters[id]
      const row = rows.get(id)
      const cached = this.settings.getRaw<ModelInfo[]>(`models:${id}`)
      const hasSecret = Boolean(row?.encryptedSecret)
      return {
        id,
        name: a.name,
        availability: a.availability,
        capabilities: a.capabilities,
        models: cached?.length ? cached : a.defaultModels,
        connected: a.availability === 'available' && (!a.requiresSecret || (hasSecret && !row?.lastError)),
        hasSecret,
        secretHint: row?.secretHint ?? null,
        lastValidatedAt: row?.lastValidatedAt ?? null,
        statusPage: a.statusPage?.page ?? null,
        services: a.statusPage?.services ?? [],
        notes: a.notes,
      }
    })
  }

  info(id: ProviderId): ProviderInfo {
    const info = this.list().find((p) => p.id === id)
    if (!info) throw new OrbitError('not_found', 'Fournisseur inconnu.')
    return info
  }

  async setKey(id: ProviderId, apiKey: string): Promise<ProviderInfo> {
    const adapter = this.adapter(id)
    if (adapter.availability !== 'available' || !adapter.requiresSecret) {
      throw new OrbitError('validation', `${adapter.name} n’accepte pas de clé pour le moment.`)
    }
    if (!this.secrets.available()) {
      throw new OrbitError('forbidden', 'Le stockage sécurisé du Trousseau macOS est indisponible : la clé n’a pas été enregistrée.')
    }
    try {
      await adapter.validate(apiKey)
    } catch (err) {
      const msg = err instanceof ProviderError || err instanceof Error ? err.message : 'Validation impossible.'
      this.journal.activity({ type: 'provider.error', level: 'error', title: `${adapter.name} : clé refusée`, detail: msg })
      throw new OrbitError('provider', msg)
    }
    const ts = nowIso()
    const values = {
      providerId: id,
      encryptedSecret: this.secrets.encrypt(apiKey),
      secretHint: `…${apiKey.slice(-4)}`,
      lastValidatedAt: ts,
      lastError: null,
      updatedAt: ts,
    }
    this.db
      .insert(providerConnections)
      .values({ ...values, createdAt: ts })
      .onConflictDoUpdate({ target: providerConnections.providerId, set: values })
      .run()
    await this.refreshModels(id).catch(() => undefined)
    this.journal.activity({ type: 'provider.connected', level: 'success', title: `${adapter.name} connecté`, detail: `Clé ${values.secretHint} enregistrée dans le Trousseau` })
    this.journal.audit({ actor: 'user', agentId: null, action: 'provider.setKey', target: id, allowed: true, reason: null })
    this.bus.invalidate('providers')
    return this.info(id)
  }

  removeKey(id: ProviderId): ProviderInfo {
    this.db
      .update(providerConnections)
      .set({ encryptedSecret: null, secretHint: null, lastValidatedAt: null, updatedAt: nowIso() })
      .where(eq(providerConnections.providerId, id))
      .run()
    this.journal.audit({ actor: 'user', agentId: null, action: 'provider.removeKey', target: id, allowed: true, reason: null })
    this.bus.invalidate('providers')
    return this.info(id)
  }

  async validate(id: ProviderId): Promise<{ ok: boolean; error: string | null }> {
    const adapter = this.adapter(id)
    try {
      await adapter.validate(adapter.requiresSecret ? this.secretFor(id) : null)
      this.db.update(providerConnections).set({ lastValidatedAt: nowIso(), lastError: null }).where(eq(providerConnections.providerId, id)).run()
      this.bus.invalidate('providers')
      return { ok: true, error: null }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.db.update(providerConnections).set({ lastError: msg }).where(eq(providerConnections.providerId, id)).run()
      this.bus.invalidate('providers')
      return { ok: false, error: msg }
    }
  }

  private async refreshModels(id: ProviderId): Promise<void> {
    const adapter = this.adapter(id)
    if (!adapter.listModels) return
    const models = await adapter.listModels(this.secretFor(id))
    if (models.length) this.settings.setRaw(`models:${id}`, models)
  }
}
