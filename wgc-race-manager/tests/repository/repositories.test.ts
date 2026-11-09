import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NotFoundError, RepositoryError } from '../../src/main/repositories'
import { runAudited } from '../../src/main/db/unit-of-work'
import { normalizeVehicleInput } from '../../src/main/repositories/vehicle-data-repository'
import { createTestDb, type TestDb } from '../helpers/db'

let t: TestDb
beforeEach(() => {
  t = createTestDb()
})
afterEach(() => t.cleanup())

const op = { id: null, name: null }

function seedEvent(name = 'WGC 2026') {
  return t.repos.events.insert({ name, scheduledStartAt: 1000, scheduledEndAt: 2000 })
}

describe('EventRepository', () => {
  it('inserts with defaults and timestamps', () => {
    const e = seedEvent()
    expect(e.status).toBe('PREPARING')
    expect(e.createdAt).toBe(t.clock.t)
    expect(e.updatedAt).toBe(t.clock.t)
    expect(e.deletedAt).toBeNull()
    expect(e.actualStartAt).toBeNull()
  })

  it('updates only allowed columns and bumps updatedAt', () => {
    const e = seedEvent()
    t.clock.advance(500)
    const { before, after } = t.repos.events.update(e.id, { status: 'RUNNING', actualStartAt: 1234 })
    expect(before.status).toBe('PREPARING')
    expect(after.status).toBe('RUNNING')
    expect(after.actualStartAt).toBe(1234)
    expect(after.updatedAt).toBe(e.updatedAt + 500)
    expect(after.createdAt).toBe(e.createdAt)
    expect(() => t.repos.events.update(e.id, { createdAt: 1 } as never)).toThrow(RepositoryError)
  })

  it('rejects invalid status via CHECK constraint', () => {
    const e = seedEvent()
    expect(() => t.repos.events.update(e.id, { status: 'BOGUS' as never })).toThrow()
  })

  it('lists all events newest first, operators in order', () => {
    const a = seedEvent('A')
    const b = seedEvent('B')
    expect(t.repos.events.listAll().map((e) => e.id)).toEqual([b.id, a.id])
    t.repos.operators.insert({ name: '佐藤' })
    t.repos.operators.insert({ name: '鈴木' })
    expect(t.repos.operators.listAll().map((o) => o.name)).toEqual(['佐藤', '鈴木'])
  })

  it('keeps events independent (spec §1.2)', () => {
    const a = seedEvent('A')
    const b = seedEvent('B')
    t.repos.teams.insert({ eventId: a.id, name: 'X' })
    expect(t.repos.teams.listByEvent(b.id)).toEqual([])
  })
})

describe('TeamRepository', () => {
  it('allows only one non-deleted own team per event', () => {
    const e = seedEvent()
    const own = t.repos.teams.insert({ eventId: e.id, name: 'Tamagawa', isOwnTeam: true })
    expect(own.isOwnTeam).toBe(true)
    expect(() => t.repos.teams.insert({ eventId: e.id, name: 'Other', isOwnTeam: true })).toThrow(
      /UNIQUE/
    )
    // 別大会なら自チームを持てる
    const e2 = seedEvent('next')
    expect(t.repos.teams.insert({ eventId: e2.id, name: 'Tamagawa', isOwnTeam: true }).isOwnTeam).toBe(
      true
    )
    expect(t.repos.teams.findOwnTeam(e.id)?.id).toBe(own.id)
  })

  it('soft-deletes and restores a team without losing its records (D-007)', () => {
    const e = seedEvent()
    const team = t.repos.teams.insert({ eventId: e.id, name: 'Rival', bibNumber: '12A' })
    t.repos.competitorPasses.insert({ eventId: e.id, teamId: team.id, passedAt: 1500 })
    t.repos.competitorPasses.insert({ eventId: e.id, teamId: team.id, passedAt: 1600 })

    expect(t.repos.teams.countRelatedRecords(team.id)).toEqual({
      lapRecords: 0,
      competitorPasses: 2,
      vehicleData: 0
    })

    t.clock.advance(10)
    const { after } = t.repos.teams.softDelete(team.id)
    expect(after.deletedAt).toBe(t.clock.t)
    expect(t.repos.teams.listByEvent(e.id)).toEqual([])
    expect(t.repos.teams.listByEvent(e.id, { includeDeleted: true })).toHaveLength(1)
    // 削除済みチームの記録はそのまま残る
    expect(t.repos.competitorPasses.listByTeam(team.id)).toHaveLength(2)

    const restored = t.repos.teams.restore(team.id).after
    expect(restored.deletedAt).toBeNull()
    expect(restored.bibNumber).toBe('12A')
    expect(t.repos.teams.countRelatedRecords(team.id).competitorPasses).toBe(2)
  })

  it('refuses restoring an old own team when another own team exists', () => {
    const e = seedEvent()
    const a = t.repos.teams.insert({ eventId: e.id, name: 'A', isOwnTeam: true })
    t.repos.teams.softDelete(a.id)
    t.repos.teams.insert({ eventId: e.id, name: 'B', isOwnTeam: true })
    expect(() => t.repos.teams.restore(a.id)).toThrow(/UNIQUE/)
    expect(t.repos.teams.getById(a.id, { includeDeleted: true }).deletedAt).not.toBeNull()
  })

  it('cannot soft-delete twice / restore a non-deleted row', () => {
    const e = seedEvent()
    const a = t.repos.teams.insert({ eventId: e.id, name: 'A' })
    expect(() => t.repos.teams.restore(a.id)).toThrow(/not deleted/)
    t.repos.teams.softDelete(a.id)
    expect(() => t.repos.teams.softDelete(a.id)).toThrow(NotFoundError)
  })

  it('forbids physical deletion of a team with records', () => {
    const e = seedEvent()
    const team = t.repos.teams.insert({ eventId: e.id, name: 'A' })
    t.repos.competitorPasses.insert({ eventId: e.id, teamId: team.id, passedAt: 1 })
    expect(() => t.db.prepare('DELETE FROM teams WHERE id = ?').run(team.id)).toThrow(
      /physical delete is forbidden/
    )
    expect(() => t.db.prepare('DELETE FROM competitor_passes').run()).toThrow(
      /physical delete is forbidden/
    )
    expect(t.repos.teams.findById(team.id)).not.toBeNull()
  })
})

describe('Lap / competitor pass repositories', () => {
  it('orders by passedAt then id, and keeps teams separate', () => {
    const e = seedEvent()
    const a = t.repos.teams.insert({ eventId: e.id, name: 'A' })
    const b = t.repos.teams.insert({ eventId: e.id, name: 'B' })
    t.repos.competitorPasses.insert({ eventId: e.id, teamId: a.id, passedAt: 300 })
    t.repos.competitorPasses.insert({ eventId: e.id, teamId: b.id, passedAt: 200 })
    t.repos.competitorPasses.insert({ eventId: e.id, teamId: a.id, passedAt: 100 })
    expect(t.repos.competitorPasses.listByTeam(a.id).map((r) => r.passedAt)).toEqual([100, 300])
    expect(t.repos.competitorPasses.listByTeam(b.id).map((r) => r.passedAt)).toEqual([200])
    expect(t.repos.competitorPasses.listByEvent(e.id).map((r) => r.passedAt)).toEqual([100, 200, 300])
  })

  it('rejects a record whose team belongs to another event', () => {
    const e1 = seedEvent('1')
    const e2 = seedEvent('2')
    const team = t.repos.teams.insert({ eventId: e1.id, name: 'A' })
    expect(() =>
      t.repos.lapRecords.insert({ eventId: e2.id, teamId: team.id, passedAt: 1 })
    ).toThrow(/does not belong/)
    expect(() =>
      t.repos.competitorPasses.insert({ eventId: e2.id, teamId: team.id, passedAt: 1 })
    ).toThrow(/does not belong/)
  })

  it('stores no lap number / lap time columns (D-005)', () => {
    const cols = (t.db.prepare('PRAGMA table_info(lap_records)').all() as { name: string }[]).map(
      (c) => c.name
    )
    expect(cols).not.toContain('lap_number')
    expect(cols).not.toContain('lap_time')
  })

  it('updates passedAt, soft-deletes, and excludes deleted by default', () => {
    const e = seedEvent()
    const own = t.repos.teams.insert({ eventId: e.id, name: 'Own', isOwnTeam: true })
    const r = t.repos.lapRecords.insert({
      eventId: e.id,
      teamId: own.id,
      passedAt: 100,
      passedWallAt: 101,
      bootSessionId: 'boot-1'
    })
    expect(r.passedWallAt).toBe(101)
    expect(t.repos.lapRecords.update(r.id, { passedAt: 150 }).after.passedAt).toBe(150)
    t.repos.lapRecords.softDelete(r.id)
    expect(t.repos.lapRecords.listByTeam(own.id)).toEqual([])
    expect(t.repos.lapRecords.listByTeam(own.id, { includeDeleted: true })).toHaveLength(1)
    // 削除済みの記録は更新できない
    expect(() => t.repos.lapRecords.update(r.id, { passedAt: 1 })).toThrow(NotFoundError)
  })
})

describe('VehicleDataRepository (D-006)', () => {
  function seedLap() {
    const e = seedEvent()
    const own = t.repos.teams.insert({ eventId: e.id, name: 'Own', isOwnTeam: true })
    return { e, lap: t.repos.lapRecords.insert({ eventId: e.id, teamId: own.id, passedAt: 100 }) }
  }

  it('stores input strings verbatim (no numeric conversion)', () => {
    const { lap } = seedLap()
    const v = t.repos.vehicleData.insert({
      lapRecordId: lap.id,
      speed: '060.50',
      voltage: '1.0e2',
      current: ' -3 ',
      integratedValue: '12,345 Wh?'
    })
    expect(v).toMatchObject({
      speed: '060.50',
      voltage: '1.0e2',
      current: ' -3 ',
      integratedValue: '12,345 Wh?'
    })
    const types = t.db
      .prepare('SELECT typeof(speed) s, typeof(voltage) v FROM vehicle_data WHERE id = ?')
      .get(v.id)
    expect(types).toEqual({ s: 'text', v: 'text' })
  })

  it('treats blank as not-entered (null), never 0', () => {
    const { lap } = seedLap()
    const v = t.repos.vehicleData.insert({ lapRecordId: lap.id, speed: '', voltage: '   ', current: '0' })
    expect(v.speed).toBeNull()
    expect(v.voltage).toBeNull()
    expect(v.current).toBe('0')
    expect(v.integratedValue).toBeNull()
    expect(normalizeVehicleInput(undefined)).toBeNull()
  })

  it('allows one active set per lap, editable later, clearable to null', () => {
    const { e, lap } = seedLap()
    const v = t.repos.vehicleData.insert({ lapRecordId: lap.id, speed: '50' })
    expect(() => t.repos.vehicleData.insert({ lapRecordId: lap.id, speed: '51' })).toThrow(/UNIQUE/)
    const { before, after } = t.repos.vehicleData.update(v.id, { speed: '55', voltage: '100' })
    expect(before.speed).toBe('50')
    expect(after).toMatchObject({ speed: '55', voltage: '100' })
    expect(t.repos.vehicleData.update(v.id, { speed: null }).after.speed).toBeNull()
    expect(t.repos.vehicleData.findByLapRecord(lap.id)?.id).toBe(v.id)
    expect(t.repos.vehicleData.listByEvent(e.id).map((x) => x.id)).toEqual([v.id])
    // 論理削除後は同じラップに新しいセットを登録できる
    t.repos.vehicleData.softDelete(v.id)
    expect(t.repos.vehicleData.insert({ lapRecordId: lap.id, speed: '60' }).speed).toBe('60')
  })
})

describe('Operation history & audited transactions (spec §11, §14)', () => {
  it('refuses to record history outside a transaction', () => {
    expect(() =>
      t.repos.history.record({
        eventId: null,
        operator: op,
        action: 'CREATE',
        targetTable: 'x',
        targetId: 1,
        before: null,
        after: {}
      })
    ).toThrow(/inside a transaction/)
  })

  it('records data change + history atomically with operator snapshot', () => {
    const e = seedEvent()
    const operator = t.repos.operators.insert({ name: '山田' })
    const ctx = { eventId: e.id, operator: { id: operator.id, name: operator.name } }

    const team = runAudited(t.db, t.repos, ctx, () => {
      const created = t.repos.teams.insert({ eventId: e.id, name: 'A' })
      return {
        result: created,
        changes: [{ action: 'CREATE', targetTable: 'teams', targetId: created.id, before: null, after: created }]
      }
    })

    // 操作者名を変更しても履歴の名前は当時のまま
    runAudited(t.db, t.repos, ctx, () => {
      const { before, after } = t.repos.operators.update(operator.id, { name: '山田太郎' })
      return { result: null, changes: [{ action: 'UPDATE', targetTable: 'operators', targetId: operator.id, before, after }] }
    })

    const h = t.repos.history.listByEvent(e.id)
    expect(h).toHaveLength(2)
    expect(h[0]).toMatchObject({
      action: 'CREATE',
      targetTable: 'teams',
      targetId: team.id,
      operatorId: operator.id,
      operatorNameSnapshot: '山田',
      beforeJson: null
    })
    expect(JSON.parse(h[0]!.afterJson!)).toMatchObject({ name: 'A' })
    expect(JSON.parse(h[1]!.beforeJson!).name).toBe('山田')
    expect(JSON.parse(h[1]!.afterJson!).name).toBe('山田太郎')
  })

  it('rolls back the data change when history recording fails', () => {
    const e = seedEvent()
    expect(() =>
      runAudited(t.db, t.repos, { eventId: e.id, operator: op }, () => {
        t.repos.teams.insert({ eventId: e.id, name: 'ghost' })
        return {
          result: null,
          changes: [{ action: 'BOGUS' as never, targetTable: 'teams', targetId: 1, before: null, after: null }]
        }
      })
    ).toThrow()
    expect(t.repos.teams.listByEvent(e.id, { includeDeleted: true })).toEqual([])
    expect(t.repos.history.listAll()).toEqual([])
  })

  it('rolls back history when the data change fails', () => {
    const e = seedEvent()
    t.repos.teams.insert({ eventId: e.id, name: 'Own', isOwnTeam: true })
    expect(() =>
      runAudited(t.db, t.repos, { eventId: e.id, operator: op }, () => {
        const first = t.repos.teams.insert({ eventId: e.id, name: 'ok' })
        t.repos.teams.insert({ eventId: e.id, name: 'dup-own', isOwnTeam: true })
        return { result: first, changes: [] }
      })
    ).toThrow(/UNIQUE/)
    expect(t.repos.teams.listByEvent(e.id).map((x) => x.name)).toEqual(['Own'])
  })

  it('keeps history append-only', () => {
    const e = seedEvent()
    runAudited(t.db, t.repos, { eventId: e.id, operator: op }, () => ({
      result: null,
      changes: [{ action: 'CREATE', targetTable: 'events', targetId: e.id, before: null, after: e }]
    }))
    expect(() => t.db.prepare("UPDATE operation_history SET action = 'DELETE'").run()).toThrow(/append-only/)
    expect(() => t.db.prepare('DELETE FROM operation_history').run()).toThrow(/physical delete/)
    expect(() => t.repos.history.insert()).toThrow()
  })
})

describe('Clock transitions, stoppages, memos', () => {
  it('stores clock transitions append-only', () => {
    const e = seedEvent()
    const tr = t.repos.clockTransitions.insert({
      eventId: e.id,
      kind: 'START',
      at: 1000,
      wallAt: 1001,
      monoMs: 12.5,
      bootSessionId: 'b1'
    })
    expect(tr).toMatchObject({ kind: 'START', at: 1000, wallAt: 1001, monoMs: 12.5 })
    expect(() => t.db.prepare('UPDATE race_clock_transitions SET at = 0').run()).toThrow(/append-only/)
    expect(() => t.repos.clockTransitions.softDelete(tr.id)).toThrow(/does not support/)
    expect(() =>
      t.repos.clockTransitions.insert({ eventId: e.id, kind: 'JUMP' as never, at: 1, wallAt: 1, monoMs: null, bootSessionId: 'b' })
    ).toThrow()
  })

  it('stores multiple stoppages and rejects end before start', () => {
    const e = seedEvent()
    t.repos.stoppages.insert({ eventId: e.id, startsAt: 500, endsAt: 600 })
    t.repos.stoppages.insert({ eventId: e.id, startsAt: 100 })
    expect(t.repos.stoppages.listByEvent(e.id).map((s) => [s.startsAt, s.endsAt])).toEqual([
      [100, null],
      [500, 600]
    ])
    expect(() => t.repos.stoppages.insert({ eventId: e.id, startsAt: 500, endsAt: 400 })).toThrow()
  })

  it('stores memos with commas and newlines intact', () => {
    const e = seedEvent()
    const body = 'ピットイン,タイヤ交換\n"ドライバー"交代'
    t.repos.memos.insert({ eventId: e.id, body, notedAt: 123 })
    expect(t.repos.memos.listByEvent(e.id)[0]!.body).toBe(body)
  })
})

describe('Durability', () => {
  it('persists committed data across close/reopen', () => {
    const e = seedEvent()
    const team = t.repos.teams.insert({ eventId: e.id, name: 'A' })
    t.repos.competitorPasses.insert({ eventId: e.id, teamId: team.id, passedAt: 42 })
    t = t.reopen()
    expect(t.repos.competitorPasses.listByTeam(team.id).map((r) => r.passedAt)).toEqual([42])
  })
})
