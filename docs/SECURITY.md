# Companion security

Smart permissions (modes, common actions, persistent grants) are described in [`docs/PERMISSIONS.md`](PERMISSIONS.md). This document describes what Orbit actually guarantees, layer by layer, and what it does not. It is the reference for the **Paramètres → Sécurité & audit** (Settings → Security & audit) screen and for the **Permissions** tab of each companion.

## Audit findings

| Area | Finding | Fix |
|---|---|---|
| Codex, supervised companion | Read-only Seatbelt sandbox: **writes** are blocked, but a read-only command (`cat /etc/…`, `cat ~/.ssh/…`) can **read outside the folder**. | Documented; level 3 (below); detection of outside and sensitive paths in commands. |
| Codex, **Exécuter des commandes** (Run commands) permission disabled | The `on-request` policy let Codex run **any** command that stayed inside its sandbox: the permission was partly cosmetic. | `approvalPolicy: untrusted` when the permission is disabled: only read commands that Codex considers safe go through; any other command is escalated, then refused by Orbit. Observed in live tests: Codex then often gives up on modifying a file. |
| Claude (SDK and CLI) | Read tools are confined to the folder; an approved Bash command can read elsewhere. | Same: a command mentioning an outside or sensitive path requires approval; level 3. |
| Symbolic links | Already resolved by the policy (longest real prefix). | Tested; level 3 also blocks them at the kernel level. |
| Sensitive files (`.env`, SSH keys, `.npmrc`, `credentials.json`…) | Readable without approval when inside the folder. | Approval required, even in automatic mode (`.env.example` stays free). |
| Child processes | A stopped engine could leave orphaned commands behind. | Each engine runs in its own process group; stopping it stops the whole group; all are killed when Orbit quits. |
| Displayed status | "Permission disabled" could coexist with an equivalent action that was still executable. | Matrix of **effective** permissions (`shared/permissions-matrix.ts`), tested. |

## The three levels

### Level 1: Orbit policy (always on)

`src/main/core/engine/policy.ts` decides `allow / ask / deny` for **every** action, on the execution path (`PreToolUse` hook + `canUseTool` for the SDK, `can_use_tool` control requests for Claude Code, approval requests for Codex). A model cannot get around it with text.

- Allowed folder, resolved paths (including symbolic links), `../` refused.
- Sensitive files: human approval.
- Destructive commands (`rm -rf`, `git push`, `sudo`, `curl | sh`…), commands touching a sensitive location or mentioning a path outside the folder: human approval.
- Unknown tools: refused.

**Limitation:** a shell command is opaque. Orbit sees the command text, not what it will actually read (variables, scripts). This level is not isolation.

### Level 2: engine sandbox

- **Codex**: Seatbelt (macOS), provided by Codex. Supervised: read-only, every write is escalated to Orbit. Automatic: writes limited to the folder. Network off unless permitted.
- **Claude Code CLI**: `--restricted` (user/project settings ignored, file tools confined to the working directories, `bypassPermissions` refused), `--strict-mcp-config`, tools limited through `--tools`.
- **Claude Agent SDK**: limited tools, `settingSources: []`, isolated configuration, sandbox for Bash commands.

**Limitation:** these sandboxes restrict writes and network access, **not all reads**.

### Level 3: hardened isolation on this Mac (optional, per companion)

`src/main/core/security/seatbelt.ts`: an Orbit Seatbelt profile (`sandbox-exec`) wraps **the engine's whole process tree** (the engine and every command it starts). The kernel refuses:

- any read or write under `$HOME`, except: the project folder, the engine's login folder (`~/.claude`, `~/.codex`), developer toolchains installed under `$HOME` (mise, nvm, cargo…) and their caches;
- any write outside the project, temporary folders and the engine's state.

It is only offered if an **empirical self-test** passes on this Mac (fake files only, about 100 ms): allowed read, outside read refused, fake SSH key unreadable, symbolic link blocked, child process confined, outside write refused, inside write allowed. A "strict" companion whose self-test fails **does not start** (there is never a silent fallback to standard mode).

Claude Code CLI works under this profile (covered by the `claude-code.live` test).

**Remaining exposure, accepted and shown in the UI:**
- the engine's login folder stays readable (it may contain its token, e.g. `~/.codex/auth.json`);
- the macOS Keychain files (`~/Library/Keychains`, encrypted) stay readable for Claude Code, which needs them for its login;
- system folders outside `$HOME` (`/etc`, `/usr`…) stay readable;
- the other listed tool folders (npm caches…) are readable;
- `sandbox-exec` is marked deprecated by Apple, although Codex and Claude Code use it themselves.

### Strong isolation: a separate machine

Only a separate machine (VPS, VM) guarantees that no data from this Mac is reachable: this is the **remote runtime** ([`docs/RUNTIME_ARCHITECTURE.md`](RUNTIME_ARCHITECTURE.md), [`docs/REMOTE_SETUP.md`](REMOTE_SETUP.md)). The runtime can also run in a Linux container (`deploy/Dockerfile`, see [`docs/REMOTE_SETUP.md`](REMOTE_SETUP.md)).

## What is never done

- No `--dangerously-skip-permissions`, no `bypassPermissions`. No permission rule is ever written into the engine (`updatedPermissions` is never sent): "for this mission" / "always" grants live in Orbit, are limited to the exact operation and can be revoked (see [`docs/PERMISSIONS.md`](PERMISSIONS.md)).
- Orbit never reads OAuth tokens, Keychain items or cookies.
- No Orbit API key is passed to Claude Code CLI or to the remote runtime.
- Secrets are masked before any context is passed between companions (`redactSecrets`).
- Git worktrees separate workspaces; they are **not** a security boundary.

## Audit log

Every policy refusal and every human decision (approved / refused / expired) is recorded in `security_audit_events`, visible in **Paramètres → Sécurité & audit**.

## Tests

`tests/security.test.ts` (fake files in a temporary folder, never your secrets): allowed read, write on approval, refused write, access outside the folder and `../`, symbolic link, `.env` and `.env.example`, fake SSH key, `printenv`, destructive child process, network, secret masking, Codex/Claude sandbox, effective matrix, real Seatbelt self-test, confined process, stop without orphans. Recovery after a restart is covered by `agent-missions.test.ts`, `constellations.test.ts`, `automations.test.ts`, `always-on.test.ts` and `always-on-scheduler.test.ts`.

## Running on a Linux server

What protects you, from the broadest layer to the finest (details: [`docs/RUNTIME_ARCHITECTURE.md`](RUNTIME_ARCHITECTURE.md), [`docs/REMOTE_SETUP.md`](REMOTE_SETUP.md)):

1. **Separate machine**: nothing from the Mac is reachable; no credentials are copied there (API keys, cookies, tokens, Keychain). You log the engines in on the server yourself.
2. **Transport**: SSH (key reserved for Orbit, pinned host, no forwarding), key restricted by a forced command to `orbit-runtime attach`; Orbit opens no port.
3. **Application authentication**: local token, runtime identity (Ed25519, pinned), client identity (Ed25519, pairing, single-use challenge, 12 h session, revocation). A private network alone is not enough.
4. **Commands**: parameters validated (zod), idempotent request ID, paths never accepted (projects are plain names; artifacts are IDs).
5. **Service**: dedicated user with no sudo and no password, hardened systemd (no capabilities, `ProtectSystem=strict`, `ProtectHome=yes`, `NoNewPrivileges`, memory/CPU/task limits), refuses to start as root, runtime installed read-only (owned by root).
6. **Per mission (bubblewrap, if the self-test passes)**: the engine and its commands only see their project and the engine's state; the runtime database, keys, token, other projects, artifacts and the server's SSH keys are invisible; the system is read-only; `/tmp` is private. Same rule as with Seatbelt: "hardened" isolation requested but not proven means the mission does not start.
7. **Orbit policy** (level 1, unchanged): per tool, persistent approvals, protected runtime paths (`state/`, `identity/`, `artifacts/`, `token`, `logs/`).
8. **Approvals**: bound to the exact operation (hash), single use, expire as a refusal, audited (`resolved_by`).
9. **Limits**: concurrency, duration and server budgets enforced by the runtime.

**Not guaranteed / known limitations:**
- Outbound network traffic is not filtered by Orbit (the engine must reach its API); only the policy and the engine sandbox govern network commands. A per-user outbound firewall is left for you to configure.
- The engine's login folder (`~/.claude`, `~/.codex` of the `orbit` user) stays readable by the engine's commands, as on the Mac.
- bubblewrap compatibility with an empty `CapabilityBoundingSet=` under systemd has not been tested on a real systemd server; the startup self-test will reveal it (fallback: isolation not offered).
- The remote runtime has not yet been tested on a real VPS (only in local Linux containers).
