# "Always On" architecture

```
Orbit Desktop (macOS, control center)                         Orbit Runtime (Linux, always-on engine)
┌───────────────────────────────────────┐                     ┌──────────────────────────────────────────┐
│ UI: Machines, Automations, …          │                     │ RuntimeHost (src/runtime/host.ts)        │
│ Shared core (composeCore)             │   ssh (key, pinned  │  ├─ Shared core (composeCore):           │
│ RemoteMachineManager                  │   host, forced      │  │  MissionManager · AgentRunner ·        │
│  ├─ Ed25519 client identity           │   command) ──────▶  │  │  policy/approvals · budgets ·         │
│  ├─ command queue (request_id)        │   orbit-runtime     │  │  ConstellationEngine · Scheduler       │
│  ├─ RemoteMirror (synced copy)        │   attach ─▶ Unix    │  ├─ SQLite node:sqlite (WAL)             │
│  └─ automation transfers              │   socket 0600       │  ├─ outbox (triggers) → rt_events log    │
│ SQLite better-sqlite3 (orbit.db)      │ ◀──── events ────── │  ├─ Ed25519 identity, clients, sessions  │
└───────────────────────────────────────┘                     │  ├─ artifacts (SHA-256, quota)           │
                                                              │  └─ health, metrics, JSON logs           │
                                                              └──────────────────────────────────────────┘
```

## One core

`src/main/core/compose.ts` assembles the core (missions, per-tool policy, approvals, budgets, constellations, scheduler). Orbit Desktop and the runtime both use it: a remote mission, constellation or automation runs **the same code** as a local one. The Scheduler and the ConstellationEngine have no "remote" variant.

Differences per host:

| | Orbit Desktop | Orbit Runtime |
|---|---|---|
| SQLite | better-sqlite3 (rebuilt for Electron) | `node:sqlite` through an adapter (no native module on the server) |
| Level 3 isolation | Seatbelt (`sandbox-exec`) | bubblewrap (`bwrap`), same self-test, same refusal when not proven |
| Notifications | native macOS | none: Orbit notifies from the synced state |
| API secrets | Keychain (safeStorage) | 0600 key file + AES-256-GCM (`orbit-runtime secrets set`) |

## Event log (runtime)

SQLite triggers write every insert, update and delete on the replicated tables (`REPLICATED_TABLES`, `src/runtime/protocol.ts`) into `rt_outbox`, **in the same transaction**. `EventLog.flush()` turns them into numbered events `rt_events.seq` (AUTOINCREMENT, never reused) carrying the full row state. Several changes to one row within a batch produce a single event, at the position of the first change (parents come before children), with the latest state.

- Order: commit order. Replay: `events.since(cursor)`.
- Retention: `prune(30 days)` only deletes what every active client has received; a client absent for more than 90 days no longer holds the log back. A client that has been away too long, or that was paired after a prune, receives a **consistent snapshot** (`snapshot`) taken inside a read transaction. Stored command responses (`rt_requests`) are kept for 90 days.
- Ordering: Orbit Desktop never applies an event while skipping a sequence number; a gap (an event pushed during a catch-up) triggers a new, ordered catch-up.
- Reconnection: backoff from 5 s to 60 s; a revoked client (403) is not retried. A connection whose catch-up fails is closed and fully re-established.
- Live events (text being written, activity, constellation pulses): pushed live only, never replayed, and ignored on the Mac when older than 10 s (no stale animations).

## Synced copy (Mac)

`RemoteMirror` applies events to Orbit's usual tables, tagged with the machine (`missions.remote_machine_id`, `constellation_runs.machine_id`, `approval_requests.machine_id`, `automation_runs.machine_id`, `usage_records.machine_id`, `remote_artifacts`). Rules:

- upsert by key, shared columns only; immutable columns (`short_id`) are never rewritten; a `short_id` collision with a local mission gets a machine suffix;
- a row owned by another origin is never overwritten;
- `automation_definitions`: only `next_run_at`, `last_run_at` and `status` are taken, and only if the automation belongs to that machine (the definition is still edited on the Mac);
- applying the same event twice changes nothing (cursor + upsert);
- notifications are derived from **actual transitions** (old state → new state), with a deduplication key; after an absence, a single native summary is shown instead of a burst.

Recovery at Orbit startup (`recoverInterrupted`) skips tagged rows: only their runtime knows what happened.

## Commands (Mac → runtime)

Every action on a remote object (create, cancel or continue a mission, answer an approval, start/cancel a constellation, schedule/pause/run/confirm an automation, limits) is a command:

1. recorded in `remote_commands` with a `request_id`;
2. sent; the runtime stores its result in `rt_requests`;
3. if the response is lost, the command stays "pending" and is resent on reconnection **with the same ID**: the runtime returns the result it already computed, without running it again;
4. a definitive refusal from the runtime marks it "failed", and the local copy is corrected if needed (a mission that was never accepted becomes failed, with the reason).

While offline, actions are refused (buttons disabled): nothing is queued blindly.

## Protocol v2

`src/runtime/protocol.ts`: line-delimited JSON-RPC 2.0, version checked at `hello`, **every parameter validated with zod** before execution, explicit error codes (401, 403, 404, 409, 422, 440 session expired). The contract does not depend on Electron and can be reused by a future client.

Authentication (all steps required): SSH → local token (`attach` runs as the runtime user) → **runtime identity** (Ed25519 signature of the client nonce, fingerprint pinned by the user) → **client identity** (Orbit Desktop Ed25519 key pair, pairing, single-use challenge, 12 h session, revocation).

## Approvals

The operation stays suspended in the runtime (persistent approval). Orbit shows it with its machine; the response carries `operationHash` (a hash of the ID, type, mission, tool call, summary and exact content). The runtime refuses if the request is no longer pending or if the hash differs (audited as `approval.mismatch`); a response can only be used once. Without a response, the request **expires as a refusal** (24 h by default): nothing is ever approved by default.

## Limits enforced by the runtime

`limits.put`: concurrent missions (beyond the limit, missions are queued and start on their own), maximum duration per mission (the mission is stopped), daily/monthly server budgets (measured or estimated API spend; subscriptions have no price and are not counted). They are enforced by the runtime core at every start (`MissionManager.admission`), whatever a client asks. Sub-missions of a constellation stay bounded by the constellation (no deadlock).

## Artifacts

When a mission ends: a report (final text) and the files changed **inside** its project (never outside the project, never through a symbolic link) are copied under `<home>/artifacts/<mission>/` with a SHA-256 hash. Limits: 5 MB per file, 50 MB per mission, 2 GB quota; beyond that, the artifact is recorded as "not kept" (nothing is deleted automatically). Retrieval is by ID only, with the hash checked on both sides.
