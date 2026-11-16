# Roadmap

Known limitations and open work. This list is kept short and factual; issues and pull requests on any of these are welcome. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together.

## Providers and engines

- Adapters for Gemini, Grok, OpenRouter and Ollama. They are registered as "planned" and expose no capabilities yet.
- The Claude Agent SDK engine and the Anthropic chat API are covered by tests against fakes but have not yet been checked end to end with a real API key.
- Codex has no dollar budget cap (subscription cost, or unknown price with an API key). Tokens are still counted.
- A Codex companion without the "run commands" permission is close to read-only in practice.
- Claude Code quota usage from `rate_limit_event` is read as a fraction; the format is not documented upstream.
- Claude Code with a consumer subscription is meant for personal use. An API key is recommended for automations and servers.

## Security and isolation

- Codex's sandbox restricts writes and network, not reads: an approved command can read outside the working folder. The same applies to an approved Bash command under Claude.
- Shell command analysis is heuristic. Anything it cannot see through is treated as unknown and asks for approval.
- macOS hardened isolation (Seatbelt) still leaves the engine's login folder, encrypted Keychain files and system folders readable. `sandbox-exec` is deprecated by Apple.
- On Linux, per-mission isolation requires bubblewrap and unprivileged user namespaces. Running bubblewrap under the hardened systemd unit has not been tested.
- Outbound network traffic from the runtime is not filtered by Orbit. A per-user outbound firewall is planned.
- Rotation of runtime and client identity keys.

## Files and changes

- Files ignored by Git are not tracked in "Changed files".
- Outside Git, the snapshot is capped (20,000 files) and marked incomplete when the cap is hit.
- Attribution is uncertain when two companions write to the same folder at the same time (shown as such in the UI).

## Constellations

- The coordinator must return a well-formed `orbit-plan` block (one correction is allowed). Native delegation through an MCP tool, for engines that support it, would remove this dependency.
- Constellations mixing local and remote companions are refused.
- An interrupted remote constellation run is not resumed automatically; it has to be relaunched.
- Dollar budgets do not apply to subscription-billed engines.

## Automations

- Local automations do not run while the Mac is off or asleep. Use a remote runtime for always-on schedules.
- "Open at login" only works in the packaged app.
- Webhook, Git and file-change triggers, with explicit configuration.

## Remote runtime

- Not yet validated on a real VPS (SSH, systemd, lingering, engines logged in on the server). The Linux container validation (`deploy/validate-linux.sh`, `tests/linux-container.live.test.ts`) and the Docker image are written but not yet part of a regular run.
- Chat conversations with a remote companion stay on the Mac.
- A runtime using the first protocol version must be reinstalled.
- Delivery guarantees are at most once, not exactly once.
- A mobile client. The runtime protocol is versioned and documented so another client can be added later.

## Known issues

- A mission follow-up that is approved after Orbit restarts runs the original prompt instead of the follow-up, because the pending follow-up is only kept in memory. Fixing it needs a database field.
- Remote sync: a row that fails to apply is reported (`syncError`) but the cursor still advances. Permanent and temporary errors need to be told apart.
- `agents.update` uses `agentInputSchema.partial()`, so Zod re-applies defaults (isolation, placement) to omitted fields. Harmless today because the UI always sends the full record.
- One Anthropic status incident can produce up to three notifications (Anthropic, Claude Code, Agent SDK).
- In offline demo mode, the "Providers" indicator may show red only because engines are not installed.
- `drizzle/0008_constellation_lifecycle.sql` has no matching snapshot in `drizzle/meta/`, so the next `npm run db:generate` may repeat its statements.

## Packaging and quality

- Signed and notarized macOS builds.
- Automated end-to-end UI tests.
- The packaged app bundles both engine binaries and is large (around 1 GB).
- English UI. The interface is currently in French.
