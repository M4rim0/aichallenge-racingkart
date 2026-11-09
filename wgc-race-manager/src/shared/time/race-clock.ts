import type { ClockTransitionKind, EventStatus } from '../types/entities'

/**
 * レース時計の計算（純粋関数）。
 *
 * - レース経過時間：START（または修正後の実際の開始時刻）から、PAUSE 中を除いて END まで進む（仕様 §4.2）
 * - 残り時間：予定終了時刻 − 現在日時。PAUSE の影響を受けない（D-002）。END 後は終了時点で固定
 * - 日時はすべてマスタークロック基準の epoch ms。保存済みの日時は書き換えない（D-013）。
 *   時系列が逆転している区間（PC 時刻異常など）は 0 として扱い、anomalies に記録する。
 */

export interface TransitionInput {
  id: number
  kind: ClockTransitionKind
  at: number
}

export interface RaceClockInput {
  status: EventStatus
  /** 実際の開始時刻（修正済みの値。D-012） */
  actualStartAt: number | null
  actualEndAt: number | null
  scheduledEndAt: number | null
  /** id 昇順 */
  transitions: readonly TransitionInput[]
  now: number
}

export interface TimelineAnomaly {
  /** 異常が見つかった遷移の id */
  transitionId: number
  kind: ClockTransitionKind
  message: string
}

export interface RaceClockSnapshot {
  status: EventStatus
  now: number
  actualStartAt: number | null
  actualEndAt: number | null
  /** レース経過時間（ms）。開始前は null */
  elapsedMs: number | null
  /** 残り時間（ms）。予定終了時刻が未設定なら null。予定終了を過ぎると負の値 */
  remainingClockMs: number | null
  /** 時系列の異常（空なら正常） */
  anomalies: TimelineAnomaly[]
}

export function computeRaceClock(input: RaceClockInput): RaceClockSnapshot {
  const anomalies: TimelineAnomaly[] = []
  const finished = input.status === 'FINISHED'
  const effectiveNow = finished && input.actualEndAt !== null ? input.actualEndAt : input.now

  let elapsed: number | null = null
  if (input.actualStartAt !== null) {
    elapsed = 0
    let runningSince: number | null = null
    let prevAt: number | null = null
    for (const t of input.transitions) {
      // START の時刻は、修正後の実際の開始時刻で置き換える（遷移記録そのものは変更しない）
      const at = t.kind === 'START' ? input.actualStartAt : t.at
      if (prevAt !== null && at < prevAt) {
        anomalies.push({
          transitionId: t.id,
          kind: t.kind,
          message: `時系列が逆転しています（${t.kind} が直前の操作より ${prevAt - at} ms 前）`
        })
      }
      prevAt = at
      switch (t.kind) {
        case 'START':
        case 'RESUME':
          if (runningSince === null) runningSince = at
          break
        case 'PAUSE':
        case 'END':
          if (runningSince !== null) {
            elapsed += Math.max(0, at - runningSince)
            runningSince = null
          }
          break
      }
    }
    if (runningSince !== null) {
      if (effectiveNow < runningSince) {
        anomalies.push({
          transitionId: input.transitions.at(-1)?.id ?? 0,
          kind: input.transitions.at(-1)?.kind ?? 'START',
          message: `現在日時が最後の操作より ${runningSince - effectiveNow} ms 前です`
        })
      }
      elapsed += Math.max(0, effectiveNow - runningSince)
    }
  }

  return {
    status: input.status,
    now: input.now,
    actualStartAt: input.actualStartAt,
    actualEndAt: input.actualEndAt,
    elapsedMs: elapsed,
    remainingClockMs: input.scheduledEndAt === null ? null : input.scheduledEndAt - effectiveNow,
    anomalies
  }
}

/** 状態遷移の可否（仕様 §3.1 の 4 状態） */
export const ALLOWED_TRANSITIONS: Readonly<Record<ClockTransitionKind, readonly EventStatus[]>> = {
  START: ['PREPARING'],
  PAUSE: ['RUNNING'],
  RESUME: ['PAUSED'],
  END: ['RUNNING', 'PAUSED']
}

export const NEXT_STATUS: Readonly<Record<ClockTransitionKind, EventStatus>> = {
  START: 'RUNNING',
  PAUSE: 'PAUSED',
  RESUME: 'RUNNING',
  END: 'FINISHED'
}

// 強制停止時間の戦略計算への組み込みは src/shared/strategy/stoppages.ts（段階10、D-044〜D-046）
