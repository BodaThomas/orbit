import type { OrbitSettings } from '@shared/types'
import { openDatabase, type DatabaseHandle } from '../infra/db/client'
import { AgentManager } from './agents'
import { ConversationManager } from './conversations'
import { seedDemo } from './demo-seed'
import type { EventBus } from './event-bus'
import { HealthMonitor } from './health'
import { Journal } from './journal'
import { MachineRegistry } from './machines'
import { MemoryStore } from './memory'
import { MissionManager } from './missions'
import { PermissionManager } from './permissions'
import type { PlatformServices } from './platform'
import { ProviderRegistry } from './providers'
import { SettingsStore } from './settings'
import { UsageTracker } from './usage'

/** Everything bound to one database (real or demo). Rebuilt when switching mode. */
export class OrbitRuntime {
  readonly handle: DatabaseHandle
  readonly settings: SettingsStore
  readonly journal: Journal
  readonly agents: AgentManager
  readonly providers: ProviderRegistry
  readonly usage: UsageTracker
  readonly permissions: PermissionManager
  readonly memory: MemoryStore
  readonly conversations: ConversationManager
  readonly missions: MissionManager
  readonly health: HealthMonitor
  readonly machines: MachineRegistry

  constructor(
    readonly mode: OrbitSettings['mode'],
    dbFile: string,
    readonly bus: EventBus,
    platform: PlatformServices,
  ) {
    this.handle = openDatabase(dbFile)
    const db = this.handle.db
    this.settings = new SettingsStore(db, mode)
    this.journal = new Journal(db, bus, platform, () => this.settings.get().nativeNotifications)
    this.agents = new AgentManager(db, bus, this.journal)
    this.providers = new ProviderRegistry(db, bus, this.journal, platform.secrets, this.settings, mode)
    this.usage = new UsageTracker(db, bus, this.settings)
    this.permissions = new PermissionManager(this.journal)
    this.memory = new MemoryStore(db, bus)
    this.conversations = new ConversationManager(db, bus, this.journal, this.agents, this.providers, this.usage, this.permissions, this.memory)
    this.missions = new MissionManager(db, bus, this.journal, this.agents, this.providers, this.usage, this.permissions, this.memory)
    this.health = new HealthMonitor(db, bus, this.journal, platform.fetch)
    this.machines = new MachineRegistry(db)

    this.conversations.recoverInterrupted()
    this.missions.recoverInterrupted()
    if (mode === 'real') this.agents.resetTransientStatuses()
    else seedDemo(db, this.agents, this.settings)
    this.machines.heartbeat()
  }

  start(): void {
    this.health.start()
  }

  dispose(): void {
    this.conversations.cancelAll()
    this.missions.cancelAll()
    this.health.stop()
    this.handle.close()
  }
}
