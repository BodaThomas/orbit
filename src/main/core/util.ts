import { customAlphabet, nanoid } from 'nanoid'

export const newId = (): string => nanoid(16)
export const shortId = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 5)
export const nowIso = (): string => new Date().toISOString()

export class OrbitError extends Error {
  constructor(
    readonly code: 'validation' | 'not_found' | 'forbidden' | 'provider' | 'budget' | 'conflict' | 'internal',
    message: string,
  ) {
    super(message)
  }
}

export function startOfUtcDay(d = new Date()): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString()
}

/** Local-time day start, used for user-facing "aujourd'hui". */
export function startOfLocalDay(d = new Date(), offsetDays = 0): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offsetDays)
}
