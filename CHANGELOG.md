# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- One **À traiter** (to do) list gathers everything waiting for you: approvals, plans to validate, blocked or failed team missions, automation runs to confirm and failed missions from the last two weeks. Failures can be marked as handled, and the sidebar shows the count next to the overview.
- Constellations: sub-missions can declare write scopes (`writes`). Writers with separate scopes in a shared folder now run in parallel instead of one after the other, and each one can only write inside its own scopes.

### Changed

- Forms are shorter. The companion wizard has four steps (appearance and planet are one step), the constellation wizard five (name and goal are one step), and rarely changed options such as reasoning effort, strict isolation, automation limits and constellation limits are folded under **Options avancées** (advanced options). The execution location only appears once a machine is connected.
- The companion profile groups configuration and permissions under one **Réglages** (settings) tab. Approval buttons say what they cover (**Pendant cette mission**, **Toujours, dans ce dossier**) and plan validation options are explained in the form.
- Onboarding has a back button until the first companion is created.
- Constellations: the coordinator is asked to mark reviews and checks as read-only, keep dependencies to what a task really needs, and avoid a review, fix and re-check loop on every round, so more sub-missions can run in parallel.
- Constellations: the number of delegation rounds is no longer capped at 5. The sub-mission count, duration and budget limits still bound a run.
- Companions: clicking a companion anywhere opens its profile. Companions on an agent engine (Claude Code, Codex) show **Confier une mission** (assign a mission) as their main action and no longer offer a chat that cannot be used.
- Companions: the wizard explains what is missing before creation, requires a working folder for agent engines and asks before discarding unsaved edits. In edit mode, **Enregistrer** (save) is the main action on every step.
- Automations: the form says which field blocks saving instead of only disabling the button.
- Disabled buttons on the constellations page explain why in a tooltip.
- Mission filters and the list/board choice are kept when you leave the page and come back.
- The sidebar is grouped by use: daily work (**Accueil** (home), Missions, Constellations, Automations), then your companions, then system pages (Activity, Statistics, Machines, Settings). The overview and **Mon univers** (my universe) are now two views of the home page, and keyboard shortcuts ⌘1 to ⌘8 follow the sidebar order.
- The interface uses one word per concept: **moteur** (engine) instead of provider or intelligence, **accord** (consent) for every approval, **dossier de travail** (working folder), **budget** for spending limits, **machine** for remote servers and **coordinateur** for the constellation lead. A constellation run is called a **mission collective** (team mission) everywhere, and stopping one now says **Arrêter** (stop) instead of « Annuler ».

### Fixed

- Stopping a mission, removing an API key, disconnecting a machine and revoking a saved permission now ask for confirmation. Confirmation dialogs for destructive actions focus the safe button.
- Pages no longer flash empty while loading, and the automation and constellation lists show an error with a retry button when they fail to load.
- A pending automation run no longer shows « undefined » when its automation was deleted.
- The machine wizard no longer shows two buttons that do the same thing on its last step.
- Onboarding prefers a chat engine for the first companion, so the first message can be sent.

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
