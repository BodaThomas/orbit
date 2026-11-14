import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { ClaudeLocalUsage } from '@shared/types'

/**
 * Read-only statistics from Claude Code's own session logs (~/.claude/projects/**.jsonl),
 * only when the user explicitly enables it. Only usage fields are read: model, token
 * counts, tool-call counts, timestamps. Message text is never stored or sent anywhere,
 * and credential files are never opened (they are not in this folder on macOS anyway).
 *
 * These are local token counts, not a quota: Orbit never turns them into a « % of limit ».
 */

interface Line {
  type?: string
  timestamp?: string
  sessionId?: string
  message?: { id?: string; model?: string; usage?: Record<string, number>; content?: unknown }
}

export async function scanClaudeLocalUsage(projectsDir: string, days = 30, now = new Date()): Promise<ClaudeLocalUsage> {
  const since = new Date(now.getTime() - days * 86400_000)
  const out: ClaudeLocalUsage = { scannedAt: now.toISOString(), days, sessions: 0, messages: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, byModel: [], daily: [], lastActivity: null, filesSkipped: 0 }
  if (!existsSync(projectsDir)) return out
  const seen = new Set<string>()
  const sessions = new Set<string>()
  const byModel = new Map<string, { messages: number; tokens: number }>()
  const daily = new Map<string, number>()
  const files: string[] = []
  for (const project of readdirSync(projectsDir)) {
    const dir = join(projectsDir, project)
    let entries: string[]
    try {
      if (!statSync(dir).isDirectory()) continue
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue
      const full = join(dir, f)
      try {
        if (statSync(full).mtime >= since) files.push(full)
      } catch {
        out.filesSkipped++
      }
    }
  }
  for (const file of files.slice(0, 5000)) {
    try {
      const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
      for await (const raw of rl) {
        if (!raw.includes('"usage"')) continue
        let l: Line
        try {
          l = JSON.parse(raw) as Line
        } catch {
          continue
        }
        if (l.type !== 'assistant' || !l.message?.usage || !l.timestamp) continue
        const at = new Date(l.timestamp)
        if (at < since) continue
        const key = l.message.id ?? `${file}:${l.timestamp}`
        if (seen.has(key)) continue
        seen.add(key)
        const u = l.message.usage
        const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
        const output = u.output_tokens ?? 0
        out.messages++
        out.inputTokens += input
        out.outputTokens += output
        out.cacheReadTokens += u.cache_read_input_tokens ?? 0
        if (Array.isArray(l.message.content)) out.toolCalls += (l.message.content as { type?: string }[]).filter((c) => c?.type === 'tool_use').length
        if (l.sessionId) sessions.add(l.sessionId)
        const model = l.message.model ?? 'inconnu'
        const m = byModel.get(model) ?? { messages: 0, tokens: 0 }
        m.messages++
        m.tokens += input + output
        byModel.set(model, m)
        const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
        daily.set(day, (daily.get(day) ?? 0) + input + output)
        if (!out.lastActivity || l.timestamp > out.lastActivity) out.lastActivity = l.timestamp
      }
    } catch {
      out.filesSkipped++
    }
  }
  out.sessions = sessions.size
  out.byModel = [...byModel].map(([model, v]) => ({ model, ...v })).sort((a, b) => b.tokens - a.tokens)
  out.daily = [...daily].map(([date, tokens]) => ({ date, tokens })).sort((a, b) => a.date.localeCompare(b.date))
  return out
}
