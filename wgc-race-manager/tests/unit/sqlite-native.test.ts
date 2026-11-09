import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { probeSqliteVersion } from '../../src/main/db/sqlite-probe'

describe('better-sqlite3 native module', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('loads and reports the SQLite version', () => {
    expect(probeSqliteVersion()).toMatch(/^3\.\d+\.\d+$/)
  })

  it('supports WAL + synchronous=FULL on a file database and persists across reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wgc-test-'))
    dirs.push(dir)
    const file = join(dir, 'probe.sqlite')

    const db = new Database(file)
    expect(db.pragma('journal_mode = WAL', { simple: true })).toBe('wal')
    db.pragma('synchronous = FULL')
    expect(db.pragma('synchronous', { simple: true })).toBe(2) // 2 = FULL
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT)')
    db.prepare('INSERT INTO t (body) VALUES (?)').run('日本語,カンマ\n改行')
    db.close()

    const reopened = new Database(file, { readonly: true })
    const row = reopened.prepare('SELECT body FROM t').get() as { body: string }
    expect(row.body).toBe('日本語,カンマ\n改行')
    reopened.close()
  })

  it('rolls back a failed transaction', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)')
    const tx = db.transaction(() => {
      db.prepare('INSERT INTO t (v) VALUES (1)').run()
      db.prepare('INSERT INTO t (v) VALUES (NULL)').run() // NOT NULL 違反
    })
    expect(() => tx()).toThrow()
    expect((db.prepare('SELECT COUNT(*) c FROM t').get() as { c: number }).c).toBe(0)
    db.close()
  })
})
