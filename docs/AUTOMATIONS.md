# Automations

## Recurrence (`src/shared/schedule.ts`)

Supported schedules: once, daily, weekly (on selected days), monthly (day 31 falls back to the last day of the month), interval (5 minutes minimum), and 5-field cron expressions. Every automation carries an **explicit IANA time zone**. The interface shows the next three computed runs.

Daylight saving time changes:
- a time that does not exist (spring forward, for example 02:30 in Paris) runs at the first valid instant (03:30);
- a time that occurs twice (fall back) runs once, on the first occurrence.

## Triggers

Available: a date, a recurrence, a mission finishing (for a given companion), a mission failing, another automation finishing, and an explicit action (**Exécuter maintenant** (Run now)). Also present in the data model (`automation_triggers.kind`) but not connected: webhooks, Git events, file changes and external services. None of them is active without explicit configuration.

Protection against repeated firing: an automation never reacts to its own missions, there is a minimum delay between two triggers (5 minutes by default, 1 minute at least), and an automation is paused automatically if it fires more than 12 times in an hour. An optional limit on runs per 24 hours can also be set.

## Guarantees

- **One run per occurrence**: each run has a unique idempotency key (automation + scheduled instant). Two ticks, a restart or a reconnection never fire it twice.
- **When Orbit starts and when the Mac wakes up**: missed occurrences follow the chosen policy, with a single decision per automation (never a burst of runs):
  - **Ignorer** (Skip);
  - **Rattraper une fois** (Catch up once);
  - **Me demander** (Ask me): an actionable notification, and an entry on the **Automatisations** (Automations) page.
- A target that can modify files, run commands or act outside the Mac is **never** re-run without confirmation: "Rattraper une fois" is treated as "Me demander".
- A run interrupted because Orbit was closed becomes **uncertain** and is never replayed automatically.
- A companion in manual mode refuses automated missions. A supervised companion with sensitive permissions asks for your approval before starting.

## What the Mac allows

The scheduler lives inside Orbit: it works as long as Orbit is running, even with the window closed (macOS keeps the application active). When the Mac is off or asleep, nothing runs. On wake (`powerMonitor.resume`) and at launch, the missed-run policy applies. **Ouvrir Orbit à l’ouverture de session** (Open Orbit at login) is an explicit setting (installed application only). For continuous operation, use a remote runtime, which has its own scheduler (see `docs/SCHEDULER.md`).

## Notifications

Scheduled mission started, finished or failed, approval required, run postponed: each produces a macOS notification. Clicking it opens the mission or the request concerned.

## Live test

`tests/automation-scheduler.live.test.ts` runs a real end-to-end check with Claude Code: a daily automation due about one minute later is fired by the scheduler, the mission runs and finishes, and the next run date is kept for the following day. It is opt-in:

```bash
ORBIT_LIVE_AUTOMATION=1 ORBIT_LIVE_DATA_DIR=<data dir> npm test -- automation-scheduler.live
```

See `docs/MANUAL_TESTING.md` for the other live tests.
