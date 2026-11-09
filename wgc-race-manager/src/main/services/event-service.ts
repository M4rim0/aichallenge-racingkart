import type { RaceEvent } from '@shared/types/entities'
import { AppError, ErrorCode } from '@shared/errors'
import {
  validateEventCreate,
  validateEventUpdate,
  validateScheduleOrder,
  type EventCreateInput,
  type EventUpdateInput
} from '@shared/validation/event-team'
import type { Db } from '../db/connection'
import { runAudited } from '../db/unit-of-work'
import type { Repositories } from '../repositories'
import type { OperatorContext } from './operator-context'

/**
 * 大会管理（仕様 §3.1）。
 * - 状態（status）と実際の開始・終了時刻は時計操作（段階4）でのみ変更する。ここでは変更できない。
 * - 終了済み大会も編集できる（仕様 §1.2「過去大会の閲覧・編集」）。
 * - 大会の削除は仕様にないため提供しない。
 */
export class EventService {
  constructor(
    private readonly db: Db,
    private readonly repos: Repositories,
    private readonly operator: OperatorContext
  ) {}

  list(): RaceEvent[] {
    return this.repos.events.listAll()
  }

  get(id: number): RaceEvent {
    const e = this.repos.events.findById(id)
    if (!e) throw new AppError(ErrorCode.EVENT_NOT_FOUND, `大会が見つかりません (id=${id})`)
    return e
  }

  create(input: EventCreateInput): RaceEvent {
    const errors = validateEventCreate(input)
    if (Object.keys(errors).length > 0) throw new AppError(ErrorCode.VALIDATION, '入力内容に誤りがあります', errors)
    return runAudited(this.db, this.repos, { eventId: null, operator: this.operator.get() }, () => {
      const created = this.repos.events.insert({ ...input, status: 'PREPARING' })
      return {
        result: created,
        changes: [{ action: 'CREATE', targetTable: 'events', targetId: created.id, before: null, after: created, eventId: created.id }]
      }
    })
  }

  update(id: number, patch: EventUpdateInput): RaceEvent {
    const errors = validateEventUpdate(patch)
    if (Object.keys(errors).length > 0) throw new AppError(ErrorCode.VALIDATION, '入力内容に誤りがあります', errors)
    const current = this.get(id)
    const orderErrors = validateScheduleOrder(
      patch.scheduledStartAt !== undefined ? patch.scheduledStartAt : current.scheduledStartAt,
      patch.scheduledEndAt !== undefined ? patch.scheduledEndAt : current.scheduledEndAt
    )
    if (Object.keys(orderErrors).length > 0) {
      throw new AppError(ErrorCode.VALIDATION, '入力内容に誤りがあります', orderErrors)
    }
    return runAudited(this.db, this.repos, { eventId: id, operator: this.operator.get() }, () => {
      const { before, after } = this.repos.events.update(id, patch)
      return {
        result: after,
        changes: [{ action: 'UPDATE', targetTable: 'events', targetId: id, before, after }]
      }
    })
  }
}
