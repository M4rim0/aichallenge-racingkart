import type { Database } from 'better-sqlite3'
import { MIGRATIONS, type Migration } from './migrations'

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0)

export function getSchemaVersion(db: Database): number {
  return db.pragma('user_version', { simple: true }) as number
}

/**
 * 未適用のマイグレーションを 1 つずつトランザクション内で適用する。
 * 途中で失敗した場合、そのマイグレーションはロールバックされ例外を投げる。
 */
export function migrate(db: Database, migrations: readonly Migration[] = MIGRATIONS): number {
  const current = getSchemaVersion(db)
  const latest = migrations.reduce((m, x) => Math.max(m, x.version), 0)
  if (current > latest) {
    throw new Error(
      `Database schema version ${current} is newer than this application supports (${latest}).`
    )
  }
  const pending = [...migrations].filter((m) => m.version > current).sort((a, b) => a.version - b.version)
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql)
      db.pragma(`user_version = ${m.version}`)
    }).immediate()
  }
  return getSchemaVersion(db)
}
