import type { HistoryAction, OperationHistoryEntry, PassRecord, Team } from '@shared/types/entities'
import { AppError, ErrorCode } from '@shared/errors'
import type { Db } from '../db/connection'
import { runAudited, type AuditedChange } from '../db/unit-of-work'
import type { Repositories } from '../repositories'
import type { BaseRepository } from '../repositories/base'
import type { OperatorContext } from './operator-context'
import { assertAfterStart, assertKeepsOrder, assertNoDuplicate } from './pass-record-rules'

/**
 * UNDO（直前操作の取り消し、決定 D-017）。
 *
 * - 単位：1 回の操作（operation_group）。大会内で最も新しい、未取り消しの対象操作を取り消す。複数段階可
 * - 対象：自チームラップ・他チーム通過・車両データ・メモ・チーム。時計の状態遷移・大会情報は対象外
 * - REDO なし：UNDO 自体は取り消せない（UNDO の操作は飛ばして、その前の操作が次の対象になる）
 * - 整合性確認：対象行の現在値が、その操作の直後の値（after）と完全に一致する場合のみ戻す。
 *   後続の変更がある場合や、戻すと規則（重複・順序・自チーム一意など）に反する場合は取り消さない
 * - 取り消しは UNDO として操作履歴に記録する（undo_of_history_id で元の操作を参照）
 * - 古い操作を飛ばして取り消すことはしない（最新の対象操作が取り消せない場合はエラー）
 */

export const UNDOABLE_TABLES = ['lap_records', 'competitor_passes', 'vehicle_data', 'memos', 'teams'] as const
type UndoableTable = (typeof UNDOABLE_TABLES)[number]

export interface UndoCandidate {
  /** 取り消す操作の ID（undo に渡す） */
  operationGroup: string
  description: string
  operatedAt: number
  operatorName: string | null
  historyIds: number[]
}

const TABLE_LABEL: Record<UndoableTable, string> = {
  lap_records: '自チームラップ記録',
  competitor_passes: '他チーム通過記録',
  vehicle_data: '車両データ',
  memos: 'メモ',
  teams: 'チーム'
}
const ACTION_LABEL: Record<HistoryAction, string> = { CREATE: '追加', UPDATE: '編集', DELETE: '削除', UNDO: '取り消し' }

type Row = Record<string, unknown> & { id: number; deletedAt?: number | null }

export class UndoService {
  constructor(
    private readonly db: Db,
    private readonly repos: Repositories,
    private readonly operator: OperatorContext
  ) {}

  /** 次に取り消される操作（なければ null） */
  peek(eventId: number): UndoCandidate | null {
    const g = this.findCandidate(eventId)
    return g ? describe(g) : null
  }

  /**
   * 取り消しを実行する。
   * @param expectedGroup peek で確認した operationGroup。確認後に別の操作が行われていた場合は取り消さない
   */
  undo(eventId: number, expectedGroup: string): UndoCandidate {
    return runAudited(this.db, this.repos, { eventId, operator: this.operator.get() }, () => {
      const group = this.findCandidate(eventId)
      if (!group) throw new AppError(ErrorCode.NOTHING_TO_UNDO, '取り消せる操作がありません')
      if (groupKey(group[0]!) !== expectedGroup) {
        throw new AppError(ErrorCode.UNDO_STALE, '確認後に操作が追加されました。取り消す内容を再確認してください')
      }
      const changes: AuditedChange<unknown>[] = []
      // 同一操作内は新しい順に戻す
      for (const entry of [...group].sort((a, b) => b.id - a.id)) {
        changes.push(this.revert(entry))
      }
      return { result: describe(group), changes }
    })
  }

  private findCandidate(eventId: number): OperationHistoryEntry[] | null {
    const groups = new Map<string, OperationHistoryEntry[]>()
    for (const h of this.repos.history.listByEventDesc(eventId)) {
      const k = groupKey(h)
      const list = groups.get(k)
      if (list) list.push(h)
      else groups.set(k, [h])
    }
    for (const entries of groups.values()) {
      if (entries.some((e) => e.action === 'UNDO')) continue // UNDO は取り消さない（REDO なし）
      if (!entries.every((e) => (UNDOABLE_TABLES as readonly string[]).includes(e.targetTable))) continue // 時計・大会情報など対象外
      if (entries.some((e) => this.repos.history.isUndone(e.id))) continue // 取り消し済み
      return entries
    }
    return null
  }

  private revert(entry: OperationHistoryEntry): AuditedChange<unknown> {
    const table = entry.targetTable as UndoableTable
    const repo = this.repoOf(table)
    const id = entry.targetId
    if (id === null) throw conflict('対象の記録を特定できません')
    const current = repo.findById(id, { includeDeleted: true }) as Row | null
    const after = entry.afterJson ? (JSON.parse(entry.afterJson) as Row) : null
    if (!current || !after) throw conflict(`${TABLE_LABEL[table]}（id=${id}）が見つかりません`)
    if (!sameSnapshot(current, after)) {
      throw conflict(`${TABLE_LABEL[table]}（id=${id}）はこの操作の後に変更されているため、取り消せません`)
    }
    const before = entry.beforeJson ? (JSON.parse(entry.beforeJson) as Row) : null

    let result: { after: unknown }
    try {
      if (entry.action === 'CREATE') {
        this.checkCreateUndo(table, current)
        result = repo.softDelete(id)
      } else if (entry.action === 'DELETE' || (before && before.deletedAt === null && after.deletedAt != null)) {
        this.checkTargetState(table, { ...current, deletedAt: null }, 'restore')
        result = repo.restore(id)
      } else if (before && before.deletedAt != null && after.deletedAt == null) {
        // 復元の取り消し → 再び論理削除
        result = repo.softDelete(id)
      } else if (entry.action === 'UPDATE' && before) {
        const patch: Record<string, unknown> = {}
        for (const k of repo.updatableKeys) if (before[k] !== after[k]) patch[k] = before[k]
        this.checkTargetState(table, { ...current, ...patch }, 'update', current)
        result = repo.update(id, patch as never)
      } else {
        throw conflict('この操作は取り消せません')
      }
    } catch (e) {
      if (e instanceof AppError && e.code === ErrorCode.UNDO_CONFLICT) throw e
      const reason = e instanceof Error ? e.message : String(e)
      throw conflict(`取り消すと記録の整合性が崩れるため、取り消せません（${reason}）`)
    }
    return {
      action: 'UNDO',
      targetTable: table,
      targetId: id,
      before: current,
      after: result.after,
      undoOfHistoryId: entry.id,
      note: `undo ${entry.action}`
    }
  }

  /** 追加の取り消し（= 論理削除）の可否 */
  private checkCreateUndo(table: UndoableTable, current: Row): void {
    if (table === 'teams') {
      // 有効な記録のみ数える。後続の記録追加を先に UNDO（論理削除）すれば、チームの追加も取り消せる（D-024）
      const n = (t: string): number =>
        (this.db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE team_id = ? AND deleted_at IS NULL`).get(current.id) as { c: number }).c
      if (n('lap_records') + n('competitor_passes') > 0) {
        throw conflict('このチームには有効な記録があるため、追加を取り消せません（記録を先に取り消すか、チームの削除を使用してください）')
      }
    }
    if (table === 'lap_records' && this.repos.vehicleData.findByLapRecord(current.id)) {
      throw conflict('このラップには車両データが登録されているため、追加を取り消せません')
    }
  }

  /** 戻した後の状態が規則に反しないか（有効な行になる場合のみ） */
  private checkTargetState(table: UndoableTable, target: Row, mode: 'restore' | 'update', current?: Row): void {
    if (target.deletedAt != null) return
    if (table === 'lap_records' || table === 'competitor_passes') {
      const rec = target as unknown as PassRecord
      const repo = table === 'lap_records' ? this.repos.lapRecords : this.repos.competitorPasses
      const sameTeam = repo.listByTeam(rec.teamId)
      assertAfterStart(rec.passedAt, this.repos.events.getById(rec.eventId).actualStartAt)
      assertNoDuplicate(rec.passedAt, sameTeam, rec.id)
      if (mode === 'update') assertKeepsOrder(rec.id, rec.passedAt, sameTeam)
    }
    if (table === 'teams') {
      const team = target as unknown as Team
      if (team.isOwnTeam) {
        const own = this.repos.teams.findOwnTeam(team.eventId)
        if (own && own.id !== team.id) throw conflict(`自チーム（${own.name}）が既に存在します`)
      }
      if (mode === 'update' && current && current['isOwnTeam'] !== team.isOwnTeam) {
        const n = (t: string): number =>
          (this.db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE team_id = ?`).get(team.id) as { c: number }).c
        if (team.isOwnTeam && n('competitor_passes') > 0) throw conflict('他チーム通過記録があるため自チームに戻せません')
        if (!team.isOwnTeam && n('lap_records') > 0) throw conflict('自チームのラップ記録があるため自チーム判定を外せません')
      }
    }
    if (table === 'vehicle_data') {
      const lapId = target['lapRecordId'] as number
      if (!this.repos.lapRecords.findById(lapId)) {
        throw conflict('紐づくラップが削除されているため、車両データを戻せません（先にラップを復元してください）')
      }
      const other = this.repos.vehicleData.findByLapRecord(lapId)
      if (other && other.id !== target.id) throw conflict('このラップには別の車両データが登録されています')
    }
  }

  private repoOf(table: UndoableTable): BaseRepository<{ id: number }, never, never> {
    const map = {
      lap_records: this.repos.lapRecords,
      competitor_passes: this.repos.competitorPasses,
      vehicle_data: this.repos.vehicleData,
      memos: this.repos.memos,
      teams: this.repos.teams
    }
    return map[table] as unknown as BaseRepository<{ id: number }, never, never>
  }
}

function groupKey(h: OperationHistoryEntry): string {
  return h.operationGroup ?? `history:${h.id}`
}

function describe(group: OperationHistoryEntry[]): UndoCandidate {
  const first = [...group].sort((a, b) => a.id - b.id)[0]!
  const label = group
    .map((e) => `${TABLE_LABEL[e.targetTable as UndoableTable] ?? e.targetTable}の${e.note === 'restore' ? '復元' : ACTION_LABEL[e.action]}（id=${e.targetId}）`)
    .join('、')
  return {
    operationGroup: groupKey(first),
    description: label,
    operatedAt: first.operatedAt,
    operatorName: first.operatorNameSnapshot,
    historyIds: group.map((e) => e.id).sort((a, b) => a - b)
  }
}

/**
 * 現在の行が、操作直後の状態と同じか。
 * - updatedAt は記録上の管理値のため比較しない（後続操作の UNDO で値が戻っても updatedAt は変わるため）
 * - deletedAt は「削除済みか否か」のみ比較する（削除→復元→再削除で日時が変わるため）
 * それ以外のすべての列（通過日時・名前・自チーム判定・入力値など）は完全一致を要求する。
 */
function sameSnapshot(current: Row, after: Row): boolean {
  const keys = new Set([...Object.keys(current), ...Object.keys(after)])
  for (const k of keys) {
    if (k === 'updatedAt') continue
    if (k === 'deletedAt') {
      if ((current[k] == null) !== (after[k] == null)) return false
      continue
    }
    if ((current[k] ?? null) !== (after[k] ?? null)) return false
  }
  return true
}

function conflict(message: string): AppError {
  return new AppError(ErrorCode.UNDO_CONFLICT, message)
}
