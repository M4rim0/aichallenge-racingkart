import type Database from 'better-sqlite3'
import { openSqlite } from './sqlite-native'
import { migrate } from './migrate'

export type Db = Database.Database

/**
 * DB を開き、データ保護用の PRAGMA を設定してマイグレーションを適用する。
 * - WAL + synchronous=FULL：コミット済みデータを電源断から保護する（仕様 §15）
 * - foreign_keys=ON：参照整合性
 */
export function openDatabase(file: string): Db {
  const db = openSqlite(file)
  try {
    configure(db)
    migrate(db)
    return db
  } catch (e) {
    db.close()
    throw e
  }
}

export function configure(db: Db): void {
  if (db.name !== ':memory:') {
    const mode = db.pragma('journal_mode = WAL', { simple: true })
    if (mode !== 'wal') throw new Error(`Failed to enable WAL (journal_mode=${String(mode)})`)
  }
  db.pragma('synchronous = FULL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
}

/** 起動時の整合性確認。問題がなければ 'ok' の配列を返す。 */
export function quickCheck(db: Db): string[] {
  const rows = db.pragma('quick_check') as { quick_check: string }[]
  return rows.map((r) => r.quick_check)
}
