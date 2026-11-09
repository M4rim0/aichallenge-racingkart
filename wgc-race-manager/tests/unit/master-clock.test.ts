import { describe, expect, it } from 'vitest'
import { MasterClock } from '../../src/main/clock/master-clock'
import { FakeNow } from '../helpers/db'

describe('MasterClock (spec §4.4)', () => {
  it('advances with the monotonic clock', () => {
    const src = new FakeNow()
    const c = new MasterClock(src, 'b1')
    const t0 = c.now()
    src.advance(1234)
    expect(c.now()).toBe(t0 + 1234)
    expect(c.bootSessionId).toBe('b1')
  })

  it('is not affected by OS time changes during the session', () => {
    const src = new FakeNow()
    const c = new MasterClock(src)
    const t0 = c.now()
    src.wallOffset = -3600_000 // OS 時刻を 1 時間戻す
    src.advance(1000)
    expect(c.now()).toBe(t0 + 1000)
    expect(c.wallNow()).toBe(t0 + 1000 - 3600_000)
    expect(c.wallDriftMs()).toBe(-3600_000)
    src.wallOffset = 5 * 60_000 // 5 分進める
    expect(c.now()).toBe(t0 + 1000)
  })

  it('stamps both master time and PC wall time (D-015)', () => {
    const src = new FakeNow()
    const c = new MasterClock(src, 'b')
    src.wallOffset = 42
    const s = c.stamp()
    expect(s.at).toBe(src.t)
    expect(s.wallAt).toBe(src.t + 42)
    expect(s.bootSessionId).toBe('b')
    expect(typeof s.monoMs).toBe('number')
  })
})
