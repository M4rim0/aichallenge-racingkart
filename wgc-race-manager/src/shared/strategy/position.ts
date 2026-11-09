import { drivableMs, timeAfterDriving, type StopInterval } from './stoppages'

/**
 * 走行位置の推定（§8.4、D-046）：Q = L + Δt / P
 * - Δt：最後の通過（自チームで 0 周なら実際の開始時刻）から現在までの「走行可能」時間（強制停止を除く）
 * - 進捗率 Δt / P は 0〜1 に制限する。1 を超えた（= 予測より遅れて未通過）場合は overdue として不確実性を示す
 * GPS・セクター計測を使わないため、すべて推定値である。
 */
export interface PositionEstimate {
  /** 推定走行位置（周） */
  q: number
  /** 進捗率（0〜1） */
  progress: number
  /** 最後の通過からの走行可能時間（ms） */
  deltaDriveMs: number
  /** 予測ペースを過ぎても次の通過がない（記録が古い・ペース低下・記録漏れの可能性） */
  overdue: boolean
  /** 現在日時が最後の通過より前（時刻異常） */
  timelineAnomaly: boolean
}

export function estimatePosition(
  laps: number,
  lastRefAt: number,
  now: number,
  paceMs: number,
  intervals: readonly StopInterval[]
): PositionEstimate {
  const deltaDriveMs = drivableMs(intervals, lastRefAt, now)
  const ratio = deltaDriveMs / paceMs
  return {
    q: laps + Math.min(1, Math.max(0, ratio)),
    progress: Math.min(1, Math.max(0, ratio)),
    deltaDriveMs,
    overdue: ratio > 1,
    timelineAnomaly: now < lastRefAt
  }
}

/**
 * 最終周回数の予測（§8.5、D-051）。
 * 最後の通過時刻から予測ペース分の走行可能時間を積み上げて次の通過時刻を求め、
 * 終了予定時刻以前に完了する通過だけを数える。停止区間は走行時間に含めない。
 * 予測上の次の通過時刻が既に過ぎている（overdue）場合は、まだ通過していないため「現在」に通過するものとして扱う。
 */
export interface Projection {
  finalLaps: number
  additionalLaps: number
  /** 次の通過の予測時刻 */
  nextPassAt: number
  /** 予測上の最後の通過時刻（追加周回がなければ最後の実通過） */
  projectedLastPassAt: number
  /** 次の通過予測が過ぎていたため現在に補正した */
  overdueAdjusted: boolean
}

export function projectFinalLaps(
  laps: number,
  lastRefAt: number,
  now: number,
  scheduledEndAt: number,
  paceMs: number,
  intervals: readonly StopInterval[]
): Projection {
  let next = timeAfterDriving(intervals, lastRefAt, paceMs)
  const overdueAdjusted = next < now
  if (overdueAdjusted) next = now
  if (next > scheduledEndAt) {
    return { finalLaps: laps, additionalLaps: 0, nextPassAt: next, projectedLastPassAt: lastRefAt, overdueAdjusted }
  }
  // 1 回目の通過以降は、残りの走行可能時間に何周入るかを数える（積み上げと同値・反復回数に依存しない）
  const remainingDrive = drivableMs(intervals, next, scheduledEndAt)
  const more = Math.floor(remainingDrive / paceMs + 1e-9)
  const additionalLaps = 1 + more
  return {
    finalLaps: laps + additionalLaps,
    additionalLaps,
    nextPassAt: next,
    projectedLastPassAt: more > 0 ? timeAfterDriving(intervals, next, more * paceMs) : next,
    overdueAdjusted
  }
}
