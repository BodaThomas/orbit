# Constellations

A constellation groups companions around a coordinator. Each companion keeps its own identity, engine, model, permissions and memory: a sub-mission is an ordinary mission of that companion, with all the usual guarantees (tool policy, approvals, file inventory, usage tracking).

## How a run works (`src/main/core/constellations/engine.ts`)

1. **Planning**: the coordinator receives the request, the team (roles, engines, permissions) and the limits. It can explore with its own tools (without write access), then ends with a block:
   ````
   ```orbit-plan
   {"tasks":[{"id":"research","assignee":"Milo","objective":"…","expected":"…","context":"…","dependsOn":[],"readOnly":true},
             {"id":"mockup","assignee":"Pixel","objective":"…","dependsOn":[],"readOnly":false,"writes":["mockups/v2"]}]}
   ```
   ````
2. **Validation by Orbit** (`protocol.ts`): the assignee exists, is active and belongs to the constellation, the coordinator is allowed to delegate, no self-delegation, unique task IDs, known and **acyclic** dependencies, number of sub-missions within the limit. An invalid plan gets one correction request, then fails with a clear error.
3. **Execution**: dependency graph, bounded parallelism, a write lock per folder (or Git worktrees), limits checked before each start.
4. **Context handoff**: each sub-mission receives its objective, the expected result, the context passed on by the coordinator, the results of its dependencies, the allowed folder and its constraints. Secrets are masked, lengths are capped, and a companion's personal history is never passed on. Every handoff is logged (`execution_handoffs`).
5. **Structured result**: each member ends with an `orbit-result` block (`status`, `summary`, `files`), stored on the mission.
6. **Synthesis**: results go back to the coordinator **in the same session**. It writes the synthesis or, if delegation rounds remain, delegates again.

## Permissions

`sub-mission permissions = companion permissions ∩ constellation ceiling ∩ (read-only if requested)`. Delegation can only remove permissions. The coordinator never writes anything itself while coordinating.

## Loop prevention and limits

Depth (delegation rounds), total sub-missions, parallelism, maximum duration (global stop), tokens, and a budget in measured dollars. Members cannot delegate, and the coordinator cannot assign a task to itself. Budget = observed spend + a **reservation** for running sub-missions (the average of finished sub-missions, or an equal share of the budget). For a subscription with no measurable cost, only the token, duration and count limits apply: Orbit does not promise a spending cap.

## Concurrency

- **Shared folder** (default): reads in parallel. Writers declare the folders they produce in `writes` (relative to the workspace); two writers run side by side when their scopes do not overlap, otherwise one after the other. A writer without `writes` locks the whole folder.

  Scopes are enforced, not advisory: Orbit's policy refuses any edit or detected command write outside them (inside the workspace), and the engine's command sandbox (Claude Code, Claude Agent SDK), Codex's writable roots and the strict Seatbelt profile only open those folders. Orbit creates the scope folders before the run. The scheduler only relies on scopes when the run is local and, if the sub-mission may run commands, the engine contains them (Claude engines on macOS, not in autonomous mode); otherwise the task locks the whole folder as before.
- **Git worktrees**: each writer works on `orbit/<run>/<companion>` in its own worktree (stored in Orbit's data folder), branched from a dependency's branch when there is one. When the task ends, its work is committed on its branch. Orbit detects pairwise conflicts with `git merge-tree` (without touching any checkout), shows diffs and conflicts, and merges only when you click, in a clean folder (`merge --no-ff`, `merge --abort` on conflict). Worktrees separate workspaces; they are **not** a security boundary.

## Run lifecycle

The **run** owns the lifecycle; the coordinator is one participant in it. The end of a coordinator reply never, by itself, ends the collective mission.

| State | Meaning |
| --- | --- |
| `planning` | the coordinator is preparing (or fixing) the plan |
| `awaiting_approval` | a plan or questions are waiting for your decision |
| `ready` | plan validated, sub-missions are about to start |
| `running` / `synthesizing` | sub-missions running / coordinator writing the round's synthesis |
| `paused` | no new sub-mission starts (running ones finish); also the state after Orbit is closed |
| `blocked` | action needed: a sub-mission failed, a limit was reached, the plan is out of limits or invalid, or the coordinator concluded while sub-missions remain |
| `failed` | orchestration failed (coordinator error, plan rejected twice); can be resumed |
| `completed` | all required steps are done |
| `cancelled` | explicitly cancelled, history kept |

Persisted in SQLite (`drizzle/0008_constellation_lifecycle.sql`): run status and phase, **versioned plans** (`constellation_plans`: tasks, stable hash, questions, errors, origin, decision), **events and decisions** (`constellation_run_events`), sub-missions, dependencies, handoffs, and actual working time (the duration limit excludes pauses and time spent waiting for approval).

### The `orbit-plan` block

```json
{"tasks":[…], "requestApproval": false, "questions": [], "note": "…"}
```

- `requestApproval: true`: the tasks wait for your approval before starting.
- `{"tasks":[], "questions":["…"]}`: the coordinator is waiting for your decisions; the run stays open (`awaiting_approval`).
- `{"tasks":[]}` with no questions: the collective mission is finished, unless sub-missions are still pending (then `blocked`).
- Invalid JSON, unknown member, unknown dependency, cycle, limit exceeded: the error is shown and logged, never ignored. A plan that exceeds the limits is kept: raise the run's limits to submit it.

### Human approval

Per-constellation policy (`planApproval`), set under **Validation des plans** (Plan approval) in the constellation wizard: `auto` (**Automatique**, Automatic; default for constellations created before this setting existed), `writes` (**Si le plan modifie**, If the plan modifies; default for new constellations: approval is required when a task can modify files or run commands), `always` (**Toujours**, Always). In every case, a plan received **during a conversation** with the coordinator (outside orchestration), or explicitly submitted by the coordinator, waits for a structured approval: `approvePlan(runId, planId, hash)`. The hash guarantees that you approve the version that was displayed. An approval covers that exact plan only: each sub-mission is still subject to its companion's permissions and approvals, and a new round or a modified plan asks again (except under the `auto` policy). A reply (**Répondre au coordinateur** (Reply to the coordinator)) is forwarded to the coordinator and never counts as an approval.

### Idempotence and concurrency

Each coordinator reply is read at most once (per run ID). An identical plan (same hash) is recognized, not created again. An existing task key refers to the same sub-mission: finished, it is kept and never restarted; never started, it is updated; failed or interrupted, its content is updated for the next explicit retry and its companion stays the same. A unique index on `(run, key)` enforces this in the database. Reusing the ID of a **finished** sub-mission for different work is refused (the coordinator gets a correction request), and the IDs already in use are listed for it at each retry and synthesis. All transitions are compare-and-set on the status, so a double click on **Approuver et lancer** (Approve and start) has no effect.

### Actions (run detail view)

Shown only when the state and the engine make them relevant (`detail.actions`):

- **Reprendre la mission** (Resume the mission);
- **Réessayer les sous-missions échouées** (Retry failed sub-missions): pick among the tasks of the current plan only, with previous attempts and files already modified shown;
- **Poursuivre sans elles** (Continue without them): failed tasks and tasks interrupted after they started, together with their dependents;
- **Modifier le plan** (Edit the plan): finished and running tasks are locked, the new version must be approved, differences are shown;
- **Limites** (Limits): for this run only;
- **Mettre en pause** (Pause);
- **Annuler** (Cancel), with confirmation;
- **Approuver et lancer / Refuser avec un commentaire / Répondre au coordinateur** (Approve and start / Reject with a comment / Reply to the coordinator);
- **Poursuivre avec le coordinateur** (Continue with the coordinator): a new instruction on a finished run.

## Resilience

- **Cancellation**: all running sub-missions are interrupted (their process groups are stopped) and the following ones are skipped.
- **Sub-mission failure**: its dependents stay pending and the run becomes `blocked`. Retry after checking, or continue without it. Results from the other sub-missions are kept.
- **Orbit closed**: the run is `paused` at the next launch and never restarts on its own. A sub-mission that was interrupted while it could write is only restarted if you select it explicitly.
- Pending approvals survive a restart. A sub-mission that was waiting for its start approval is picked up again on resume (never restarted).
- Changing the duration limit only affects an active or paused run (never a cancelled or finished one).
- A plan blocked by limits keeps the approval it required: raising the limits never approves it.
- The budget reservation applies as soon as a budget is set, even before any measured spend.
- A coordinator reply received outside the orchestration loop (for example in a direct conversation with the coordination mission) is still read and submitted for your approval. At startup, Orbit also re-reads replies that arrived after an older run had ended, without executing anything.
- Unfinished runs are listed at the top of the **Constellations** page.
- Nothing runs while Orbit is closed, except constellations coordinated by an Orbit Runtime server. For those, only cancellation is currently relayed from the Mac.

## Interface

**Univers** (Universe) view: planets and links whose style reflects the actual state, with a light pulse only on a real delegation or result event (a single flash when the macOS "Reduce motion" setting is on). Also an inspection panel, **Liste** (List) and **Timeline** views (duration bars and handoffs), the synthesis, and worktree merge proposals.

## Live test

`tests/constellation-multi-engine.live.test.ts` runs a real multi-engine constellation: Nova (Claude Code) coordinates, Milo (Claude Code, read-only) researches, Atlas (Codex) modifies a throw-away project after approval, and Nova checks the change and writes the synthesis. It uses your own Claude Code and Codex logins and is opt-in:

```bash
ORBIT_LIVE_CONSTELLATION=1 ORBIT_LIVE_DATA_DIR=<data dir> npm test -- constellation-multi-engine.live
```

Expected result: the run reaches `completed`, Atlas's change (made through a shell command) is detected by Orbit's file snapshot and shown on its mission. See `docs/MANUAL_TESTING.md`.
