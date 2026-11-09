import { app, ipcMain } from 'electron'
import { IpcChannel, type AppInfo } from '@shared/ipc-contract'
import { probeSqliteVersion } from '../db/sqlite-probe'

export function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannel.appGetInfo, (): AppInfo => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    sqlite: probeSqliteVersion(),
    platform: process.platform,
    userDataPath: app.getPath('userData')
  }))
}
