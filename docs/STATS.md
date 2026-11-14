# Statistics rules

A single implementation (`src/shared/stats.ts`), used by the main process (`agents.list`, `usage.summary`) and by the UI (dashboard, sidebar, profiles, **Univers** (Universe), **Statistiques** (Statistics)).

## Companion states

| State | Rule |
|---|---|
| Offline (`offline`) | companion disabled |
| Awaiting approval (`awaiting_approval`) | at least one pending request for this companion, or a mission in the "approval required" status; takes precedence |
| On a mission (`in_mission`) | at least one running or waiting mission, or a conversation currently generating |
| Error (`error`) | last run failed and nothing is running |
| Available (`available`) | everything else (the celebratory "finished" state only lasts 30 s) |
| Busy (**Occupés** (Busy) on the dashboard) | on a mission + awaiting approval (shown with the detail, e.g. « 2 en mission · 1 attend votre accord », "2 on a mission · 1 waiting for your approval") |

The state is **derived from missions and requests**, never from a stored field that an interrupted run could have left stale.

## Missions

- *Total*, *in progress* (running + waiting + approval required), *to do*, *done*, *failed*, *cancelled*.
- **Success rate = done / (done + failed)**. Cancelled missions are counted separately and **excluded** from the rate (you stopped them yourself). With no done or failed mission, the rate shows "—".
- "This month" statistics: missions created since the 1st of the month (local time).

## Usage

- Requests = usage records (one conversation turn, or one engine run per model).
- Tokens = input + output.
- Costs: official and estimated costs only; subscription and unknown costs are counted separately; the API-price equivalent of a subscription is never added up.
- **Most used** = the most requests; ties are shown as « ex æquo » (tied), ranked by requests, then cost, then ID.
- Daily activity: last 30 days, local days.

Consistency tests: `tests/stats-files.test.ts`.
