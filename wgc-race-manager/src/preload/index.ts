import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel, type WgcApi } from '@shared/ipc-contract'

// Renderer には型定義済みの操作のみを公開する。ipcRenderer そのものは公開しない。
const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

const api: WgcApi = {
  app: {
    getInfo: () => invoke(IpcChannel.appGetInfo)
  },
  events: {
    list: () => invoke(IpcChannel.eventsList),
    get: (id) => invoke(IpcChannel.eventsGet, id),
    create: (input) => invoke(IpcChannel.eventsCreate, input),
    update: (id, patch) => invoke(IpcChannel.eventsUpdate, id, patch)
  },
  teams: {
    list: (eventId, includeDeleted) => invoke(IpcChannel.teamsList, eventId, includeDeleted === true),
    create: (eventId, input) => invoke(IpcChannel.teamsCreate, eventId, input),
    update: (id, patch) => invoke(IpcChannel.teamsUpdate, id, patch),
    deletionImpact: (id) => invoke(IpcChannel.teamsDeletionImpact, id),
    delete: (id, impact) => invoke(IpcChannel.teamsDelete, id, impact),
    restore: (id) => invoke(IpcChannel.teamsRestore, id)
  }
}

contextBridge.exposeInMainWorld('wgc', api)
