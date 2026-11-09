import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

/**
 * 起動時の DB 整合性の事前チェック（決定 D-065）。マイグレーションより前に実行する。
 *
 * - 元の DB ファイル・WAL には一切書き込まない：DB 本体と `-wal` を一時フォルダへコピーし、コピーを検査する。
 *   （元ファイルを読み取り専用で開いても、SQLite が `-shm` の作成や WAL の復旧処理を行う可能性があるため）
 * - コピーを開くと SQLite が WAL を適用するため、WAL に含まれる確定済みデータも検査対象になる（未確定の書き込みは含まれない）。
 * - `PRAGMA integrity_check` と `PRAGMA foreign_key_check` の両方を実施する。
 * - 自動修復は行わない。
 */

export type PrecheckStatus =
  /** DB ファイルがない（初回起動）。新規作成してよい */
  | 'NEW'
  | 'OK'
  /** 異常あり。通常起動を停止する */
  | 'FAILED'

export interface PrecheckResult {
  status: PrecheckStatus
  dbPath: string
  /** WAL ファイルがあり、検査対象に含めた */
  walIncluded: boolean
  /** integrity_check の結果（正常時は ['ok']） */
  integrity: string[]
  /** foreign_key_check で見つかった違反の件数 */
  foreignKeyViolations: number
  /** 違反の例（最大 10 件） */
  foreignKeySamples: string[]
  /** 開けなかった等のエラー */
  error: string | null
}

export function precheckDatabase(dbPath: string, tmpRoot: string = tmpdir()): PrecheckResult {
  const walPath = `${dbPath}-wal`
  const base: PrecheckResult = {
    status: 'OK',
    dbPath,
    walIncluded: false,
    integrity: [],
    foreignKeyViolations: 0,
    foreignKeySamples: [],
    error: null
  }
  if (!existsSync(dbPath)) {
    if (existsSync(walPath)) {
      // DB 本体がなく WAL だけ残っている：新規作成すると WAL の内容を失う可能性があるため停止する
      return { ...base, status: 'FAILED', error: 'DB 本体がなく WAL ファイルだけが残っています' }
    }
    return { ...base, status: 'NEW' }
  }

  const dir = mkdtempSync(join(tmpRoot, 'wgc-precheck-'))
  const copy = join(dir, 'check.sqlite')
  let db: Database.Database | null = null
  try {
    copyFileSync(dbPath, copy)
    const walIncluded = existsSync(walPath)
    if (walIncluded) copyFileSync(walPath, `${copy}-wal`)
    db = new Database(copy, { fileMustExist: true })
    const integrity = (db.pragma('integrity_check') as { integrity_check: string }[]).map((r) => r.integrity_check)
    const fk = db.pragma('foreign_key_check') as { table: string; rowid: number | null; parent: string; fkid: number }[]
    const ok = integrity.length === 1 && integrity[0] === 'ok' && fk.length === 0
    return {
      ...base,
      status: ok ? 'OK' : 'FAILED',
      walIncluded,
      integrity,
      foreignKeyViolations: fk.length,
      foreignKeySamples: fk.slice(0, 10).map((v) => `${v.table}#${v.rowid ?? '?'} → ${v.parent}`)
    }
  } catch (e) {
    return { ...base, status: 'FAILED', walIncluded: existsSync(walPath), error: e instanceof Error ? e.message : String(e) }
  } finally {
    try {
      db?.close()
    } catch {
      // コピーの後始末の失敗は無視する（元ファイルには影響しない）
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 異常時に表示する説明（D-065：エラー内容と対処方法） */
export function describePrecheckFailure(r: PrecheckResult): string {
  const lines: string[] = []
  if (r.error) lines.push(`エラー: ${r.error}`)
  if (r.integrity.length > 0 && !(r.integrity.length === 1 && r.integrity[0] === 'ok')) {
    lines.push(`整合性チェック（integrity_check）: ${r.integrity.slice(0, 5).join(' / ')}${r.integrity.length > 5 ? ' …' : ''}`)
  }
  if (r.foreignKeyViolations > 0) {
    lines.push(`参照整合性チェック（foreign_key_check）: ${r.foreignKeyViolations} 件の違反（${r.foreignKeySamples.slice(0, 3).join(', ')}）`)
  }
  lines.push('')
  lines.push(`データベース: ${r.dbPath}`)
  lines.push('')
  lines.push('対処方法:')
  lines.push('1. このアプリを終了します（データは変更していません）。')
  lines.push('2. 上記フォルダ（-wal / -shm を含むすべてのファイル）を、別の場所へ丸ごとコピーして保全してください。')
  lines.push('3. ファイルを削除・上書きしないでください。開発担当者に連絡してください。')
  return lines.join('\n')
}
