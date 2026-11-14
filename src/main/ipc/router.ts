import { ZodError } from 'zod'
import { ipcSchemas, type IpcChannel, type IpcResult } from '@shared/ipc'
import { OrbitError } from '../core/util'
import { createLogger } from '../infra/logger'
import { handlers, type HostApi } from './handlers'

const log = createLogger('ipc')

export function isChannel(value: unknown): value is IpcChannel {
  return typeof value === 'string' && Object.hasOwn(ipcSchemas, value)
}

/** Validates, dispatches and serialises errors. Never leaks stacks to the renderer. */
export async function dispatch(channel: unknown, rawInput: unknown, host: HostApi): Promise<IpcResult<unknown>> {
  if (!isChannel(channel)) return { ok: false, error: { code: 'forbidden', message: 'Canal IPC inconnu.' } }
  try {
    const input = ipcSchemas[channel].parse(rawInput)
    const handler = handlers[channel] as (i: unknown, h: HostApi) => unknown
    const data = await handler(input, host)
    return { ok: true, data }
  } catch (err) {
    if (err instanceof ZodError) {
      return { ok: false, error: { code: 'validation', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' · ') } }
    }
    if (err instanceof OrbitError) return { ok: false, error: { code: err.code, message: err.message } }
    log.error(`${channel} failed`, err)
    return { ok: false, error: { code: 'internal', message: err instanceof Error ? err.message : 'Erreur interne.' } }
  }
}
