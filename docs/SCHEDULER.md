# Schedulers: this Mac or a server

The same `Scheduler` (`src/main/core/automations/scheduler.ts`) runs in Orbit Desktop and in each runtime. For recurrence rules, IANA time zones and daylight saving time, see `docs/AUTOMATIONS.md`.

## A single owner

Each automation has a `scheduler_owner` (`local` or a machine ID) and an `owner_state` (`active` | `transferring`). A scheduler fires **only** what it owns and what is `active` (scheduled runs, catch-ups, event triggers, recovery at startup). On the runtime side, a received automation is `local`. Once handed back to the Mac, it becomes `released` (kept for history, never fired).

## Transfer

`RemoteMachineManager.transferAutomation(id, to)`:

1. checks the target: machine online, companion (or the whole constellation) placed on it, engine ready;
2. sets the automation to `transferring`: **no scheduler fires it anymore**;
3. if the previous owner is a runtime: `automation.release`, confirmed;
4. pushes the companion(s) or constellation, then `automation.put` (version = `config_version`), and reads it back with `automation.get`;
5. only then: `scheduler_owner = to`, `active`, next run taken from the server.

If any step fails or a reply is lost, the automation stays `transferring`. On every reconnection, `reconcileTransfers` reads the actual state on both sides and finishes the transfer (the commands are idempotent). **Annuler le transfert** (Cancel transfer) only gives the automation back to its previous owner after the target has confirmed the release. **Two schedulers are never active at once**: `tests/always-on-scheduler.test.ts` covers this, including a reply lost during the transfer.

Moving back to the Mac: occurrences that fell during the transfer are not replayed; scheduling resumes from the current time.

## Editing a remote automation

The definition is still edited in Orbit. Each save increments `config_version` and is pushed to the server, which refuses an older version. Pause, resume, **Exécuter maintenant** (Run now) and confirming a missed run are commands sent to the server. When the server is offline, these actions are disabled and the last known state is shown.

## Reliability

| Situation | Behavior |
|---|---|
| Duplicate tick, restart | one run per occurrence (`automation + instant` key, unique index) |
| Runtime stopped at the scheduled time | at restart, the automation's policy applies (skip / catch up once / ask); noted as "runtime stopped" |
| Target that can modify files | never re-run without confirmation after downtime, even with "catch up once" |
| Run interrupted by a restart | marked "uncertain", never replayed |
| Maximum duration | target stopped, run marked "failed" with the reason |
| Automation budget (24 h) | occurrence skipped and notified |
| Failure | notify, or pause the automation (configurable) |
| Companion unavailable / engine missing | mission failed with the reason, visible in the history |
| Approval with no answer | expires as a refusal (24 h) |
| Missed run waiting for confirmation | expires as a refusal after 24 h; refused if the automation was paused or transferred in the meantime |
| Constellation target | the run is only closed in a final state (`completed` → succeeded, `cancelled` → cancelled); `paused` / `blocked` / `failed` can still be resumed, bounded by the maximum duration |
| Recurrence that never occurs (`0 0 30 2 *`, one-off date in the past) | rejected on creation and on edit |

Guarantee: **at most one run per occurrence**, covered by the tests. There is no "exactly once" guarantee: depending on the policy, an occurrence can be skipped if the server was down.
