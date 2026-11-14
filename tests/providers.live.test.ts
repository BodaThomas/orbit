import { describe, expect, it } from 'vitest'
import { anthropicAdapter } from '../src/main/infra/providers/anthropic'
import { openaiAdapter } from '../src/main/infra/providers/openai'

/**
 * Network smoke tests against the official APIs with a deliberately invalid key.
 * They prove the SDK wiring and error mapping without spending anything.
 * Run with ORBIT_LIVE=1.
 */
describe.skipIf(!process.env.ORBIT_LIVE)('provider adapters (live, invalid key)', () => {
  it('anthropic maps a bad key to a French auth error', async () => {
    await expect(anthropicAdapter.validate('sk-ant-invalid-orbit-test')).rejects.toMatchObject({ kind: 'auth' })
  })
  it('anthropic streaming surfaces the auth error', async () => {
    const run = async () => {
      for await (const _ of anthropicAdapter.stream({ model: 'claude-haiku-5-5', system: '', messages: [{ role: 'user', content: 'ping' }], maxTokens: 16 }, 'sk-ant-invalid-orbit-test', new AbortController().signal)) void _
    }
    await expect(run()).rejects.toMatchObject({ kind: 'auth' })
  })
  it('openai maps a bad key to an auth error', async () => {
    await expect(openaiAdapter.validate('sk-invalid-orbit-test')).rejects.toMatchObject({ kind: 'auth' })
  })
})
