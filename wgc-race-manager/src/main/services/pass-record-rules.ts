import type { PassRecord } from '@shared/types/entities'
import { AppError, ErrorCode } from '@shared/errors'
import { formatJst } from '@shared/time/jst'

/**
 * 通過記録（自チームラップ・他チーム通過）の日時の整合性規則（D-018）。
 * 過去記録の追加・修正、および UNDO による復元で共通に使う。
 */

function fail(message: string, code: ErrorCode = ErrorCode.VALIDATION): never {
  throw new AppError(code, message, { passedAt: message })
}

export function assertValidEpoch(passedAt: unknown): asserts passedAt is number {
  if (typeof passedAt !== 'number' || !Number.isSafeInteger(passedAt) || passedAt < 0) fail('日時が不正です')
}

/** 実際の開始時刻より後であること（同時刻は初回ラップタイム 0 になるため拒否） */
export function assertAfterStart(passedAt: number, actualStartAt: number | null): void {
  if (actualStartAt === null) fail('レースが開始されていません', ErrorCode.RACE_NOT_STARTED)
  if (passedAt <= actualStartAt) fail(`通過日時は実際の開始時刻（${formatJst(actualStartAt)}）より後にしてください`)
}

/** 現在（マスタークロック）より未来でないこと */
export function assertNotFuture(passedAt: number, now: number): void {
  if (passedAt > now) fail('通過日時を現在より後にはできません')
}

/** 同じチームの有効な記録に同一日時がないこと（異なるチームは許可） */
export function assertNoDuplicate(passedAt: number, sameTeamActive: readonly PassRecord[], exceptId: number | null): void {
  const dup = sameTeamActive.find((r) => r.passedAt === passedAt && r.id !== exceptId)
  if (dup) fail(`同じチームに同一日時（${formatJst(passedAt)}）の記録があります`, ErrorCode.DUPLICATE_PASS)
}

/**
 * 修正で時系列（周回の順序）が入れ替わらないこと。
 * 修正後の日時は、同じチームの直前の記録より後、直後の記録より前でなければならない。
 * 順序を変えたい場合は、削除と追加で行う。
 */
export function assertKeepsOrder(recordId: number, newPassedAt: number, sameTeamActive: readonly PassRecord[]): void {
  const sorted = [...sameTeamActive].sort((a, b) => a.passedAt - b.passedAt || a.id - b.id)
  const idx = sorted.findIndex((r) => r.id === recordId)
  if (idx < 0) return
  const prev = sorted[idx - 1]
  const next = sorted[idx + 1]
  if (prev && newPassedAt <= prev.passedAt) {
    fail(`修正後の日時が直前の記録（${formatJst(prev.passedAt)}）以前になり、周回の順序が変わります`, ErrorCode.TIMELINE_CONFLICT)
  }
  if (next && newPassedAt >= next.passedAt) {
    fail(`修正後の日時が直後の記録（${formatJst(next.passedAt)}）以降になり、周回の順序が変わります`, ErrorCode.TIMELINE_CONFLICT)
  }
}
