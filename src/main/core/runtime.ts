import { dirname } from 'node:path'
import type { OrbitSettings } from '@shared/types'
import { openDatabase, type DatabaseHandle } from '../infra/db/client'
import { AgentRunner } from './agent-runner'
import { AgentManager } from './agents'
import { ConversationManager } from './conversations'
import { seedDemo } from './demo-seed'
import { claudeConfigDir, createClaudeAgentEngine, resolveClaudeExecutable } from './engine/claude-agent'
import { createClaudeCodeEngine } from './engine/claude-code'
import { createCodexEngine } from './engine/codex'
import type { AgentEngine, EngineId } from './engine/types'
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
import { SecurityService } from './security/service'
import { ConstellationEngine } from './constellations/engine'
import { Scheduler } from './automations/scheduler'
import { RemoteMachineManager } from './remote/manager'
import { join } from 'node:path'

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
  readonly runner: AgentRunner
  readonly health: HealthMonitor
  readonly machines: MachineRegistry
  readonly security: SecurityService
  readonly constellations: ConstellationEngine
  readonly scheduler: Scheduler
  readonly remote: RemoteMachineManager

  constructor(
    readonly mode: OrbitSettings['mode'],
    dbFile: string,
    readonly bus: EventBus,
    platform: PlatformServices,
    engines?: Partial<Record<EngineId, AgentEngine>>,
  ) {
    this.handle = openDatabase(dbFile)
    const db = this.handle.db
    this.settings = new SettingsStore(db, mode)
    this.journal = new Journal(db, bus, platform, () => this.settings.get().nativeNotifications)
    this.agents = new AgentManager(db, bus, this.journal)
    const dataDir = dirname(dbFile)
    this.providers = new ProviderRegistry(
      db,
      bus,
      this.journal,
      platform.secrets,
      this.settings,
      mode,
      undefined,
      engines ?? {
        'claude-agent': createClaudeAgentEngine({ configDir: claudeConfigDir(dataDir), pathToExecutable: resolveClaudeExecutable() }),
        codex: createCodexEngine({ clientVersion: platform.appVersion }),
        'claude-code': createClaudeCodeEngine(),
      },
    )
    this.usage = new UsageTracker(db, bus, this.settings)
    this.permissions = new PermissionManager(this.journal)
    this.memory = new MemoryStore(db, bus)
    this.conversations = new ConversationManager(db, bus, this.journal, this.agents, this.providers, this.usage, this.permissions, this.memory)
    this.security = new SecurityService(db)
    this.runner = new AgentRunner(db, bus, this.journal, this.agents, this.usage, this.security)
    // Orbit's data (database with grants and audit, engine config): out of reach of every tool.
    if (dbFile !== ':memory:') this.runner.protectedPaths = [dataDir]
    this.missions = new MissionManager(db, bus, this.journal, this.agents, this.providers, this.usage, this.permissions, this.memory, this.runner, this.security)
    this.health = new HealthMonitor(db, bus, this.journal, platform.fetch)
    this.machines = new MachineRegistry(db)
    this.constellations = new ConstellationEngine(db, bus, this.journal, this.agents, this.missions, this.providers, join(dataDir, 'worktrees'))
    this.remote = new RemoteMachineManager(db, bus, this.journal, dataDir, platform.runtimeBundle ?? (() => null))
    this.missions.remoteEngine = (agent) => this.remote.engineFor(agent)
    this.remote.onRemoteOutcome = (executionId, outcome) => this.missions.applyRemoteOutcome(executionId, outcome)
    this.remote.resetOnBoot()
    this.scheduler = new Scheduler(db, bus, this.journal, this.agents, this.missions, this.constellations)

    this.conversations.recoverInterrupted()
    this.missions.recoverInterrupted()
    this.constellations.recoverInterrupted()
    if (mode === 'real') this.agents.resetTransientStatuses()
    else seedDemo(db, this.agents, this.settings)
    this.machines.heartbeat()
  }

  start(): void {
    this.health.start()
    // Demo mode never runs scheduled work against fake data.
    if (this.mode === 'real') this.scheduler.start()
  }

  dispose(): void {
    this.scheduler.stop()
    this.remote.disposeAll()
    this.constellations.cancelAll()
    this.conversations.cancelAll()
    this.missions.cancelAll()
    this.health.stop()
    this.handle.close()
  }
}
