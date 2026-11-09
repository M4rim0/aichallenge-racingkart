/**
 * ドメインエンティティの型。DB の行を camelCase に変換したもの。
 *
 * 日時はすべて UTC の epoch ミリ秒（number）。表示・CSV 出力時に日本時間へ変換する。
 * `deletedAt` が null でない行は論理削除済み。
 */

export type EpochMs = number

export interface Timestamps {
  createdAt: EpochMs
  updatedAt: EpochMs
}

export interface SoftDeletable {
  deletedAt: EpochMs | null
}

export const EVENT_STATUSES = ['PREPARING', 'RUNNING', 'PAUSED', 'FINISHED'] as const
export type EventStatus = (typeof EVENT_STATUSES)[number]

export interface RaceEvent extends Timestamps, SoftDeletable {
  id: number
  name: string
  /** 開催日（YYYY-MM-DD、日本時間の暦日） */
  heldOn: string | null
  courseName: string | null
  /** 1周の距離（メートル） */
  lapDistanceM: number | null
  scheduledStartAt: EpochMs | null
  scheduledEndAt: EpochMs | null
  actualStartAt: EpochMs | null
  actualEndAt: EpochMs | null
  status: EventStatus
}

export interface Team extends Timestamps, SoftDeletable {
  id: number
  eventId: number
  name: string
  /** ゼッケン番号（英字を含む可能性があるため文字列） */
  bibNumber: string | null
  /** 識別色（表示形式は UI 確定時に決定。値はそのまま保存） */
  color: string | null
  isOwnTeam: boolean
}

/**
 * 通過記録（自チームのラップ記録・他チームの通過記録で共通の形）。
 * 周回番号・ラップタイムは保存せず、通過日時から算出する（D-005）。
 */
export interface PassRecord extends Timestamps, SoftDeletable {
  id: number
  eventId: number
  teamId: number
  /** 通過日時（マスタークロック基準） */
  passedAt: EpochMs
  /** 記録時点の OS 実日時（参考値。扱いは論点 A-3 で確定） */
  passedWallAt: EpochMs | null
  /** 記録時のアプリ起動セッション ID */
  bootSessionId: string | null
}

export type LapRecord = PassRecord
export type CompetitorPass = PassRecord

/** 車両データ。4 項目すべて入力文字列のまま保存し、null は未入力（D-006）。 */
export interface VehicleData extends Timestamps, SoftDeletable {
  id: number
  lapRecordId: number
  speed: string | null
  voltage: string | null
  current: string | null
  integratedValue: string | null
}

export interface Operator extends Timestamps, SoftDeletable {
  id: number
  name: string
}

export interface Memo extends Timestamps, SoftDeletable {
  id: number
  eventId: number
  body: string
  notedAt: EpochMs
}

export const HISTORY_ACTIONS = ['CREATE', 'UPDATE', 'DELETE', 'UNDO'] as const
export type HistoryAction = (typeof HISTORY_ACTIONS)[number]

export interface OperationHistoryEntry {
  id: number
  eventId: number | null
  operatorId: number | null
  operatorNameSnapshot: string | null
  operatedAt: EpochMs
  action: HistoryAction
  targetTable: string
  targetId: number | null
  /** 変更前の値（JSON 文字列）。追加時は null */
  beforeJson: string | null
  /** 変更後の値（JSON 文字列）。削除時も論理削除後の行を保存する */
  afterJson: string | null
  /** UNDO の場合、取り消した履歴の ID */
  undoOfHistoryId: number | null
  /** 補足説明（任意） */
  note: string | null
}

export const CLOCK_TRANSITION_KINDS = ['START', 'PAUSE', 'RESUME', 'END'] as const
export type ClockTransitionKind = (typeof CLOCK_TRANSITION_KINDS)[number]

export interface RaceClockTransition {
  id: number
  eventId: number
  kind: ClockTransitionKind
  /** 遷移日時（マスタークロック基準） */
  at: EpochMs
  /** 遷移時点の OS 実日時 */
  wallAt: EpochMs
  /** 遷移時点の単調時計の値（同一起動セッション内でのみ比較可能） */
  monoMs: number | null
  bootSessionId: string
  createdAt: EpochMs
}

export interface MandatoryStoppage extends Timestamps, SoftDeletable {
  id: number
  eventId: number
  startsAt: EpochMs
  /** 終了日時（未定の場合 null。登録・変更条件は §20 で未確定） */
  endsAt: EpochMs | null
}
