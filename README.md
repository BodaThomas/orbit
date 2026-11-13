# Orbit

A macOS app (Electron) to configure, supervise and talk to your personal AI companions.

## Getting started

```bash
npm install   # rebuilds better-sqlite3 for Electron (postinstall)
npm run dev
```

On first launch, onboarding lets you connect Anthropic or OpenAI (the API key is checked, then encrypted with the macOS Keychain) or explore a demo mode (separate database, no network requests).

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Electron + Vite with hot reload |
| `npm run build` | Builds main, preload and renderer into `out/` |
| `npm run typecheck` | Strict TypeScript (main process and renderer) |
| `npm run lint` | ESLint |
| `npm test` | Vitest, run inside Electron's Node (same SQLite binary) |
| `ORBIT_LIVE=1 npm test` | Adds network tests against the real APIs with an invalid key |
| `npm run package` | Unsigned `release/mac-arm64/Orbit.app` |
| `npm run db:generate` | New Drizzle migration after a schema change |

Data lives in `~/Library/Application Support/Orbit/` (`orbit.db`, `orbit-demo.db`). Set `ORBIT_DATA_DIR` to use another folder.
