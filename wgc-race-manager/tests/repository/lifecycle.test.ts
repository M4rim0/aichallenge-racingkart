import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { MIGRATIONS } from '../../src/main/db/migrations'
import { migrate, getSchemaVersion } from '../../src/main/db/migrate'
import { configure } from '../../src/main/db/connection'
import { createRepositories } from '../../src/main/repositories'
import { registerBootSession } from '../../src/main/clock/session-registry'
import { MasterClock } from '../../src/main/clock/master-clock'
import { FakeNow, createTestDb, type TestDb } from '../helpers/db'

let t: TestDb | null = null
afterEach(() => t?.cleanup())

describe('Migrations 004 / 005 (D-066, D-072)', () => {
  it('upgrades a version-3 database without touching existing data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wgc-mig-'))
    const file = join(dir, 'v3.sqlite')
    const db = new Database(file)
    configure(db)
    migrate(db, MIGRATIONS.filter((m) => m.version <= 3))
    expect(getSchemaVersion(db)).toBe(3)
    db.prepare("INSERT INTO events (name, status, created_at, updated_at) VALUES ('旧大会', 'FINISHED', 1, 1)").run()
    migrate(db)
    expect(getSchemaVersion(db)).toBe(5) // 004（起動・終了の記録）と 005（復旧確認待ち）
    expect(db.prepare('SELECT name FROM events').all()).toEqual([{ name: '旧大会' }])
    expect(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name IN ('app_lifecycle_events', 'race_recovery_holds')").get()).toEqual({ c: 2 })
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('is append-only and separate from operation history', () => {
    t = createTestDb()
    const clock = new MasterClock(t.clock, 'b1')
    registerBootSession(t.db, t.repos, clock, 'test')
    expect(() => t!.db.prepare("UPDATE app_lifecycle_events SET kind = 'CLEAN_SHUTDOWN'").run()).toThrow(/append-only/)
    expect(() => t!.db.prepare('DELETE FROM app_lifecycle_events').run()).toThrow(/physical delete/)
    expect(t.repos.history.listAll()).toEqual([]) // 起動の記録は操作履歴に入らない
  })
})

describe('Boot / clean shutdown judgement (D-066)', () => {
  function boot(tdb: TestDb, id: string) {
    const clock = new MasterClock(tdb.clock, id)
    return registerBootSession(tdb.db, createRepositories(tdb.db, () => clock.now(), id), clock, 'test')
  }
  const markClean = (tdb: TestDb, id: string) =>
    tdb.repos.lifecycle.insert({ bootSessionId: id, kind: 'CLEAN_SHUTDOWN', at: tdb.clock.t, wallAt: tdb.clock.t })

  it('records BOOT together with the session and judges the previous boot', () => {
    t = createTestDb()
    boot(t, 's1')
    expect(t.repos.lifecycle.listBySession('s1').map((e) => e.kind)).toEqual(['BOOT'])
    expect(t.repos.lifecycle.previousShutdownStatus('s1')).toBeNull() // 初回は判定対象なし

    t.clock.advance(1000)
    markClean(t, 's1')
    t.clock.advance(1000)
    boot(t, 's2')
    expect(t.repos.lifecycle.previousShutdownStatus('s2')).toMatchObject({ bootSessionId: 's1', clean: true })

    t.clock.advance(1000)
    boot(t, 's3') // s2 は正常終了の記録なし
    expect(t.repos.lifecycle.previousShutdownStatus('s3')).toMatchObject({ bootSessionId: 's2', clean: false })
  })

  it('does not judge sessions from before the lifecycle table existed (no false "unclean")', () => {
    t = createTestDb()
    // BOOT の記録がない古い起動
    t.repos.appSessions.insert({ id: 'legacy', startedWallAt: 1, latestSavedAtBefore: null, clockAnomaly: false, anomalyDetail: null, appVersion: null })
    t.clock.advance(1000)
    boot(t, 'new')
    expect(t.repos.lifecycle.previousShutdownStatus('new')).toBeNull()
  })

  it('previous-shutdown helpers survive reopen', () => {
    t = createTestDb()
    boot(t, 'a')
    t = t.reopen()
    t.clock.advance(1000)
    boot(t, 'b')
    expect(t.repos.lifecycle.previousShutdownStatus('b')).toMatchObject({ bootSessionId: 'a', clean: false })
    void FakeNow
  })
})
