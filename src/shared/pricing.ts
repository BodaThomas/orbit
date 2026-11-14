import type { CostKind, ProviderId } from './types'

/**
 * Dated public list prices, USD per million tokens.
 * Costs computed from these are always labelled `estimated`: the token counts
 * are official (returned by the provider), the multiplication is ours.
 */
export const PRICING_VERSION = '2026-11-03'

interface Price {
  input: number
  output: number
  /** Long-prompt tier: applies to the whole request when its input exceeds `above` tokens. */
  long?: { above: number; input: number; output: number }
}

const ANTHROPIC: Record<string, Price> = {
  'claude-fable-5-2': { input: 8, output: 40 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, long: { above: 100_000, input: 0.5, output: 2.5 } },
  // Served by the server-side refusal fallback; priced when they answer instead of the requested model.
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-fable-5-1': { input: 10, output: 50 },
}

export const PRICE_TABLE: Partial<Record<ProviderId, Record<string, Price>>> = {
  anthropic: ANTHROPIC,
  // The Agent SDK reports its own cost estimate; this table is the fallback when it does not.
  'claude-agent': ANTHROPIC,
}

export interface CostEstimate {
  costUsd: number | null
  costKind: CostKind
  pricingVersion: string | null
}

export function estimateCost(
  providerId: ProviderId,
  model: string,
  inputTokens: number,
  outputTokens: number,
  overrides?: Record<string, Price>,
): CostEstimate {
  if (providerId === 'demo') return { costUsd: 0, costKind: 'estimated', pricingVersion: 'demo' }
  const price = overrides?.[`${providerId}:${model}`] ?? PRICE_TABLE[providerId]?.[model]
  if (!price) return { costUsd: null, costKind: 'unknown', pricingVersion: null }
  const tier = price.long && inputTokens > price.long.above ? price.long : price
  const costUsd = (inputTokens * tier.input + outputTokens * tier.output) / 1_000_000
  return { costUsd, costKind: 'estimated', pricingVersion: overrides ? 'custom' : PRICING_VERSION }
}
