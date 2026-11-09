import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCode } from '../../src/shared/errors'
import type { AppContext } from '../../src/main/app-context'
import { createTestDb, type TestDb } from '../helpers/db'
import { MIN, bootApp, errorCode, startedRace } from '../helpers/app'

let t: TestDb
let ctx: AppContext
beforeEach(() => {
  t = createTestDb()
  ctx = bootApp(t)
})
afterEach(() => t.cleanup())

function undoLatest(eventId: number) {
  const c = ctx.undo.peek(eventId)!
  return ctx.undo.undo(eventId, c.operationGroup)
}

function raceWithLaps(n = 3) {
  const r = startedRace(t, ctx)
  for (let i = 0; i < n; i++) {
    t.clock.advance(10 * MIN)
    ctx.laps.register(r.event.id)
  }
  return { ...r, laps: ctx.laps.list(r.event.id) }
}

describe('Vehicle data entry (spec §6, D-006, D-027, D-029)', () => {
  it('links one set to each lap, independently of lap registration', () => {
    const { event, laps } = raceWithLaps()
    ctx.vehicleData.create(laps[0]!.recordId, { speed: '62.5', voltage: '98.1', current: '12.3', integratedValue: '1234' })
    ctx.vehicleData.create(laps[2]!.recordId, { speed: '60' })
    const rows = ctx.vehicleData.listByEvent(event.id)
    expect(rows.map((r) => [r.lapNumber, r.vehicleData?.speed ?? null])).toEqual([
      [1, '62.5'],
      [2, null],
      [3, '60']
    ])
    expect(rows[0]!.vehicleData).toMatchObject({ voltage: '98.1', current: '12.3', integratedValue: '1234' })
    expect(rows[1]!.vehicleData).toBeNull()
    expect(errorCode(() => ctx.vehicleData.create(laps[0]!.recordId, { speed: '1' }))).toBe(ErrorCode.VEHICLE_DATA_EXISTS)
  })

  it('stores raw strings and never turns blanks into 0', () => {
    const { laps } = raceWithLaps(1)
    const v = ctx.vehicleData.create(laps[0]!.recordId, { speed: '', voltage: '  ', current: '0', integratedValue: '0012.50' })
    expect(v).toMatchObject({ speed: null, voltage: null, current: '0', integratedValue: '0012.50' })
  })

  it('keeps the row when all four fields are blank (all not entered, D-027)', () => {
    const { event, laps } = raceWithLaps(2)
    const v = ctx.vehicleData.create(laps[0]!.recordId, { speed: '50', voltage: '100' })
    const cleared = ctx.vehicleData.update(v.id, { speed: '', voltage: null })
    expect(cleared).toMatchObject({ id: v.id, speed: null, voltage: null, current: null, integratedValue: null, deletedAt: null })
    expect(ctx.vehicleData.listByEvent(event.id)[0]!.vehicleData?.id).toBe(v.id)
    // 全項目空欄での新規登録も行として残る
    const blank = ctx.vehicleData.create(laps[1]!.recordId, { speed: '', voltage: '', current: '', integratedValue: '' })
    expect(blank).toMatchObject({ speed: null, voltage: null, current: null, integratedValue: null })
    expect(ctx.vehicleData.listByEvent(event.id)[1]!.vehicleData?.id).toBe(blank.id)
  })

  it('saves modified values; partial updates keep other fields; full before/after in history (D-028)', () => {
    const { event, laps } = raceWithLaps(1)
    const v = ctx.vehicleData.create(laps[0]!.recordId, { speed: '50', voltage: '100', current: '10', integratedValue: 'x' })
    const u = ctx.vehicleData.update(v.id, { speed: '55' })
    expect(u).toMatchObject({ speed: '55', voltage: '100', current: '10', integratedValue: 'x' })
    const h = t.repos.history.listByEvent(event.id).at(-1)!
    expect(h).toMatchObject({ action: 'UPDATE', targetTable: 'vehicle_data', targetId: v.id })
    const before = JSON.parse(h.beforeJson!)
    const after = JSON.parse(h.afterJson!)
    for (const k of ['speed', 'voltage', 'current', 'integratedValue']) {
      expect(k in before && k in after).toBe(true)
    }
    expect([before.speed, after.speed, before.voltage, after.voltage]).toEqual(['50', '55', '100', '100'])
  })

  it('validates input shape only', () => {
    const { laps } = raceWithLaps(1)
    expect(errorCode(() => ctx.vehicleData.create(laps[0]!.recordId, { speed: 60 } as never))).toBe(ErrorCode.VALIDATION)
    expect(errorCode(() => ctx.vehicleData.create(laps[0]!.recordId, { soc: '80' } as never))).toBe(ErrorCode.VALIDATION)
    expect(errorCode(() => ctx.vehicleData.create(laps[0]!.recordId, { lapRecordId: 9 } as never))).toBe(ErrorCode.VALIDATION)
    expect(errorCode(() => ctx.vehicleData.create(999, { speed: '1' }))).toBe(ErrorCode.RECORD_NOT_FOUND)
  })

  it('cannot be attached to competitor passes (D-029)', () => {
    const { rival } = raceWithLaps(0)
    t.clock.advance(MIN)
    const p = ctx.competitors.register(rival.id)
    // vehicle_data は lap_records のみを参照するため、通過記録の ID を指定しても他チームには紐づかない
    const lapIds = t.repos.lapRecords.listByTeam(rival.id, { includeDeleted: true }).map((x) => x.id)
    expect(lapIds).toEqual([])
    expect(errorCode(() => ctx.vehicleData.create(p.recordId, { speed: '1' }))).toBe(ErrorCode.RECORD_NOT_FOUND)
  })
})

describe('Deleted laps (D-025, D-026)', () => {
  it('keeps vehicle data when the lap is deleted, hides it, and shows it again after restore', () => {
    const { event, laps } = raceWithLaps(2)
    const v = ctx.vehicleData.create(laps[0]!.recordId, { speed: '50' })
    ctx.laps.delete(laps[0]!.recordId)
    expect(ctx.vehicleData.listByEvent(event.id).map((r) => r.lapRecordId)).toEqual([laps[1]!.recordId])
    expect(t.repos.vehicleData.findById(v.id)).not.toBeNull() // DB には保持
    undoLatest(event.id) // ラップ削除の取り消し（= 復元）
    const rows = ctx.vehicleData.listByEvent(event.id)
    expect(rows[0]!.vehicleData?.id).toBe(v.id)
    expect(rows[0]!.vehicleData?.speed).toBe('50')
  })

  it('rejects create / update / delete on a deleted lap', () => {
    const { laps } = raceWithLaps(2)
    const v = ctx.vehicleData.create(laps[0]!.recordId, { speed: '50' })
    ctx.laps.delete(laps[0]!.recordId)
    ctx.laps.delete(laps[1]!.recordId)
    expect(errorCode(() => ctx.vehicleData.create(laps[1]!.recordId, { speed: '1' }))).toBe(ErrorCode.LAP_DELETED)
    expect(errorCode(() => ctx.vehicleData.update(v.id, { speed: '1' }))).toBe(ErrorCode.LAP_DELETED)
    expect(errorCode(() => ctx.vehicleData.delete(v.id))).toBe(ErrorCode.LAP_DELETED)
    expect(t.repos.vehicleData.findById(v.id)?.speed).toBe('50')
  })

  it('allows entry after END and for a deleted own team (records stay editable, D-009)', () => {
    const { event, own, laps } = raceWithLaps(1)
    ctx.raceClock.end(event.id)
    ctx.teams.delete(own.id, ctx.teams.getDeletionImpact(own.id))
    expect(ctx.vehicleData.create(laps[0]!.recordId, { speed: '50' }).speed).toBe('50')
  })
})

describe('Vehicle data deletion and UNDO (D-017, D-024, D-028)', () => {
  it('deletes the set as a separate operation and allows re-entry', () => {
    const { event, laps } = raceWithLaps(1)
    const v = ctx.vehicleData.create(laps[0]!.recordId, { speed: '50' })
    ctx.vehicleData.delete(v.id)
    expect(ctx.vehicleData.listByEvent(event.id)[0]!.vehicleData).toBeNull()
    expect(errorCode(() => ctx.vehicleData.update(v.id, { speed: '1' }))).toBe(ErrorCode.RECORD_NOT_FOUND)
    expect(ctx.vehicleData.create(laps[0]!.recordId, { speed: '51' }).speed).toBe('51')
  })

  it('restores the exact previous values (including nulls) step by step', () => {
    const { event, laps } = raceWithLaps(1)
    const v = ctx.vehicleData.create(laps[0]!.recordId, { speed: '50', voltage: '100', current: null, integratedValue: '7' })
    ctx.vehicleData.update(v.id, { speed: '55', integratedValue: '' })
    ctx.vehicleData.update(v.id, { voltage: null, current: '12' })
    ctx.vehicleData.delete(v.id)

    undoLatest(event.id)
    expect(t.repos.vehicleData.findById(v.id)).toMatchObject({ speed: '55', voltage: null, current: '12', integratedValue: null })
    undoLatest(event.id)
    expect(t.repos.vehicleData.findById(v.id)).toMatchObject({ speed: '55', voltage: '100', current: null, integratedValue: null })
    undoLatest(event.id)
    expect(t.repos.vehicleData.findById(v.id)).toMatchObject({ speed: '50', voltage: '100', current: null, integratedValue: '7' })
    undoLatest(event.id)
    expect(t.repos.vehicleData.findById(v.id)).toBeNull()
    // 車両データの追加を取り消した後は、ラップの追加も取り消せる（D-024）
    undoLatest(event.id)
    expect(ctx.laps.list(event.id)).toEqual([])
  })

  it('refuses to restore vehicle data while its lap is deleted', () => {
    const { event, laps } = raceWithLaps(1)
    const v = ctx.vehicleData.create(laps[0]!.recordId, { speed: '50' })
    ctx.vehicleData.delete(v.id)
    // ラップを UNDO 対象外の経路で削除した状況（直接）
    t.repos.lapRecords.softDelete(laps[0]!.recordId)
    expect(errorCode(() => undoLatest(event.id))).toBe(ErrorCode.UNDO_CONFLICT)
    expect(t.repos.vehicleData.findById(v.id)).toBeNull()
  })

  it('refuses undoing a lap addition while vehicle data is active, allows it after the data is undone', () => {
    const { event, laps } = raceWithLaps(1)
    ctx.vehicleData.create(laps[0]!.recordId, { speed: '50' })
    // 車両データ追加が最新のため、まずそれが取り消される
    expect(ctx.undo.peek(event.id)!.description).toContain('車両データの追加')
    undoLatest(event.id)
    expect(ctx.undo.peek(event.id)!.description).toContain('自チームラップ記録の追加')
    undoLatest(event.id)
    expect(ctx.laps.list(event.id)).toEqual([])
  })
})
