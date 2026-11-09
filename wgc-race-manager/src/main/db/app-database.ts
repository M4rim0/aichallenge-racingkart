import { join } from 'node:path'
import { openDatabase, quickCheck, type Db } from './connection'
import { getSchemaVersion } from './migrate'

export const DB_FILE_NAME = 'wgc-race-manager.sqlite'

export interface DatabaseStatus {
  path: string
  schemaVersion: number
  integrity: string[]
}

let instance: { db: Db; status: DatabaseStatus } | null = null

/** アプリ用 DB を開く（userData 配下）。起動時に 1 回だけ呼ぶ。 */
export function openAppDatabase(userDataDir: string): { db: Db; status: DatabaseStatus } {
  if (instance) return instance
  const path = join(userDataDir, DB_FILE_NAME)
  const db = openDatabase(path)
  const status: DatabaseStatus = { path, schemaVersion: getSchemaVersion(db), integrity: quickCheck(db) }
  instance = { db, status }
  return instance
}

export function getAppDatabase(): { db: Db; status: DatabaseStatus } {
  if (!instance) throw new Error('Database is not opened')
  return instance
}

export function closeAppDatabase(): void {
  if (instance?.db.open) instance.db.close()
  instance = null
}
