import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { IpcChannel, IpcResult, OrbitEvent } from '@shared/ipc'

// Constants are inlined: the sandboxed preload can only require 'electron'.
const INVOKE = 'orbit:invoke'
const EVENT = 'orbit:event'

const api = {
  invoke: (channel: IpcChannel, input?: unknown): Promise<IpcResult<unknown>> => ipcRenderer.invoke(INVOKE, channel, input),
  onEvent: (listener: (event: OrbitEvent) => void): (() => void) => {
    const wrapped = (_e: IpcRendererEvent, evt: OrbitEvent) => listener(evt)
    ipcRenderer.on(EVENT, wrapped)
    return () => ipcRenderer.removeListener(EVENT, wrapped)
  },
  platform: process.platform,
}

contextBridge.exposeInMainWorld('orbit', api)

export type OrbitBridge = typeof api
