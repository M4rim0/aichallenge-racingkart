import type { StopInterval } from './stoppages'
import { overlapMs } from './stoppages'

/**
 * 平均ペース（決定 D-045, D-047〜D-049）。
 * 直近 N 周の「有効な」ラップタイムの単純平均。有効なラップが N 件未満ならデータ不足（算出しない）。
 */

export const SCENARIOS = ['avg3', 'avg5', 'avg10'] as const
export type ScenarioId = (typeof SCENARIOS)[number]
export const SCENARIO_LAPS: Record<ScenarioId, number> = { avg3: 3, avg5: 5, avg10: 10 }

export type LapExclusionReason =
  /** 他チームの 1 周目：基準時刻がない（D-047） */
  | 'NO_BASE_TIME'
  /** 強制停止と時間的に重なった（D-045） */
  | 'STOPPAGE_OVERLAP'
  /** ラップタイムが 0 以下（時刻異常など。計算を破綻させないため除外） */
  | 'NON_POSITIVE'

export interface LapSample {
  recordId: number
  lapNumber: number
  /** ラップの開始（前回通過、または自チーム 1 周目は実際の開始時刻）。基準がなければ null */
  startAt: number | null
  /** 通過日時 */
  endAt: number
}

export interface PaceAverage {
  /** 平均ラップタイム（ms）。データ不足なら null */
  avgMs: number | null
  /** 平均に使用したラップ数 */
  used: number
  /** 必要なラップ数 */
  required: number
  sufficient: boolean
}

export interface PaceChange {
  /** 3 周平均 − 10 周平均（ms）。負ならペース上昇 */
  diffMs: number
  /** diffMs / 10 周平均 × 100 */
  percent: number
  direction: 'FASTER' | 'SLOWER' | 'SAME'
}

export interface PaceResult {
  averages: Record<ScenarioId, PaceAverage>
  /** 有効なラップタイムの件数 */
  validLapCount: number
  excluded: { recordId: number; lapNumber: number; reason: LapExclusionReason }[]
  /** 3 周平均と 10 周平均の両方がある場合のみ */
  change: PaceChange | null
}

export function computePace(laps: readonly LapSample[], intervals: readonly StopInterval[]): PaceResult {
  const valid: number[] = []
  const excluded: PaceResult['excluded'] = []
  for (const l of laps) {
    if (l.startAt === null) {
      excluded.push({ recordId: l.recordId, lapNumber: l.lapNumber, reason: 'NO_BASE_TIME' })
      continue
    }
    const t = l.endAt - l.startAt
    if (!(t > 0)) {
      excluded.push({ recordId: l.recordId, lapNumber: l.lapNumber, reason: 'NON_POSITIVE' })
      continue
    }
    if (overlapMs(intervals, l.startAt, l.endAt) > 0) {
      excluded.push({ recordId: l.recordId, lapNumber: l.lapNumber, reason: 'STOPPAGE_OVERLAP' })
      continue
    }
    valid.push(t)
  }
  const averages = Object.fromEntries(
    SCENARIOS.map((id) => [id, average(valid, SCENARIO_LAPS[id])])
  ) as Record<ScenarioId, PaceAverage>
  const a3 = averages.avg3.avgMs
  const a10 = averages.avg10.avgMs
  const change: PaceChange | null =
    a3 !== null && a10 !== null
      ? {
          diffMs: a3 - a10,
          percent: ((a3 - a10) / a10) * 100,
          direction: a3 < a10 ? 'FASTER' : a3 > a10 ? 'SLOWER' : 'SAME'
        }
      : null
  return { averages, validLapCount: valid.length, excluded, change }
}

function average(valid: readonly number[], n: number): PaceAverage {
  if (valid.length < n) return { avgMs: null, used: valid.length, required: n, sufficient: false }
  const recent = valid.slice(-n)
  return { avgMs: recent.reduce((s, x) => s + x, 0) / n, used: n, required: n, sufficient: true }
}
