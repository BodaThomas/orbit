import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import os from 'node:os'
import { join } from 'node:path'
import { createClaudeCodeEngine } from '../main/core/engine/claude-code'
import { createCodexEngine } from '../main/core/engine/codex'
import type { AgentEngine } from '../main/core/engine/types'
import { echoEngine, RuntimeDaemon } from './daemon'
import { RUNTIME_VERSION, type RemoteEngineId } from './protocol'

/**
 * orbit-runtime - the remote side of Orbit.
 *   orbit-runtime daemon [--home DIR]   run the daemon (systemd user service)
 *   orbit-runtime attach [--home DIR]   bridge stdin/stdout to the daemon (used over SSH)
 *   orbit-runtime version
 *   orbit-runtime unit [--home DIR]     print the systemd user unit
 */
const args = process.argv.slice(2)
const cmd = args[0]
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const home = flag('--home') ?? process.env.ORBIT_RUNTIME_HOME ?? join(os.homedir(), '.orbit-runtime')

async function daemon() {
  const engines: Partial<Record<RemoteEngineId, AgentEngine>> = {
    codex: createCodexEngine({ clientVersion: RUNTIME_VERSION }),
    'claude-code': createClaudeCodeEngine(),
  }
  if (process.env.ORBIT_RUNTIME_ECHO === '1') engines.echo = echoEngine()
  const d = new RuntimeDaemon({ home, engines, log: (l) => process.stderr.write(`${l}\n`) })
  await d.start()
  process.stderr.write(`orbit-runtime ${RUNTIME_VERSION} · ${d.socketPath}\n`)
  const stop = () => void d.stop().then(() => process.exit(0))
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

function attach() {
  const token = readFileSync(join(home, 'token'), 'utf8').trim()
  let path = join(home, 'orbit.sock')
  try {
    path = readFileSync(join(home, 'socket'), 'utf8').trim()
  } catch {
    /* default location */
  }
  const sock = connect(path)
  sock.on('connect', () => {
    sock.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'auth', params: { token } }) + '\n')
    process.stdin.pipe(sock)
    sock.pipe(process.stdout)
  })
  sock.on('error', (err) => {
    process.stderr.write(`orbit-runtime: démon injoignable (${err.message}). Est-il démarré ? systemctl --user status orbit-runtime\n`)
    process.exit(2)
  })
  sock.on('close', () => process.exit(0))
  process.stdin.on('end', () => sock.end())
}

function unit() {
  process.stdout.write(`[Unit]
Description=Orbit runtime (compagnons distants)
After=network-online.target

[Service]
ExecStart=${process.execPath} ${process.argv[1]} daemon --home ${home}
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=${home} %h/.codex %h/.claude %h/.claude.json
UMask=0077

[Install]
WantedBy=default.target
`)
}

if (cmd === 'daemon') void daemon()
else if (cmd === 'attach') attach()
else if (cmd === 'version') process.stdout.write(`${RUNTIME_VERSION}\n`)
else if (cmd === 'unit') unit()
else {
  process.stderr.write('Usage : orbit-runtime daemon|attach|version|unit [--home DIR]\n')
  process.exit(1)
}
