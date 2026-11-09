import type { PreviousShutdownStatus, RecoveryConfirmation, RecoveryHold } from '@shared/types/entities'
import { AppError, ErrorCode } from '@shared/errors'
import type { Db } from '../db/connection'
import { runAudited } from '../db/unit-of-work'
import type { Repositories } from '../repositories'
import type { MasterClock } from '../clock/master-clock'
import type { OperatorContext } from './operator-context'

/**
 * レースに影響する操作の前に呼ぶ確認（D-071）。復旧確認待ちの大会なら拒否する。
 * サービス層で使うため、IPC 以外の経路からも迂回できない。
 */
export interface RecoveryGuard {
  assertNotPending(eventId: number): void
}

export const noRecoveryGuard: RecoveryGuard = { assertNotPending: () => undefined }

/**
 * 異常終了後の復旧確認待ち（決定 D-070〜D-072）。
 *
 * - 異常終了後の起動時に、進行中（RUNNING / PAUSED）だった大会ごとに確認待ちを作る（正常終了後の起動では作らない）
 * - 大会の状態・時計の操作記録には触れない：時計は実際の経過時間に合わせて進み続け、PAUSED は PAUSED のまま
 * - 確認は時計の再開操作ではない。確認待ちを解除するだけ
 * - 確認待ち・確認は追記専用テーブルに記録し、操作履歴にも追記する（UNDO の対象外）
 */
export class RecoveryService implements RecoveryGuard {
  constructor(
    private readonly db: Db,
    private readonly repos: Repositories,
    private readonly clock: MasterClock,
    private readonly operator: OperatorContext
  ) {}

  /**
   * 起動時に呼ぶ。前回が異常終了なら、進行中の大会を確認待ちにする。
   * 既に確認待ちの大会（確認前に再び異常終了した場合）は重複して作らない。作成した確認待ちを返す。
   */
  holdAfterUncleanShutdown(previous: PreviousShutdownStatus | null): RecoveryHold[] {
    if (!previous || previous.clean) return []
    const inProgress = this.repos.events
      .listAll()
      .filter((e) => e.status === 'RUNNING' || e.status === 'PAUSED')
      .sort((a, b) => a.id - b.id)
    const created: RecoveryHold[] = []
    for (const e of inProgress) {
      if (this.repos.recovery.findPending(e.id)) continue
      const hold = runAudited(this.db, this.repos, { eventId: e.id, operator: { id: null, name: null } }, () => {
        const h = this.repos.recovery.insertHold({
          eventId: e.id,
          eventStatus: e.status as 'RUNNING' | 'PAUSED',
          bootSessionId: this.clock.bootSessionId,
          crashedSessionId: previous.bootSessionId,
          at: this.clock.now(),
          wallAt: this.clock.wallNow()
        })
        return {
          result: h,
          changes: [{ action: 'CREATE', targetTable: 'race_recovery_holds', targetId: h.holdId, before: null, after: h, note: 'recovery hold (system, unclean shutdown)' }]
        }
      })
      created.push(hold)
    }
    return created
  }

  listPending(): RecoveryHold[] {
    return this.repos.recovery.listPending()
  }

  findPending(eventId: number): RecoveryHold | null {
    return this.repos.recovery.findPending(eventId)
  }

  assertNotPending(eventId: number): void {
    const h = this.repos.recovery.findPending(eventId)
    if (h) {
      throw new AppError(
        ErrorCode.RECOVERY_CONFIRMATION_REQUIRED,
        `大会「${h.eventName}」は異常終了後の復旧確認待ちです。復旧を確認するまで、レースに影響する操作は受け付けません`
      )
    }
  }

  /**
   * 復旧を確認する（時計の再開ではない）。holdId は画面で確認した確認待ちの ID。
   * 操作者名のスナップショット付きで記録し、操作履歴にも追記する。
   */
  confirm(eventId: number, holdId: number): RecoveryConfirmation {
    return runAudited<RecoveryConfirmation, unknown>(this.db, this.repos, { eventId, operator: this.operator.get() }, () => {
      const pending = this.repos.recovery.findPending(eventId)
      if (!pending || pending.holdId !== holdId) {
        throw new AppError(ErrorCode.RECOVERY_HOLD_NOT_FOUND, 'この復旧確認待ちは見つからないか、既に確認されています')
      }
      const op = this.operator.get()
      const c = this.repos.recovery.insertConfirm({
        eventId,
        holdId,
        bootSessionId: this.clock.bootSessionId,
        operatorId: op.id,
        operatorName: op.name,
        at: this.clock.now(),
        wallAt: this.clock.wallNow()
      })
      return {
        result: c,
        changes: [{ action: 'CREATE', targetTable: 'race_recovery_holds', targetId: c.confirmId, before: pending, after: c, note: 'recovery confirmed' }]
      }
    })
  }
}
