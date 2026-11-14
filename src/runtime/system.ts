import { readdirSync, statfsSync } from 'node:fs'
import os from 'node:os'
import type { AgentEngine } from '../main/core/engine/types'
import type { EngineStatus, MetricsReport, RemoteEngineId } from './protocol'

/** Real measurements only: a value the system can't give is null, never estimated. */
export function measure(home: string, engineProcesses: number): MetricsReport {
  let disk: MetricsReport['disk']
  try {
    const s = statfsSync(home)
    disk = { path: home, totalMb: Math.round((s.blocks * s.bsize) / 1048576), freeMb: Math.round((s.bavail * s.bsize) / 1048576) }
  } catch {
    disk = null
  }
  let processes: number | null = null
  if (process.platform === 'linux') {
    try {
      processes = readdirSync('/proc').filter((d) => /^\d+$/.test(d)).length
    } catch {
      processes = null
    }
  }
  const load = os.loadavg()
  return {
    at: new Date().toISOString(),
    loadAvg: process.platform === 'win32' ? null : [load[0]!, load[1]!, load[2]!],
    cpus: os.cpus().length,
    memory: { totalMb: Math.round(os.totalmem() / 1048576), freeMb: Math.round(os.freemem() / 1048576), processRssMb: Math.round(process.memoryUsage().rss / 1048576) },
    disk,
    processes,
    engineProcesses,
    uptimeSec: Math.round(process.uptime()),
    osUptimeSec: Math.round(os.uptime()),
  }
}

const NAMES: Record<RemoteEngineId, string> = { 'claude-code': 'Claude Code CLI', codex: 'Codex', 'claude-agent': 'Claude Agent SDK', anthropic: 'Anthropic API', openai: 'OpenAI API' }

/**
 * Detects each engine on this machine through the engine's own readiness check (binary,
 * version, login). Never installs or logs in anything.
 */
export async function detectEngines(engines: Partial<Record<RemoteEngineId, AgentEngine>>, apiKeys: { anthropic: boolean; openai: boolean }): Promise<EngineStatus[]> {
  const out: EngineStatus[] = []
  for (const id of ['claude-code', 'codex', 'claude-agent'] as const) {
    const e = engines[id]
    if (!e) {
      out.push({ id, name: NAMES[id], installed: false, version: null, authenticated: false, ready: false, detail: 'Non pris en charge par ce runtime.', capabilities: [], restrictions: [] })
      continue
    }
    const r = await e.checkReady(null).catch((err: unknown) => ({ ready: false, detail: err instanceof Error ? err.message : String(err), auth: 'unknown' as const }))
    const missing = /introuvable|not found|ENOENT|absent|installez|install/i.test(r.detail) && !r.ready
    const caps = e.capabilities
    out.push({
      id,
      // A test engine keeps its own label: never shown as the real engine.
      name: /test/i.test(e.name) ? e.name : NAMES[id],
      installed: !missing,
      version: /\b(\d+\.\d+\.\d+)\b/.exec(r.detail)?.[1] ?? null,
      authenticated: r.ready ? true : /connect|login|auth|identifi/i.test(r.detail) ? false : 'unknown',
      ready: r.ready,
      detail: r.detail,
      capabilities: [caps.approvals && 'approbations', caps.resume && 'reprise de session', caps.interrupt && 'interruption', caps.fileDiffs && 'diffs', caps.budgetCap && 'plafond de dépense'].filter(Boolean) as string[],
      restrictions: [process.platform === 'linux' ? 'Isolation Seatbelt indisponible (macOS uniquement) : utilisateur dédié + systemd, bubblewrap si présent' : null].filter(Boolean) as string[],
    })
  }
  for (const id of ['anthropic', 'openai'] as const) {
    out.push({ id, name: NAMES[id], installed: true, version: null, authenticated: apiKeys[id], ready: apiKeys[id], detail: apiKeys[id] ? 'Clé API configurée sur ce serveur.' : 'Aucune clé API sur ce serveur (orbit-runtime secrets set …).', capabilities: ['conversation'], restrictions: ['Pas d’outils : texte seulement'] })
  }
  return out
}
