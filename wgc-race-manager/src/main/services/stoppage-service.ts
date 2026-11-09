import type { MandatoryStoppage } from '@shared/types/entities'
import { AppError, ErrorCode } from '@shared/errors'
import type { Db } from '../db/connection'
import { runAudited } from '../db/unit-of-work'
import type { Repositories } from '../repositories'
import type { OperatorContext } from './operator-context'
import { noRecoveryGuard, type RecoveryGuard } from './recovery-service'

/**
 * 強制停止時間（仕様 §4.5、決定 D-044）。
 * - 開始・終了日時を登録できる。終了未定（null）でも登録可能。複数登録可能
 * - 登録・修正・削除は大会終了後も可能。修正・削除は UNDO の対象
 * - 重複する区間はそのまま保存し、計算時に結合して二重計上しない（strategy/stoppages.ts）
 * - アプリの PAUSE とは別概念（D-002）。レース時計は止めない
 */
export class StoppageService {
  constructor(
    private readonly db: Db,
    private readonly repos: Repositories,
    private readonly operator: OperatorContext,
    private readonly guard: RecoveryGuard = noRecoveryGuard
  ) {}

  list(eventId: number): MandatoryStoppage[] {
    this.requireEvent(eventId)
    return this.repos.stoppages.listByEvent(eventId)
  }

  create(eventId: number, startsAt: unknown, endsAt: unknown): MandatoryStoppage {
    const { s, e } = validate(startsAt, endsAt)
    this.requireEvent(eventId)
    this.guard.assertNotPending(eventId) // 復旧確認待ち（D-071）
    return runAudited(this.db, this.repos, { eventId, operator: this.operator.get() }, () => {
      const created = this.repos.stoppages.insert({ eventId, startsAt: s, endsAt: e })
      return { result: created, changes: [{ action: 'CREATE', targetTable: 'mandatory_stoppages', targetId: created.id, before: null, after: created }] }
    })
  }

  /** 開始・終了日時の修正（終了未定の停止に、後から終了日時を入れる場合など） */
  update(id: number, startsAt: unknown, endsAt: unknown): MandatoryStoppage {
    const { s, e } = validate(startsAt, endsAt)
    const current = this.require(id)
    this.guard.assertNotPending(current.eventId)
    return runAudited(this.db, this.repos, { eventId: current.eventId, operator: this.operator.get() }, () => {
      const { before, after } = this.repos.stoppages.update(id, { startsAt: s, endsAt: e })
      return { result: after, changes: [{ action: 'UPDATE', targetTable: 'mandatory_stoppages', targetId: id, before, after }] }
    })
  }

  delete(id: number): void {
    const current = this.require(id)
    this.guard.assertNotPending(current.eventId)
    runAudited(this.db, this.repos, { eventId: current.eventId, operator: this.operator.get() }, () => {
      const { before, after } = this.repos.stoppages.softDelete(id)
      return { result: null, changes: [{ action: 'DELETE', targetTable: 'mandatory_stoppages', targetId: id, before, after }] }
    })
  }

  private require(id: number): MandatoryStoppage {
    const s = this.repos.stoppages.findById(id)
    if (!s) throw new AppError(ErrorCode.RECORD_NOT_FOUND, `強制停止時間が見つかりません (id=${id})`)
    return s
  }

  private requireEvent(eventId: number): void {
    if (!this.repos.events.findById(eventId)) {
      throw new AppError(ErrorCode.EVENT_NOT_FOUND, `大会が見つかりません (id=${eventId})`)
    }
  }
}

function validate(startsAt: unknown, endsAt: unknown): { s: number; e: number | null } {
  const isMs = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
  if (!isMs(startsAt)) throw new AppError(ErrorCode.VALIDATION, '開始日時が不正です', { startsAt: '開始日時が不正です' })
  if (endsAt !== null && !isMs(endsAt)) throw new AppError(ErrorCode.VALIDATION, '終了日時が不正です', { endsAt: '終了日時が不正です' })
  if (endsAt !== null && endsAt <= startsAt) {
    throw new AppError(ErrorCode.VALIDATION, '終了日時は開始日時より後にしてください', { endsAt: '終了日時は開始日時より後にしてください' })
  }
  return { s: startsAt, e: endsAt }
}
