# Installing Orbit Runtime on a Linux server

> **Known limitation**: this procedure has been validated in local Linux containers only (see [`docs/MANUAL_TESTING.md`](MANUAL_TESTING.md)). It has not yet been run on a real VPS. Orbit never runs any step of this document automatically.

## Prerequisites

- Linux x86_64 or ARM64 (Debian 12 / Ubuntu 24.04 targeted), with systemd.
- **Node.js ≥ 22.16** (LTS 24 recommended), installed by you from nodejs.org or your distribution. The runtime needs no native module.
- Optional: `bubblewrap` (per-mission isolation), `git` (constellation worktrees).
- A private network is recommended: Tailscale, with the SSH port listening on the private network only. No other port is opened: the runtime listens on a Unix socket.

## 1. On the Mac: build and check the bundle

```bash
npm run build:runtime
```

```bash
shasum -a 256 out/runtime/orbit-runtime.mjs
```

Create an SSH key reserved for Orbit:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/orbit_ed25519 -C orbit-desktop
```

## 2. On the server: install (as root, after reading the script)

Copy `out/runtime/orbit-runtime.mjs` and `deploy/install.sh`, then:

```bash
sudo sh install.sh --bundle ./orbit-runtime.mjs --sha256 <fingerprint> --authorize-key "$(cat orbit_ed25519.pub)"
```

The script: checks the bundle fingerprint and Node.js; creates the `orbit` system user (no password, no sudo, home `/var/lib/orbit`); installs the runtime read-only under `/opt/orbit`; authorizes Orbit's key **only** for `orbit-runtime attach` (forced command, no shell, no forwarding, no PTY); writes a hardened systemd service and starts it; runs `orbit-runtime doctor`.

Service (`orbit-runtime unit --system orbit`): `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=yes` (other accounts and their SSH keys are invisible), `PrivateTmp`, `PrivateDevices`, `CapabilityBoundingSet=` (no capabilities), `RestrictSUIDSGID`, `RestrictNamespaces=~net cgroup`, `MemoryMax=75%`, `CPUQuota=200%`, `TasksMax=512`, `UMask=0077`, automatic restart, and a controlled shutdown (running missions are cancelled and recorded, never replayed).

Logs: `journalctl -u orbit-runtime` (JSON, rotated by journald) and `/var/lib/orbit/runtime/logs/runtime.log` (5 × 5 MB). Secrets are masked and prompts are never logged.

## 3. Connect the engines (on the server, by you)

Authentication on the server is **independent** from the Mac. Orbit never copies credentials, cookies, tokens or Keychain items.

- Codex: official install (`npm i -g @openai/codex`), then `sudo -u orbit -H codex login --device-auth`.
- Claude Code: official install, then `sudo -u orbit -H claude` and `/login`.
- API: `sudo -u orbit -H /opt/orbit/bin/orbit-runtime secrets set anthropic < key.txt` (stored encrypted on the server, never sent to the Mac).

**Terms of use** (not verified by the project, check them yourself): a personal subscription (Claude, ChatGPT) is meant for individual use; automated, continuous use on a server may fall under different terms or be limited by quotas. For recurring automations, an API key (usage-based billing, commercial terms) is the most clearly permitted option. Orbit never switches engines or billing modes on your behalf.

## 4. In Orbit: **Machines → Connecter une machine** (Machines → Connect a machine)

1. **Serveur Linux / VPS** (Linux server / VPS).
2. Host (a Tailscale address is recommended), user `orbit`, port, directory `/var/lib/orbit/runtime`, key `~/.ssh/orbit_ed25519`.
3. **Lire l’empreinte** (Read fingerprint), compare it (hosting provider's console or `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`), then confirm.
4. **Tester la connexion** (Test connection), compare the runtime identity (`orbit-runtime doctor` / `health` on the server) and confirm: Orbit pairs this Mac.
5. Check the detected engines.
6. Place a companion on the machine (companion profile → **Modifier** (Edit) → **Où travaille-t-il ?** (Where does it work?)), then give it missions and automations.

## Updating

1. Build the new bundle and check its fingerprint.
2. On the server: `sudo systemctl stop orbit-runtime` (running missions are cancelled and recorded, so pick a time with no active mission; this is visible in **Machines**).
3. `sudo sh install.sh --bundle … --sha256 …` (user and data are kept; SQLite migrations are additive and applied at startup).
4. Rollback: reinstall the previous bundle and restore the `runtime.db` backup if a migration ran (see [`docs/BACKUP_RESTORE.md`](BACKUP_RESTORE.md)).

Compatibility: the protocol version is checked at `hello`; a different version is rejected with a message saying which side to update.

## Revocation

- In Orbit: **Révoquer** (Revoke). The runtime forgets this client, and Orbit forgets the host key and the runtime identity.
- On the server: `orbit-runtime clients revoke <id>`, and remove the line from `/var/lib/orbit/.ssh/authorized_keys`.

## Alternative: container

`deploy/Dockerfile`: non-root user (uid 10001), to run with `--read-only --cap-drop ALL --security-opt no-new-privileges`, memory/CPU/PID limits, no Docker socket, state on a volume. Engines must be installed in a derived image. bubblewrap needs user namespaces, which Docker's default seccomp profile is expected to block (not confirmed yet; `deploy/validate-linux.sh` measures it). If the self-test fails, per-mission isolation is not offered.
