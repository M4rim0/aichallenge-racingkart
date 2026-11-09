import { describe, expect, it } from 'vitest'
import { drivableMs, effectiveIntervals, isInStoppage, overlapMs, timeAfterDriving } from '../../src/shared/strategy/stoppages'
import { computePace, type LapSample } from '../../src/shared/strategy/pace'
import { estimatePosition, projectFinalLaps } from '../../src/shared/strategy/position'
import { computeAttack, computeDefense } from '../../src/shared/strategy/attack-defense'

const M = 60_000

describe('stoppage intervals (D-044, D-046)', () => {
  it('merges overlapping and adjacent stoppages (no double counting)', () => {
    const iv = effectiveIntervals(
      [
        { startsAt: 200 * M, endsAt: 230 * M },
        { startsAt: 210 * M, endsAt: 240 * M },
        { startsAt: 240 * M, endsAt: 250 * M },
        { startsAt: 10 * M, endsAt: 20 * M }
      ],
      0
    )
    expect(iv).toEqual([
      { start: 10 * M, end: 20 * M, openEnded: false },
      { start: 200 * M, end: 250 * M, openEnded: false }
    ])
    expect(overlapMs(iv, 0, 1000 * M)).toBe(60 * M)
  })

  it('treats open-ended stoppages as lasting until max(start, now)', () => {
    expect(effectiveIntervals([{ startsAt: 100 * M, endsAt: null }], 130 * M)).toEqual([
      { start: 100 * M, end: 130 * M, openEnded: true }
    ])
    // 未来に始まる終了未定の停止：長さ 0（分かっている最小値）だが openEnded は残す
    expect(effectiveIntervals([{ startsAt: 200 * M, endsAt: null }], 130 * M)).toEqual([
      { start: 200 * M, end: 200 * M, openEnded: true }
    ])
    expect(isInStoppage([{ startsAt: 100 * M, endsAt: null }], 130 * M)).toBe(true)
    expect(isInStoppage([{ startsAt: 100 * M, endsAt: 120 * M }], 120 * M)).toBe(false)
  })

  it('computes drivable time and skips stoppages when accumulating driving time', () => {
    const iv = effectiveIntervals([{ startsAt: 20 * M, endsAt: 30 * M }], 0)
    expect(drivableMs(iv, 10 * M, 60 * M)).toBe(40 * M)
    expect(drivableMs(iv, 60 * M, 10 * M)).toBe(0)
    expect(timeAfterDriving(iv, 10 * M, 5 * M)).toBe(15 * M)
    expect(timeAfterDriving(iv, 10 * M, 10 * M)).toBe(20 * M)
    expect(timeAfterDriving(iv, 10 * M, 15 * M)).toBe(35 * M) // 20〜30 を飛ばす
    expect(timeAfterDriving(iv, 25 * M, 5 * M)).toBe(35 * M) // 停止中から開始
  })
})

describe('pace (D-045, D-047..D-049)', () => {
  const lap = (n: number, start: number | null, end: number): LapSample => ({ recordId: n, lapNumber: n, startAt: start, endAt: end })

  it('averages the most recent N valid laps and reports insufficient data', () => {
    // 10, 10, 10, 9, 8 分
    const ends = [10, 20, 30, 39, 47]
    const laps = ends.map((e, i) => lap(i + 1, i === 0 ? 0 : ends[i - 1]! * M, e * M))
    const p = computePace(laps, [])
    expect(p.validLapCount).toBe(5)
    expect(p.averages.avg3).toEqual({ avgMs: 9 * M, used: 3, required: 3, sufficient: true })
    expect(p.averages.avg5.avgMs).toBe(9.4 * M)
    expect(p.averages.avg10).toEqual({ avgMs: null, used: 5, required: 10, sufficient: false })
    expect(p.change).toBeNull() // 10 周平均がないため
  })

  it('excludes competitor first lap, stoppage-overlapping laps and non-positive laps with reasons', () => {
    const iv = effectiveIntervals([{ startsAt: 25 * M, endsAt: 28 * M }], 0)
    const p = computePace(
      [lap(1, null, 10 * M), lap(2, 10 * M, 20 * M), lap(3, 20 * M, 33 * M), lap(4, 33 * M, 33 * M), lap(5, 33 * M, 43 * M)],
      iv
    )
    expect(p.excluded).toEqual([
      { recordId: 1, lapNumber: 1, reason: 'NO_BASE_TIME' },
      { recordId: 3, lapNumber: 3, reason: 'STOPPAGE_OVERLAP' },
      { recordId: 4, lapNumber: 4, reason: 'NON_POSITIVE' }
    ])
    expect(p.validLapCount).toBe(2)
  })

  it('reports pace change between 3-lap and 10-lap averages (seconds and %)', () => {
    // 7 周 10 分、最後の 3 周 9 分
    const times = [10, 10, 10, 10, 10, 10, 10, 9, 9, 9]
    let t = 0
    const laps = times.map((m, i) => {
      const s = t
      t += m * M
      return lap(i + 1, s, t)
    })
    const p = computePace(laps, [])
    expect(p.change!.diffMs).toBeCloseTo(9 * M - 9.7 * M, 6)
    expect(p.change!.percent).toBeCloseTo(((9 - 9.7) / 9.7) * 100, 6)
    expect(p.change!.direction).toBe('FASTER')
  })
})

describe('position and projection (§8.4, §8.5, D-046, D-051)', () => {
  it('Q = L + Δt/P with progress clamped to 0..1 and stoppages removed from Δt', () => {
    expect(estimatePosition(12, 120 * M, 125 * M, 10 * M, [])).toMatchObject({ q: 12.5, progress: 0.5, overdue: false })
    const late = estimatePosition(12, 120 * M, 150 * M, 10 * M, [])
    expect(late).toMatchObject({ q: 13, progress: 1, overdue: true })
    const iv = effectiveIntervals([{ startsAt: 121 * M, endsAt: 124 * M }], 0)
    expect(estimatePosition(12, 120 * M, 125 * M, 10 * M, iv)).toMatchObject({ q: 12.2, deltaDriveMs: 2 * M })
  })

  it('counts only passes completed by the scheduled end (pass exactly at the end counts)', () => {
    expect(projectFinalLaps(0, 0, 0, 60 * M, 10 * M, [])).toMatchObject({ finalLaps: 6, projectedLastPassAt: 60 * M })
    expect(projectFinalLaps(0, 0, 0, 60 * M - 1, 10 * M, [])).toMatchObject({ finalLaps: 5, projectedLastPassAt: 50 * M })
  })

  it('uses actual pass timing rather than truncating remaining time / pace', () => {
    // 最後の通過 118 分、現在 125 分、終了 140 分、ペース 10 分
    // 単純な floor(残り 15 分 / 10 分) = 1 周だが、実際には 128 分と 138 分に通過できるので 2 周
    const p = projectFinalLaps(12, 118 * M, 125 * M, 140 * M, 10 * M, [])
    expect(p).toMatchObject({ finalLaps: 14, additionalLaps: 2, nextPassAt: 128 * M, projectedLastPassAt: 138 * M })
  })

  it('removes future stoppages from driving time', () => {
    const iv = effectiveIntervals([{ startsAt: 20 * M, endsAt: 30 * M }], 0)
    expect(projectFinalLaps(1, 10 * M, 10 * M, 60 * M, 10 * M, iv)).toMatchObject({ finalLaps: 5, projectedLastPassAt: 60 * M })
  })

  it('treats an overdue next pass as happening now (not counted in the past)', () => {
    const p = projectFinalLaps(1, 0, 15 * M, 60 * M, 10 * M, [])
    expect(p).toMatchObject({ overdueAdjusted: true, nextPassAt: 15 * M, finalLaps: 6, projectedLastPassAt: 55 * M })
  })
})

describe('attack / defense (§8.6, §8.7, D-052)', () => {
  const R = 60 * M
  it('attack: catch-up pace makes positions equal at the end', () => {
    const a = computeAttack({ targetTeamId: 2, ownQ: 10, targetQ: 11, targetPaceMs: 10 * M, ownPaceMs: 9 * M, remainingDriveMs: R })
    expect(a.status).toBe('OK')
    expect(a.gapLaps).toBe(1)
    expect(a.catchUpPaceMs!).toBeCloseTo(R / 7, 6) // 自 7 周 = 相手 6 周 + 差 1 周
    expect(10 + R / a.catchUpPaceMs!).toBeCloseTo(11 + R / (10 * M), 9)
    expect(a.paceMarginMs!).toBeCloseTo(R / 7 - 9 * M, 6)
  })

  it('defense: limit pace at which the car behind would draw level', () => {
    const d = computeDefense({ threatTeamId: 3, ownQ: 11, threatQ: 10, threatPaceMs: 10 * M, ownPaceMs: 11 * M, remainingDriveMs: R })
    expect(d.status).toBe('OK')
    expect(d.limitPaceMs!).toBeCloseTo(R / 5, 6) // 自 5 周 + リード 1 = 相手 6 周
    expect(d.paceMarginMs!).toBeCloseTo(R / 5 - 11 * M, 6)
  })

  it('handles infeasible / degenerate cases without numbers', () => {
    expect(computeDefense({ threatTeamId: 3, ownQ: 17, threatQ: 10, threatPaceMs: 10 * M, ownPaceMs: null, remainingDriveMs: R }).status).toBe('SAFE_EVEN_IF_STOPPED')
    expect(computeDefense({ threatTeamId: 3, ownQ: 16, threatQ: 10, threatPaceMs: 10 * M, ownPaceMs: null, remainingDriveMs: R }).status).toBe('SAFE_EVEN_IF_STOPPED') // 分母 = 0
    expect(computeAttack({ targetTeamId: 2, ownQ: 17, targetQ: 10, targetPaceMs: 10 * M, ownPaceMs: null, remainingDriveMs: R }).status).toBe('AHEAD_EVEN_IF_STOPPED')
    expect(computeAttack({ targetTeamId: 2, ownQ: 1, targetQ: 2, targetPaceMs: 10 * M, ownPaceMs: null, remainingDriveMs: 0 }).status).toBe('NO_TIME')
    expect(computeAttack({ targetTeamId: 2, ownQ: null, targetQ: 2, targetPaceMs: 10 * M, ownPaceMs: null, remainingDriveMs: R }).status).toBe('NO_DATA')
    expect(computeDefense({ threatTeamId: 2, ownQ: 1, threatQ: 0, threatPaceMs: 0, ownPaceMs: null, remainingDriveMs: R }).status).toBe('NO_DATA')
    const a = computeAttack({ targetTeamId: 2, ownQ: 1, targetQ: 2, targetPaceMs: 10 * M, ownPaceMs: null, remainingDriveMs: R })
    expect(a.paceMarginMs).toBeNull()
  })
})
