import { dirname, join } from 'node:path'
import type { OrbitSettings } from '@shared/types'
import { openDatabase, type DatabaseHandle } from '../infra/db/client'
import type { AgentRunner } from './agent-runner'
import type { AgentManager } from './agents'
import type { Scheduler } from './automations/scheduler'
import { composeCore } from './compose'
import type { ConstellationEngine } from './constellations/engine'
import type { ConversationManager } from './conversations'
import { seedDemo } from './demo-seed'
import { claudeConfigDir, createClaudeAgentEngine, resolveClaudeExecutable } from './engine/claude-agent'
import { createClaudeCodeEngine } from './engine/claude-code'
import { createCodexEngine } from './engine/codex'
import type { AgentEngine, EngineId } from './engine/types'
import type { EventBus } from './event-bus'
import { HealthMonitor } from './health'
import type { Journal } from './journal'
import { MachineRegistry } from './machines'
import type { MemoryStore } from './memory'
import type { MissionManager } from './missions'
import type { PermissionManager } from './permissions'
import type { PlatformServices } from './platform'
import type { ProviderRegistry } from './providers'
import { RemoteMachineManager } from './remote/manager'
import { Inbox } from './inbox'
import type { SecurityService } from './security/service'
import type { SettingsStore } from './settings'
import type { UsageTracker } from './usage'

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
  readonly inbox: Inbox

  constructor(
    readonly mode: OrbitSettings['mode'],
    dbFile: string,
    readonly bus: EventBus,
    platform: PlatformServices,
    engines?: Partial<Record<EngineId, AgentEngine>>,
  ) {
    this.handle = openDatabase(dbFile)
    const db = this.handle.db
    const dataDir = dirname(dbFile)
    const core = composeCore({
      mode,
      handle: this.handle,
      bus,
      platform,
      engines: engines ?? {
        'claude-agent': createClaudeAgentEngine({ configDir: claudeConfigDir(dataDir), pathToExecutable: resolveClaudeExecutable() }),
        codex: createCodexEngine({ clientVersion: platform.appVersion }),
        'claude-code': createClaudeCodeEngine(),
      },
      worktreeRoot: join(dataDir, 'worktrees'),
      // Orbit's data (database with grants and audit, engine config): out of reach of every tool.
      protectedPaths: dbFile !== ':memory:' ? [dataDir] : [],
    })
    this.settings = core.settings
    this.journal = core.journal
    this.agents = core.agents
    this.providers = core.providers
    this.usage = core.usage
    this.permissions = core.permissions
    this.memory = core.memory
    this.conversations = core.conversations
    this.security = core.security
    this.runner = core.runner
    this.missions = core.missions
    this.constellations = core.constellations
    this.scheduler = core.scheduler
    this.health = new HealthMonitor(db, bus, this.journal, platform.fetch)
    this.machines = new MachineRegistry(db)
    this.inbox = new Inbox(db, bus)
    this.remote = new RemoteMachineManager(this.handle, bus, this.journal, dataDir, platform.runtimeBundle ?? (() => null), undefined, platform.secrets)
    this.remote.attach({ missions: this.missions, constellations: this.constellations, scheduler: this.scheduler, agents: this.agents })
    this.remote.resetOnBoot()

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
    if (this.mode === 'real') {
      this.scheduler.start()
      this.remote.start()
    }
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
