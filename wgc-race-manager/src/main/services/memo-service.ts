import type { Memo } from '@shared/types/entities'
import { AppError, ErrorCode } from '@shared/errors'
import type { Db } from '../db/connection'
import { runAudited } from '../db/unit-of-work'
import type { Repositories } from '../repositories'
import type { MasterClock } from '../clock/master-clock'
import type { OperatorContext } from './operator-context'

/**
 * メモ（仕様 §9、決定 D-036〜D-038）。
 * - 自由記述のみ。定型イベントボタン・ピット管理は実装しない
 * - 日時は作成時のマスタークロックで自動保存し、後から変更できない。本文は修正できる
 * - 本文は入力のまま保存（改行・カンマ等を含めて変更しない）。空欄・空白のみは拒否
 * - 大会の状態に関係なく（終了後も）記録できる
 */
export class MemoService {
  constructor(
    private readonly db: Db,
    private readonly repos: Repositories,
    private readonly clock: MasterClock,
    private readonly operator: OperatorContext
  ) {}

  list(eventId: number): Memo[] {
    this.requireEvent(eventId)
    return this.repos.memos.listByEvent(eventId)
  }

  create(eventId: number, body: unknown): Memo {
    const b = validateBody(body)
    this.requireEvent(eventId)
    return runAudited(this.db, this.repos, { eventId, operator: this.operator.get() }, () => {
      const created = this.repos.memos.insert({ eventId, body: b, notedAt: this.clock.now() })
      return { result: created, changes: [{ action: 'CREATE', targetTable: 'memos', targetId: created.id, before: null, after: created }] }
    })
  }

  /** 本文の修正。日時は変更しない */
  updateBody(id: number, body: unknown): Memo {
    const b = validateBody(body)
    const memo = this.require(id)
    return runAudited(this.db, this.repos, { eventId: memo.eventId, operator: this.operator.get() }, () => {
      const { before, after } = this.repos.memos.update(id, { body: b })
      return { result: after, changes: [{ action: 'UPDATE', targetTable: 'memos', targetId: id, before, after }] }
    })
  }

  delete(id: number): void {
    const memo = this.require(id)
    runAudited(this.db, this.repos, { eventId: memo.eventId, operator: this.operator.get() }, () => {
      const { before, after } = this.repos.memos.softDelete(id)
      return { result: null, changes: [{ action: 'DELETE', targetTable: 'memos', targetId: id, before, after }] }
    })
  }

  private require(id: number): Memo {
    const m = this.repos.memos.findById(id)
    if (!m) throw new AppError(ErrorCode.RECORD_NOT_FOUND, `メモが見つかりません (id=${id})`)
    return m
  }

  private requireEvent(eventId: number): void {
    if (!this.repos.events.findById(eventId)) {
      throw new AppError(ErrorCode.EVENT_NOT_FOUND, `大会が見つかりません (id=${eventId})`)
    }
  }
}

function validateBody(body: unknown): string {
  if (typeof body !== 'string' || body.trim() === '') {
    throw new AppError(ErrorCode.VALIDATION, 'メモの本文を入力してください', { body: '空欄または空白のみのメモは登録できません' })
  }
  return body
}
