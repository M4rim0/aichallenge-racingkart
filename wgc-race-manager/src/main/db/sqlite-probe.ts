import { openSqlite } from './sqlite-native'

/** better-sqlite3 のネイティブモジュールが読み込めることを確認し、SQLite のバージョンを返す。 */
export function probeSqliteVersion(): string {
  const db = openSqlite(':memory:')
  try {
    const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string }
    return row.v
  } finally {
    db.close()
  }
}
