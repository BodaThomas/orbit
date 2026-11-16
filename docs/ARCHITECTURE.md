# Architecture

This document is a map of the codebase for maintainers and contributors. It explains how Orbit is put together and why. Topic documents go deeper on each subsystem; they are linked from the relevant sections instead of being repeated here.

## Overview

Orbit is an Electron app for macOS that supervises AI agents ("companions"). Agents do not run inside Orbit: Orbit drives existing engines (Claude Code CLI, Claude Agent SDK, Codex app-server) or calls provider APIs directly for plain chat, and puts its own policy, approvals, budgets and bookkeeping around them.

The same execution core also runs headless on Linux as **Orbit Runtime**, so companions can keep working while the Mac is closed.

## Processes

| Process | Entry point | Role |
|---|---|---|
| Main | `src/main/index.ts` | Owns the window, menus, CSP, native notifications and the database. Builds an `OrbitRuntime` (`src/main/core/runtime.ts`) for the current mode (real or demo) and routes IPC to it. |
| Preload | `src/preload/index.ts` | Sandboxed bridge. Exposes only `window.orbit.invoke(channel, input)`, `window.orbit.onEvent(listener)` and `platform`. |
| Renderer | `src/renderer/src/main.tsx` | React UI. Holds no secrets and no business logic beyond presentation. |
| Engine processes | spawned by `src/main/core/engine/*` | `claude` and `codex` binaries, run in their own process group so they can be stopped without orphans (`engine/process.ts`). |
| Linux runtime | `src/runtime/main.ts` | `orbit-runtime` CLI: `daemon`, `attach`, `health`, `doctor`, `unit`, `clients`, `secrets`, `version`. Bundled by `scripts/build-runtime.mjs` into a single `out/runtime/orbit-runtime.mjs`. |

Electron hardening: `contextIsolation`, `sandbox: true`, `nodeIntegration: false`, a strict CSP, navigation and `window.open` blocked, and IPC calls refused when they do not come from the app's own origin.

## Source layout

```
src/
  shared/              Code imported by main, renderer and runtime
    ipc.ts             IPC contract: Zod input schemas, output types, event types
    types.ts           Domain types
    mission-states.ts  Mission state machine (allowed transitions)
    constellation-states.ts
    schedule.ts        Recurrences, IANA time zones, DST, cron
    stats.ts           Single definition of companion states and counters
    permissions-matrix.ts  Effective permissions (policy + engine + sandbox + isolation)
    pricing.ts         Dated price tables for cost estimates
    engines.ts, catalog.ts, permission-labels.ts, remote.ts
  main/
    index.ts           Electron bootstrap
    ipc/               router.ts (validate + dispatch), handlers.ts (one handler per channel)
    core/              Execution core, free of Electron imports
      compose.ts       composeCore(): wires the core for any host
      runtime.ts       Desktop host: core + health monitor + remote machines
      agents.ts, missions.ts, agent-runner.ts, conversations.ts, memory.ts,
      permissions.ts, permission-grants.ts, usage.ts, journal.ts, settings.ts,
      providers.ts, health.ts, machines.ts, event-bus.ts, demo-seed.ts
      engine/          Engine adapters and the tool policy
      constellations/  Delegation protocol, orchestration engine, Git worktrees
      automations/     Persistent scheduler and triggers
      remote/          Runtime client, transports (SSH, socket), mirror, machine manager
      security/        Sensitive files, Seatbelt (macOS) and bubblewrap (Linux) isolation
      files/           Before/after snapshots and diffs of working folders
    infra/
      db/              Drizzle schema, migration runner, better-sqlite3 and node:sqlite drivers
      providers/       Chat adapters: Anthropic, OpenAI, demo, plus "planned" placeholders
      logger.ts
  preload/             The bridge described above
  renderer/src/
    pages/             One file per screen (Overview, Universe, Missions, Constellations, ...)
    orbit/             Orbit-specific components (avatars, planets, approval cards, ...)
    components/        Generic UI primitives and the app shell
    lib/               Typed API client, TanStack Query setup, formatting
    stores/            Zustand stores (UI state, a small in-app router)
  runtime/             Linux daemon: host, protocol, event log, identity, artifacts
drizzle/               SQL migrations (embedded at build time)
deploy/                install.sh, Dockerfile, validate-linux.sh
tests/                 Vitest suites; *.live.test.ts need real engines or credentials
```

## Domain concepts

**Companion** (`agents` table, `core/agents.ts`). A configured agent: name, role, appearance (the avatar and its planet, stored in `agent_appearances`), provider/engine, model, instructions, autonomy level, permissions, working folder, budget, and placement (local or a remote machine).

**Conversation** (`core/conversations.ts`). Streaming chat with a provider API (Anthropic Messages, OpenAI Responses, or the offline demo provider). A conversation row holds the provider session id when there is one. Companions on an agent engine work through missions instead of chat.

**Mission** (`core/missions.ts`). A unit of work given to a companion. For agent engines, a mission *is* an engine session: `missions.session_id` keeps the Claude session or Codex thread, and every follow-up creates a new `mission_executions` row with its own prompt and usage. Status changes go through the state machine in `shared/mission-states.ts`; anything not listed there is rejected. After a restart, interrupted missions and stale approval requests are recovered, never silently resumed.

**Engine** (`core/engine/`). A common contract (`types.ts`): `run(request, io)` emits normalized events (session, status, delta, message, tool started/completed, file changed, usage, warning) and calls `io.requestApproval()` when needed. Adapters: `claude-code.ts` (official `claude` binary over stream-json with `can_use_tool` control requests), `claude-agent.ts` (Claude Agent SDK), `codex.ts` + `codex-rpc.ts` (`codex app-server` JSON-RPC). `AgentRunner` connects a run to Orbit: tool calls, file changes, approvals, activity, usage. See [ENGINES.md](ENGINES.md).

**Permissions** (`engine/policy.ts`, `engine/commands.ts`, `engine/gate.ts`, `core/permission-grants.ts`). Every tool call goes through one gate that returns allow, ask or deny. Commands are classified by arguments and effects, including through `sh -c`, pipes and substitutions; anything the analyzer cannot see is treated as unknown, never as routine. Remembered decisions (once, mission, always) live in `permission_grants`. See [PERMISSIONS.md](PERMISSIONS.md) and [SECURITY.md](SECURITY.md).

**Constellation** (`core/constellations/`). A team: a coordinator and members. The coordinator returns a structured plan, which is validated into an acyclic graph of sub-missions, optionally approved by the user, then executed with bounded depth, parallelism, duration, tokens and budget. Writes are serialized with a lock or isolated in Git worktrees. Results are synthesized in the coordinator's session. See [CONSTELLATIONS.md](CONSTELLATIONS.md).

**Automation** (`core/automations/scheduler.ts`, `shared/schedule.ts`). A recurring or event-triggered mission or constellation run, with an explicit time zone, a missed-run policy and idempotent run keys. See [AUTOMATIONS.md](AUTOMATIONS.md) and [SCHEDULER.md](SCHEDULER.md).

**Remote runtime** (`src/runtime/`, `core/remote/`). A Linux daemon hosting the same core, reached over SSH. The Mac keeps a synchronized copy of remote entities and sends commands. See [RUNTIME_ARCHITECTURE.md](RUNTIME_ARCHITECTURE.md), [REMOTE_RUNTIME.md](REMOTE_RUNTIME.md), [REMOTE_SETUP.md](REMOTE_SETUP.md) and [BACKUP_RESTORE.md](BACKUP_RESTORE.md).

**Usage and stats** (`core/usage.ts`, `shared/stats.ts`, `shared/pricing.ts`). Usage records carry a cost kind (official, estimated, subscription, unknown) and a pricing version. Subscription usage is never converted into a dollar amount. See [STATS.md](STATS.md).

## The shared core

`composeCore()` in `src/main/core/compose.ts` builds the whole execution core from a database handle, an event bus, a set of engines and a `PlatformServices` object (`core/platform.ts`: secret cipher, native notifications, fetch, app version). Nothing under `src/main/core` imports Electron.

- On the Mac, `OrbitRuntime` adds the provider health monitor, the machine registry and `RemoteMachineManager`. It is rebuilt when switching between real and demo mode.
- On Linux, `src/runtime/host.ts` adds the transport, client identities, the event log and artifacts.
- Tests instantiate the core directly, outside Electron.

## Data layer

SQLite through Drizzle ORM. The schema is in `src/main/infra/db/schema.ts`; migrations are SQL files in `drizzle/`.

- **Drivers.** The desktop uses `better-sqlite3` (rebuilt for Electron). The runtime uses Node's built-in `node:sqlite` behind a small adapter (`infra/db/node-sqlite.ts`) that exposes the same surface, so the runtime needs no native module. `ORBIT_TEST_DB=node npm test` runs the whole suite on `node:sqlite`.
- **Migrations.** `infra/db/migrations.ts` embeds `drizzle/*.sql` at build time with `import.meta.glob`; `scripts/build-runtime.mjs` inlines the same files for the runtime. `runMigrations()` in `infra/db/core.ts` applies pending files in name order, one transaction each, and records them in `__orbit_migrations`. Orbit does not use drizzle-kit's migrator or its journal at runtime.
- **Adding a migration.** Change the schema, run `npm run db:generate`, review the SQL. Migrations so far are additive only (no dropped columns or tables), and should stay that way so an older database always upgrades in place. Note that `0008_constellation_lifecycle.sql` was written by hand and has no snapshot in `drizzle/meta/`; check the next generated migration for duplicated statements.
- **Pragmas.** WAL, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`. The database files are created with mode 0600.
- **Files.** `~/Library/Application Support/Orbit/orbit.db` for real data and `orbit-demo.db` for demo mode (`ORBIT_DATA_DIR` overrides the folder). Demo data never shares a database with real data.
- **Legacy tables.** `scheduled_jobs` is no longer used; automations live in `automation_definitions`, `automation_triggers` and `automation_runs`.

## IPC contract

`src/shared/ipc.ts` is the single source of truth for the main/renderer boundary.

- `ipcSchemas` maps every channel name (`agents.create`, `missions.followUp`, `constellations.approvePlan`, ...) to a Zod input schema. `IpcOutputs` gives the return type of each channel.
- All calls go through one Electron channel, `orbit:invoke`. `ipc/router.ts` rejects unknown channels, parses the input with the channel's schema, calls the matching function in `ipc/handlers.ts`, and returns `{ ok: true, data }` or `{ ok: false, error: { code, message } }`. Stack traces never reach the renderer.
- Events flow the other way on `orbit:event`. The core emits typed `OrbitEvent`s on the `EventBus` (`message.delta`, `mission.event`, `mission.tool`, `constellation.signal`, `invalidate`, ...). `invalidate` events are coalesced over a short window and mapped to TanStack Query keys in `renderer/src/lib/queries.ts`, so screens refetch instead of patching state by hand.
- In the renderer, `lib/api.ts` exposes a typed `call(channel, input)`.

To add a channel: add the schema to `ipcSchemas`, the output type to `IpcOutputs`, the handler in `handlers.ts`, and an invalidation scope if the call changes data other screens show.

## Key design decisions

**Drive official engines, do not reimplement them.** Orbit supervises the real Claude Code binary, the Claude Agent SDK and `codex app-server`, using each tool's own authentication. It never reads engine credentials or reuses consumer sessions. Codex is driven through `app-server` rather than `codex exec` because only the former supports interactive approvals.

**Permissions are enforced in the execution path, never by the prompt.** For Claude engines, only allowed tools exist in the session, user and project settings are not loaded (`settingSources: []`), configuration is isolated in Orbit's data folder, and a `PreToolUse` hook that fails closed plus the permission callback send every call to Orbit's policy. For Codex, the system sandbox is read-only for supervised companions so every write becomes an escalation that Orbit decides.

**Three independent security layers.** Orbit's policy, the engine's own sandbox, and optional hardened isolation (Seatbelt on macOS, bubblewrap on Linux) that is only offered when a self-test proves it works on that machine. A working folder or a prompt is never presented as isolation. See [SECURITY.md](SECURITY.md).

**Capabilities are declared, not assumed.** Each provider adapter declares what it supports (streaming, tools, cancel, usage, sessions). Providers that are not implemented are registered as `planned` with no capabilities, and the UI reads these declarations.

**Costs are labeled by how they were obtained.** Official usage, dated estimates, subscription usage and unknown costs are kept apart. Dollar budgets apply only where a dollar figure exists.

**Secrets stay in the main process.** API keys are encrypted with Electron `safeStorage` (key held in the macOS Keychain); only ciphertext is stored. The renderer only learns that a key exists.

**One core, two hosts.** The Linux runtime runs the same `composeCore()` as the desktop, so remote missions, constellations and automations get the same policy, approvals, budgets and limits. An earlier, simplified remote executor was replaced for this reason.

**Transactional outbox for sync.** On the runtime, SQLite triggers write every change to replicated tables into an outbox in the same transaction; a flush turns them into numbered events carrying the full row. Nothing can change without producing an event, replay from a cursor is straightforward, and applying events on the Mac is an idempotent upsert. A gap in sequence numbers triggers an ordered catch-up; a client that is too far behind receives a snapshot.

**The Mac is a control center for remote work.** Remote entities are mirrored into the regular tables, tagged with their machine, so existing screens display them unchanged. The Mac never writes those rows itself: every action is a command with an idempotent request id, and the UI updates when the resulting event comes back.

**One scheduler owns each automation.** An automation is owned either by the Mac or by one machine. Transfers disable the old owner first and switch only after reading the new owner's state; while uncertain, the automation stays in a neutral `transferring` state that no scheduler fires. Delivery is at most once, not exactly once.

**SSH plus application-level identity.** No port is opened. Orbit connects with `ssh ... orbit-runtime attach` using a pinned host key and a key restricted to that command. On top of SSH, the runtime and each client have Ed25519 identities, pairing is explicit, and each session signs a one-time challenge. Remote approvals are single-use and bound to a hash of the operation.

**Minimal configuration sync.** The runtime receives a versioned subset of a companion's configuration. API keys, chat history, full memory, Mac paths and tokens are never sent. Engines on the server are logged in by the user on the server.

**Placement is explicit.** A companion runs locally or on one machine, and its engine must be available there; Orbit refuses rather than silently switching engine or billing mode. A constellation runs remotely only if the coordinator and all members are on the same machine.

**Demo mode is fully separate.** A distinct database, an offline provider that streams local responses, and a permanent banner. No demo data is mixed with real data.

## Testing

`npm test` runs Vitest inside Electron's Node so the same `better-sqlite3` binary is used. Suites cover the policy and command analyzer, engine adapters against faithful fakes, missions and recovery, constellations (including real Git worktrees), schedules and DST, and the runtime: `tests/always-on*.test.ts` start a real runtime and a real desktop core connected by a socket. Files named `*.live.test.ts` need installed engines, credentials or Docker and are skipped unless their environment variable is set (see the README). Manual checks against real accounts and servers are described in [MANUAL_TESTING.md](MANUAL_TESTING.md).
