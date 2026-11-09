import type { HistoryAction, OperationHistoryEntry } from '@shared/types/entities'
import type { Db } from '../db/connection'
import { BaseRepository, RepositoryError, type Now } from './base'

export interface OperatorSnapshot {
  id: number | null
  name: string | null
}

export interface HistoryRecordInput {
  eventId: number | null
  operator: OperatorSnapshot
  action: HistoryAction
  targetTable: string
  targetId: number | null
  before: unknown
  after: unknown
  undoOfHistoryId?: number | null
  note?: string | null
}

/**
 * 操作履歴。追記専用。
 * 「データ変更と操作履歴の保存は同一トランザクション」（仕様 §14）を守るため、
 * トランザクション外からの記録は拒否する。
 */
export class OperationHistoryRepository extends BaseRepository<
  OperationHistoryEntry,
  Exclude<keyof OperationHistoryEntry, 'id'> & string,
  never
> {
  constructor(db: Db, now: Now) {
    super(db, now, {
      table: 'operation_history',
      columns: {
        id: 'id',
        eventId: 'event_id',
        operatorId: 'operator_id',
        operatorNameSnapshot: 'operator_name_snapshot',
        operatedAt: 'operated_at',
        action: 'action',
        targetTable: 'target_table',
        targetId: 'target_id',
        beforeJson: 'before_json',
        afterJson: 'after_json',
        undoOfHistoryId: 'undo_of_history_id',
        note: 'note'
      },
      insertable: [],
      updatable: [],
      orderBy: 'id ASC'
    })
  }

  record(input: HistoryRecordInput): OperationHistoryEntry {
    if (!this.db.inTransaction) {
      throw new RepositoryError('operation history must be recorded inside a transaction')
    }
    const info = this.db
      .prepare(
        `INSERT INTO operation_history
         (event_id, operator_id, operator_name_snapshot, operated_at, action, target_table, target_id,
          before_json, after_json, undo_of_history_id, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.eventId,
        input.operator.id,
        input.operator.name,
        this.now(),
        input.action,
        input.targetTable,
        input.targetId,
        input.before === null || input.before === undefined ? null : JSON.stringify(input.before),
        input.after === null || input.after === undefined ? null : JSON.stringify(input.after),
        input.undoOfHistoryId ?? null,
        input.note ?? null
      )
    return this.getById(Number(info.lastInsertRowid))
  }

  override insert(): never {
    throw new RepositoryError('use record() to append operation history')
  }

  listByEvent(eventId: number): OperationHistoryEntry[] {
    return this.list('event_id = ?', [eventId], {})
  }

  listAll(): OperationHistoryEntry[] {
    return this.list('', [], {})
  }
}
