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
  /** 操作が行われた起動セッション ID */
  bootSessionId: string | null
  /** 1 回の操作で作られた履歴行をまとめる ID（UNDO の単位、D-017） */
  operationGroup: string | null
}

/** アプリの起動セッション（D-013） */
export interface AppSession {
  id: string
  startedWallAt: EpochMs
  /** 起動時点で DB に保存されていた最新の日時 */
  latestSavedAtBefore: EpochMs | null
  /** 起動時の PC 時刻が latestSavedAtBefore より過去だった */
  clockAnomaly: boolean
  anomalyDetail: string | null
  appVersion: string | null
  createdAt: EpochMs
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

/** 算出済みのラップ（周回番号・ラップタイムは保存せず算出。D-005） */
export interface LapView {
  recordId: number
  teamId: number
  lapNumber: number
  passedAt: EpochMs
  passedWallAt: EpochMs | null
  /** ラップタイム（ms）。基準時刻が無い場合は null */
  lapTimeMs: number | null
  bootSessionId: string | null
}

/** 車両データの入力項目（すべて入力文字列。null / 空欄は未入力。D-006, D-027） */
export interface VehicleDataFields {
  speed: string | null
  voltage: string | null
  current: string | null
  integratedValue: string | null
}

/** 車両データ一覧の 1 行（有効な自チームラップごと。D-025） */
export interface VehicleDataRow {
  lapRecordId: number
  lapNumber: number
  passedAt: EpochMs
  /** 未登録なら null */
  vehicleData: VehicleData | null
}

export const LIFECYCLE_KINDS = ['BOOT', 'CLEAN_SHUTDOWN', 'SUSPEND', 'RESUME'] as const
export type LifecycleKind = (typeof LIFECYCLE_KINDS)[number]

/** 起動・正常終了・スリープ／復帰の記録（D-064, D-066）。追記専用 */
export interface AppLifecycleEvent {
  id: number
  bootSessionId: string
  kind: LifecycleKind
  /** マスタークロック日時 */
  at: EpochMs
  /** PC 実日時 */
  wallAt: EpochMs
  monoMs: number | null
  /** RESUME：復帰時の「PC 実日時 − マスタークロック」 */
  driftMs: number | null
  /** RESUME：ずれの変化がしきい値（5 秒）を超えた */
  anomaly: boolean
  detail: string | null
  createdAt: EpochMs
}

/** 前回の起動の終了状態（D-066） */
export interface PreviousShutdownStatus {
  bootSessionId: string
  startedWallAt: EpochMs
  /** true：正常終了の記録あり / false：正常終了の記録なし（異常終了） */
  clean: boolean
}

/** 復旧確認待ち（D-070〜D-072）。確認されるまで、その大会のレースに影響する操作を受け付けない */
export interface RecoveryHold {
  holdId: number
  eventId: number
  eventName: string
  /** 異常終了を検出した時点の大会の状態（そのまま維持される） */
  eventStatus: 'RUNNING' | 'PAUSED'
  /** 確認待ちを作成した起動 */
  bootSessionId: string
  /** 異常終了した（正常終了の記録がない）起動 */
  crashedSessionId: string | null
  /** 作成日時（マスタークロック） */
  createdAt: EpochMs
}

/** 復旧確認の記録 */
export interface RecoveryConfirmation {
  confirmId: number
  holdId: number
  eventId: number
  operatorId: number | null
  operatorNameSnapshot: string | null
  confirmedAt: EpochMs
}
