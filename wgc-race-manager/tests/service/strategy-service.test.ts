import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCode } from '../../src/shared/errors'
import type { AppContext } from '../../src/main/app-context'
import { createTestDb, type TestDb } from '../helpers/db'
import { MIN, bootApp, errorCode } from '../helpers/app'

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

/** 自チーム 10 分/周、R 9 分/周で 60 分走った大会 */
function race() {
  const start = t.clock.t
  const event = ctx.events.create({ name: 'WGC', scheduledStartAt: start, scheduledEndAt: start + 480 * MIN })
  const own = ctx.teams.create(event.id, { name: 'Own', isOwnTeam: true })
  const rival = ctx.teams.create(event.id, { name: 'R' })
  ctx.raceClock.start(event.id)
  for (let m = 1; m <= 60; m++) {
    t.clock.advance(MIN)
    if (m % 10 === 0) ctx.laps.register(event.id)
    if (m % 9 === 0) ctx.competitors.register(rival.id)
  }
  return { event, own, rival, start }
}

describe('Mandatory stoppages (D-044)', () => {
  it('registers multiple stoppages including open-ended ones; validates times', () => {
    const { event, start } = race()
    ctx.stoppages.create(event.id, start + 100 * MIN, start + 110 * MIN)
    const open = ctx.stoppages.create(event.id, start + 200 * MIN, null)
    expect(ctx.stoppages.list(event.id).map((s) => s.endsAt)).toEqual([start + 110 * MIN, null])
    expect(errorCode(() => ctx.stoppages.create(event.id, start, start))).toBe(ErrorCode.VALIDATION)
    expect(errorCode(() => ctx.stoppages.create(event.id, 1.5, null))).toBe(ErrorCode.VALIDATION)
    expect(errorCode(() => ctx.stoppages.create(999, start, null))).toBe(ErrorCode.EVENT_NOT_FOUND)
    // 終了未定に後から終了日時を入れる
    expect(ctx.stoppages.update(open.id, start + 200 * MIN, start + 215 * MIN).endsAt).toBe(start + 215 * MIN)
  })

  it('allows changes after END and supports UNDO of create / update / delete', () => {
    const { event, start } = race()
    ctx.raceClock.end(event.id)
    const s = ctx.stoppages.create(event.id, start + 20 * MIN, start + 25 * MIN)
    ctx.stoppages.update(s.id, start + 20 * MIN, start + 30 * MIN)
    ctx.stoppages.delete(s.id)
    expect(ctx.stoppages.list(event.id)).toEqual([])
    expect(ctx.undo.peek(event.id)!.description).toContain('強制停止時間の削除')
    undoLatest(event.id)
    expect(ctx.stoppages.list(event.id)[0]!.endsAt).toBe(start + 30 * MIN)
    undoLatest(event.id)
    expect(ctx.stoppages.list(event.id)[0]!.endsAt).toBe(start + 25 * MIN)
    undoLatest(event.id)
    expect(ctx.stoppages.list(event.id)).toEqual([])
    const h = t.repos.history.listByEvent(event.id).filter((x) => x.targetTable === 'mandatory_stoppages')
    expect(h.map((x) => x.action)).toEqual(['CREATE', 'UPDATE', 'DELETE', 'UNDO', 'UNDO', 'UNDO'])
  })
})

describe('StrategyService recalculates from source data (§8.9)', () => {
  it('reads both record types and includes deleted teams', () => {
    const { event, rival } = race()
    ctx.teams.delete(rival.id, ctx.teams.getDeletionImpact(rival.id))
    const rep = ctx.strategy.get(event.id)
    expect(rep.teams.map((x) => [x.name, x.current.laps, x.teamDeleted])).toEqual([
      ['R', 6, true],
      ['Own', 6, false]
    ])
    expect(rep.rankingRule.provisional).toBe(true)
  })

  it('updates after a new lap, a correction, a deletion and an UNDO', () => {
    const { event } = race()
    const before = ctx.strategy.get(event.id).teams.find((x) => x.name === 'Own')!
    expect(before.current.laps).toBe(6)
    t.clock.advance(10 * MIN)
    ctx.laps.register(event.id)
    expect(ctx.strategy.get(event.id).teams.find((x) => x.name === 'Own')!.current.laps).toBe(7)
    const lap = ctx.laps.list(event.id).at(-1)!
    ctx.laps.updatePassedAt(lap.recordId, lap.passedAt - 2 * MIN)
    const p3 = ctx.strategy.get(event.id).teams.find((x) => x.name === 'Own')!.pace.averages.avg3.avgMs
    expect(p3).toBeCloseTo((10 * MIN + 10 * MIN + 8 * MIN) / 3, 6)
    ctx.laps.delete(lap.recordId)
    expect(ctx.strategy.get(event.id).teams.find((x) => x.name === 'Own')!.current.laps).toBe(6)
    undoLatest(event.id)
    expect(ctx.strategy.get(event.id).teams.find((x) => x.name === 'Own')!.current.laps).toBe(7)
  })

  it('updates after stoppage and scheduled end changes', () => {
    const { event, start } = race()
    const base = ctx.strategy.get(event.id)
    const ownBase = base.teams.find((x) => x.name === 'Own')!.scenarios.avg5.predictedFinalLaps!
    const s = ctx.stoppages.create(event.id, start + 200 * MIN, start + 230 * MIN)
    const withStop = ctx.strategy.get(event.id)
    expect(withStop.clock.remainingStoppageMs).toBe(30 * MIN)
    expect(withStop.teams.find((x) => x.name === 'Own')!.scenarios.avg5.predictedFinalLaps).toBe(ownBase - 3)
    ctx.stoppages.delete(s.id)
    expect(ctx.strategy.get(event.id).clock.remainingStoppageMs).toBe(0)
    ctx.events.update(event.id, { scheduledEndAt: start + 420 * MIN })
    expect(ctx.strategy.get(event.id).teams.find((x) => x.name === 'Own')!.scenarios.avg5.predictedFinalLaps).toBe(ownBase - 6)
  })

  it('reports not-found events', () => {
    expect(errorCode(() => ctx.strategy.get(999))).toBe(ErrorCode.EVENT_NOT_FOUND)
  })
})
