# Contributing to Orbit

Thanks for your interest in Orbit. Bug reports, fixes and documentation improvements are all welcome.

## Before you start

- For anything larger than a small fix, open an issue first so we can agree on the approach.
- Security issues must be reported privately through [GitHub security advisories](https://github.com/BodaThomas/orbit/security/advisories/new), not in a public issue.
- Contributions are accepted under the [Contributor License Agreement](CLA.md). The pull request template asks you to confirm it.

## Development setup

Orbit is an Electron app built with electron-vite, React, TypeScript and SQLite (Drizzle). macOS is the primary target.

```bash
npm install
npm run dev
```

Before opening a pull request, make sure these pass:

```bash
npm run typecheck
npm run lint
npm test
```

Tests run inside Electron's Node so they use the same SQLite binary as the app. Tests that hit real APIs or engines are opt-in through environment variables; see [docs/MANUAL_TESTING.md](docs/MANUAL_TESTING.md).

If you change the database schema in `src/main/infra/db/schema.ts`, generate a migration with `npm run db:generate` and commit it alongside the change.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for an overview of the codebase.

## Code style

- TypeScript strict mode. Follow the existing style: no semicolons, single quotes, two-space indentation. ESLint must pass.
- Code, comments and identifiers are in English. The app UI is currently in French.
- Keep comments for the *why*; the code should say the *what*.

## Commit messages

Orbit follows [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <summary>
```

- **type**: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`
- **scope** (optional): the area touched, e.g. `missions`, `engines`, `constellations`, `automations`, `runtime`, `permissions`, `db`, `ipc`, `ui`
- **summary**: imperative mood, lowercase, no trailing period, 72 characters max

Use the body to explain why the change is needed when it is not obvious. Examples:

```
feat(constellations): resume interrupted runs after restart
fix(runtime): resend unacknowledged commands on reconnect
docs: document the remote runtime pairing flow
```

## Pull requests

- Keep pull requests focused on one change.
- Describe what changed and how you tested it; include screenshots for UI changes.
- Pull requests are squash-merged, so the PR title should follow the commit convention above.
