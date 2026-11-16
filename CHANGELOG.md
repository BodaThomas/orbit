# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Constellations: sub-missions can declare write scopes (`writes`). Writers with separate scopes in a shared folder now run in parallel instead of one after the other, and each one can only write inside its own scopes.

### Changed

- Constellations: the coordinator is asked to mark reviews and checks as read-only, keep dependencies to what a task really needs, and avoid a review, fix and re-check loop on every round, so more sub-missions can run in parallel.

## [0.1.0] - 2026-11-16

First public release.

### Added

- Companions: personal AI agents with a profile, memory, avatar and a place in the "universe" view.
- Chat with Anthropic and OpenAI models, with streaming, cancellation and official usage reporting.
- Agent engines: Claude Code (local CLI), Claude Agent SDK and Codex (`codex app-server`) missions running in an authorized folder.
- Permissions: per-companion capabilities, autonomy levels (supervised to autonomous), a command classifier and approval prompts for sensitive actions.
- Constellations: a coordinator companion that plans, delegates sub-missions to other companions and writes a synthesis, with plan approval, pause, resume and retry.
- Automations: scheduled and recurring missions with limits on runs, duration and budget.
- Remote runtime: a Linux service (`orbit-runtime`) that hosts companions, missions and the scheduler, with pairing, sync and remote approvals.
- Statistics: token usage and costs per companion, engine and provider.
- Security: API keys encrypted with the macOS Keychain, Orbit data protected from engines, journaled actions.

[Unreleased]: https://github.com/BodaThomas/orbit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/BodaThomas/orbit/releases/tag/v0.1.0
