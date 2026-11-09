import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppError, ErrorCode } from '../../src/shared/errors'
import { createAppContext, type AppContext } from '../../src/main/app-context'
import { MasterClock } from '../../src/main/clock/master-clock'
import { registerBootSession } from '../../src/main/clock/session-registry'
import { createTestDb, type TestDb } from '../helpers/db'

const MIN = 60_000
let t: TestDb
let ctx: AppContext
let boot = 0

function bootApp(): AppContext {
  const clock = new MasterClock(t.clock, `boot-${++boot}`)
  const session = registerBootSession(t.db, createAppContext(t.db, clock).repos, clock, 'test')
  return createAppContext(t.db, clock, session)
}

beforeEach(() => {
  t = createTestDb()
  ctx = bootApp()
})
afterEach(() => t.cleanup())

function code(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(AppError)
    return (e as AppError).code
  }
  throw new Error('expected error')
}

function newEvent() {
  return ctx.events.create({ name: 'WGC', scheduledStartAt: t.clock.t + MIN, scheduledEndAt: t.clock.t + 61 * MIN })
}

describe('RaceClockService transitions (spec §4.2, D-011)', () => {
  it('START → PAUSE → RESUME → END with elapsed/remaining', () => {
    const e = newEvent()
    t.clock.advance(MIN)
    const started = ctx.raceClock.start(e.id)
    expect(started.status).toBe('RUNNING')
    expect(started.actualStartAt).toBe(t.clock.t)
    expect(ctx.events.get(e.id).actualStartAt).toBe(t.clock.t)

    t.clock.advance(10 * MIN)
    expect(ctx.raceClock.pause(e.id).elapsedMs).toBe(10 * MIN)
    t.clock.advance(5 * MIN)
    const p = ctx.raceClock.getState(e.id)
    expect(p.status).toBe('PAUSED')
    expect(p.elapsedMs).toBe(10 * MIN) // PAUSE 中は止まる
    expect(p.remainingClockMs).toBe(45 * MIN) // 残り時間は減り続ける

    ctx.raceClock.resume(e.id)
    t.clock.advance(20 * MIN)
    expect(ctx.raceClock.getState(e.id).elapsedMs).toBe(30 * MIN)
    const ended = ctx.raceClock.end(e.id)
    expect(ended.status).toBe('FINISHED')
    expect(ended.actualEndAt).toBe(t.clock.t)
    t.clock.advance(60 * MIN)
    expect(ctx.raceClock.getState(e.id).elapsedMs).toBe(30 * MIN) // END 後は停止
  })

  it('rejects invalid transitions and cannot reopen a finished race', () => {
    const e = newEvent()
    expect(code(() => ctx.raceClock.pause(e.id))).toBe(ErrorCode.INVALID_RACE_TRANSITION)
    expect(code(() => ctx.raceClock.resume(e.id))).toBe(ErrorCode.INVALID_RACE_TRANSITION)
    expect(code(() => ctx.raceClock.end(e.id))).toBe(ErrorCode.INVALID_RACE_TRANSITION)
    ctx.raceClock.start(e.id)
    expect(code(() => ctx.raceClock.start(e.id))).toBe(ErrorCode.INVALID_RACE_TRANSITION)
    expect(code(() => ctx.raceClock.resume(e.id))).toBe(ErrorCode.INVALID_RACE_TRANSITION)
    ctx.raceClock.pause(e.id)
    expect(code(() => ctx.raceClock.pause(e.id))).toBe(ErrorCode.INVALID_RACE_TRANSITION)
    ctx.raceClock.end(e.id) // PAUSED から END 可能
    for (const op of ['start', 'pause', 'resume', 'end'] as const) {
      expect(code(() => ctx.raceClock[op](e.id))).toBe(ErrorCode.INVALID_RACE_TRANSITION)
    }
    expect(t.repos.clockTransitions.listByEvent(e.id).map((x) => x.kind)).toEqual(['START', 'PAUSE', 'END'])
    expect(code(() => ctx.raceClock.start(999))).toBe(ErrorCode.EVENT_NOT_FOUND)
  })

  it('records transitions with master time, PC time and boot session, plus history', () => {
    const e = newEvent()
    t.clock.wallOffset = 777
    ctx.raceClock.start(e.id)
    const [tr] = t.repos.clockTransitions.listByEvent(e.id)
    expect(tr).toMatchObject({ kind: 'START', at: t.clock.t, wallAt: t.clock.t + 777, bootSessionId: ctx.clock.bootSessionId })
    const h = t.repos.history.listByEvent(e.id).slice(-2)
    expect(h.map((x) => [x.action, x.targetTable])).toEqual([
      ['CREATE', 'race_clock_transitions'],
      ['UPDATE', 'events']
    ])
    expect(h[1]!.note).toBe('START')
    expect(h[1]!.bootSessionId).toBe(ctx.clock.bootSessionId)
  })

  it('keeps independent clocks per event', () => {
    const a = newEvent()
    const b = newEvent()
    ctx.raceClock.start(a.id)
    t.clock.advance(MIN)
    expect(ctx.raceClock.getState(b.id).elapsedMs).toBeNull()
    expect(ctx.raceClock.getState(a.id).elapsedMs).toBe(MIN)
  })
})

describe('OS time changes and restart (spec §4.4, §15, D-013)', () => {
  it('is not affected by OS time changes while running', () => {
    const e = newEvent()
    ctx.raceClock.start(e.id)
    t.clock.wallOffset = -2 * 3600_000
    t.clock.advance(10 * MIN)
    expect(ctx.raceClock.getState(e.id).elapsedMs).toBe(10 * MIN)
    t.clock.wallOffset = +3600_000
    t.clock.advance(MIN)
    expect(ctx.raceClock.getState(e.id).elapsedMs).toBe(11 * MIN)
  })

  it('restores RUNNING state after restart, counting the downtime', () => {
    const e = newEvent()
    ctx.raceClock.start(e.id)
    t.clock.advance(10 * MIN)
    t = t.reopen() // プロセス終了・DB 再オープン
    t.clock.advance(3 * MIN) // 停止していた時間
    ctx = bootApp()
    const s = ctx.raceClock.getState(e.id)
    expect(s.status).toBe('RUNNING')
    expect(s.elapsedMs).toBe(13 * MIN)
    expect(ctx.session?.clockAnomaly).toBe(false)
  })

  it('keeps PAUSED state across restart (elapsed stays frozen)', () => {
    const e = newEvent()
    ctx.raceClock.start(e.id)
    t.clock.advance(7 * MIN)
    ctx.raceClock.pause(e.id)
    t = t.reopen()
    t.clock.advance(30 * MIN)
    ctx = bootApp()
    const s = ctx.raceClock.getState(e.id)
    expect(s.status).toBe('PAUSED')
    expect(s.elapsedMs).toBe(7 * MIN)
    t.clock.advance(MIN)
    ctx.raceClock.resume(e.id)
    t.clock.advance(MIN)
    expect(ctx.raceClock.getState(e.id).elapsedMs).toBe(8 * MIN)
  })

  it('detects a PC clock that went backwards at boot, warns, and rewrites nothing', () => {
    const e = newEvent()
    ctx.raceClock.start(e.id)
    t.clock.advance(10 * MIN)
    const before = JSON.stringify(t.db.prepare('SELECT * FROM race_clock_transitions').all())
    const eventBefore = ctx.events.get(e.id)

    t = t.reopen()
    t.clock.advance(MIN)
    t.clock.t -= 60 * MIN // PC の時刻が 1 時間戻った状態で起動
    ctx = bootApp()

    expect(ctx.session?.clockAnomaly).toBe(true)
    expect(ctx.session?.anomalyDetail).toContain('過去')
    expect(t.repos.appSessions.listAnomalous().map((s) => s.id)).toEqual([ctx.clock.bootSessionId])
    // 保存済みの日時は書き換えない
    expect(JSON.stringify(t.db.prepare('SELECT * FROM race_clock_transitions').all())).toBe(before)
    expect(ctx.events.get(e.id)).toEqual(eventBefore)
    // 経過時間は負にならない（異常として識別される）
    const s = ctx.raceClock.getState(e.id)
    expect(s.elapsedMs).toBe(0)
    expect(s.anomalies.length).toBeGreaterThan(0)
    // この起動中の操作は異常セッションの ID で識別できる
    ctx.raceClock.pause(e.id)
    expect(t.repos.clockTransitions.listByEvent(e.id).at(-1)!.bootSessionId).toBe(ctx.clock.bootSessionId)
  })
})

describe('Correcting the actual start time (D-012)', () => {
  it('corrects start, recalculates elapsed, and logs before/after', () => {
    const e = newEvent()
    const original = t.clock.t
    ctx.raceClock.start(e.id)
    t.clock.advance(10 * MIN)
    const s = ctx.raceClock.correctActualStart(e.id, original - 30_000)
    expect(s.actualStartAt).toBe(original - 30_000)
    expect(s.elapsedMs).toBe(10 * MIN + 30_000)
    // START の遷移記録そのものは書き換えない
    expect(t.repos.clockTransitions.listByEvent(e.id)[0]!.at).toBe(original)
    const h = t.repos.history.listByEvent(e.id).at(-1)!
    expect(JSON.parse(h.beforeJson!).actualStartAt).toBe(original)
    expect(JSON.parse(h.afterJson!).actualStartAt).toBe(original - 30_000)
    expect(h.note).toContain('correct actual start')
  })

  it('allows correction after END', () => {
    const e = newEvent()
    const original = t.clock.t
    ctx.raceClock.start(e.id)
    t.clock.advance(10 * MIN)
    ctx.raceClock.end(e.id)
    const s = ctx.raceClock.correctActualStart(e.id, original + MIN)
    expect(s.status).toBe('FINISHED')
    expect(s.elapsedMs).toBe(9 * MIN)
  })

  it('rejects corrections that would break the timeline', () => {
    const e = newEvent()
    expect(code(() => ctx.raceClock.correctActualStart(e.id, t.clock.t))).toBe(ErrorCode.RACE_NOT_STARTED)
    const own = ctx.teams.create(e.id, { name: 'Own', isOwnTeam: true })
    const start = t.clock.t
    ctx.raceClock.start(e.id)
    t.clock.advance(5 * MIN)
    t.repos.lapRecords.insert({ eventId: e.id, teamId: own.id, passedAt: start + 3 * MIN })
    ctx.raceClock.pause(e.id)
    t.clock.advance(5 * MIN)
    expect(code(() => ctx.raceClock.correctActualStart(e.id, t.clock.t + 1))).toBe(ErrorCode.VALIDATION) // 未来
    expect(code(() => ctx.raceClock.correctActualStart(e.id, start + 6 * MIN))).toBe(ErrorCode.VALIDATION) // PAUSE より後
    expect(code(() => ctx.raceClock.correctActualStart(e.id, start + 3 * MIN))).toBe(ErrorCode.VALIDATION) // 初回ラップ以降
    expect(code(() => ctx.raceClock.correctActualStart(e.id, 1.5))).toBe(ErrorCode.VALIDATION)
    expect(ctx.events.get(e.id).actualStartAt).toBe(start)
    expect(ctx.raceClock.correctActualStart(e.id, start + 3 * MIN - 1).actualStartAt).toBe(start + 3 * MIN - 1)
  })
})
