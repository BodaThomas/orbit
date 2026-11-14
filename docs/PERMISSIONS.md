# Companion permissions

Goal: a **supervised** companion can carry out an everyday development mission without asking for confirmation at every step, while genuinely sensitive actions still require approval or are refused. This complements `docs/SECURITY.md` (isolation levels).

## Architecture

```
engine (Claude SDK / Claude Code CLI / Codex / remote runtime)
  │  PreToolUse hook (Claude) · approval request (Codex)
  ▼
engine/gate.ts ─► engine/policy.ts ─► engine/commands.ts      (decision: allow / ask / deny)
  │                      │
  │ allow "routine"      │ ask
  ▼                      ▼
io.autoAllowed        io.requestApproval
  │                      │
  ▼                      ▼
AgentRunner ──► GrantStore (stored grant?) ──► otherwise: ask the user
  │                                              │ "once / mission / always / refuse"
  ▼                                              ▼
security_audit_events (log) · permission.auto event (non-blocking notification)
```

- **`engine/commands.ts`**: analyzes a command by its **arguments and effects**: `git status` ≠ `git push --force`, `rm a.ts` ≠ `rm -rf src`, `npm test` ≠ `npm install` ≠ `npm publish`. It sees through `sh -c`, `bash -lc`, `env`, `timeout`, `xargs`, `find -exec`, `$(…)` and pipes (`curl … | sh`), follows `cd`, and resolves relative paths, `~` and `$HOME`. Anything it cannot see into (variables, scripts, unknown programs) is classified `opaque`/`unknown`, never "routine".
- **`engine/policy.ts`**: decision table by mode, exact operation key, and maximum grant scope (`grant.max`).
- **`engine/gate.ts`**: single gate for both Claude engines. `PreToolUse` hook, then `canUseTool`/`can_use_tool` if Claude still asks: the decision is computed **once per tool call** and reused, so the same action is never asked about twice.
- **`permission-grants.ts`**: persistent grants (`permission_grants` table, migration `0006`).
- **`AgentRunner`**: shared by all engines (including Codex and the remote runtime). It checks stored grants before bothering the user and logs automatic actions.

## Decision table

|                                  | Manual | Supervised | Automated | Autonomous |
|---|---|---|---|---|
| Read / search inside the folder | ✓ | ✓ | ✓ | ✓ |
| Modify a file inside the folder | approval | ✓ | ✓ | ✓ |
| Inspection (`ls`, `git status`, `rg`…) | approval | ✓ | ✓ | ✓ |
| Tests, checks, builds, local Git | approval | ✓ if commands are contained, otherwise first-time approval | ✓ | ✓ |
| Unknown command / opaque effect | approval | approval | Claude's `auto` classifier if active, otherwise ✓ if contained, otherwise approval | ✓ |
| Web | approval | approval | ✓ | ✓ |
| Installs, remote/destructive Git, mass deletion, deployment, remote database, publishing, secrets, system, hooks | approval | approval | approval | ✓ (logged) |
| MCP tools | approval | approval | approval | ✓ (logged) |
| Outside the folder | file tools: refused · commands: approval (never storable) ||| ✓ (logged) |
| Mission started by an automation | refused | approval if sensitive permissions | ✓ | ✓ |
| Companion permission turned off | **refused** ||||
| Orbit's own data (database, grants, engine config) | **refused**, always ||||

### Full autonomy (`autonomous`)

Full delegation, chosen explicitly for each companion (in the companion wizard, **Cadre** (Boundaries) step). The policy **never** returns `ask`: everything the companion's permission switches allow runs and appears in the log of actions taken without confirmation. Two limits remain: Orbit's own data (refused) and permissions that are turned off (refused, never a question). To restrict an autonomous companion, reduce its permissions or enable reinforced isolation (level 3, Seatbelt), which still applies.

On the engine side: Claude (SDK and CLI) runs in `permissionMode: default` with Orbit's hook approving, **without** the command sandbox (it turned installs, `git push` or global tools into failures). Codex runs in `workspace-write`, with network access according to the permission, and escalations accepted by the policy. Safety net in `AgentRunner`: any question that still reaches Orbit (an engine's own prompt, a remote daemon running an older policy) is accepted and logged instead of waiting. Plan approval for a constellation is still governed by the constellation itself (its plan approval setting: automatic / if the plan modifies / always).

"Contained" (`commandsContained`) means that Orbit itself configured an OS sandbox that limits command writes to the folder and the temporary folder, and that **fails** rather than running without it: Claude SDK and Claude Code CLI on macOS (`sandbox.failIfUnavailable: true`), or proven reinforced isolation. Codex escalated commands are not contained: in supervised mode, `npm test` therefore asks for a first approval there (storable as "always"), and so does modifying the files that decide what tests run (`package.json`, `Makefile`, `*.config.ts`…).

Files that are executed **later, outside the sandbox** (`.git/`, `.claude/`, `.codex/`, `.vscode/`, `.husky/`, CI workflows…) always require approval.

## Engine integration

**Claude Agent SDK**: explicit `permissionMode`: `default` (manual, supervised) or `auto` (automated). Never `bypassPermissions`. `PreToolUse` hook (`onFailure: 'block'`) plus `canUseTool` on the same gate. The mode actually applied is read back from the `init` message: if `auto` is not available, a warning is emitted and Orbit stops delegating any decision to the engine.

**Claude Code CLI**: explicit `--permission-mode default|auto` (without it, `claude -p` picks `auto` where available), `--settings '{"sandbox":…}'` (honored under `--restricted`), and above all a **PreToolUse hook registered in the `initialize` request**: every tool call goes through Orbit, including those the CLI would allow on its own. `hook_callback` replies with a different ID are refused.

**Codex**: the sandbox is unchanged (read-only in supervised mode: every write is escalated to Orbit). Routine escalations are accepted by the policy without bothering you.

**Remote runtime**: the daemon's policy applies. Requests that reach the Mac go through `AgentRunner`, so persistent grants apply there too. The daemon's automatic actions are not yet logged on the Mac.

## Persistent grants

Choices offered on a request: **Autoriser une fois** (Allow once) · **Pour cette mission** (For this mission) · **Toujours** (Always) · **Refuser** (Refuse), within the `grant.max` scope set by the policy:

- `always`: routine or unknown commands, installs, remote Git, web (per site);
- `mission`: mass deletion, destructive Git, deployment, databases, publishing, hooks, reading a specific `.env` file;
- `once` only: secrets in a command, modifying a sensitive file, system commands, anything outside the folder.

A grant covers **the exact operation** (same command words, same file, same site), for **this companion**, in **this real folder** (and this mission, for mission scope). It never turns a policy refusal into an approval. Grants live in Orbit (no `updatedPermissions` is ever sent to the engine): revoking one (**Profil → Permissions** (Profile → Permissions), or **Paramètres → Sécurité & audit** (Settings → Security & audit)) takes effect at the next action. The main process checks the scope: a scope that is too broad is refused and the request stays open.

A companion cannot change its own permissions: grants are only created through the interface's IPC, and any tool targeting Orbit's data folder is refused (except its own files inside a constellation worktree).

## Interface

- Approval card: action family (in red if sensitive) and the four choices.
- Profil → Permissions: explanation of the modes, the **Autorisé sans confirmation** (Allowed without confirmation) list, stored grants (revocable), and **Historique sans confirmation** (History without confirmation).
- Paramètres → Sécurité & audit: all grants and the global history.
- A non-blocking notification (grouped by mission) for each action run without confirmation.

## Known limitations

- Command analysis is a heuristic on text. Anything it cannot read is never classified as routine, but `npm test` still runs the project's code. The guarantee against writes outside the folder comes from the command sandbox, not from the analysis.
- The allowed folder is not a sandbox for **reads** without reinforced isolation (level 3) or a remote runtime.
- `auto` mode depends on the account and the model. Orbit checks it and falls back otherwise.

## Tests

`tests/permissions.test.ts`: classification by arguments, subshells, substitutions, heredocs, quoting; bypass attempts through relative paths, `cd`, `~`/`$HOME`, symlinks, redirections, child processes, Git hooks and Orbit's data; grant scopes and revocation; a single question for an operation allowed "always"; hooks and modes actually applied by both Claude adapters (no double approval, warning if the mode differs).
