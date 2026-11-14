import { describe, expect, it } from 'vitest'
import { canTransition } from '@shared/mission-states'
import { estimateCost } from '@shared/pricing'
import { agentInputSchema } from '@shared/ipc'
import { PermissionManager } from '../src/main/core/permissions'
import { buildDays } from '../src/main/core/health'
import { DEFAULT_PERMISSIONS } from '@shared/catalog'
import { novaInput } from './helpers'

describe('mission state machine', () => {
  it('allows the normal lifecycle', () => {
    expect(canTransition('todo', 'running')).toBe(true)
    expect(canTransition('running', 'done')).toBe(true)
    expect(canTransition('failed', 'todo')).toBe(true)
  })
  it('rejects illegal jumps', () => {
    expect(canTransition('done', 'running')).toBe(false)
    expect(canTransition('cancelled', 'done')).toBe(false)
    expect(canTransition('todo', 'done')).toBe(false)
  })
})

describe('pricing', () => {
  it('estimates known Anthropic models and labels them estimated', () => {
    const c = estimateCost('anthropic', 'claude-opus-5-5', 1_000_000, 100_000)
    expect(c.costKind).toBe('estimated')
    expect(c.costUsd).toBeCloseTo(4 + 2, 6)
    expect(c.pricingVersion).toBe('2026-11-03')
  })
  it('never invents a price for unknown models', () => {
    expect(estimateCost('openai', 'gpt-x', 10, 10)).toEqual({ costUsd: null, costKind: 'unknown', pricingVersion: null })
  })
})

describe('permission manager', () => {
  const base = { enabled: true, autonomy: 'supervised' as const, permissions: { ...DEFAULT_PERMISSIONS } }
  it('blocks disabled agents', () => {
    expect(PermissionManager.decide({ ...base, enabled: false }, 'conversation.send', 'user').allowed).toBe(false)
  })
  it('manual agents never start missions from automation', () => {
    expect(PermissionManager.decide({ ...base, autonomy: 'manual' }, 'mission.start', 'automation').allowed).toBe(false)
    expect(PermissionManager.decide({ ...base, autonomy: 'manual' }, 'mission.start', 'user').allowed).toBe(true)
  })
  it('supervised + sensitive permissions require approval', () => {
    const d = PermissionManager.decide({ ...base, permissions: { ...DEFAULT_PERMISSIONS, writeFiles: true } }, 'mission.start', 'user')
    expect(d).toMatchObject({ allowed: true, requiresApproval: true })
  })
  it('denies capabilities that were not granted', () => {
    expect(PermissionManager.decide(base, 'runCommands', 'user').allowed).toBe(false)
  })
  it('external actions always need a human, even when automated', () => {
    const d = PermissionManager.decide({ ...base, autonomy: 'automated', permissions: { ...DEFAULT_PERMISSIONS, externalActions: true } }, 'externalActions', 'automation')
    expect(d.requiresApproval).toBe(true)
  })
})

describe('health history', () => {
  const now = new Date('2026-11-13T12:00:00Z')
  it('marks incident days with the worst impact', () => {
    const { days, uptimePct } = buildDays(
      [
        { id: 'a', name: 'x', status: 'resolved', impact: 'minor', created_at: '2026-11-10T10:00:00Z', updated_at: '', resolved_at: '2026-11-10T11:00:00Z' },
        { id: 'b', name: 'y', status: 'resolved', impact: 'major', created_at: '2026-11-10T13:00:00Z', updated_at: '', resolved_at: '2026-11-10T15:00:00Z' },
      ],
      now,
    )
    expect(days).toHaveLength(30)
    expect(days.at(-1)!.date).toBe('2026-11-13')
    expect(days.find((d) => d.date === '2026-11-10')).toMatchObject({ level: 'outage', incidents: 2 })
    expect(days.find((d) => d.date === '2026-11-11')!.level).toBe('operational')
    expect(uptimePct).toBeCloseTo(100 - (2 / (30 * 24)) * 100, 4)
  })
  it('uses unknown for days the saturated feed does not cover', () => {
    const incidents = Array.from({ length: 50 }, (_, i) => ({ id: String(i), name: 'n', status: 'resolved', impact: 'none', created_at: '2026-11-12T00:00:00Z', updated_at: '', resolved_at: '2026-11-12T00:10:00Z' }))
    const { days } = buildDays(incidents, now)
    expect(days[0]!.level).toBe('unknown')
    expect(days.at(-2)!.level).toBe('operational')
  })
})

describe('ipc validation', () => {
  it('rejects malformed agents', () => {
    expect(agentInputSchema.safeParse({ ...novaInput(), name: '' }).success).toBe(false)
    expect(agentInputSchema.safeParse({ ...novaInput(), providerId: 'evil' }).success).toBe(false)
    expect(agentInputSchema.safeParse(novaInput()).success).toBe(true)
  })
})
