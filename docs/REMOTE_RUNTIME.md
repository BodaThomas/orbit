> **Superseded.** This document describes the first version of the remote runtime (protocol v1, simplified executor). The current design is documented in [`docs/RUNTIME_ARCHITECTURE.md`](RUNTIME_ARCHITECTURE.md) (protocol v2, shared core), [`docs/REMOTE_SETUP.md`](REMOTE_SETUP.md) and [`docs/SCHEDULER.md`](SCHEDULER.md). A v1 runtime is rejected with an upgrade message. It is kept for reference only.

# Remote runtime (v1)

Goal: companions that keep working on a Linux server while this Mac is off, supervised by Orbit when it reconnects.

## Architecture

```
Orbit (Mac) ──ssh (key, pinned host)──▶ orbit-runtime attach ──Unix socket 0600──▶ orbit-runtime daemon
                                                                                     ├─ engines (Codex, Claude Code)
                                                                                     ├─ autonomous scheduler
                                                                                     └─ state: missions, schedules, event log
```

- **No network port**: the daemon only listens on a Unix socket (0600) in a 0700 directory. SSH provides strong authentication (keys, `BatchMode`, never a password), encryption and host verification.
- **Host verification**: Orbit reads the host key (`ssh-keyscan`), shows you the fingerprint, and only stores it after you confirm, in its own `known_hosts` (`StrictHostKeyChecking=yes`, `GlobalKnownHostsFile=/dev/null`). No agent, X11 or port forwarding.
- **Local token**: `attach` proves to the daemon that it runs as the same user.
- **Protocol**: line-delimited JSON-RPC, version `1` checked at `hello` (incompatible version: explicit refusal, update the runtime). Methods: `hello`, `heartbeat`, `mission.submit|cancel|get|list`, `events.since`, `approval.resolve`, `schedule.put|delete|list`.
- **Event log**: append-only and numbered. Orbit replays it from its cursor on every reconnection; each event is applied once (`runtime_events` is unique per machine and sequence number).
- **Missions**: the mission ID is Orbit's run ID, so resubmitting never starts a mission twice. Projects are isolated under `<home>/projects/<name>` (plain names, no paths).
- **Approvals**: relayed to Orbit. If Orbit is disconnected, the mission waits.
- **Autonomous scheduler**: the daemon runs its own schedules without the Mac (`schedule.put`, one idempotency key per occurrence). In v1 this was not wired to Orbit: an automation targeting a remote companion was triggered from the Mac (the Mac had to be on) and the mission then ran on the server. v2 transfers automations to the runtime (see [`docs/SCHEDULER.md`](SCHEDULER.md)).
- **Runtime restart**: running missions become "interrupted" and are never restarted.
- **Secrets**: no Orbit API key is sent. Engines use the logins you set up **on the server** (`codex login`, `claude` + `/login`). Prompts of finished missions are not kept.
- **Revocation**: Orbit forgets the host key and disconnects. Also remove Orbit's SSH key from `authorized_keys`.
- **Updates**: **Installer / mettre à jour** (Install / update) reinstalls the bundle (`out/runtime/orbit-runtime.mjs`).

## Deployment (never automatic)

Add the machine, check the fingerprint, then **Installer / mettre à jour** shows **exactly** which commands will run before running them:

1. `mkdir -p <home>/bin && chmod 700 <home>`
2. copy of the bundle through `ssh … cat >`
3. `orbit-runtime` launcher
4. systemd user unit (`orbit-runtime unit`): `NoNewPrivileges`, `ProtectSystem=strict`, `PrivateTmp`, `UMask=0077`
5. `systemctl --user daemon-reload && systemctl --user enable --now orbit-runtime`

Prerequisites, done by you: Node.js, a dedicated user without administrator rights, an SSH key reserved for Orbit, engine logins on the server, and `loginctl enable-linger` so the service runs without an open session.

## Validation

The v1 runtime was only validated locally (daemon, built binary and connection from the UI on a single Mac). It was never run on a real Linux server. Its test suite has been replaced by the v2 tests described in [`docs/MANUAL_TESTING.md`](MANUAL_TESTING.md).
