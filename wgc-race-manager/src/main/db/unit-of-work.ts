import { randomUUID } from 'node:crypto'
import type { HistoryAction } from '@shared/types/entities'
import type { Db } from './connection'
import type { Repositories } from '../repositories'
import type { OperatorSnapshot } from '../repositories/operation-history-repository'

export interface AuditContext {
  eventId: number | null
  operator: OperatorSnapshot
}

export interface AuditedChange<T> {
  action: HistoryAction
  targetTable: string
  targetId: number | null
  before: T | null
  after: T | null
  undoOfHistoryId?: number | null
  note?: string | null
  /** 履歴に記録する大会 ID（省略時は AuditContext の eventId）。大会の作成時など、ID が操作中に決まる場合に使う */
  eventId?: number | null
}

/**
 * データ変更と操作履歴の保存を 1 つのトランザクションで実行する（仕様 §14）。
 * fn が返した変更内容を履歴に記録する。fn または履歴記録のどちらかが失敗すると全体がロールバックされる。
 * BEGIN IMMEDIATE を使い、書き込みロックを先に確保する。
 * 1 回の呼び出しで記録される履歴行には同じ operation_group を付け、UNDO の単位とする（D-017）。
 */
export function runAudited<R, T>(
  db: Db,
  repos: Repositories,
  ctx: AuditContext,
  fn: () => { result: R; changes: AuditedChange<T>[] }
): R {
  return db
    .transaction(() => {
      const { result, changes } = fn()
      const operationGroup = randomUUID()
      for (const c of changes) {
        repos.history.record({
          eventId: c.eventId !== undefined ? c.eventId : ctx.eventId,
          operator: ctx.operator,
          action: c.action,
          targetTable: c.targetTable,
          targetId: c.targetId,
          before: c.before,
          after: c.after,
          undoOfHistoryId: c.undoOfHistoryId ?? null,
          note: c.note ?? null,
          operationGroup
        })
      }
      return result
    })
    .immediate()
}
