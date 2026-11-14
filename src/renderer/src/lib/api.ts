import type { IpcChannel, IpcError, IpcInput, IpcOutputs } from '@shared/ipc'

export class ApiError extends Error {
  constructor(
    readonly code: IpcError['code'],
    message: string,
  ) {
    super(message)
  }
}

type Args<C extends IpcChannel> = [IpcInput<C>] extends [void] ? [] : [IpcInput<C>]

/** Typed bridge call. Throws ApiError with a user-facing French message. */
export async function call<C extends IpcChannel>(channel: C, ...args: Args<C>): Promise<IpcOutputs[C]> {
  if (!window.orbit) throw new ApiError('internal', 'Orbit doit être lancé dans son application de bureau.')
  const res = await window.orbit.invoke(channel, args[0])
  if (!res.ok) throw new ApiError(res.error.code, res.error.message)
  return res.data as IpcOutputs[C]
}
