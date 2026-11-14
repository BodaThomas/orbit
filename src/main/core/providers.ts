import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import type { ModelInfo, ProviderId, ProviderInfo } from '@shared/types'
import type { OrbitDb } from '../infra/db/client'
import { providerConnections } from '../infra/db/schema'
import { ADAPTERS, ProviderError, type ProviderAdapter } from '../infra/providers'
import type { AgentEngine, EngineId, EngineReadiness } from './engine/types'
import type { EventBus } from './event-bus'
import type { Journal } from './journal'
import type { SecretCipher } from './platform'
import type { SettingsStore } from './settings'
import { nowIso, OrbitError } from './util'

const ORDER: ProviderId[] = ['claude-code', 'anthropic', 'openai', 'claude-agent', 'codex', 'gemini', 'grok', 'openrouter', 'ollama', 'demo']

export class ProviderRegistry {
  constructor(
    private db: OrbitDb,
    private bus: EventBus,
    private journal: Journal,
    private secrets: SecretCipher,
    private settings: SettingsStore,
    private mode: 'real' | 'demo',
    private adapters: Record<ProviderId, ProviderAdapter> = ADAPTERS,
    private engines: Partial<Record<EngineId, AgentEngine>> = {},
  ) {}

  adapter(id: ProviderId): ProviderAdapter {
    return this.adapters[id]
  }

  engine(id: ProviderId): AgentEngine | null {
    return id === 'claude-agent' || id === 'codex' || id === 'claude-code' ? (this.engines[id] ?? null) : null
  }

  /** Decrypts the secret for a provider. Main-process only, never crosses IPC. */
  secretFor(id: ProviderId): string | null {
    const from = this.adapters[id].secretFrom
    if (from) return this.secretFor(from)
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
      const source = a.secretFrom ? rows.get(a.secretFrom) : row
      const hasSecret = Boolean(source?.encryptedSecret)
      const readiness = a.capabilities.kind === 'agent' ? this.settings.getRaw<EngineReadiness>(`engine:${id}`) : null
      const connected =
        a.capabilities.kind === 'agent'
          ? a.requiresSecret
            ? hasSecret && !source?.lastError
            : Boolean(readiness?.ready)
          : a.availability === 'available' && (!a.requiresSecret || (hasSecret && !row?.lastError))
      return {
        id,
        name: a.name,
        availability: a.availability,
        capabilities: a.capabilities,
        models: cached?.length ? cached : a.defaultModels,
        connected,
        hasSecret,
        secretHint: source?.secretHint ?? null,
        lastValidatedAt: a.capabilities.kind === 'agent' ? (this.settings.getRaw<string>(`engine:${id}:at`) ?? null) : (row?.lastValidatedAt ?? null),
        statusPage: a.statusPage?.page ?? null,
        services: a.statusPage?.services ?? [],
        notes: a.notes,
        engineFacts: a.capabilities.kind === 'agent' ? this.engineFacts(id, readiness ?? null) : null,
        engineAuth: readiness?.auth ?? null,
        statusDetail: readiness?.detail ?? (a.capabilities.kind === 'agent' && a.secretFrom && !hasSecret ? `Connectez d’abord ${this.adapters[a.secretFrom].name} : le moteur utilise sa clé.` : null),
      }
    })
  }

  private engineFacts(id: ProviderId, readiness: EngineReadiness | null): Record<string, string> | null {
    const facts: Record<string, string> = { ...(readiness?.facts ?? {}) }
    const model = this.settings.getRaw<string>(`engine:${id}:lastModel`)
    const at = this.settings.getRaw<string>(`engine:${id}:lastRunAt`)
    if (model) facts['Modèle utilisé (dernière session)'] = model
    if (at) facts['Dernière activité'] = at
    return Object.keys(facts).length ? facts : null
  }

  /**
   * « Tester le moteur »: one real, minimal turn in an empty temp folder, with no
   * permission at all (any tool request is refused). Proves the engine answers.
   */
  async testEngine(id: ProviderId): Promise<{ ok: boolean; text: string; model: string | null; durationMs: number; error: string | null; deniedTools: number }> {
    const engine = this.engine(id)
    if (!engine) throw new OrbitError('validation', 'Ce fournisseur n’est pas un moteur agent.')
    const adapter = this.adapter(id)
    const ws = mkdtempSync(join(tmpdir(), 'orbit-engine-test-'))
    const t0 = Date.now()
    let model: string | null = null
    let deniedTools = 0
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 120_000)
    try {
      const res = await engine.run(
        {
          runId: `test-${Date.now()}`,
          sessionId: null,
          prompt: 'Test de connexion Orbit. Réponds uniquement par « OK », sans utiliser aucun outil.',
          instructions: 'Tu es testé par Orbit. N’utilise aucun outil.',
          model: null,
          policy: { workspace: ws, permissions: { readFiles: true, writeFiles: false, runCommands: false, network: false, manageProjects: false, externalActions: false }, autonomy: 'manual', isolation: 'standard' },
          secret: adapter.requiresSecret ? this.secretFor(id) : null,
          budgetUsd: adapter.requiresSecret ? 0.05 : null,
          signal: controller.signal,
        },
        {
          emit: (e) => {
            if (e.type === 'session') {
              model = e.model
              this.noteEngineSession(id, e.model)
            }
          },
          requestApproval: async () => {
            deniedTools++
            return false
          },
        },
      )
      this.journal.audit({ actor: 'user', agentId: null, action: 'engine.test', target: id, allowed: true, reason: res.status })
      return { ok: res.status === 'completed', text: res.finalText.slice(0, 400), model, durationMs: Date.now() - t0, error: res.error?.message ?? (res.status === 'cancelled' ? 'Délai dépassé (2 min).' : null), deniedTools }
    } finally {
      clearTimeout(timer)
      rmSync(ws, { recursive: true, force: true })
    }
  }

  /** Called by the runner when an engine session starts: real facts only. */
  noteEngineSession(id: ProviderId, model: string | null): void {
    if (model) this.settings.setRaw(`engine:${id}:lastModel`, model)
    this.settings.setRaw(`engine:${id}:lastRunAt`, nowIso())
    this.bus.invalidate('providers')
  }

  info(id: ProviderId): ProviderInfo {
    const info = this.list().find((p) => p.id === id)
    if (!info) throw new OrbitError('not_found', 'Fournisseur inconnu.')
    return info
  }

  async setKey(id: ProviderId, apiKey: string): Promise<ProviderInfo> {
    const adapter = this.adapter(id)
    if (adapter.availability !== 'available' || !adapter.requiresSecret || adapter.secretFrom) {
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
    const engine = this.engine(id)
    if (engine) {
      let readiness: EngineReadiness
      try {
        readiness = await engine.checkReady(adapter.requiresSecret ? this.secretFor(id) : null)
      } catch (err) {
        readiness = { ready: false, detail: err instanceof Error ? err.message : String(err), auth: 'unknown' }
      }
      this.settings.setRaw(`engine:${id}`, readiness)
      this.settings.setRaw(`engine:${id}:at`, nowIso())
      if (readiness.ready && engine.listModels) {
        const models = await engine.listModels().catch(() => [])
        if (models.length) this.settings.setRaw(`models:${id}`, [{ id: 'default', label: 'Modèle par défaut', hint: 'Défini par le moteur' }, ...models])
      }
      this.bus.invalidate('providers')
      return { ok: readiness.ready, error: readiness.ready ? null : readiness.detail }
    }
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
