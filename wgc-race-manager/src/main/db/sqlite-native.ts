import { existsSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

/**
 * SQLite（better-sqlite3）を開く唯一の入口。
 *
 * better-sqlite3 12 は Node・Electron の ABI ごとに別のバイナリを使う（Electron 33.4.11 は better-sqlite3 13 を読み込めないため 12 を使用）。
 * - Electron の中で動くとき：native/electron-v<ABI>-<platform>-<arch>/better_sqlite3.node を明示的に読み込む
 *   （scripts/fetch-electron-sqlite.mjs が npm install 時に導入）
 * - 自動テスト（システムの Node）：node_modules の通常のバイナリを使う
 */
export function electronNativeBindingPath(): string | null {
  if (!process.versions.electron) return null
  const dir = `electron-v${process.versions.modules}-${process.platform}-${process.arch}`
  // ビルド後の main は out/main/index.js。プロジェクト直下の native/ を参照する
  const base = process.env['WGC_NATIVE_DIR'] ?? join(__dirname, '..', '..', 'native')
  return join(base, dir, 'better_sqlite3.node')
}

export function openSqlite(file: string, options: Database.Options = {}): Database.Database {
  const nativeBinding = electronNativeBindingPath()
  if (nativeBinding !== null) {
    if (!existsSync(nativeBinding)) {
      throw new Error(
        `Electron 用の SQLite バイナリが見つかりません: ${nativeBinding}\nプロジェクトのフォルダで「npm run setup:native」を実行してください。`
      )
    }
    return new Database(file, { ...options, nativeBinding })
  }
  return new Database(file, options)
}
