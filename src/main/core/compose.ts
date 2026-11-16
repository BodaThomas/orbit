import type { OrbitSettings } from '@shared/types'
import type { DatabaseHandle } from '../infra/db/core'
import { AgentRunner } from './agent-runner'
import { AgentManager } from './agents'
import { Scheduler } from './automations/scheduler'
import { ConstellationEngine } from './constellations/engine'
import { ConversationManager } from './conversations'
import type { AgentEngine, EngineId } from './engine/types'
import type { EventBus } from './event-bus'
import { Journal } from './journal'
import { MemoryStore } from './memory'
import { MissionManager } from './missions'
import { PermissionManager } from './permissions'
import type { PlatformServices } from './platform'
import { ProviderRegistry } from './providers'
import { SecurityService } from './security/service'
import type { ConfinementProof } from './security/seatbelt'
import { SettingsStore } from './settings'
import { UsageTracker } from './usage'

/**
 * The execution core, shared by Orbit Desktop (Electron main) and Orbit Runtime (Linux
 * daemon): one implementation of missions, tool policy, approvals, budgets,
 * constellations and scheduling, whatever the host. Hosts add their own layers
 * (health monitor and remote machines on the Mac; transport and sync on the runtime).
 */
export interface Core {
  handle: DatabaseHandle
  settings: SettingsStore
  journal: Journal
  agents: AgentManager
  providers: ProviderRegistry
  usage: UsageTracker
  permissions: PermissionManager
  memory: MemoryStore
  conversations: ConversationManager
  security: SecurityService
  runner: AgentRunner
  missions: MissionManager
  constellations: ConstellationEngine
  scheduler: Scheduler
}

export interface ComposeOptions {
  mode: OrbitSettings['mode']
  handle: DatabaseHandle
  bus: EventBus
  platform: PlatformServices
  engines: Partial<Record<EngineId, AgentEngine>>
  worktreeRoot: string
  /** Folders no tool may ever touch (the host's own data). */
  protectedPaths?: string[]
  /** Level-3 isolation self-test for this host (Seatbelt on macOS, bubblewrap on Linux). */
  confinementSelfTest?: () => ConfinementProof
  /** Clock for the scheduler (tests). */
  now?: () => number
}

export function composeCore(o: ComposeOptions): Core {
  const db = o.handle.db
  const settings = new SettingsStore(db, o.mode)
  const journal = new Journal(db, o.bus, o.platform, () => settings.get().nativeNotifications)
  const agents = new AgentManager(db, o.bus, journal)
  const providers = new ProviderRegistry(db, o.bus, journal, o.platform.secrets, settings, o.mode, undefined, o.engines)
  const usage = new UsageTracker(db, o.bus, settings)
  const permissions = new PermissionManager(journal)
  const memory = new MemoryStore(db, o.bus)
  const conversations = new ConversationManager(db, o.bus, journal, agents, providers, usage, permissions, memory)
  const security = o.confinementSelfTest ? new SecurityService(db, o.confinementSelfTest) : new SecurityService(db)
  const runner = new AgentRunner(db, o.bus, journal, agents, usage, security)
  if (o.protectedPaths?.length) runner.protectedPaths = o.protectedPaths
  const missions = new MissionManager(db, o.bus, journal, agents, providers, usage, permissions, memory, runner, security)
  agents.beforeDelete = (agentId) => missions.stopForAgent(agentId)
  const constellations = new ConstellationEngine(db, o.bus, journal, agents, missions, providers, o.worktreeRoot)
  const scheduler = new Scheduler(db, o.bus, journal, agents, missions, constellations, o.now)
  return { handle: o.handle, settings, journal, agents, providers, usage, permissions, memory, conversations, security, runner, missions, constellations, scheduler }
}
