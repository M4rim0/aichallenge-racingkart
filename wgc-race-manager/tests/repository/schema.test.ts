import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { LATEST_SCHEMA_VERSION, getSchemaVersion, migrate } from '../../src/main/db/migrate'
import { quickCheck } from '../../src/main/db/connection'
import { createTestDb, type TestDb } from '../helpers/db'

const TABLES = [
  'events',
  'teams',
  'lap_records',
  'vehicle_data',
  'competitor_passes',
  'operators',
  'memos',
  'operation_history',
  'race_clock_transitions',
  'mandatory_stoppages'
]

describe('schema & connection', () => {
  let t: TestDb
  beforeEach(() => {
    t = createTestDb()
  })
  afterEach(() => t.cleanup())

  it('creates all 10 base tables (spec §14)', () => {
    const names = (
      t.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name)
    for (const tbl of TABLES) expect(names).toContain(tbl)
  })

  it('applies data-protection pragmas', () => {
    expect(t.db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(t.db.pragma('synchronous', { simple: true })).toBe(2)
    expect(t.db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(quickCheck(t.db)).toEqual(['ok'])
  })

  it('is idempotent across reopen and keeps schema version', () => {
    expect(getSchemaVersion(t.db)).toBe(LATEST_SCHEMA_VERSION)
    t = t.reopen()
    expect(getSchemaVersion(t.db)).toBe(LATEST_SCHEMA_VERSION)
  })

  it('refuses to open a database newer than the app', () => {
    const db = new Database(':memory:')
    db.pragma('user_version = 999')
    expect(() => migrate(db)).toThrow(/newer/)
    db.close()
  })

  it('rolls back a failing migration entirely', () => {
    const db = new Database(':memory:')
    expect(() =>
      migrate(db, [{ version: 1, name: 'bad', sql: 'CREATE TABLE a (x); CREATE TABLE a (y);' }])
    ).toThrow()
    expect(getSchemaVersion(db)).toBe(0)
    expect(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='a'").get()).toEqual({ c: 0 })
    db.close()
  })

})
