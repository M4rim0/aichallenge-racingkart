import type { Operator } from '@shared/types/entities'
import { AppError, ErrorCode } from '@shared/errors'
import type { Db } from '../db/connection'
import { runAudited } from '../db/unit-of-work'
import type { Repositories } from '../repositories'
import type { OperatorContext } from './operator-context'

/**
 * 操作者管理（仕様 §10、決定 D-030〜D-035）。
 * - 全大会共通。名前のみ
 * - 名前の修正・論理削除が可能。削除済みは選択候補から除外
 * - 登録・編集・削除は操作履歴に記録する（大会に属さないため event_id は NULL）。UNDO の対象外
 */
export class OperatorService {
  constructor(
    private readonly db: Db,
    private readonly repos: Repositories,
    private readonly context: OperatorContext
  ) {}

  /** 選択候補（削除済みを除く）。includeDeleted で全件 */
  list(opts: { includeDeleted?: boolean } = {}): Operator[] {
    return this.repos.operators.listAll(opts)
  }

  create(name: unknown): Operator {
    const n = validateName(name)
    return runAudited(this.db, this.repos, { eventId: null, operator: this.context.get() }, () => {
      const created = this.repos.operators.insert({ name: n })
      return { result: created, changes: [{ action: 'CREATE', targetTable: 'operators', targetId: created.id, before: null, after: created }] }
    })
  }

  rename(id: number, name: unknown): Operator {
    const n = validateName(name)
    this.require(id)
    return runAudited(this.db, this.repos, { eventId: null, operator: this.context.get() }, () => {
      const { before, after } = this.repos.operators.update(id, { name: n })
      return { result: after, changes: [{ action: 'UPDATE', targetTable: 'operators', targetId: id, before, after }] }
    })
  }

  delete(id: number): void {
    this.require(id)
    runAudited(this.db, this.repos, { eventId: null, operator: this.context.get() }, () => {
      const { before, after } = this.repos.operators.softDelete(id)
      return { result: null, changes: [{ action: 'DELETE', targetTable: 'operators', targetId: id, before, after }] }
    })
    // 削除した操作者が選択中なら未選択に戻す
    if (this.context.getSelectedId() === id) this.context.select(null)
  }

  /** 操作者の切り替え（null で未選択）。計測は止めない。切り替え自体は履歴に残さない（D-034） */
  select(id: number | null): Operator | null {
    if (id === null) {
      this.context.select(null)
      return null
    }
    const op = this.require(id)
    this.context.select(op.id)
    return op
  }

  /** 現在選択中の操作者（未選択なら null） */
  current(): Operator | null {
    const id = this.context.getSelectedId()
    return id === null ? null : this.repos.operators.findById(id)
  }

  private require(id: number): Operator {
    const op = this.repos.operators.findById(id)
    if (!op) throw new AppError(ErrorCode.OPERATOR_NOT_FOUND, `操作者が見つかりません（削除済みの可能性があります） (id=${id})`)
    return op
  }
}

function validateName(name: unknown): string {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new AppError(ErrorCode.VALIDATION, '操作者名を入力してください', { name: '必須項目です' })
  }
  return name
}
