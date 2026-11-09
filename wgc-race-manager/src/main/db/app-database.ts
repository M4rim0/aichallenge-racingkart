import { join } from 'node:path'
import { openDatabase, type Db } from './connection'
import { precheckDatabase, describePrecheckFailure, type PrecheckResult } from './integrity-precheck'
import { getSchemaVersion } from './migrate'

export const DB_FILE_NAME = 'wgc-race-manager.sqlite'

export interface DatabaseStatus {
  path: string
  schemaVersion: number
  integrity: string[]
  precheck: PrecheckResult
}

/** 起動前の整合性チェックで異常があった（D-065）。DB は書き込み可能な状態では開いていない */
export class DatabaseIntegrityError extends Error {
  constructor(readonly result: PrecheckResult) {
    super(describePrecheckFailure(result))
    this.name = 'DatabaseIntegrityError'
  }
}

let instance: { db: Db; status: DatabaseStatus } | null = null

/** アプリ用 DB を開く（userData 配下）。起動時に 1 回だけ呼ぶ。整合性に異常があれば DatabaseIntegrityError を投げる */
export function openAppDatabase(userDataDir: string): { db: Db; status: DatabaseStatus } {
  if (instance) return instance
  const path = join(userDataDir, DB_FILE_NAME)
  // マイグレーションより前に、元ファイルを変更しない方法で整合性を確認する（D-065）
  const precheck = precheckDatabase(path)
  if (precheck.status === 'FAILED') throw new DatabaseIntegrityError(precheck)
  const db = openDatabase(path)
  const status: DatabaseStatus = {
    path,
    schemaVersion: getSchemaVersion(db),
    integrity: precheck.status === 'NEW' ? ['new database'] : precheck.integrity,
    precheck
  }
  instance = { db, status }
  return instance
}

export function getAppDatabase(): { db: Db; status: DatabaseStatus } {
  if (!instance) throw new Error('Database is not opened')
  return instance
}

/** DB を閉じる。閉じられたかどうかを返す（閉じられなかった場合は例外） */
export function closeAppDatabase(): boolean {
  const db = instance?.db
  if (db?.open) db.close()
  const closed = !db || !db.open
  if (closed) instance = null
  return closed
}
