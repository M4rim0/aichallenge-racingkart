import { app, ipcMain } from 'electron'
import { IpcChannel, type AppInfo } from '@shared/ipc-contract'
import { probeSqliteVersion } from '../db/sqlite-probe'
import { getAppDatabase } from '../db/app-database'

export function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannel.appGetInfo, (): AppInfo => {
    const { status } = getAppDatabase()
    return {
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      sqlite: probeSqliteVersion(),
      platform: process.platform,
      userDataPath: app.getPath('userData'),
      dbPath: status.path,
      dbSchemaVersion: status.schemaVersion,
      dbIntegrity: status.integrity.join('; ')
    }
  })
}
