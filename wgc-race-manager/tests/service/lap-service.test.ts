import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCode } from '../../src/shared/errors'
import type { AppContext } from '../../src/main/app-context'
import { createTestDb, type TestDb } from '../helpers/db'
import { MIN, SEC, bootApp, errorCode, startedRace } from '../helpers/app'

let t: TestDb
let ctx: AppContext
beforeEach(() => {
  t = createTestDb()
  ctx = bootApp(t)
})
afterEach(() => t.cleanup())

describe('LAP REGISTER (spec §5.1, D-016)', () => {
  it('rejects before START and after END; accepts RUNNING and PAUSED', () => {
    const event = ctx.events.create({ name: 'x' })
    ctx.teams.create(event.id, { name: 'Own', isOwnTeam: true })
    expect(errorCode(() => ctx.laps.register(event.id))).toBe(ErrorCode.RACE_NOT_ACCEPTING_LAPS)
    ctx.raceClock.start(event.id)
    t.clock.advance(MIN)
    expect(ctx.laps.register(event.id).lapNumber).toBe(1)
    ctx.raceClock.pause(event.id)
    t.clock.advance(MIN)
    expect(ctx.laps.register(event.id).lapNumber).toBe(2)
    ctx.raceClock.end(event.id)
    t.clock.advance(MIN)
    expect(errorCode(() => ctx.laps.register(event.id))).toBe(ErrorCode.RACE_NOT_ACCEPTING_LAPS)
    expect(ctx.laps.list(event.id)).toHaveLength(2)
  })

  it('stores master time and PC time; lap times include the paused span (D-011)', () => {
    const { event, startAt } = startedRace(t, ctx)
    t.clock.advance(5 * MIN)
    t.clock.wallOffset = 123
    const l1 = ctx.laps.register(event.id)
    expect(l1).toMatchObject({ lapNumber: 1, passedAt: startAt + 5 * MIN, passedWallAt: startAt + 5 * MIN + 123, lapTimeMs: 5 * MIN })
    ctx.raceClock.pause(event.id)
    t.clock.advance(3 * MIN)
    ctx.raceClock.resume(event.id)
    t.clock.advance(2 * MIN)
    expect(ctx.laps.register(event.id).lapTimeMs).toBe(5 * MIN) // 一時停止の 3 分を含む
  })

  it('requires an active own team for live registration (D-008)', () => {
    const event = ctx.events.create({ name: 'x' })
    ctx.raceClock.start(event.id)
    expect(errorCode(() => ctx.laps.register(event.id))).toBe(ErrorCode.OWN_TEAM_NOT_FOUND)
    const own = ctx.teams.create(event.id, { name: 'Own', isOwnTeam: true })
    ctx.teams.delete(own.id, ctx.teams.getDeletionImpact(own.id))
    expect(errorCode(() => ctx.laps.register(event.id))).toBe(ErrorCode.OWN_TEAM_NOT_FOUND)
  })

  it('rejects a same-millisecond double registration (no zero lap time)', () => {
    const { event } = startedRace(t, ctx)
    t.clock.advance(MIN)
    ctx.laps.register(event.id)
    expect(errorCode(() => ctx.laps.register(event.id))).toBe(ErrorCode.DUPLICATE_PASS)
    expect(ctx.laps.list(event.id)).toHaveLength(1)
  })

  it('records history with the operator snapshot', () => {
    const { event } = startedRace(t, ctx)
    ctx.operator.set({ id: null, name: '計測係A' })
    t.clock.advance(MIN)
    const l = ctx.laps.register(event.id)
    const h = t.repos.history.listByEvent(event.id).at(-1)!
    expect(h).toMatchObject({ action: 'CREATE', targetTable: 'lap_records', targetId: l.recordId, operatorNameSnapshot: '計測係A' })
  })
})

describe('Past record operations (spec §5.3, D-018)', () => {
  function threeLaps() {
    const r = startedRace(t, ctx)
    for (let i = 0; i < 3; i++) {
      t.clock.advance(10 * MIN)
      ctx.laps.register(r.event.id)
    }
    return r
  }

  it('adds a missed lap in the middle and renumbers/recomputes', () => {
    const { event, startAt } = threeLaps()
    const added = ctx.laps.addPast(event.id, startAt + 15 * MIN)
    expect(added.lapNumber).toBe(2)
    expect(added.passedWallAt).toBeNull()
    expect(ctx.laps.list(event.id).map((l) => [l.lapNumber, l.lapTimeMs])).toEqual([
      [1, 10 * MIN],
      [2, 5 * MIN],
      [3, 5 * MIN],
      [4, 10 * MIN]
    ])
  })

  it('rejects add before/at start, in the future, or duplicating the same team', () => {
    const { event, startAt, rival } = threeLaps()
    expect(errorCode(() => ctx.laps.addPast(event.id, startAt))).toBe(ErrorCode.VALIDATION)
    expect(errorCode(() => ctx.laps.addPast(event.id, startAt - SEC))).toBe(ErrorCode.VALIDATION)
    expect(errorCode(() => ctx.laps.addPast(event.id, t.clock.t + 1))).toBe(ErrorCode.VALIDATION)
    expect(errorCode(() => ctx.laps.addPast(event.id, startAt + 10 * MIN))).toBe(ErrorCode.DUPLICATE_PASS)
    expect(errorCode(() => ctx.laps.addPast(event.id, 1.5))).toBe(ErrorCode.VALIDATION)
    // 異なるチームの同一日時は許可
    t.repos.competitorPasses.insert({ eventId: event.id, teamId: rival.id, passedAt: startAt + 12 * MIN })
    expect(ctx.laps.addPast(event.id, startAt + 12 * MIN).lapNumber).toBe(2)
  })

  it('rejects past additions before START', () => {
    const event = ctx.events.create({ name: 'x' })
    ctx.teams.create(event.id, { name: 'Own', isOwnTeam: true })
    expect(errorCode(() => ctx.laps.addPast(event.id, t.clock.t - 1))).toBe(ErrorCode.RACE_NOT_STARTED)
  })

  it('updates within neighbours; rejects reordering, duplicates and before-start', () => {
    const { event, startAt } = threeLaps()
    const [l1, l2] = ctx.laps.list(event.id)
    const u = ctx.laps.updatePassedAt(l2!.recordId, startAt + 18 * MIN)
    expect(u.lapTimeMs).toBe(8 * MIN)
    expect(ctx.laps.list(event.id)[2]!.lapTimeMs).toBe(12 * MIN)
    expect(errorCode(() => ctx.laps.updatePassedAt(l1!.recordId, startAt + 19 * MIN))).toBe(ErrorCode.TIMELINE_CONFLICT)
    expect(errorCode(() => ctx.laps.updatePassedAt(l2!.recordId, startAt + 5 * MIN))).toBe(ErrorCode.TIMELINE_CONFLICT)
    expect(errorCode(() => ctx.laps.updatePassedAt(l2!.recordId, startAt + 10 * MIN))).toBe(ErrorCode.DUPLICATE_PASS)
    expect(errorCode(() => ctx.laps.updatePassedAt(l1!.recordId, startAt))).toBe(ErrorCode.VALIDATION)
    expect(errorCode(() => ctx.laps.updatePassedAt(999, startAt + MIN))).toBe(ErrorCode.RECORD_NOT_FOUND)
    expect(ctx.laps.list(event.id)[1]!.passedAt).toBe(startAt + 18 * MIN)
  })

  it('deletes logically and renumbers', () => {
    const { event } = threeLaps()
    const [, l2] = ctx.laps.list(event.id)
    ctx.laps.delete(l2!.recordId)
    expect(ctx.laps.list(event.id).map((l) => [l.lapNumber, l.lapTimeMs])).toEqual([
      [1, 10 * MIN],
      [2, 20 * MIN]
    ])
    expect(t.repos.lapRecords.findById(l2!.recordId, { includeDeleted: true })?.deletedAt).not.toBeNull()
    expect(errorCode(() => ctx.laps.delete(l2!.recordId))).toBe(ErrorCode.RECORD_NOT_FOUND)
  })

  it('allows past operations after END', () => {
    const { event, startAt } = threeLaps()
    ctx.raceClock.end(event.id)
    t.clock.advance(10 * MIN)
    expect(ctx.laps.addPast(event.id, startAt + 35 * MIN).lapNumber).toBe(4)
    ctx.laps.updatePassedAt(ctx.laps.list(event.id)[0]!.recordId, startAt + 9 * MIN)
    ctx.laps.delete(ctx.laps.list(event.id)[3]!.recordId)
    expect(ctx.laps.list(event.id)).toHaveLength(3)
  })

  it('allows past operations for a deleted own team and keeps it deleted (D-009)', () => {
    const { event, own, startAt } = threeLaps()
    ctx.teams.delete(own.id, ctx.teams.getDeletionImpact(own.id))
    expect(ctx.laps.list(event.id)).toHaveLength(3) // 削除済みでも記録は表示対象
    ctx.laps.addPast(event.id, startAt + 25 * MIN)
    expect(ctx.teams.get(own.id).deletedAt).not.toBeNull()
    expect(ctx.laps.list(event.id)).toHaveLength(4)
  })

  it('recomputes the first lap after correcting the actual start (D-012)', () => {
    const { event, startAt } = threeLaps()
    ctx.raceClock.correctActualStart(event.id, startAt - 30 * SEC)
    expect(ctx.laps.list(event.id)[0]!.lapTimeMs).toBe(10 * MIN + 30 * SEC)
  })
})
