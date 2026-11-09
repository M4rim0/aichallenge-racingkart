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
}

/**
 * データ変更と操作履歴の保存を 1 つのトランザクションで実行する（仕様 §14）。
 * fn が返した変更内容を履歴に記録する。fn または履歴記録のどちらかが失敗すると全体がロールバックされる。
 * BEGIN IMMEDIATE を使い、書き込みロックを先に確保する。
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
      for (const c of changes) {
        repos.history.record({
          eventId: ctx.eventId,
          operator: ctx.operator,
          action: c.action,
          targetTable: c.targetTable,
          targetId: c.targetId,
          before: c.before,
          after: c.after,
          undoOfHistoryId: c.undoOfHistoryId ?? null,
          note: c.note ?? null
        })
      }
      return result
    })
    .immediate()
}
