import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel, type WgcApi } from '@shared/ipc-contract'

// Renderer には型定義済みの操作のみを公開する。ipcRenderer そのものは公開しない。
const api: WgcApi = {
  app: {
    getInfo: () => ipcRenderer.invoke(IpcChannel.appGetInfo)
  }
}

contextBridge.exposeInMainWorld('wgc', api)
