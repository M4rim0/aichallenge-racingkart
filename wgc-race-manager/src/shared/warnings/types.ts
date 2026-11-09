import type { SuppressedWarning, WarningCandidate } from './detect'

/** 警告一覧の表示用の型（Main ⇔ Renderer 共通） */

/** NEW：発生または重要度上昇から 10 秒以内 / CONTINUING：それ以降（W-10、D-069） */
export type WarningPhase = 'NEW' | 'CONTINUING'

export interface ActiveWarning extends WarningCandidate {
  /** 発生ごとの ID（再発生すると変わる）。確認済み操作はこの ID で行う */
  occurrenceId: string
  phase: WarningPhase
  raisedAt: number
  updatedAt: number
  /** 重要度が上昇した時刻（なければ null） */
  escalatedAt: number | null
  acknowledged: boolean
}

export interface WarningList {
  eventId: number
  evaluatedAt: number
  /** 表示対象（確認済みを除く）。重要度順 */
  visible: ActiveWarning[]
  /** 確認済みで非表示の件数（条件は継続中） */
  acknowledgedCount: number
  /** 不確実性により抑制した判定（参考情報） */
  suppressed: SuppressedWarning[]
}
