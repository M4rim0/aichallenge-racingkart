import { describe, expect, it } from 'vitest'
import { detectWarnings, type WarningCandidate } from '../../src/shared/warnings/detect'
import type { StrategyReport } from '../../src/shared/strategy/engine'
import type { ScenarioId } from '../../src/shared/strategy/pace'
import { M, every, finiteDeep, laps, own, patchScenario, report, setPaceChange, team } from './helpers'

const of = (ws: WarningCandidate[], type: string) => ws.filter((w) => w.type === type)

/** 自チーム 10 分/周（12 周、最終 120 分）。Rear は 11 分/周で後方、Front は 9 分/周で前方。現在 125 分。予測では順位は入れ替わらない */
function base(): StrategyReport {
  return report([own(every(10, 10, 125)), team(2, 'Front', every(9, 9, 125)), team(3, 'Rear', every(11, 11, 125))], 125)
}

describe('① rear approach (D-057, W-1..W-3)', () => {
  const cases: [ScenarioId[], string | null][] = [
    [[], null],
    [['avg10'], 'INFO'],
    [['avg5'], 'CAUTION'],
    [['avg3'], 'INFO'], // W-1
    [['avg3', 'avg10'], 'INFO'],
    [['avg5', 'avg10'], 'CAUTION'],
    [['avg3', 'avg5'], 'CAUTION'],
    [['avg3', 'avg5', 'avg10'], 'CRITICAL']
  ]
  it.each(cases)('overtake in %j → %s', (scen, expected) => {
    const r = base()
    for (const s of scen) patchScenario(r, 'Rear', s, { predictedRank: 1 }) // 自チーム（予測 2 位）より上
    const w = of(detectWarnings({ report: r }).warnings, 'REAR_APPROACH')
    if (expected === null) expect(w).toEqual([])
    else {
      expect(w).toHaveLength(1)
      expect(w[0]).toMatchObject({ severity: expected, kind: 'OVERTAKE', key: 'REAR_APPROACH:3', teamId: 3 })
      expect(w[0]!.basis.overtakeScenarios).toEqual(scen)
    }
  })

  it('distinguishes catching up (same final lap, order kept) from overtaking', () => {
    // 自チーム：5,15,…,115（12 周）→ 最終 48 周（最後 475 分）。T：9.7 分/周、11 周（最後 120 分）→ 48 周（最後 478.9 分）
    const r = report([own(every(5, 10, 125)), team(3, 'Chaser', every(23, 9.7, 120))], 125)
    const w = of(detectWarnings({ report: r }).warnings, 'REAR_APPROACH')
    expect(w).toHaveLength(1)
    expect(w[0]).toMatchObject({ kind: 'CATCH_UP', severity: 'INFO' })
    expect((w[0]!.basis.catchUpScenarios as string[]).length).toBe(3)
    expect(w[0]!.basis.overtakeScenarios).toEqual([])
    expect(w[0]!.message).toContain('追いつかれる')
    expect(w[0]!.message).not.toContain('追い抜かれる')
  })

  it('applies the time-gap floors at the boundaries (measured gap on the same lap)', () => {
    // 同周回（12 周）、自チーム最終 120 分。後方は遅い（10.5 分/周）ので予測では入れ替わらない
    // 最後の通過だけをミリ秒単位でずらす（every() は 0.001 分単位に丸めるため）
    const gapCase = (lastMin: number, extraMs = 0) => {
      const close = team(3, 'Close', every(lastMin - 11 * 10.5, 10.5, lastMin + 1e-6))
      close.passes.at(-1)!.passedAt += extraMs
      const r = report([own(every(10, 10, 125)), close], 125)
      return of(detectWarnings({ report: r }).warnings, 'REAR_APPROACH')
    }
    expect(gapCase(122)).toMatchObject([{ severity: 'CAUTION', kind: 'PROXIMITY', basis: { gapMs: 120_000 } }]) // ちょうど 2 分
    expect(gapCase(122, 1)).toEqual([]) // 2 分 + 1ms
    expect(gapCase(121)).toMatchObject([{ severity: 'CRITICAL', kind: 'PROXIMITY', basis: { gapMs: 60_000 } }]) // ちょうど 1 分
    expect(gapCase(121, 1)).toMatchObject([{ severity: 'CAUTION' }]) // 1 分 + 1ms
    const w = gapCase(121.5)[0]!
    expect(w.basis.gapMeasured).toBe(true)
    expect(w.message).toContain('実測')
  })

  it('raises a prediction-based INFO to the gap floor (max of both)', () => {
    const r = base()
    patchScenario(r, 'Rear', 'avg10', { predictedRank: 1 })
    r.teams.find((t) => t.isOwnTeam)!.behind!.estimatedTimeGapMs = 90_000
    const [w] = of(detectWarnings({ report: r }).warnings, 'REAR_APPROACH')
    expect(w).toMatchObject({ severity: 'CAUTION', kind: 'OVERTAKE' })
    expect(w!.basis).toMatchObject({ predictionSeverity: 'INFO', gapSeverity: 'CAUTION', gapMeasured: false })
    expect(w!.message).toContain('推定')
  })
})

describe('② front overtake (D-057)', () => {
  it.each([
    [['avg5'], 'INFO'],
    [['avg3', 'avg10'], 'CAUTION'],
    [['avg3', 'avg5', 'avg10'], 'CRITICAL']
  ] as [ScenarioId[], string][])('%j → %s', (scen, expected) => {
    const r = base()
    for (const s of scen) patchScenario(r, 'Own', s, { predictedRank: 1 }) // Front（予測 1 位）を上回る
    for (const s of scen) patchScenario(r, 'Front', s, { predictedRank: 2 })
    const w = of(detectWarnings({ report: r }).warnings, 'FRONT_OVERTAKE')
    expect(w).toMatchObject([{ severity: expected, teamId: 2, key: 'FRONT_OVERTAKE:2' }])
    expect(w[0]!.basis.scenarios).toEqual(scen)
  })
})

describe('③ own pace and ⑤ other-team pace (D-057, W-4)', () => {
  const ownPace = (pct: number) => {
    const r = base()
    setPaceChange(r, 'Own', pct)
    return of(detectWarnings({ report: r }).warnings, 'OWN_PACE')
  }
  it('own pace degradation boundaries', () => {
    expect(ownPace(4.999)).toEqual([])
    expect(ownPace(5)).toMatchObject([{ severity: 'INFO', kind: 'SLOWER' }])
    expect(ownPace(9.999)).toMatchObject([{ severity: 'INFO' }])
    expect(ownPace(10)).toMatchObject([{ severity: 'CAUTION' }])
    expect(ownPace(14.999)).toMatchObject([{ severity: 'CAUTION' }])
    expect(ownPace(15)).toMatchObject([{ severity: 'CRITICAL' }])
    expect(ownPace(40)).toMatchObject([{ severity: 'CRITICAL' }])
  })

  it('own pace improvement is INFO only', () => {
    expect(ownPace(-4.999)).toEqual([])
    expect(ownPace(-5)).toMatchObject([{ severity: 'INFO', kind: 'FASTER', key: 'OWN_PACE:1:FASTER' }])
    expect(ownPace(-30)).toMatchObject([{ severity: 'INFO', kind: 'FASTER' }])
  })

  it('handles an exact 5% computed from real lap times (floating point)', () => {
    // 3 周平均 10.5 分、10 周平均 10 分 → +5%
    const lapTimes = [9.785714285714286, 9.785714285714286, 9.785714285714286, 9.785714285714286, 9.785714285714286, 9.785714285714286, 9.785714285714286, 10.5, 10.5, 10.5]
    const r = report([own(laps(10, lapTimes)), team(2, 'X', every(9, 9, 120))], 112)
    const p = r.teams.find((t) => t.isOwnTeam)!.pace.change!.percent
    expect(p).toBeCloseTo(5, 6)
    expect(of(detectWarnings({ report: r }).warnings, 'OWN_PACE')).toMatchObject([{ severity: 'INFO' }])
  })

  it('other-team pace change in both directions with the same boundaries', () => {
    const teamPace = (pct: number) => {
      const r = base()
      setPaceChange(r, 'Front', pct)
      return of(detectWarnings({ report: r }).warnings, 'TEAM_PACE').filter((w) => w.teamId === 2)
    }
    expect(teamPace(4.999)).toEqual([])
    expect(teamPace(5)).toMatchObject([{ severity: 'INFO', kind: 'SLOWER' }])
    expect(teamPace(10)).toMatchObject([{ severity: 'CAUTION', kind: 'SLOWER' }])
    expect(teamPace(15)).toMatchObject([{ severity: 'CRITICAL', kind: 'SLOWER' }])
    expect(teamPace(-4.999)).toEqual([])
    expect(teamPace(-5)).toMatchObject([{ severity: 'INFO', kind: 'FASTER', key: 'TEAM_PACE:2:FASTER' }])
    expect(teamPace(-10)).toMatchObject([{ severity: 'CAUTION', kind: 'FASTER' }])
    expect(teamPace(-15)).toMatchObject([{ severity: 'CRITICAL', kind: 'FASTER' }])
  })
})

describe('④ predicted rank change (D-057, W-5)', () => {
  it.each([
    [2, 2, null],
    [2, 3, 'INFO'],
    [3, 1, 'CAUTION'],
    [1, 4, 'CRITICAL'],
    [5, 1, 'CRITICAL']
  ] as [number, number, string | null][])('%i → %i : %s', (prev, cur, expected) => {
    const w = of(detectWarnings({ report: base(), rankChange: { teamId: 1, previousRank: prev, currentRank: cur } }).warnings, 'PREDICTED_RANK_CHANGE')
    if (expected === null) expect(w).toEqual([])
    else {
      expect(w).toMatchObject([{ severity: expected, kind: cur < prev ? 'UP' : 'DOWN' }])
      // 現在順位と予測順位を区別して示す
      expect(w[0]!.basis).toMatchObject({ previousPredictedRank: prev, currentPredictedRank: cur, currentRank: 2 })
      expect(w[0]!.message).toContain('現在順位は 2位')
    }
  })
})

describe('Uncertainty handling (D-058, W-6..W-9)', () => {
  it('insufficient data → no prediction / pace warnings', () => {
    const r = report([own([10, 20]), team(2, 'R', [9, 18, 27])], 28)
    expect(detectWarnings({ report: r, rankChange: { teamId: 1, previousRank: 1, currentRank: 2 } }).warnings).toEqual([])
  })

  it('stale records (OVERDUE) suppress the related scenarios, gap and pace warnings', () => {
    const r = base()
    for (const s of ['avg3', 'avg5', 'avg10'] as ScenarioId[]) {
      patchScenario(r, 'Rear', s, s === 'avg10' ? { predictedRank: 1 } : { predictedRank: 1, addUncertainty: 'OVERDUE' })
    }
    setPaceChange(r, 'Rear', 20)
    r.teams.find((t) => t.isOwnTeam)!.behind!.estimatedTimeGapMs = 30_000
    const res = detectWarnings({ report: r })
    // avg3/avg5 は除外、avg10 のみ → 情報。時間差は使わない。ペース警告は出さない
    expect(of(res.warnings, 'REAR_APPROACH')).toMatchObject([{ severity: 'INFO', basis: { overtakeScenarios: ['avg10'], gapSeverity: null } }])
    expect(of(res.warnings, 'TEAM_PACE').filter((w) => w.teamId === 3)).toEqual([])
    expect(res.suppressed.map((s) => s.reason)).toEqual(expect.arrayContaining(['STALE_RECORD']))
  })

  it('in a stoppage: pace warnings suppressed, others kept', () => {
    const r = base()
    r.clock.inStoppage = true
    setPaceChange(r, 'Own', 20)
    setPaceChange(r, 'Front', -20)
    patchScenario(r, 'Rear', 'avg5', { predictedRank: 1 })
    const res = detectWarnings({ report: r })
    expect(of(res.warnings, 'OWN_PACE')).toEqual([])
    expect(of(res.warnings, 'TEAM_PACE')).toEqual([])
    expect(of(res.warnings, 'REAR_APPROACH')).toHaveLength(1)
    expect(res.suppressed.filter((s) => s.reason === 'IN_STOPPAGE')).toHaveLength(2)
  })

  it('open-ended stoppage downgrades prediction-based warnings by one level (INFO stays INFO)', () => {
    // ② 3 シナリオ（重大 → 注意）、④ 2 位変動（注意 → 情報）、③ は残り時間に依存しないので重大のまま
    const r = base()
    r.clock.openEndedStoppage = true
    for (const s of ['avg3', 'avg5', 'avg10'] as ScenarioId[]) {
      patchScenario(r, 'Own', s, { predictedRank: 1 })
      patchScenario(r, 'Front', s, { predictedRank: 2 })
    }
    setPaceChange(r, 'Own', 20)
    const res = detectWarnings({ report: r, rankChange: { teamId: 1, previousRank: 3, currentRank: 1 } })
    expect(of(res.warnings, 'FRONT_OVERTAKE')[0]).toMatchObject({ severity: 'CAUTION' })
    expect(of(res.warnings, 'FRONT_OVERTAKE')[0]!.adjustments[0]).toContain('終了未定')
    expect(of(res.warnings, 'PREDICTED_RANK_CHANGE')[0]).toMatchObject({ severity: 'INFO' })
    expect(of(res.warnings, 'OWN_PACE')[0]).toMatchObject({ severity: 'CRITICAL' })
    // ① 10 周平均のみ（情報）は情報のまま
    const r2 = base()
    r2.clock.openEndedStoppage = true
    patchScenario(r2, 'Rear', 'avg10', { predictedRank: 1 })
    expect(of(detectWarnings({ report: r2 }).warnings, 'REAR_APPROACH')[0]).toMatchObject({ severity: 'INFO' })
  })

  it('open-ended stoppage does not lower the gap-based floor of ①', () => {
    const r = base()
    r.clock.openEndedStoppage = true
    patchScenario(r, 'Rear', 'avg3', { predictedRank: 1 })
    patchScenario(r, 'Rear', 'avg5', { predictedRank: 1 })
    patchScenario(r, 'Rear', 'avg10', { predictedRank: 1 })
    r.teams.find((t) => t.isOwnTeam)!.behind!.estimatedTimeGapMs = 45_000
    expect(of(detectWarnings({ report: r }).warnings, 'REAR_APPROACH')[0]).toMatchObject({ severity: 'CRITICAL', basis: { predictionSeverity: 'CAUTION', gapSeverity: 'CRITICAL' } })
  })

  it('no scheduled end → no prediction warnings, but the gap-based approach remains', () => {
    const lastMin = 121.5
    const r = report([own(every(10, 10, 125)), team(3, 'Close', every(lastMin - 11 * 10.5, 10.5, lastMin + 1e-6)), team(2, 'Front', every(9, 9, 125))], 125, { scheduledEndAt: null })
    const res = detectWarnings({ report: r, rankChange: { teamId: 1, previousRank: 2, currentRank: 1 } })
    expect(of(res.warnings, 'FRONT_OVERTAKE')).toEqual([])
    expect(of(res.warnings, 'PREDICTED_RANK_CHANGE')).toEqual([])
    expect(of(res.warnings, 'REAR_APPROACH')).toMatchObject([{ kind: 'PROXIMITY', severity: 'CAUTION', basis: { gapMs: 90_000 } }])
    expect(res.suppressed.some((s) => s.reason === 'NO_SCHEDULED_END')).toBe(true)
  })

  it('never issues CRITICAL from data with a timeline anomaly (capped at CAUTION)', () => {
    const r = base()
    setPaceChange(r, 'Front', 30)
    patchScenario(r, 'Front', 'avg5', { addUncertainty: 'TIMELINE_ANOMALY' })
    const [w] = of(detectWarnings({ report: r }).warnings, 'TEAM_PACE')
    expect(w).toMatchObject({ severity: 'CAUTION' })
    expect(w!.adjustments[0]).toContain('時刻異常')
  })
})

describe('General behaviour', () => {
  it('issues no warnings before START or after END (W-8)', () => {
    const teams = [own(every(10, 10, 125)), team(2, 'R', every(9, 9, 125))]
    expect(detectWarnings({ report: report(teams, 125, { status: 'PREPARING', actualStartAt: null }) }).warnings).toEqual([])
    expect(detectWarnings({ report: report(teams, 999, { status: 'FINISHED', actualEndAt: 130 * M + Date.UTC(2026, 9, 1) }) }).warnings).toEqual([])
  })

  it('without an own team, only other-team pace warnings are evaluated (W-11)', () => {
    // A：最後の通過 99 分、現在 100 分（記録は新しい）
    const r = report([team(2, 'A', laps(5, [10, 10, 10, 10, 10, 10, 10, 8, 8, 8])), team(3, 'B', every(9, 9, 99))], 100)
    const ws = detectWarnings({ report: r, rankChange: { teamId: 1, previousRank: 1, currentRank: 3 } }).warnings
    expect(ws.map((w) => w.type)).toEqual(['TEAM_PACE'])
    expect(ws[0]).toMatchObject({ teamId: 2, kind: 'FASTER' })
  })

  it('sorts by severity (CRITICAL → CAUTION → INFO)', () => {
    const r = base()
    setPaceChange(r, 'Own', 6)
    setPaceChange(r, 'Front', -16)
    patchScenario(r, 'Rear', 'avg5', { predictedRank: 1 })
    const sev = detectWarnings({ report: r }).warnings.map((w) => w.severity)
    expect(sev).toEqual(['CRITICAL', 'CAUTION', 'INFO'])
  })

  it('produces only finite numbers even with abnormal data', () => {
    const r = report([own([10, 10, 5, 30, 31, 31.5]), team(2, 'W', [10, 10, 10]), team(3, 'Z', [])], 40)
    const res = detectWarnings({ report: r, rankChange: { teamId: 1, previousRank: 1, currentRank: 2 } })
    expect(finiteDeep(res)).toBe(true)
  })
})
