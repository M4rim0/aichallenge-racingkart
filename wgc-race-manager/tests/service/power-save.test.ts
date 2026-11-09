import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppContext } from '../../src/main/app-context'
import { createAppContext } from '../../src/main/app-context'
import { MasterClock } from '../../src/main/clock/master-clock'
import { PowerSaveService, type PowerBlocker } from '../../src/main/power/power-save-service'
import { createTestDb, type TestDb } from '../helpers/db'

/** powerSaveBlocker の偽物：開始中の ID を保持する */
class FakeBlocker implements PowerBlocker {
  started = new Set<number>()
  starts = 0
  stops = 0
  next = 1
  fail = false
  start(type: 'prevent-display-sleep'): number {
    if (this.fail) throw new Error('power api failure')
    expect(type).toBe('prevent-display-sleep')
    this.starts++
    const id = this.next++
    this.started.add(id)
    return id
  }
  stop(id: number): void {
    this.stops++
    this.started.delete(id)
  }
  isStarted(id: number): boolean {
    return this.started.has(id)
  }
}

let t: TestDb
let blocker: FakeBlocker
let ctx: AppContext
const boot = () => createAppContext(t.db, new MasterClock(t.clock, `b-${Math.random()}`), null, { powerBlocker: blocker })
beforeEach(() => {
  t = createTestDb()
  blocker = new FakeBlocker()
  ctx = boot()
})
afterEach(() => t.cleanup())

describe('Power management (D-063)', () => {
  it('blocks on START, keeps blocking while PAUSED, releases on END', () => {
    const e = ctx.events.create({ name: 'x' })
    expect(ctx.power.reconcile().active).toBe(false)
    ctx.raceClock.start(e.id)
    expect(ctx.power.status()).toEqual({ active: true, eventIds: [e.id] })
    ctx.raceClock.pause(e.id)
    expect(ctx.power.status().active).toBe(true)
    ctx.raceClock.resume(e.id)
    expect(ctx.power.status().active).toBe(true)
    expect(blocker.starts).toBe(1) // 二重に開始しない
    ctx.raceClock.end(e.id)
    expect(ctx.power.status()).toEqual({ active: false, eventIds: [] })
    expect(blocker.started.size).toBe(0)
  })

  it('stays blocked until every running race has ended', () => {
    const a = ctx.events.create({ name: 'A' })
    const b = ctx.events.create({ name: 'B' })
    ctx.raceClock.start(a.id)
    ctx.raceClock.start(b.id)
    ctx.raceClock.end(a.id)
    expect(ctx.power.status()).toEqual({ active: true, eventIds: [b.id] })
    ctx.raceClock.end(b.id)
    expect(ctx.power.status().active).toBe(false)
  })

  it('restores blocking at boot when a race was left running or paused (crash restart)', () => {
    const e = ctx.events.create({ name: 'x' })
    ctx.raceClock.start(e.id)
    ctx.raceClock.pause(e.id)
    // 異常終了：OS が要求を解除した状態で再起動
    blocker = new FakeBlocker()
    t = t.reopen()
    ctx = boot()
    expect(ctx.power.status().active).toBe(false)
    expect(ctx.power.reconcile()).toEqual({ active: true, eventIds: [e.id] })
  })

  it('releases on normal shutdown', () => {
    const e = ctx.events.create({ name: 'x' })
    ctx.raceClock.start(e.id)
    ctx.power.release()
    expect(blocker.started.size).toBe(0)
    expect(ctx.power.status().active).toBe(false)
  })

  it('re-acquires if the OS-level request was dropped', () => {
    const svc = new PowerSaveService(blocker, () => [1])
    svc.reconcile()
    blocker.started.clear()
    expect(svc.reconcile().active).toBe(true)
    expect(blocker.starts).toBe(2)
  })

  it('never breaks race-clock recording when the power API fails', () => {
    const e = ctx.events.create({ name: 'x' })
    blocker.fail = true
    expect(() => ctx.raceClock.start(e.id)).not.toThrow()
    expect(ctx.raceClock.getState(e.id).status).toBe('RUNNING')
    expect(t.repos.clockTransitions.listByEvent(e.id)).toHaveLength(1)
  })
})
