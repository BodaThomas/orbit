import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import os from 'node:os'
import { join } from 'node:path'
import { claudeConfigDir, createClaudeAgentEngine } from '../main/core/engine/claude-agent'
import { createClaudeCodeEngine } from '../main/core/engine/claude-code'
import { createCodexEngine } from '../main/core/engine/codex'
import type { AgentEngine, EngineId } from '../main/core/engine/types'
import { bwrapAvailable, bwrapSelfTest } from '../main/core/security/bwrap'
import { fileCipher, RuntimeHost } from './host'
import { MIN_NODE, PROTOCOL_VERSION, RUNTIME_VERSION } from './protocol'
import { echoEngine } from './test-engine'

/**
 * orbit-runtime - Orbit's execution service for Linux servers.
 *   daemon   [--home DIR]          run the service (systemd)
 *   attach   [--home DIR]          bridge stdin/stdout to the daemon (used by Orbit over SSH)
 *   health   [--home DIR]          liveness/readiness report (exit 1 when not ready)
 *   doctor   [--home DIR]          check prerequisites, changes nothing
 *   unit     [--home DIR] [--system USER]   print the systemd unit
 *   clients  list|revoke ID        paired Orbit Desktop clients
 *   secrets  set|remove anthropic|openai   API keys for this server (read from stdin)
 *   version
 */
const args = process.argv.slice(2)
const cmd = args[0]
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const home = flag('--home') ?? process.env.ORBIT_RUNTIME_HOME ?? join(os.homedir(), '.orbit-runtime')
const out = (s: string) => process.stdout.write(`${s}\n`)
const err = (s: string) => process.stderr.write(`${s}\n`)

function nodeOk(): boolean {
  const [maj, min] = process.versions.node.split('.').map(Number)
  return maj! > MIN_NODE[0] || (maj === MIN_NODE[0] && min! >= MIN_NODE[1])
}

async function openDb(file: string) {
  const { openNodeSqliteDatabase } = await import('../main/infra/db/node-sqlite')
  return openNodeSqliteDatabase(file)
}

function engines(): Partial<Record<EngineId, AgentEngine>> {
  // Validation in a disposable environment only: a deterministic engine, labelled « Echo (test) ».
  if (process.env.ORBIT_RUNTIME_TEST_ENGINE === '1') return { codex: echoEngine() }
  return {
    'claude-code': createClaudeCodeEngine(),
    codex: createCodexEngine({ clientVersion: RUNTIME_VERSION }),
    'claude-agent': createClaudeAgentEngine({ configDir: claudeConfigDir(home) }),
  }
}

async function daemon() {
  if (process.getuid?.() === 0) {
    err('orbit-runtime refuse de tourner en root : les compagnons ne doivent jamais avoir ces droits. Utilisez l’utilisateur dédié (voir docs/REMOTE_SETUP.md).')
    process.exit(1)
  }
  if (!nodeOk()) {
    err(`Node.js ${MIN_NODE.join('.')} ou plus récent est requis (installé : ${process.versions.node}).`)
    process.exit(1)
  }
  const host = new RuntimeHost({ home, engines: engines(), openDb: (f) => openDbSync(f), logToStderr: true, confinementSelfTest: bwrapAvailable() ? () => bwrapSelfTest() : undefined })
  await host.start()
  let stopping = false
  const stop = (sig: string) => {
    if (stopping) return
    stopping = true
    host.log.info('arrêt demandé', { signal: sig })
    void host.stop().then(() => process.exit(0))
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('uncaughtException', (e) => host.log.error('exception non gérée', { error: e.stack ?? String(e) }))
  process.on('unhandledRejection', (e) => host.log.error('promesse rejetée', { error: String(e) }))
}

let openDbSync: (f: string) => ReturnType<Awaited<typeof import('../main/infra/db/node-sqlite')>['openNodeSqliteDatabase']>

function socketPath(): string {
  try {
    return readFileSync(join(home, 'socket'), 'utf8').trim()
  } catch {
    return join(home, 'orbit.sock')
  }
}

function attach() {
  const token = readFileSync(join(home, 'token'), 'utf8').trim()
  const sock = connect(socketPath())
  sock.on('connect', () => {
    sock.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'auth', params: { token } }) + '\n')
    process.stdin.pipe(sock)
    sock.pipe(process.stdout)
  })
  sock.on('error', (e) => {
    err(`orbit-runtime : service injoignable (${e.message}). Est-il démarré ? systemctl status orbit-runtime`)
    process.exit(2)
  })
  sock.on('close', () => process.exit(0))
  process.stdin.on('end', () => sock.end())
}

/** One request over the local socket (token-authenticated, open methods only). */
function localCall(method: string, params: unknown = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const token = readFileSync(join(home, 'token'), 'utf8').trim()
    const s = connect(socketPath())
    let buf = ''
    const t = setTimeout(() => (s.destroy(), reject(new Error('pas de réponse'))), 10_000)
    s.on('connect', () => {
      s.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'auth', params: { token } }) + '\n')
      s.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n')
    })
    s.setEncoding('utf8')
    s.on('data', (d: string) => {
      buf += d
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } }
        if (msg.id === 1) {
          clearTimeout(t)
          s.end()
          if (msg.error) reject(new Error(msg.error.message))
          else resolve(msg.result)
        }
      }
    })
    s.on('error', (e) => (clearTimeout(t), reject(e)))
  })
}

async function health() {
  try {
    const h = (await localCall('health')) as { ready: boolean; checks: { name: string; ok: boolean; detail: string }[]; version: string }
    out(`orbit-runtime ${h.version} · ${h.ready ? 'prêt' : 'NON PRÊT'}`)
    for (const c of h.checks) out(`  ${c.ok ? '✓' : '✗'} ${c.name} — ${c.detail}`)
    process.exit(h.ready ? 0 : 1)
  } catch (e) {
    err(`Service injoignable : ${e instanceof Error ? e.message : String(e)}`)
    process.exit(2)
  }
}

function which(bin: string): string | null {
  const r = spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

/** Prerequisites, read-only: reports what to do, never does it. */
async function doctor() {
  const lines: [boolean | null, string][] = []
  const add = (ok: boolean | null, s: string) => lines.push([ok, s])
  add(nodeOk(), `Node.js ${process.versions.node} (minimum ${MIN_NODE.join('.')})`)
  try {
    await import('node:sqlite')
    add(true, 'node:sqlite disponible')
  } catch {
    add(false, 'node:sqlite indisponible : mettez Node.js à jour (LTS recommandée)')
  }
  add(process.platform === 'linux' ? true : null, `Système : ${os.type()} ${os.release()} ${os.arch()}`)
  add(process.getuid?.() !== 0, process.getuid?.() === 0 ? 'Lancé en root : refusé, utilisez l’utilisateur dédié' : `Utilisateur : ${os.userInfo().username} (non root)`)
  if (existsSync(home)) {
    const mode = statSync(home).mode & 0o777
    add((mode & 0o077) === 0, `Dossier ${home} : ${mode.toString(8)}${(mode & 0o077) === 0 ? '' : ' (doit être 700)'}`)
  } else add(null, `Dossier ${home} : sera créé au premier démarrage (700)`)
  add(which('systemctl') ? true : null, which('systemctl') ? 'systemd présent' : 'systemd absent : service à lancer autrement (conteneur…)')
  add(bwrapAvailable() ? true : null, bwrapAvailable() ? 'bubblewrap présent : isolation par mission testée au démarrage' : 'bubblewrap absent : pas d’isolation par mission (apt install bubblewrap)')
  if (bwrapAvailable()) {
    const p = bwrapSelfTest()
    add(p.ok, `Auto-test d’isolation : ${p.ok ? 'réussi' : `échec${p.error ? ` (${p.error})` : ''}`}`)
  }
  add(which('git') ? true : null, which('git') ? 'git présent (worktrees des constellations)' : 'git absent : pas de worktrees')
  add(which('claude') ? true : null, which('claude') ? `Claude Code : ${which('claude')} (connexion : lancez « claude » puis /login sur ce serveur)` : 'Claude Code non installé (facultatif)')
  add(which('codex') ? true : null, which('codex') ? `Codex : ${which('codex')} (connexion : « codex login » sur ce serveur)` : 'Codex non installé (facultatif)')
  try {
    const s = (await import('node:fs')).statfsSync(existsSync(home) ? home : os.homedir())
    const freeGb = (s.bavail * s.bsize) / 1024 ** 3
    add(freeGb > 2, `Espace libre : ${freeGb.toFixed(1)} Go`)
  } catch {
    add(null, 'Espace libre : inconnu')
  }
  try {
    const l = (await localCall('health.liveness')) as { version: string }
    add(true, `Service en marche (${l.version})`)
  } catch {
    add(null, 'Service non joignable (normal avant le premier démarrage)')
  }
  for (const [ok, s] of lines) out(`${ok === true ? '✓' : ok === false ? '✗' : '·'} ${s}`)
  process.exit(lines.some(([ok]) => ok === false) ? 1 : 0)
}

function unit() {
  const system = flag('--system')
  const exec = `${process.execPath} ${process.argv[1]} daemon --home ${home}`
  // Kernel-enforced confinement of the whole service (and every agent it starts).
  const hardening = `NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
RestrictNamespaces=~net cgroup
LockPersonality=yes
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallArchitectures=native
UMask=0077
MemoryMax=75%
CPUQuota=200%
TasksMax=512
LimitNOFILE=8192`
  if (system) {
    out(`[Unit]
Description=Orbit Runtime (compagnons distants)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${system}
Group=${system}
ExecStart=${exec}
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
KillMode=mixed
${hardening}
# Other users' homes (and their SSH keys) are invisible; only this user's home is writable.
ProtectHome=yes
ReadWritePaths=${os.homedir()}
Environment=HOME=${os.homedir()}
Environment=ORBIT_RUNTIME_HOME=${home}

[Install]
WantedBy=multi-user.target`)
  } else {
    out(`[Unit]
Description=Orbit Runtime (compagnons distants)
After=network-online.target

[Service]
ExecStart=${exec}
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
KillMode=mixed
${hardening}
ReadWritePaths=${home} %h/.codex %h/.claude %h/.claude.json

[Install]
WantedBy=default.target`)
  }
}

async function clients() {
  const db = await openDb(join(home, 'state', 'runtime.db'))
  const sub = args[1]
  if (sub === 'revoke' && args[2]) {
    const r = db.sqlite.prepare('UPDATE rt_clients SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(new Date().toISOString(), args[2])
    out(r.changes ? `Client ${args[2]} révoqué (effectif à sa prochaine requête).` : 'Client inconnu.')
  } else {
    for (const c of db.sqlite.prepare('SELECT id, name, fingerprint, created_at, last_seen_at, revoked_at FROM rt_clients').all() as Record<string, string | null>[]) out(`${c.revoked_at ? '✗' : '✓'} ${c.id}  ${c.name}  ${c.fingerprint}  vu ${c.last_seen_at ?? 'jamais'}${c.revoked_at ? `  révoqué ${c.revoked_at}` : ''}`)
  }
  db.close()
}

async function secrets() {
  const sub = args[1]
  const provider = args[2]
  if (!provider || !['anthropic', 'openai'].includes(provider)) {
    err('Usage : orbit-runtime secrets set|remove anthropic|openai   (la clé est lue sur l’entrée standard)')
    process.exit(1)
  }
  const db = await openDb(join(home, 'state', 'runtime.db'))
  if (sub === 'remove') {
    db.sqlite.prepare('UPDATE provider_connections SET encrypted_secret = NULL, secret_hint = NULL WHERE provider_id = ?').run(provider)
    out('Clé retirée.')
  } else {
    const key = readFileSync(0, 'utf8').trim()
    if (key.length < 20) {
      err('Clé vide ou trop courte.')
      process.exit(1)
    }
    const c = fileCipher(join(home, 'identity', 'secrets.key'))
    const ts = new Date().toISOString()
    db.sqlite.prepare('INSERT INTO provider_connections (provider_id, encrypted_secret, secret_hint, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(provider_id) DO UPDATE SET encrypted_secret = excluded.encrypted_secret, secret_hint = excluded.secret_hint, updated_at = excluded.updated_at').run(provider, c.encrypt(key), `…${key.slice(-4)}`, ts, ts)
    out(`Clé ${provider} enregistrée sur ce serveur (chiffrée, ${key.slice(-4).replace(/./g, '•')}). Elle n’est jamais envoyée à Orbit Desktop.`)
  }
  db.close()
}

async function main() {
  if (cmd === 'daemon') {
    const { openNodeSqliteDatabase } = await import('../main/infra/db/node-sqlite').catch(() => {
      err(`node:sqlite indisponible : Node.js ${MIN_NODE.join('.')}+ requis.`)
      process.exit(1)
    })
    openDbSync = openNodeSqliteDatabase
    await daemon()
  } else if (cmd === 'attach') attach()
  else if (cmd === 'health') await health()
  else if (cmd === 'doctor') await doctor()
  else if (cmd === 'version') out(`${RUNTIME_VERSION} (protocole ${PROTOCOL_VERSION})`)
  else if (cmd === 'unit') unit()
  else if (cmd === 'clients') await clients()
  else if (cmd === 'secrets') await secrets()
  else {
    err('Usage : orbit-runtime daemon|attach|health|doctor|unit|clients|secrets|version [--home DIR]')
    process.exit(1)
  }
}

void main()
