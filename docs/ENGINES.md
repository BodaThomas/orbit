# Engines and connections

Each companion uses **one** engine. Connections are independent and can coexist.

| Engine | Connection | Billing | Tools | Session resume |
|---|---|---|---|---|
| **Claude Code** | Your official `claude` binary, your login | Claude subscription (or API key, depending on your Claude Code login) | Yes | Yes (`--resume`) |
| **Claude Agent SDK** | Bundled SDK, Anthropic API key stored in Orbit | Pay as you go (API) | Yes | Yes |
| **Anthropic API** | Messages API, API key | Pay as you go (API) | No (conversation only) | n/a |
| **Codex** | `codex app-server`, your `codex login` | ChatGPT subscription or OpenAI key | Yes | Yes (`thread/resume`) |
| **OpenAI API** | Responses API, API key | Pay as you go (API) | No | n/a |

## Claude Code CLI

### Terms of use

Based on Anthropic's published Claude Code documentation (code.claude.com/docs/en/legal-and-compliance, /agent-sdk/overview, /cli-reference, /headless, /statusline). Check the current version of these pages yourself; they can change.

- OAuth login (Free, Pro, Max and other subscriptions) is intended for ordinary use of Claude Code and Anthropic's own applications.
- Third-party developers may not: offer Claude.ai login inside their application, route requests through other people's subscription credentials, or collect, store or relay Claude.ai credentials or session tokens.
- Explicitly allowed: a user signing in to the **unmodified Claude Code binary** with their own subscription.
- The binary must not be modified, and its authentication methods must not be disabled.
- Subscription usage limits assume ordinary individual use.

**How Orbit fits:**
- Orbit launches the `claude` binary that you installed, without modifying it, and never reads or relays any credential. You sign in from a terminal with the official process (`claude`, then `/login`). Orbit never offers a Claude.ai login of its own.
- Each user runs their own binary with their own login. If you are unsure whether your use fits the terms, use the Claude Agent SDK engine with an API key instead.
- Heavy round-the-clock use through automations should stay "ordinary". Anthropic can apply its limits without notice.

### Protocol

```
claude -p --input-format stream-json --output-format stream-json --verbose
       --include-partial-messages --permission-prompt-tool stdio --permission-prompts host
       --restricted --strict-mcp-config --tools Read,Glob,Grep[,Edit,Write…][,Bash][,WebFetch…]
       --append-system-prompt <Orbit rules> [--model M] [--effort E] [--resume SESSION]
```

This is the structured protocol spoken by the official SDK. Orbit sends `initialize`, then the user message. Each permission request arrives as `control_request { subtype: "can_use_tool" }`, and Orbit answers `allow` (without `updatedPermissions`) or `deny` according to its policy and, when needed, your decision. Any other control request (elicitation, dialog…) is refused. Interrupting sends `control_request { subtype: "interrupt" }`, then stops the process group. No human-facing terminal output is ever parsed.

Tested against Claude Code 2.1.322: free reads inside the folder, `Write` goes through `can_use_tool`, a refusal is respected (nothing written), session resume, and operation under reinforced isolation.

### Detection and status

- Binary: `ORBIT_CLAUDE_CODE_PATH`, then `~/.local/bin/claude`, `~/.claude/local/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`, then `PATH`. Never the copy bundled with the SDK.
- Version: `claude --version` (minimum 2.1.259).
- Login: `claude auth status --json` (official, no secret involved). Orbit keeps only `loggedIn`, `authMethod` and `subscriptionType`, never the email address or the organization.
- **Tester le moteur** (Test the engine): a real minimal session (answer "OK", no tools, empty temporary folder), run after confirmation.

### Models

**Modèle par défaut du compte** (Account default model) lets Claude Code choose. An explicit model is passed as is (`--model`); if it is unavailable, the mission fails with a clear message. `--fallback-model` is never used: no silent change of behavior or cost. Effort (`--effort low…max`) is optional.

### Usage and quotas

| Category | Source | Display |
|---|---|---|
| Measured API spend | Amount returned by a provider | `official` |
| Estimated API cost | Dated public pricing or the SDK's estimate | `estimated` |
| Subscription usage | Official token counts from Claude Code / Codex | **Inclus dans votre abonnement — N jetons** (Included in your subscription, N tokens) |
| API price equivalent | Claude Code `costUSD` for a subscription session | `equivalent_usd` column, never added to spend |
| Unavailable | No reliable pricing | **coût inconnu** (unknown cost) |

**Quotas (5-hour and weekly windows)**: shown only from the `rate_limit_event` messages that Claude Code emits during a run (and Codex `account/rateLimits`), with the time they were observed and the reset time. They are discarded after 6 hours. Without data, Orbit shows **Quota indisponible — consulter Claude Code** (Quota unavailable, check Claude Code). Orbit never reconstructs a quota from local token counts and never calls a private endpoint. Reading Keychain cookies or `~/.claude/.credentials.json`, as some third-party usage trackers do, was deliberately ruled out.

**Local logs (optional, off by default)**: with your explicit consent, Orbit reads `~/.claude/projects/**/*.jsonl` from the last 30 days, read-only (model, tokens, number of tool calls, timestamp, session ID). Conversation text is neither stored nor transmitted.

## Codex

Codex runs through `codex app-server` with: a real "commands" permission (`untrusted` approval policy), reasoning effort, official quotas from `account/rateLimits`, processes stopped by process group, and optional reinforced isolation.
