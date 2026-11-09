/**
 * Main → Renderer に返すエラー。IPC を通しても失われないよう、コードとメッセージのみの平坦な形にする。
 */
export const ErrorCode = {
  VALIDATION: 'VALIDATION',
  NOT_FOUND: 'NOT_FOUND',
  EVENT_NOT_FOUND: 'EVENT_NOT_FOUND',
  TEAM_NOT_FOUND: 'TEAM_NOT_FOUND',
  TEAM_DELETED: 'TEAM_DELETED',
  TEAM_NOT_DELETED: 'TEAM_NOT_DELETED',
  OWN_TEAM_ALREADY_EXISTS: 'OWN_TEAM_ALREADY_EXISTS',
  OWN_TEAM_HAS_LAP_RECORDS: 'OWN_TEAM_HAS_LAP_RECORDS',
  TEAM_HAS_COMPETITOR_PASSES: 'TEAM_HAS_COMPETITOR_PASSES',
  DELETION_IMPACT_CHANGED: 'DELETION_IMPACT_CHANGED',
  INVALID_RACE_TRANSITION: 'INVALID_RACE_TRANSITION',
  RACE_NOT_STARTED: 'RACE_NOT_STARTED',
  RACE_NOT_ACCEPTING_LAPS: 'RACE_NOT_ACCEPTING_LAPS',
  OWN_TEAM_NOT_FOUND: 'OWN_TEAM_NOT_FOUND',
  OWN_TEAM_NOT_ALLOWED: 'OWN_TEAM_NOT_ALLOWED',
  RECORD_NOT_FOUND: 'RECORD_NOT_FOUND',
  LAP_DELETED: 'LAP_DELETED',
  VEHICLE_DATA_EXISTS: 'VEHICLE_DATA_EXISTS',
  DUPLICATE_PASS: 'DUPLICATE_PASS',
  TIMELINE_CONFLICT: 'TIMELINE_CONFLICT',
  NOTHING_TO_UNDO: 'NOTHING_TO_UNDO',
  UNDO_STALE: 'UNDO_STALE',
  UNDO_CONFLICT: 'UNDO_CONFLICT',
  INTERNAL: 'INTERNAL'
} as const
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

export interface AppErrorPayload {
  code: ErrorCode
  message: string
  /** 入力検証エラーの場合、項目名 → メッセージ */
  fields?: Record<string, string>
}

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly fields?: Record<string, string>
  ) {
    super(message)
    this.name = 'AppError'
  }

  toPayload(): AppErrorPayload {
    return this.fields ? { code: this.code, message: this.message, fields: this.fields } : { code: this.code, message: this.message }
  }
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppErrorPayload }
