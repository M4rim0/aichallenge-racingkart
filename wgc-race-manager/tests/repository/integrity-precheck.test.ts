import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { describePrecheckFailure, precheckDatabase } from '../../src/main/db/integrity-precheck'
import { LATEST_SCHEMA_VERSION } from '../../src/main/db/migrate'
import { openDatabase } from '../../src/main/db/connection'
import { closeAppDatabase, DatabaseIntegrityError, DB_FILE_NAME, openAppDatabase } from '../../src/main/db/app-database'

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wgc-precheck-test-'))
  file = join(dir, DB_FILE_NAME)
})
afterEach(() => {
  closeAppDatabase()
  rmSync(dir, { recursive: true, force: true })
})

const fingerprint = (p: string) => (existsSync(p) ? { hash: createHash('sha256').update(readFileSync(p)).digest('hex'), mtime: statSync(p).mtimeMs, size: statSync(p).size } : null)
const snapshot = () => ({ db: fingerprint(file), wal: fingerprint(`${file}-wal`), shm: fingerprint(`${file}-shm`) })

/** 正常な DB を作る。keepOpen の場合は接続を開いたまま（WAL に確定済みデータが残る）返す */
function healthy(keepOpen = false): Database.Database | null {
  const db = openDatabase(file)
  db.pragma('wal_autocheckpoint = 0') // WAL の内容を DB 本体に反映しない
  db.prepare("INSERT INTO events (name, status, created_at, updated_at) VALUES ('A', 'PREPARING', 1, 1)").run()
  if (keepOpen) return db
  db.close()
  return null
}

describe('Integrity pre-check (D-065)', () => {
  it('reports NEW when there is no database (first boot) and creates nothing', () => {
    expect(precheckDatabase(file).status).toBe('NEW')
    expect(existsSync(file)).toBe(false)
  })

  it('passes a healthy database and leaves the original files untouched', () => {
    healthy()
    const before = snapshot()
    const r = precheckDatabase(file)
    expect(r).toMatchObject({ status: 'OK', integrity: ['ok'], foreignKeyViolations: 0 })
    expect(snapshot()).toEqual(before)
  })

  it('includes committed data that exists only in the WAL, without modifying DB or WAL', () => {
    const writer = healthy(true)!
    // 参照整合性違反を WAL にだけ書く（外部キー制約を一時的に無効にして書き込み）
    writer.pragma('foreign_keys = OFF')
    writer.prepare("INSERT INTO teams (event_id, name, is_own_team, created_at, updated_at) VALUES (999, 'ghost', 0, 1, 1)").run()
    expect(existsSync(`${file}-wal`)).toBe(true)
    expect(statSync(`${file}-wal`).size).toBeGreaterThan(0)
    const before = snapshot()
    const r = precheckDatabase(file)
    expect(r.walIncluded).toBe(true)
    expect(r.status).toBe('FAILED')
    expect(r.foreignKeyViolations).toBe(1)
    expect(r.foreignKeySamples[0]).toContain('teams')
    expect(snapshot()).toEqual(before) // DB・WAL・SHM とも変更なし
    writer.close()
  })

  it('fails on a corrupted page and keeps the original files unchanged', () => {
    healthy()
    const buf = readFileSync(file)
    expect(buf.length).toBeGreaterThan(8192)
    // 2 ページ目以降の B-tree ページを壊す（ヘッダー 100 バイトは残す）
    for (let i = 4096 + 8; i < 4096 + 400; i++) buf[i] = 0xff
    writeFileSync(file, buf)
    const before = snapshot()
    const r = precheckDatabase(file)
    expect(r.status).toBe('FAILED')
    expect(r.integrity.join(' ') + (r.error ?? '')).not.toBe('ok')
    expect(snapshot()).toEqual(before)
    expect(describePrecheckFailure(r)).toContain('対処方法')
  })

  it('fails on a file that is not a database and on an orphan WAL', () => {
    writeFileSync(file, 'this is not a database file at all '.repeat(200))
    const before = snapshot()
    const r = precheckDatabase(file)
    expect(r.status).toBe('FAILED')
    expect(r.error).toBeTruthy()
    expect(snapshot()).toEqual(before)

    rmSync(file)
    writeFileSync(`${file}-wal`, 'orphan')
    expect(precheckDatabase(file)).toMatchObject({ status: 'FAILED' })
    expect(existsSync(file)).toBe(false)
  })

  it('openAppDatabase stops before migration and never opens the damaged file for writing', () => {
    writeFileSync(file, 'garbage '.repeat(1000))
    const before = snapshot()
    expect(() => openAppDatabase(dir)).toThrow(DatabaseIntegrityError)
    expect(snapshot()).toEqual(before)
  })

  it('openAppDatabase reports the pre-check result for a healthy database', () => {
    healthy()
    const { status } = openAppDatabase(dir)
    expect(status.precheck.status).toBe('OK')
    expect(status.integrity).toEqual(['ok'])
    expect(status.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
  })
})
