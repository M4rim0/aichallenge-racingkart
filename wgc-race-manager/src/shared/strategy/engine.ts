import type { EventStatus } from '../types/entities'
import { deriveLaps } from '../race/laps'
import { provisionalRule, rankTeams, type RankingRule } from '../race/ranking'
import { computeAttack, computeDefense, type AttackResult, type DefenseResult } from './attack-defense'
import { SCENARIOS, computePace, type LapSample, type PaceResult, type ScenarioId } from './pace'
import { estimatePosition, projectFinalLaps, type PositionEstimate, type Projection } from './position'
import { effectiveIntervals, isInStoppage, overlapMs, type StoppageInput } from './stoppages'

/**
 * 戦略計算エンジン（仕様 §8、決定 D-044〜D-055）。
 * 純粋関数：入力（元データ）から毎回すべてを再計算する。AI は使わない。
 *
 * 用語：
 * - 周回差：確定した周回数（通過回数）の差（整数、実測）
 * - 実測時間差：同じ周回数のチーム間でのみ、その周回の通過時刻の差（実測）
 * - 推定時間差：周回数が異なる場合、推定走行位置の差 × 後方チームの予測ペース（推定値。実測時間差としては扱わない）
 * - 推定走行位置 Q：§8.4（position.ts）
 */

export type Uncertainty =
  /** 平均に必要なラップ数が足りない */
  | 'INSUFFICIENT_DATA'
  /** 予測ペースを過ぎても次の通過記録がない（記録が古い・ペース低下・記録漏れの可能性） */
  | 'OVERDUE'
  /** 位置の基準となる通過がない（他チームで通過 0 回） */
  | 'NO_REFERENCE'
  /** 終了日時が未定の強制停止がある（予測は確定値ではない） */
  | 'OPEN_ENDED_STOPPAGE'
  /** 現在、強制停止中 */
  | 'IN_STOPPAGE'
  /** 終了予定時刻が未設定 */
  | 'NO_SCHEDULED_END'
  | 'RACE_NOT_STARTED'
  | 'RACE_FINISHED'
  /** 現在日時が最後の通過より前（時刻異常） */
  | 'TIMELINE_ANOMALY'
  /** 順位が暫定ルールによる */
  | 'PROVISIONAL_RANKING_RULE'

export interface StrategyTeamInput {
  teamId: number
  name: string
  bibNumber: string | null
  isOwnTeam: boolean
  teamDeleted: boolean
  /** 有効な通過記録（自チームはラップ記録、他チームは通過記録） */
  passes: readonly { id: number; passedAt: number }[]
}

export interface StrategyInput {
  now: number
  status: EventStatus
  actualStartAt: number | null
  actualEndAt: number | null
  scheduledEndAt: number | null
  stoppages: readonly StoppageInput[]
  teams: readonly StrategyTeamInput[]
  rule?: RankingRule
}

export interface ClockBasis {
  /** 計算に使った現在日時（終了後は実際の終了時刻） */
  evaluatedAt: number
  scheduledEndAt: number | null
  /** 残りレース時間 R_clock（ms）。終了予定未設定なら null */
  remainingClockMs: number | null
  /** 今後の強制停止時間 S_remaining（ms、重複は結合済み） */
  remainingStoppageMs: number | null
  /** 残り走行可能時間 R_drive = R_clock − S_remaining（0 未満は 0） */
  remainingDriveMs: number | null
  /** これまでの強制停止時間の合計（ms、重複は結合済み。終了未定の停止は現在まで） */
  elapsedStoppageMs: number
  inStoppage: boolean
  /** 終了日時が未定の停止がある（その停止は「現在まで」として計算している） */
  openEndedStoppage: boolean
}

export interface NeighborComparison {
  teamId: number
  /** 周回差（整数、実測）。前方なら 相手 − 自、後方なら 自 − 相手 */
  lapGap: number
  /** 同じ周回数の場合のみの実測時間差（ms、その周回の通過時刻の差） */
  measuredTimeGapMs: number | null
  /** 周回数が異なる場合などの推定時間差（ms、5 周平均基準）。実測ではない */
  estimatedTimeGapMs: number | null
  /** ペース差（自 − 相手、ms）。正なら自チームが遅い。5 周平均が標準（D-050） */
  paceDiffMs: Record<ScenarioId, number | null>
}

export interface TeamScenarioResult {
  scenario: ScenarioId
  paceMs: number | null
  position: PositionEstimate | null
  projection: Projection | null
  /** 予測最終周回数（予測できない場合は null） */
  predictedFinalLaps: number | null
  /** 予測最終順位（予測できないチームは現在の進捗のまま並べた順位、predicted = false） */
  predictedRank: number
  predicted: boolean
  /** 現在順位 − 予測順位（正なら順位上昇） */
  rankChange: number
  attack: AttackResult | null
  defense: DefenseResult | null
  uncertainties: Uncertainty[]
}

export interface OvertakePossibility {
  teamId: number
  /** 入れ替わりが予測されるシナリオ */
  scenarios: ScenarioId[]
}

export interface TeamStrategy {
  teamId: number
  name: string
  bibNumber: string | null
  isOwnTeam: boolean
  teamDeleted: boolean
  current: {
    rank: number
    tied: boolean
    laps: number
    lastPassAt: number | null
  }
  pace: PaceResult
  ahead: NeighborComparison | null
  behind: NeighborComparison | null
  scenarios: Record<ScenarioId, TeamScenarioResult>
  /** 現在前方で、いずれかのシナリオで抜ける可能性があるチーム（可能性であり確定ではない） */
  mayOvertake: OvertakePossibility[]
  /** 現在後方で、いずれかのシナリオで抜かれる可能性があるチーム */
  mayBeOvertakenBy: OvertakePossibility[]
}

export interface StrategyReport {
  status: EventStatus
  clock: ClockBasis
  rankingRule: { id: string; label: string; provisional: boolean }
  scenarios: readonly ScenarioId[]
  /** 現在順位の順 */
  teams: TeamStrategy[]
  uncertainties: Uncertainty[]
}

export function computeStrategy(input: StrategyInput): StrategyReport {
  const rule = input.rule ?? provisionalRule
  const evaluatedAt = input.status === 'FINISHED' && input.actualEndAt !== null ? input.actualEndAt : input.now
  const intervals = effectiveIntervals(input.stoppages, evaluatedAt)
  const openEnded = input.stoppages.some((s) => s.endsAt === null)
  const inStoppage = input.status !== 'FINISHED' && isInStoppage(input.stoppages, evaluatedAt)
  const live = input.status === 'RUNNING' || input.status === 'PAUSED'

  // 時計の根拠
  const end = input.scheduledEndAt
  const remainingClockMs = end === null ? null : end - evaluatedAt
  const remainingStoppageMs = end === null ? null : overlapMs(intervals, evaluatedAt, end)
  const remainingDriveMs =
    remainingClockMs === null || remainingStoppageMs === null
      ? null
      : Math.max(0, remainingClockMs - remainingStoppageMs)
  const startRef = input.actualStartAt ?? evaluatedAt
  const clock: ClockBasis = {
    evaluatedAt,
    scheduledEndAt: end,
    remainingClockMs,
    remainingStoppageMs,
    remainingDriveMs,
    elapsedStoppageMs: overlapMs(intervals, startRef, evaluatedAt),
    inStoppage,
    openEndedStoppage: openEnded
  }

  const global: Uncertainty[] = []
  if (rule.provisional) global.push('PROVISIONAL_RANKING_RULE')
  if (input.status === 'PREPARING') global.push('RACE_NOT_STARTED')
  if (input.status === 'FINISHED') global.push('RACE_FINISHED')
  if (end === null) global.push('NO_SCHEDULED_END')
  if (openEnded) global.push('OPEN_ENDED_STOPPAGE')
  if (inStoppage) global.push('IN_STOPPAGE')

  // チームごとの基礎データ
  const base = input.teams.map((t) => {
    const baseAt = t.isOwnTeam ? input.actualStartAt : null
    const derived = deriveLaps(t.passes, baseAt)
    const samples: LapSample[] = derived.map((d, i) => ({
      recordId: d.record.id,
      lapNumber: d.lapNumber,
      startAt: i === 0 ? baseAt : derived[i - 1]!.record.passedAt,
      endAt: d.record.passedAt
    }))
    const laps = derived.length
    const lastPassAt = derived.at(-1)?.record.passedAt ?? null
    // 位置の基準：最後の通過。自チームで 0 周なら実際の開始時刻
    const lastRefAt = lastPassAt ?? (t.isOwnTeam ? input.actualStartAt : null)
    return { input: t, pace: computePace(samples, intervals), laps, lastPassAt, lastRefAt }
  })

  const current = rankTeams(base.map((b) => ({ teamId: b.input.teamId, laps: b.laps, lastPassAt: b.lastPassAt })), rule)
  const order = current.map((c) => c.teamId)
  const byId = new Map(base.map((b) => [b.input.teamId, b]))
  const currentById = new Map(current.map((c) => [c.teamId, c]))

  // シナリオごとの位置・予測
  type Partial = { position: PositionEstimate | null; projection: Projection | null; paceMs: number | null; unc: Uncertainty[] }
  const perScenario = new Map<ScenarioId, Map<number, Partial>>()
  for (const s of SCENARIOS) {
    const m = new Map<number, Partial>()
    for (const b of base) {
      const unc: Uncertainty[] = []
      const paceMs = b.pace.averages[s].avgMs
      let position: PositionEstimate | null = null
      let projection: Projection | null = null
      if (paceMs === null) unc.push('INSUFFICIENT_DATA')
      if (b.lastRefAt === null) unc.push('NO_REFERENCE')
      if (input.status !== 'PREPARING' && paceMs !== null && b.lastRefAt !== null) {
        position = estimatePosition(b.laps, b.lastRefAt, evaluatedAt, paceMs, intervals)
        if (position.overdue && live) unc.push('OVERDUE')
        if (position.timelineAnomaly) unc.push('TIMELINE_ANOMALY')
        if (live && end !== null) {
          projection = projectFinalLaps(b.laps, b.lastRefAt, evaluatedAt, end, paceMs, intervals)
        }
      }
      m.set(b.input.teamId, { position, projection, paceMs, unc })
    }
    perScenario.set(s, m)
  }

  // 予測順位（終了後は実績そのもの）
  const predictedRanks = new Map<ScenarioId, Map<number, { rank: number; predicted: boolean; finalLaps: number | null }>>()
  for (const s of SCENARIOS) {
    const m = perScenario.get(s)!
    const progress = base.map((b) => {
      const p = m.get(b.input.teamId)!
      if (input.status === 'FINISHED') {
        return { teamId: b.input.teamId, laps: b.laps, lastPassAt: b.lastPassAt, predicted: true, finalLaps: b.laps as number | null }
      }
      if (p.projection) {
        return { teamId: b.input.teamId, laps: p.projection.finalLaps, lastPassAt: p.projection.projectedLastPassAt, predicted: true, finalLaps: p.projection.finalLaps as number | null }
      }
      return { teamId: b.input.teamId, laps: b.laps, lastPassAt: b.lastPassAt, predicted: false, finalLaps: null as number | null }
    })
    const ranked = rankTeams(progress, rule)
    const flags = new Map(progress.map((p) => [p.teamId, p]))
    predictedRanks.set(
      s,
      new Map(ranked.map((r) => [r.teamId, { rank: r.rank, predicted: flags.get(r.teamId)!.predicted, finalLaps: flags.get(r.teamId)!.finalLaps }]))
    )
  }

  const teams: TeamStrategy[] = order.map((teamId, idx) => {
    const b = byId.get(teamId)!
    const cur = currentById.get(teamId)!
    const aheadId = idx > 0 ? order[idx - 1]! : null
    const behindId = idx < order.length - 1 ? order[idx + 1]! : null

    const scenarios = Object.fromEntries(
      SCENARIOS.map((s) => {
        const m = perScenario.get(s)!
        const self = m.get(teamId)!
        const pr = predictedRanks.get(s)!.get(teamId)!
        const rd = live ? remainingDriveMs : null
        const attack =
          aheadId !== null && rd !== null
            ? computeAttack({
                targetTeamId: aheadId,
                ownQ: self.position?.q ?? null,
                targetQ: m.get(aheadId)!.position?.q ?? null,
                targetPaceMs: m.get(aheadId)!.paceMs,
                ownPaceMs: self.paceMs,
                remainingDriveMs: rd
              })
            : null
        const defense =
          behindId !== null && rd !== null
            ? computeDefense({
                threatTeamId: behindId,
                ownQ: self.position?.q ?? null,
                threatQ: m.get(behindId)!.position?.q ?? null,
                threatPaceMs: m.get(behindId)!.paceMs,
                ownPaceMs: self.paceMs,
                remainingDriveMs: rd
              })
            : null
        const result: TeamScenarioResult = {
          scenario: s,
          paceMs: self.paceMs,
          position: self.position,
          projection: self.projection,
          predictedFinalLaps: pr.finalLaps,
          predictedRank: pr.rank,
          predicted: pr.predicted,
          rankChange: cur.rank - pr.rank,
          attack,
          defense,
          uncertainties: [...global.filter((u) => u !== 'PROVISIONAL_RANKING_RULE'), ...self.unc]
        }
        return [s, result]
      })
    ) as Record<ScenarioId, TeamScenarioResult>

    return {
      teamId,
      name: b.input.name,
      bibNumber: b.input.bibNumber,
      isOwnTeam: b.input.isOwnTeam,
      teamDeleted: b.input.teamDeleted,
      current: { rank: cur.rank, tied: cur.tied, laps: b.laps, lastPassAt: b.lastPassAt },
      pace: b.pace,
      ahead: aheadId === null ? null : neighbor(b, byId.get(aheadId)!, 'ahead', perScenario),
      behind: behindId === null ? null : neighbor(b, byId.get(behindId)!, 'behind', perScenario),
      scenarios,
      mayOvertake: [],
      mayBeOvertakenBy: []
    }
  })

  // 抜ける・抜かれる可能性（両チームとも予測できたシナリオのみ。D-053）
  if (live) {
    for (const t of teams) {
      for (const o of teams) {
        if (o.teamId === t.teamId) continue
        const over: ScenarioId[] = []
        for (const s of SCENARIOS) {
          const a = t.scenarios[s]
          const b = o.scenarios[s]
          if (!a.predicted || !b.predicted) continue
          if (o.current.rank < t.current.rank && a.predictedRank < b.predictedRank) over.push(s)
        }
        if (over.length > 0) {
          t.mayOvertake.push({ teamId: o.teamId, scenarios: over })
          o.mayBeOvertakenBy.push({ teamId: t.teamId, scenarios: over })
        }
      }
    }
  }

  return {
    status: input.status,
    clock,
    rankingRule: { id: rule.id, label: rule.label, provisional: rule.provisional },
    scenarios: SCENARIOS,
    teams,
    uncertainties: global
  }
}

type BaseInfo = { input: StrategyTeamInput; pace: PaceResult; laps: number; lastPassAt: number | null }

function neighbor(
  self: BaseInfo,
  other: BaseInfo,
  side: 'ahead' | 'behind',
  perScenario: Map<ScenarioId, Map<number, { position: PositionEstimate | null; paceMs: number | null }>>
): NeighborComparison {
  const front = side === 'ahead' ? other : self
  const back = side === 'ahead' ? self : other
  const lapGap = front.laps - back.laps
  const measured =
    lapGap === 0 && front.lastPassAt !== null && back.lastPassAt !== null ? back.lastPassAt - front.lastPassAt : null
  // 推定時間差（5 周平均基準）：前方チームの推定位置まで、後方チームが予測ペースで到達するのにかかる時間
  const m5 = perScenario.get('avg5')!
  const fq = m5.get(front.input.teamId)!.position?.q ?? null
  const bq = m5.get(back.input.teamId)!.position?.q ?? null
  const bp = m5.get(back.input.teamId)!.paceMs
  const estimated = fq !== null && bq !== null && bp !== null ? (fq - bq) * bp : null
  const paceDiffMs = Object.fromEntries(
    SCENARIOS.map((s) => {
      const a = self.pace.averages[s].avgMs
      const b = other.pace.averages[s].avgMs
      return [s, a !== null && b !== null ? a - b : null]
    })
  ) as Record<ScenarioId, number | null>
  return { teamId: other.input.teamId, lapGap, measuredTimeGapMs: measured, estimatedTimeGapMs: estimated, paceDiffMs }
}
