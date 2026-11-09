import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCode } from '../../src/shared/errors'
import { createAppContext, type AppContext } from '../../src/main/app-context'
import { MasterClock } from '../../src/main/clock/master-clock'
import { registerBootSession } from '../../src/main/clock/session-registry'
import type { PowerBlocker } from '../../src/main/power/power-save-service'
import { createTestDb, type TestDb } from '../helpers/db'
import { MIN, errorCode } from '../helpers/app'

/** 偽の電源 API（起動ごとに OS 側の要求は消える＝新しいインスタンス） */
class FakeBlocker implements PowerBlocker {
  ids = new Set<number>()
  n = 1
  start(): number {
    const id = this.n++
    this.ids.add(id)
    return id
  }
  stop(id: number): void {
    this.ids.delete(id)
  }
  isStarted(id: number): boolean {
    return this.ids.has(id)
  }
}

let t: TestDb
let ctx: AppContext
let bootId = ''
let seq = 0

/** アプリ起動と同じ順序：起動記録（BOOT）→ コンテキスト → 異常終了なら復旧確認待ち → 電源の再判定 */
function boot(): AppContext {
  bootId = `boot-${++seq}`
  const clock = new MasterClock(t.clock, bootId)
  const ctxBoot = createAppContext(t.db, clock)
  const session = registerBootSession(t.db, ctxBoot.repos, clock, 'test')
  const c = createAppContext(t.db, clock, session, { powerBlocker: new FakeBlocker() })
  c.recovery.holdAfterUncleanShutdown(c.previousShutdown)
  c.power.reconcile()
  return c
}
/** 正常終了（CLEAN_SHUTDOWN を記録して閉じる）→ 再起動 */
function cleanRestart(downMs = MIN): AppContext {
  t.repos.lifecycle.insert({ bootSessionId: bootId, kind: 'CLEAN_SHUTDOWN', at: t.clock.t, wallAt: t.clock.t })
  t = t.reopen()
  t.clock.advance(downMs)
  return boot()
}
/** 異常終了（CLEAN_SHUTDOWN なし）→ 再起動 */
function crashRestart(downMs = MIN): AppContext {
  t = t.reopen()
  t.clock.advance(downMs)
  return boot()
}

function raceWithLaps(name = 'WGC') {
  const event = ctx.events.create({ name, scheduledStartAt: t.clock.t, scheduledEndAt: t.clock.t + 480 * MIN })
  const own = ctx.teams.create(event.id, { name: `Own-${name}`, isOwnTeam: true })
  const rival = ctx.teams.create(event.id, { name: `Rival-${name}` })
  ctx.raceClock.start(event.id)
  t.clock.advance(10 * MIN)
  const lap = ctx.laps.register(event.id)
  ctx.competitors.register(rival.id)
  return { event, own, rival, lap }
}

beforeEach(() => {
  t = createTestDb()
  ctx = boot()
})
afterEach(() => t.cleanup())

describe('Recovery hold after an unclean shutdown (D-070..D-072)', () => {
  it('1. puts a RUNNING race on hold after a crash, without touching status or clock records', () => {
    const { event } = raceWithLaps()
    const transitionsBefore = JSON.stringify(t.repos.clockTransitions.listByEvent(event.id))
    ctx = crashRestart()
    expect(ctx.previousShutdown).toMatchObject({ clean: false })
    const pending = ctx.recovery.listPending()
    expect(pending).toMatchObject([{ eventId: event.id, eventName: 'WGC', eventStatus: 'RUNNING' }])
    expect(ctx.events.get(event.id).status).toBe('RUNNING')
    expect(JSON.stringify(t.repos.clockTransitions.listByEvent(event.id))).toBe(transitionsBefore)
  })

  it('2. rejects race-affecting operations before confirmation (memos and reads remain available)', () => {
    const { event, rival, lap } = raceWithLaps()
    ctx = crashRestart()
    t.clock.advance(MIN)
    const R = ErrorCode.RECOVERY_CONFIRMATION_REQUIRED
    const ops: [string, () => unknown][] = [
      ['LAP REGISTER', () => ctx.laps.register(event.id)],
      ['lap add past', () => ctx.laps.addPast(event.id, lap.passedAt - 1000)],
      ['lap update', () => ctx.laps.updatePassedAt(lap.recordId, lap.passedAt - 1000)],
      ['lap delete', () => ctx.laps.delete(lap.recordId)],
      ['PASS REGISTER', () => ctx.competitors.register(rival.id)],
      ['pass add past', () => ctx.competitors.addPast(rival.id, lap.passedAt + 1)],
      ['PAUSE', () => ctx.raceClock.pause(event.id)],
      ['END', () => ctx.raceClock.end(event.id)],
      ['correct start', () => ctx.raceClock.correctActualStart(event.id, ctx.events.get(event.id).actualStartAt! - 1000)],
      ['stoppage', () => ctx.stoppages.create(event.id, t.clock.t + MIN, null)],
      ['UNDO', () => ctx.undo.undo(event.id, ctx.undo.peek(event.id)?.operationGroup ?? 'x')],
      ['vehicle data', () => ctx.vehicleData.create(lap.recordId, { speed: '50' })],
      ['team edit', () => ctx.teams.update(rival.id, { name: 'x' })],
      ['team add', () => ctx.teams.create(event.id, { name: 'late' })],
      ['event edit', () => ctx.events.update(event.id, { name: 'x' })]
    ]
    for (const [label, op] of ops) expect(errorCode(op), label).toBe(R)
    // 記録は増えていない
    expect(ctx.laps.list(event.id)).toHaveLength(1)
    expect(ctx.competitors.listByTeam(rival.id)).toHaveLength(1)
    // 閲覧・メモは可能
    expect(() => ctx.standings.get(event.id)).not.toThrow()
    expect(() => ctx.strategy.get(event.id)).not.toThrow()
    expect(ctx.memos.create(event.id, '異常終了から復旧中').body).toBe('異常終了から復旧中')
  })

  it('3. allows normal operation after confirmation (confirmation is not a clock operation)', () => {
    const { event, rival } = raceWithLaps()
    ctx = crashRestart()
    const h = ctx.recovery.findPending(event.id)!
    const transitionsBefore = t.repos.clockTransitions.listByEvent(event.id).length
    ctx.recovery.confirm(event.id, h.holdId)
    expect(ctx.recovery.findPending(event.id)).toBeNull()
    expect(t.repos.clockTransitions.listByEvent(event.id)).toHaveLength(transitionsBefore) // 時計の操作記録は増えない
    t.clock.advance(MIN)
    expect(ctx.laps.register(event.id).lapNumber).toBe(2)
    ctx.competitors.register(rival.id)
    ctx.raceClock.pause(event.id)
    expect(ctx.raceClock.getState(event.id).status).toBe('PAUSED')
  })

  it('4. includes the downtime in the elapsed race time (clock keeps running)', () => {
    const { event } = raceWithLaps() // 10 分走行
    ctx = crashRestart(7 * MIN) // 7 分停止
    expect(ctx.raceClock.getState(event.id)).toMatchObject({ status: 'RUNNING', elapsedMs: 17 * MIN })
    t.clock.advance(MIN)
    expect(ctx.raceClock.getState(event.id).elapsedMs).toBe(18 * MIN) // 確認待ちの間も進む
    ctx.recovery.confirm(event.id, ctx.recovery.findPending(event.id)!.holdId)
    t.clock.advance(MIN)
    expect(ctx.raceClock.getState(event.id).elapsedMs).toBe(19 * MIN) // 確認で値は変わらない
  })

  it('5. restores a PAUSED race as PAUSED (frozen elapsed time) and holds it too', () => {
    const { event } = raceWithLaps()
    ctx.raceClock.pause(event.id)
    ctx = crashRestart(30 * MIN)
    expect(ctx.raceClock.getState(event.id)).toMatchObject({ status: 'PAUSED', elapsedMs: 10 * MIN })
    expect(ctx.recovery.findPending(event.id)).toMatchObject({ eventStatus: 'PAUSED' })
    expect(errorCode(() => ctx.raceClock.resume(event.id))).toBe(ErrorCode.RECOVERY_CONFIRMATION_REQUIRED)
    ctx.recovery.confirm(event.id, ctx.recovery.findPending(event.id)!.holdId)
    expect(ctx.raceClock.getState(event.id).status).toBe('PAUSED') // 確認しても再開しない
    ctx.raceClock.resume(event.id)
    expect(ctx.raceClock.getState(event.id).status).toBe('RUNNING')
  })

  it('6. does not hold anything after a clean shutdown', () => {
    const { event } = raceWithLaps()
    ctx = cleanRestart(5 * MIN)
    expect(ctx.previousShutdown).toMatchObject({ clean: true })
    expect(ctx.recovery.listPending()).toEqual([])
    expect(ctx.raceClock.getState(event.id).elapsedMs).toBe(15 * MIN)
    t.clock.advance(MIN)
    expect(ctx.laps.register(event.id).lapNumber).toBe(2)
  })

  it('7. manages holds per event when several races were in progress', () => {
    const a = raceWithLaps('A')
    const b = raceWithLaps('B')
    ctx.raceClock.pause(b.event.id)
    const c = ctx.events.create({ name: 'C（準備中）' })
    const d = raceWithLaps('D')
    ctx.raceClock.end(d.event.id) // 終了済み
    ctx = crashRestart()
    const pending = ctx.recovery.listPending()
    expect(pending.map((h) => [h.eventName, h.eventStatus])).toEqual([
      ['A', 'RUNNING'],
      ['B', 'PAUSED']
    ])
    // A だけ確認 → A は操作可能、B は確認待ちのまま
    ctx.recovery.confirm(a.event.id, ctx.recovery.findPending(a.event.id)!.holdId)
    t.clock.advance(MIN)
    expect(ctx.laps.register(a.event.id).lapNumber).toBe(2)
    expect(errorCode(() => ctx.raceClock.resume(b.event.id))).toBe(ErrorCode.RECOVERY_CONFIRMATION_REQUIRED)
    // 進行中でなかった大会は対象外
    expect(() => ctx.events.update(c.id, { name: 'C2' })).not.toThrow()
    expect(() => ctx.laps.addPast(d.event.id, d.lap.passedAt - 1000)).not.toThrow()
    // 他の大会の ID を指定して確認することはできない
    expect(errorCode(() => ctx.recovery.confirm(b.event.id, pending[0]!.holdId))).toBe(ErrorCode.RECOVERY_HOLD_NOT_FOUND)
  })

  it('8. records the confirmation (with operator) and keeps the state across restarts', () => {
    const { event } = raceWithLaps()
    ctx = crashRestart()
    const op = ctx.operators.create('記録係')
    ctx.operators.select(op.id)
    const h = ctx.recovery.findPending(event.id)!
    const c = ctx.recovery.confirm(event.id, h.holdId)
    expect(c).toMatchObject({ holdId: h.holdId, operatorId: op.id, operatorNameSnapshot: '記録係' })
    expect(t.repos.recovery.listConfirmations(event.id)).toHaveLength(1)
    const hist = t.repos.history.listByEvent(event.id).filter((x) => x.targetTable === 'race_recovery_holds')
    expect(hist.map((x) => [x.note, x.operatorNameSnapshot])).toEqual([
      ['recovery hold (system, unclean shutdown)', null],
      ['recovery confirmed', '記録係']
    ])
    // 二重に確認できない
    expect(errorCode(() => ctx.recovery.confirm(event.id, h.holdId))).toBe(ErrorCode.RECOVERY_HOLD_NOT_FOUND)
    // 再起動（正常終了）後も確認済みのまま
    ctx = cleanRestart()
    expect(ctx.recovery.listPending()).toEqual([])
    expect(t.repos.recovery.listConfirmations(event.id)).toHaveLength(1)
  })
})

describe('Recovery hold: operator switching is allowed (D-071)', () => {
  it('allows switching operators while waiting, and records the switched operator on confirmation', () => {
    const { event } = raceWithLaps()
    const a = ctx.operators.create('A')
    const b = ctx.operators.create('B')
    ctx = crashRestart()
    expect(ctx.recovery.findPending(event.id)).not.toBeNull()
    expect(ctx.operators.select(a.id)?.name).toBe('A')
    expect(ctx.operators.select(b.id)?.name).toBe('B')
    expect(ctx.operators.current()?.name).toBe('B')
    // 確認待ちのまま（切り替えは確認待ちを解除しない）
    expect(ctx.recovery.findPending(event.id)).not.toBeNull()
    expect(ctx.recovery.confirm(event.id, ctx.recovery.findPending(event.id)!.holdId).operatorNameSnapshot).toBe('B')
  })
})

describe('Recovery hold: persistence and safety', () => {
  it('keeps a pending hold across restarts and does not duplicate it on another crash', () => {
    const { event } = raceWithLaps()
    ctx = crashRestart()
    const first = ctx.recovery.findPending(event.id)!
    ctx = cleanRestart() // 確認せずに正常終了 → 確認待ちは残る
    expect(ctx.recovery.findPending(event.id)?.holdId).toBe(first.holdId)
    ctx = crashRestart() // 確認前に再び異常終了 → 重複して作らない
    expect(ctx.recovery.listPending().map((h) => h.holdId)).toEqual([first.holdId])
  })

  it('keeps power blocking while waiting for confirmation', () => {
    const { event } = raceWithLaps()
    ctx = crashRestart()
    expect(ctx.recovery.findPending(event.id)).not.toBeNull()
    expect(ctx.power.status()).toEqual({ active: true, eventIds: [event.id] })
  })

  it('stores holds append-only and leaves existing records and history untouched', () => {
    const { event } = raceWithLaps()
    const snapshot = () =>
      JSON.stringify({
        laps: t.db.prepare('SELECT * FROM lap_records ORDER BY id').all(),
        passes: t.db.prepare('SELECT * FROM competitor_passes ORDER BY id').all(),
        clock: t.db.prepare('SELECT * FROM race_clock_transitions ORDER BY id').all(),
        events: t.db.prepare('SELECT * FROM events ORDER BY id').all(),
        history: t.db.prepare("SELECT * FROM operation_history WHERE target_table <> 'race_recovery_holds' ORDER BY id").all()
      })
    const before = snapshot()
    ctx = crashRestart()
    ctx.recovery.confirm(event.id, ctx.recovery.findPending(event.id)!.holdId)
    expect(snapshot()).toBe(before)
    expect(() => t.db.prepare("UPDATE race_recovery_holds SET kind = 'CONFIRM'").run()).toThrow(/append-only/)
    expect(() => t.db.prepare('DELETE FROM race_recovery_holds').run()).toThrow(/physical delete/)
  })

  it('does not hold races on the first boot after the lifecycle table was introduced (no judgement possible)', () => {
    // BOOT の記録がない古い起動の後
    const t2 = createTestDb()
    t2.repos.appSessions.insert({ id: 'legacy', startedWallAt: 1, latestSavedAtBefore: null, clockAnomaly: false, anomalyDetail: null, appVersion: null })
    const clock = new MasterClock(t2.clock, 'new')
    const session = registerBootSession(t2.db, t2.repos, clock, 'test')
    const c = createAppContext(t2.db, clock, session)
    expect(c.previousShutdown).toBeNull()
    expect(c.recovery.holdAfterUncleanShutdown(c.previousShutdown)).toEqual([])
    t2.cleanup()
  })
})
