import { describe, expect, it } from 'vitest'
import { computeStrategy, type StrategyInput, type StrategyTeamInput } from '../../src/shared/strategy/engine'
import { SCENARIOS } from '../../src/shared/strategy/pace'

const M = 60_000
const T0 = Date.UTC(2026, 9, 1, 0, 0) // 09:00 JST スタート
const END = T0 + 480 * M // 8 時間レース
let nextId = 1

/** 通過時刻（分、スタートからの経過）のリストからチームを作る */
function team(teamId: number, name: string, minutes: number[], opts: Partial<StrategyTeamInput> = {}): StrategyTeamInput {
  return {
    teamId,
    name,
    bibNumber: String(teamId),
    isOwnTeam: false,
    teamDeleted: false,
    passes: minutes.map((m) => ({ id: nextId++, passedAt: T0 + m * M })),
    ...opts
  }
}
/** first 分から every 分ごと、upTo 分以下の通過 */
const every = (first: number, step: number, upTo: number): number[] => {
  const out: number[] = []
  for (let m = first; m <= upTo + 1e-9; m += step) out.push(Math.round(m * 1000) / 1000)
  return out
}

function input(teams: StrategyTeamInput[], nowMin: number, extra: Partial<StrategyInput> = {}): StrategyInput {
  return {
    now: T0 + nowMin * M,
    status: 'RUNNING',
    actualStartAt: T0,
    actualEndAt: null,
    scheduledEndAt: END,
    stoppages: [],
    teams,
    ...extra
  }
}

/** 独立した検算：停止なしの一定ペースで、終了予定までに通過できる回数を 1 周ずつ数える */
function oracleFinalLaps(laps: number, lastRefMin: number, nowMin: number, paceMin: number, endMin = 480): number {
  let t = lastRefMin + paceMin
  if (t < nowMin) t = nowMin
  let n = laps
  while (t <= endMin + 1e-9) {
    n++
    t += paceMin
  }
  return n
}

/** レポート中に NaN / Infinity が無いこと */
function assertFinite(v: unknown, path = 'report'): void {
  if (typeof v === 'number') expect(Number.isFinite(v), path).toBe(true)
  else if (Array.isArray(v)) v.forEach((x, i) => assertFinite(x, `${path}[${i}]`))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) assertFinite(x, `${path}.${k}`)
}

describe('Virtual race A: constant paces, no stoppages', () => {
  // 自チーム 10 分/周、R1 9 分/周（初回 9 分）、R2 11 分/周（初回 11 分）。現在 125 分
  const own = team(1, 'Tamagawa', every(10, 10, 125), { isOwnTeam: true })
  const r1 = team(2, 'R1', every(9, 9, 125))
  const r2 = team(3, 'R2', every(11, 11, 125))
  const rep = computeStrategy(input([own, r1, r2], 125))
  const byName = Object.fromEntries(rep.teams.map((t) => [t.name, t]))

  it('current ranking, laps and remaining times', () => {
    expect(rep.teams.map((t) => [t.name, t.current.rank, t.current.laps])).toEqual([
      ['R1', 1, 13],
      ['Tamagawa', 2, 12],
      ['R2', 3, 11]
    ])
    expect(rep.clock).toMatchObject({ remainingClockMs: 355 * M, remainingStoppageMs: 0, remainingDriveMs: 355 * M, inStoppage: false })
    expect(rep.uncertainties).toEqual(['PROVISIONAL_RANKING_RULE'])
  })

  it('pace averages: own first lap included, competitor first lap excluded', () => {
    expect(byName.Tamagawa!.pace.averages.avg5.avgMs).toBe(10 * M)
    expect(byName.Tamagawa!.pace.validLapCount).toBe(12)
    expect(byName.R1!.pace.validLapCount).toBe(12)
    expect(byName.R1!.pace.excluded).toEqual([{ recordId: r1.passes[0]!.id, lapNumber: 1, reason: 'NO_BASE_TIME' }])
    expect(byName.R2!.pace.averages.avg10.avgMs).toBe(11 * M)
  })

  it('estimated positions Q', () => {
    expect(byName.Tamagawa!.scenarios.avg5.position!.q).toBeCloseTo(12.5, 9)
    expect(byName.R1!.scenarios.avg5.position!.q).toBeCloseTo(13 + 8 / 9, 9)
    expect(byName.R2!.scenarios.avg5.position!.q).toBeCloseTo(11 + 4 / 11, 9)
  })

  it('final lap predictions match the independent oracle in all scenarios', () => {
    for (const s of SCENARIOS) {
      expect(byName.Tamagawa!.scenarios[s].predictedFinalLaps).toBe(oracleFinalLaps(12, 120, 125, 10))
      expect(byName.R1!.scenarios[s].predictedFinalLaps).toBe(oracleFinalLaps(13, 117, 125, 9))
      expect(byName.R2!.scenarios[s].predictedFinalLaps).toBe(oracleFinalLaps(11, 121, 125, 11))
    }
    expect([48, 53, 43]).toEqual([
      byName.Tamagawa!.scenarios.avg5.predictedFinalLaps,
      byName.R1!.scenarios.avg5.predictedFinalLaps,
      byName.R2!.scenarios.avg5.predictedFinalLaps
    ])
    expect(byName.Tamagawa!.scenarios.avg5.rankChange).toBe(0)
    expect(byName.Tamagawa!.mayOvertake).toEqual([])
    expect(byName.Tamagawa!.mayBeOvertakenBy).toEqual([])
  })

  it('lap gap and time gap are separate; different laps give only an estimated time gap', () => {
    const ahead = byName.Tamagawa!.ahead!
    expect(ahead).toMatchObject({ teamId: 2, lapGap: 1, measuredTimeGapMs: null })
    // 推定時間差 = (Q_R1 − Q_自) × 自の 5 周平均 = (13.889 − 12.5) × 10 分
    expect(ahead.estimatedTimeGapMs!).toBeCloseTo((13 + 8 / 9 - 12.5) * 10 * M, 3)
    // 最終通過時刻の単純差（117 − 120 = −3 分）を時間差として使っていない
    expect(ahead.estimatedTimeGapMs).not.toBe(-3 * M)
    expect(ahead.paceDiffMs).toEqual({ avg3: 1 * M, avg5: 1 * M, avg10: 1 * M })
    const behind = byName.Tamagawa!.behind!
    expect(behind).toMatchObject({ teamId: 3, lapGap: 1, measuredTimeGapMs: null })
    expect(behind.estimatedTimeGapMs!).toBeCloseTo((12.5 - (11 + 4 / 11)) * 11 * M, 3)
  })

  it('attack / defense use Q differences and remaining drive time', () => {
    const s = byName.Tamagawa!.scenarios.avg5
    const R = 355 * M
    const qOwn = 12.5
    const qR1 = 13 + 8 / 9
    const qR2 = 11 + 4 / 11
    expect(s.attack!.status).toBe('OK')
    expect(s.attack!.gapLaps!).toBeCloseTo(qR1 - qOwn, 9)
    // 追いつきペースで走ると、終了時の推定位置が R1 と並ぶ
    expect(qOwn + R / s.attack!.catchUpPaceMs!).toBeCloseTo(qR1 + R / (9 * M), 6)
    expect(s.defense!.status).toBe('OK')
    expect(qOwn + R / s.defense!.limitPaceMs!).toBeCloseTo(qR2 + R / (11 * M), 6)
    // 先頭は攻撃対象なし、最後尾は防衛対象なし
    expect(byName.R1!.scenarios.avg5.attack).toBeNull()
    expect(byName.R2!.scenarios.avg5.defense).toBeNull()
  })

  it('contains no NaN / Infinity', () => assertFinite(rep))
})

describe('Virtual race B: a faster car behind is predicted to overtake', () => {
  // 自チーム 10 分/周（12 周、最終 120 分）。R3 9.5 分/周、初回 20.5 分 → 12 周、最終 125 分（同周回で後方）
  const own = team(1, 'Tamagawa', every(10, 10, 125), { isOwnTeam: true })
  const r3 = team(4, 'R3', every(20.5, 9.5, 125))
  const rep = computeStrategy(input([own, r3], 125))
  const t = Object.fromEntries(rep.teams.map((x) => [x.name, x]))

  it('measured time gap on the same lap', () => {
    expect(t.Tamagawa!.current.rank).toBe(1)
    expect(t.R3!.current.laps).toBe(12)
    expect(t.Tamagawa!.behind).toMatchObject({ lapGap: 0, measuredTimeGapMs: 5 * M })
  })

  it('predicts the overtake in every scenario and labels it as a possibility', () => {
    expect(t.R3!.scenarios.avg5.predictedFinalLaps).toBe(oracleFinalLaps(12, 125, 125, 9.5))
    expect(t.Tamagawa!.scenarios.avg5.predictedFinalLaps).toBe(48)
    expect(t.Tamagawa!.mayBeOvertakenBy).toEqual([{ teamId: 4, scenarios: ['avg3', 'avg5', 'avg10'] }])
    expect(t.R3!.mayOvertake).toEqual([{ teamId: 1, scenarios: ['avg3', 'avg5', 'avg10'] }])
    expect(t.Tamagawa!.scenarios.avg5.rankChange).toBe(-1)
    expect(t.R3!.scenarios.avg5.rankChange).toBe(1)
    // 現在順位は変わらない（可能性と確定事項を区別）
    expect(t.Tamagawa!.current.rank).toBe(1)
  })

  it('defense says the own pace is too slow (negative margin)', () => {
    const d = t.Tamagawa!.scenarios.avg5.defense!
    expect(d.status).toBe('OK')
    expect(d.paceMarginMs!).toBeLessThan(0)
  })
})

describe('Virtual race C: only the recent-pace scenario predicts an overtake', () => {
  // R4：10 周 11 分/周のあと、直近 3 周 9 分/周 → 3 周平均 9 分、5 周平均 9.8 分、10 周平均 10.4 分
  const r4Times = [11, 11, 11, 11, 11, 11, 11, 9, 9, 9]
  const r4: number[] = []
  let acc = 7 // 初回通過 7 分 → 11 周目は 111 分（自チーム 110 分より後 = 同周回で後方）
  r4.push(acc)
  for (const x of r4Times) r4.push((acc += x))
  const own = team(1, 'Tamagawa', every(10, 10, 110), { isOwnTeam: true }) // 11 周、最終 110 分
  const rep = computeStrategy(input([own, team(5, 'R4', r4)], 112))
  const t = Object.fromEntries(rep.teams.map((x) => [x.name, x]))

  it('has the expected averages and pace change', () => {
    expect(t.R4!.pace.averages.avg3.avgMs).toBe(9 * M)
    expect(t.R4!.pace.averages.avg5.avgMs).toBeCloseTo(9.8 * M, 6)
    expect(t.R4!.pace.averages.avg10.avgMs).toBeCloseTo(10.4 * M, 6)
    expect(t.R4!.pace.change).toMatchObject({ direction: 'FASTER' })
  })

  it('lists exactly the scenarios in which the predicted order flips, consistent with predicted laps', () => {
    expect(t.Tamagawa!.current.rank).toBe(1)
    expect(t.R4!.current).toMatchObject({ rank: 2, laps: 11 })
    const flips = SCENARIOS.filter((s) => t.R4!.scenarios[s].predictedRank < t.Tamagawa!.scenarios[s].predictedRank)
    expect(flips.length).toBeGreaterThan(0)
    expect(flips.length).toBeLessThan(3) // シナリオによって結果が異なる
    expect(flips).toContain('avg3')
    expect(t.Tamagawa!.mayBeOvertakenBy).toEqual([{ teamId: 5, scenarios: flips }])
    expect(t.R4!.mayOvertake).toEqual([{ teamId: 1, scenarios: flips }])
    for (const s of SCENARIOS) {
      const a = t.R4!.scenarios[s]
      expect(a.predictedFinalLaps).toBe(oracleFinalLaps(11, 111, 112, a.paceMs! / M))
    }
  })
})

describe('Virtual race D: mandatory stoppages', () => {
  // 自チーム 10 分/周。60〜75 分に強制停止 → 7 周目（60→85）は停止と重なる
  const ownPasses = [10, 20, 30, 40, 50, 60, 85, 95, 105, 115]
  const own = () => team(1, 'Tamagawa', ownPasses, { isOwnTeam: true })
  const past = { startsAt: T0 + 60 * M, endsAt: T0 + 75 * M }

  it('excludes the overlapping lap from averages but keeps it as a lap', () => {
    const rep = computeStrategy(input([own()], 118, { stoppages: [past] }))
    const t = rep.teams[0]!
    expect(t.current.laps).toBe(10)
    expect(t.pace.excluded.map((e) => [e.lapNumber, e.reason])).toEqual([[7, 'STOPPAGE_OVERLAP']])
    expect(t.pace.averages.avg3.avgMs).toBe(10 * M)
    expect(t.pace.averages.avg10).toMatchObject({ avgMs: null, used: 9, sufficient: false })
    expect(t.scenarios.avg10.uncertainties).toContain('INSUFFICIENT_DATA')
    expect(rep.clock.elapsedStoppageMs).toBe(15 * M)
  })

  it('removes future stoppage time from the remaining drive time and the prediction', () => {
    const base = computeStrategy(input([own()], 118, { stoppages: [past] })).teams[0]!.scenarios.avg5
    expect(base.predictedFinalLaps).toBe(46) // 停止なし：125, 135, ... 475 分
    const rep = computeStrategy(input([own()], 118, { stoppages: [past, { startsAt: T0 + 200 * M, endsAt: T0 + 230 * M }] }))
    expect(rep.clock).toMatchObject({ remainingClockMs: 362 * M, remainingStoppageMs: 30 * M, remainingDriveMs: 332 * M })
    expect(rep.teams[0]!.scenarios.avg5.predictedFinalLaps).toBe(43)
  })

  it('does not double count overlapping stoppages', () => {
    const rep = computeStrategy(
      input([own()], 118, {
        stoppages: [past, { startsAt: T0 + 200 * M, endsAt: T0 + 230 * M }, { startsAt: T0 + 210 * M, endsAt: T0 + 240 * M }]
      })
    )
    expect(rep.clock.remainingStoppageMs).toBe(40 * M) // 30 + 30 ではなく 40
    expect(rep.teams[0]!.scenarios.avg5.predictedFinalLaps).toBe(42)
  })

  it('during an open-ended stoppage: Δt excludes the stop, results flagged as not definitive', () => {
    const rep = computeStrategy(input([own()], 118, { stoppages: [past, { startsAt: T0 + 116 * M, endsAt: null }] }))
    expect(rep.clock.inStoppage).toBe(true)
    expect(rep.clock.openEndedStoppage).toBe(true)
    expect(rep.uncertainties).toEqual(expect.arrayContaining(['OPEN_ENDED_STOPPAGE', 'IN_STOPPAGE']))
    const s = rep.teams[0]!.scenarios.avg5
    expect(s.position!.deltaDriveMs).toBe(1 * M) // 115〜116 分のみ走行
    expect(s.position!.q).toBeCloseTo(10.1, 9)
    expect(s.uncertainties).toEqual(expect.arrayContaining(['OPEN_ENDED_STOPPAGE', 'IN_STOPPAGE']))
  })
})

describe('Data shortage, stale data and edge states', () => {
  it('reports insufficient data and makes no prediction early in the race', () => {
    const rep = computeStrategy(input([team(1, 'Own', [10, 20], { isOwnTeam: true }), team(2, 'R', [9, 18, 27])], 28))
    for (const t of rep.teams) {
      for (const s of SCENARIOS) {
        expect(t.scenarios[s].predicted).toBe(false)
        expect(t.scenarios[s].predictedFinalLaps).toBeNull()
        expect(t.scenarios[s].uncertainties).toContain('INSUFFICIENT_DATA')
      }
      expect(t.mayOvertake).toEqual([])
    }
    // 他チーム 3 通過 → ラップタイム 2 件のみ（初回除外）
    expect(rep.teams.find((t) => t.name === 'R')!.pace.averages.avg3).toMatchObject({ used: 2, sufficient: false })
  })

  it('flags overdue teams (stale records) and adjusts their next pass to now', () => {
    const rep = computeStrategy(input([team(1, 'Own', every(10, 10, 100), { isOwnTeam: true }), team(2, 'Stale', every(10, 10, 60))], 100))
    const s = rep.teams.find((t) => t.name === 'Stale')!.scenarios.avg5
    expect(s.uncertainties).toContain('OVERDUE')
    expect(s.position!.progress).toBe(1)
    expect(s.projection!.overdueAdjusted).toBe(true)
    expect(s.projection!.nextPassAt).toBe(T0 + 100 * M)
  })

  it('handles teams with no passes (no reference) without crashing', () => {
    const rep = computeStrategy(input([team(1, 'Own', every(10, 10, 60), { isOwnTeam: true }), team(2, 'NoPass', [])], 61))
    const s = rep.teams.find((t) => t.name === 'NoPass')!.scenarios.avg5
    expect(s.uncertainties).toEqual(expect.arrayContaining(['NO_REFERENCE', 'INSUFFICIENT_DATA']))
    expect(s.position).toBeNull()
    expect(rep.teams.find((t) => t.name === 'Own')!.scenarios.avg5.defense!.status).toBe('NO_DATA')
    assertFinite(rep)
  })

  it('survives abnormal input (same-time passes, reversed times) without NaN', () => {
    const weird = team(2, 'Weird', [10, 10, 5, 30])
    const rep = computeStrategy(input([team(1, 'Own', every(10, 10, 60), { isOwnTeam: true }), weird], 61))
    const w = rep.teams.find((t) => t.name === 'Weird')!
    expect(w.pace.excluded.some((e) => e.reason === 'NON_POSITIVE')).toBe(true)
    assertFinite(rep)
  })

  it('no predictions before START; final results after END', () => {
    const pre = computeStrategy(input([team(1, 'Own', [], { isOwnTeam: true })], 0, { status: 'PREPARING', actualStartAt: null }))
    expect(pre.uncertainties).toContain('RACE_NOT_STARTED')
    expect(pre.teams[0]!.scenarios.avg5.position).toBeNull()

    const own = team(1, 'Own', every(10, 10, 470), { isOwnTeam: true })
    const fin = computeStrategy(input([own, team(2, 'R', every(9, 9, 470))], 999, { status: 'FINISHED', actualEndAt: T0 + 475 * M }))
    expect(fin.uncertainties).toContain('RACE_FINISHED')
    expect(fin.clock.evaluatedAt).toBe(T0 + 475 * M)
    const o = fin.teams.find((t) => t.name === 'Own')!
    expect(o.scenarios.avg5.predictedFinalLaps).toBe(47)
    expect(o.scenarios.avg5.attack).toBeNull()
    expect(o.mayBeOvertakenBy).toEqual([])
  })

  it('without a scheduled end: no remaining time, no predictions, no attack/defense', () => {
    const rep = computeStrategy(input([team(1, 'Own', every(10, 10, 60), { isOwnTeam: true }), team(2, 'R', every(9, 9, 60))], 61, { scheduledEndAt: null }))
    expect(rep.clock.remainingDriveMs).toBeNull()
    expect(rep.uncertainties).toContain('NO_SCHEDULED_END')
    expect(rep.teams[0]!.scenarios.avg5.projection).toBeNull()
    expect(rep.teams[1]!.scenarios.avg5.attack).toBeNull()
  })
})
