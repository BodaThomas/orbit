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
}

const ANTHROPIC: Record<string, Price> = {
  'claude-fable-5-2': { input: 8, output: 40 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
}

export const PRICE_TABLE: Partial<Record<ProviderId, Record<string, Price>>> = {
  anthropic: ANTHROPIC,
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
  const costUsd = (inputTokens * price.input + outputTokens * price.output) / 1_000_000
  return { costUsd, costKind: 'estimated', pricingVersion: overrides ? 'custom' : PRICING_VERSION }
}
