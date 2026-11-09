import { describe, expect, it } from 'vitest'
import { computeRaceClock, type TransitionInput } from '../../src/shared/time/race-clock'

const T0 = Date.UTC(2026, 9, 1, 0, 0)
const MIN = 60_000
let id = 0
const tr = (kind: TransitionInput['kind'], at: number): TransitionInput => ({ id: ++id, kind, at })

describe('computeRaceClock', () => {
  it('returns null elapsed before start', () => {
    const s = computeRaceClock({
      status: 'PREPARING',
      actualStartAt: null,
      actualEndAt: null,
      scheduledEndAt: T0 + 60 * MIN,
      transitions: [],
      now: T0 - MIN
    })
    expect(s.elapsedMs).toBeNull()
    expect(s.remainingClockMs).toBe(61 * MIN)
  })

  it('stops elapsed during PAUSE, while remaining time keeps decreasing (D-002)', () => {
    const transitions = [tr('START', T0), tr('PAUSE', T0 + 10 * MIN), tr('RESUME', T0 + 15 * MIN)]
    const base = { actualStartAt: T0, actualEndAt: null, scheduledEndAt: T0 + 60 * MIN }
    const paused = computeRaceClock({ ...base, status: 'PAUSED', transitions: transitions.slice(0, 2), now: T0 + 12 * MIN })
    expect(paused.elapsedMs).toBe(10 * MIN)
    expect(paused.remainingClockMs).toBe(48 * MIN)
    const resumed = computeRaceClock({ ...base, status: 'RUNNING', transitions, now: T0 + 20 * MIN })
    expect(resumed.elapsedMs).toBe(15 * MIN)
    expect(resumed.remainingClockMs).toBe(40 * MIN)
    expect(resumed.anomalies).toEqual([])
  })

  it('freezes elapsed and remaining at END', () => {
    const transitions = [tr('START', T0), tr('PAUSE', T0 + 10 * MIN), tr('RESUME', T0 + 20 * MIN), tr('END', T0 + 70 * MIN)]
    const s = computeRaceClock({
      status: 'FINISHED',
      actualStartAt: T0,
      actualEndAt: T0 + 70 * MIN,
      scheduledEndAt: T0 + 60 * MIN,
      transitions,
      now: T0 + 999 * MIN
    })
    expect(s.elapsedMs).toBe(60 * MIN)
    expect(s.remainingClockMs).toBe(-10 * MIN)
  })

  it('END directly from PAUSED does not add the paused span', () => {
    const transitions = [tr('START', T0), tr('PAUSE', T0 + 10 * MIN), tr('END', T0 + 30 * MIN)]
    const s = computeRaceClock({
      status: 'FINISHED',
      actualStartAt: T0,
      actualEndAt: T0 + 30 * MIN,
      scheduledEndAt: null,
      transitions,
      now: T0 + 40 * MIN
    })
    expect(s.elapsedMs).toBe(10 * MIN)
    expect(s.remainingClockMs).toBeNull()
  })

  it('uses the corrected actual start instead of the START transition time (D-012)', () => {
    const s = computeRaceClock({
      status: 'RUNNING',
      actualStartAt: T0 - 2 * MIN,
      actualEndAt: null,
      scheduledEndAt: null,
      transitions: [tr('START', T0)],
      now: T0 + 10 * MIN
    })
    expect(s.elapsedMs).toBe(12 * MIN)
  })

  it('flags reversed timelines without rewriting data, never negative (D-013)', () => {
    // 再起動時に PC 時刻が戻っていて、RESUME が PAUSE より前の日時になった例
    const transitions = [tr('START', T0), tr('PAUSE', T0 + 10 * MIN), tr('RESUME', T0 + 5 * MIN)]
    const s = computeRaceClock({
      status: 'RUNNING',
      actualStartAt: T0,
      actualEndAt: null,
      scheduledEndAt: null,
      transitions,
      now: T0 + 8 * MIN
    })
    expect(s.anomalies).toHaveLength(1)
    expect(s.anomalies[0]!.kind).toBe('RESUME')
    expect(s.elapsedMs).toBe(10 * MIN + 3 * MIN)

    const backwards = computeRaceClock({
      status: 'RUNNING',
      actualStartAt: T0,
      actualEndAt: null,
      scheduledEndAt: null,
      transitions: [tr('START', T0)],
      now: T0 - MIN
    })
    expect(backwards.elapsedMs).toBe(0)
    expect(backwards.anomalies).toHaveLength(1)
  })
})
