# Manual testing

This guide checks the full companion workflow with **real credentials** (Claude Agent SDK and Codex), then lists the automated and live test suites, and the procedure for a real Linux server.

No secret is ever typed into code, a file or a shared terminal:

- **Anthropic**: the API key is pasted into Orbit (**Paramètres → Fournisseurs** (Settings → Providers)), verified, then encrypted through the macOS Keychain. It never appears in the database (only the ciphertext is stored), in logs or in the renderer. It is passed to the engine only through an environment variable of the child process.
- **Codex**: Orbit uses your official Codex CLI login (`codex login`, ChatGPT subscription or API key). Orbit neither reads nor stores that token.

Duration: about 15 minutes. Cost: a few cents on the Anthropic side; a little quota on the Codex side.

## 0. Prepare a throw-away project

```bash
mkdir -p ~/OrbitTest/meteo-cli/src && cd ~/OrbitTest/meteo-cli
printf '{ "name": "meteo-cli", "type": "module", "scripts": { "test": "node --test" } }\n' > package.json
printf "export const forecast = (c) => ['soleil','nuages','pluie'][c.length % 3]\n" > src/forecast.js
printf '# meteo-cli\n\nMétéo fictive par ville.\n' > README.md
```

Never point a companion at a real project for this first run.

## 1. Codex

1. In a terminal: `codex login` (if not done already).
2. Start Orbit (`npm run dev` or the packaged app).
3. **Paramètres → Fournisseurs → Codex → Vérifier** (Verify). Expected: a **Prêt** (Ready) badge and « Connecté avec ChatGPT (…) » or « … clé API » (connected with ChatGPT / with an API key).
4. **Compagnons → Atlas → Modifier** (Companions → Atlas → Edit), or create Atlas from the *Atlas* template:
   - **Fournisseur** (Provider): **Codex**, model: **Modèle par défaut** (Default model).
   - **Autonomie** (Autonomy): **Supervisé** (Supervised).
   - Permissions: **Lire des fichiers** (Read files) on, **Modifier des fichiers** (Edit files) on, **Exécuter des commandes** (Run commands) on, **Accès réseau** (Network access) off.
   - **Dossier autorisé** (Allowed folder): `~/OrbitTest/meteo-cli`.
5. **Nouvelle mission** (New mission, ⌘N) for Atlas: « Analyse le projet, puis ajoute un test pour `forecast` dans `test/forecast.test.js` et lance-le. » ("Analyze the project, then add a test for `forecast` in `test/forecast.test.js` and run it.")

Check:

| # | Expected |
|---|---|
| 1.1 | The live card shows Atlas animated and the current action (e.g. « Lit README.md », reading README.md), with a running timer. No made-up progress. |
| 1.2 | The timeline lists each command with its status; clicking a line shows the exact command and its output. |
| 1.3 | An **approval request** appears (mission in **Approbation nécessaire** (Approval required), orange avatar, macOS notification). **Détails exacts** (Exact details) shows the command or the diff. |
| 1.4 | **Refuse** the first request: the action becomes **Refusé** (Refused), Atlas suggests an alternative or stops, and nothing is written to disk. |
| 1.5 | In **Poursuivre** (Continue), ask it to retry, then **approve**: the file is created and the test runs. |
| 1.6 | Cost shown as subscription (ChatGPT) or **Inconnu** (Unknown) with an API key (Orbit has no dated Codex pricing). Tokens are filled in. |
| 1.7 | During a follow-up, click **Arrêter** (Stop): the mission becomes **Annulée** (Cancelled) within a few seconds and pending requests expire. |

## 2. Claude Agent SDK

1. **Paramètres → Fournisseurs → Anthropic**: paste your Console key, **Connecter** (Connect). Then **Claude Agent SDK → Vérifier**: **Prêt**.
2. Create a companion (or switch Atlas) to **Claude Agent SDK**, model *Claude Opus 5.5*, same permissions and folder, **Budget journalier** (Daily budget) $0.50.
3. Mission: « Explique l'architecture de ce projet puis renomme `forecast` en `predict` partout. » ("Explain this project's architecture, then rename `forecast` to `predict` everywhere.")

Check:

| # | Expected |
|---|---|
| 2.1 | Reads (`Read`, `Glob`, `Grep`) run without a request; every `Edit`/`Write`/`Bash` waits for your approval, with the diff. |
| 2.2 | Ask in a follow-up: « Lis /etc/hosts » (read /etc/hosts). The action is **refused by Orbit** (outside the allowed folder) without being submitted to you. |
| 2.3 | Cost shown as estimated (computed by the SDK at public prices); it counts toward the budget. With a nearly exhausted budget, the mission stops on its own (« Budget de la mission atteint », mission budget reached). |
| 2.4 | An invalid key (**Paramètres**, replace it with a fake key) gives a readable error, « Clé API Anthropic refusée » (Anthropic API key refused), without a crash. |

## 3. Persistence

1. Start a long mission, wait for an approval request, then **quit Orbit** (⌘Q).
2. Restart Orbit and open the mission. Expected: status **Échec** (Failed) with « Interrompue… la session est conservée » (interrupted, the session is kept), the request expired, running actions marked as cancelled, Atlas **Disponible** (Available).
3. In **Poursuivre**, write « Reprends où tu en étais » ("pick up where you left off"). Expected: the **same session** resumes (same ID in the right-hand panel) and the companion remembers the context.

## 4. Network

Turn off Wi-Fi, then start a mission. Expected: a readable failure (« Impossible de joindre… » / « Réseau indisponible… », cannot reach / network unavailable), the companion in an error state, a notification. Turn Wi-Fi back on and continue the mission: it resumes.

## Automated tests

```bash
npm test                                    # full suite, no network (live tests are skipped by default)
```

```bash
ORBIT_TEST_DB=node npm test                 # full suite on node:sqlite, the runtime's driver
```

```bash
npm run build:runtime && npm test -- always-on
```

The `always-on` tests run a real runtime in a separate context on the local machine, with the test engine labelled « Echo (test) » or scripted engines. They cover:

| Area | Covered by |
|---|---|
| Runtime persistence, authentication, protocol, identity, event cursors | `always-on.test.ts` |
| Remote mission end to end: status, events, result, cancellation, no Orbit secret sent | `always-on.test.ts` |
| Orbit closed during a mission, reopened with no loss and no duplicate | `always-on.test.ts` |
| Transport loss, resume, command whose response was lost | `always-on.test.ts` |
| Remote approval: approve, refuse, replay refused, expiry as a refusal | `always-on.test.ts` |
| Remote automation fired by the server without the Mac, transfers between Mac and server | `always-on-scheduler.test.ts` (controlled clock) |
| Runtime restart: missed occurrences, interrupted missions never replayed | `always-on-scheduler.test.ts` |
| Limits enforced by the runtime, artifacts | `always-on-scheduler.test.ts` |
| Remote constellation (coordinator and members on the runtime, 2 engines, dependency, synthesis) | `always-on-scheduler.test.ts` (scripted engines) |

## Live tests

Live tests use real engines or services and are opt-in. They run in temporary folders with fake files, and use your own logins (`codex login`, Claude Code `/login`). Where an approval is needed, the test grants it on your behalf and records it as such.

| Command | Covers |
|---|---|
| `ORBIT_LIVE=1 npm test -- providers.live` | Provider adapters (Anthropic, OpenAI) map an invalid key to a readable auth error. |
| `ORBIT_LIVE_CODEX=1 npm test -- engines.live` | Real Codex: reads a project, asks before writing, honours a refusal, resumes the thread. |
| `ORBIT_LIVE_CLAUDE_CODE=1 npm test -- claude-code.live` | Real Claude Code CLI: detection and login check, read, approval before writing, write after approval, refusal honoured (nothing written), same session resumed, run under hardened isolation. |
| `ORBIT_LIVE_CLAUDE_CODE=1 npm test -- permissions.live` | Smart permissions with Claude Code: Orbit's `PreToolUse` hook decides, `.env` reads go through Orbit, bulk deletion needs approval, an out-of-folder write is blocked by the engine sandbox even when approved, automated mode. |
| `ORBIT_LIVE_CONSTELLATION=1 ORBIT_LIVE_DATA_DIR=<dir> npm test -- constellation-multi-engine` | Multi-engine constellation: Nova (Claude Code) delegates to Milo (Claude Code, read-only) then Atlas (Codex), then writes the final synthesis. |
| `ORBIT_LIVE_AUTOMATION=1 ORBIT_LIVE_DATA_DIR=<same dir> npm test -- automation-scheduler` | A daily automation due in about a minute is fired by the scheduler, Milo runs the mission, the next run date is kept. Run after the constellation test, with the same data directory. |
| `sh deploy/validate-linux.sh` | Runs `tests/linux-container.live.test.ts` against a real runtime in a local Linux container (it sets `ORBIT_LINUX_DOCKER`, `ORBIT_LINUX_SSH_PORT`, `ORBIT_LINUX_SSH_KEY`): end-to-end mission, Orbit closed / transport cut without duplicates, remote approval, automation fired while the Mac is disconnected, container restart, container hardening, pinned host key and forced command over real SSH. Also measures the bubblewrap self-test. |

`deploy/validate-linux.sh` needs Docker running. It pulls the `node:24-bookworm-slim` image and Debian packages; everything stays local and the SSH port is bound to 127.0.0.1 only.

## On a real Linux server

Known limitation: the remote runtime has so far been validated in local Linux containers only, never on a real VPS, and real engines (Claude Code, Codex) have not yet been run on a server. To validate it:

1. Install the runtime following [`docs/REMOTE_SETUP.md`](REMOTE_SETUP.md) and log in at least one engine on the server.
2. In Orbit: **Machines → Connecter une machine** (Machines → Connect a machine) and go through the six steps. Compare the fingerprint shown by **Lire l’empreinte** (Read fingerprint) with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server before clicking **C’est la bonne** (That's the right one). Expected: the machine shows **En ligne** (Online) and its engines are listed.
3. Place a companion on the server (profile → **Modifier** (Edit) → **Où travaille-t-il ?** (Where does it work?)) and give it a mission that requires an approval. Approve from the Mac. Expected: the file is written under `/var/lib/orbit/runtime/projects/<project>/` on the server, and the mission completes in Orbit.
4. Give it an automation due in 5 minutes, transfer it to the server, **turn the Mac off**, and turn it back on after the scheduled time. Expected: the run history and the result are present.
5. Run `sudo systemctl restart orbit-runtime` during a mission. Expected: the mission is interrupted and never restarted.
6. Cut the Mac's network during a mission. Expected: the mission keeps running on the server, and no duplicate appears once the Mac reconnects.
7. Quit Orbit during a mission and restart it. Expected: Orbit catches up on reconnection and shows the result.
