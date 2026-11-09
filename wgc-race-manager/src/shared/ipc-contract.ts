/**
 * Renderer ⇔ Main の IPC 契約。
 * Renderer に公開する操作はここで型定義したものに限る（仕様 §2.1）。
 */

export const IpcChannel = {
  appGetInfo: 'app:get-info'
} as const

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel]

export interface AppInfo {
  appVersion: string
  electron: string
  chrome: string
  node: string
  sqlite: string
  platform: string
  userDataPath: string
}

/** preload が window.wgc として公開する API */
export interface WgcApi {
  app: {
    getInfo(): Promise<AppInfo>
  }
}
