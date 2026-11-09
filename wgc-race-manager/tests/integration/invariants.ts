import { expect } from 'vitest'
import type { AppContext } from '../../src/main/app-context'
import type { WarningList } from '../../src/shared/warnings/types'
import type { Db } from '../../src/main/db/connection'

/** 追記専用テーブルの「これまでの行」が書き換えられていないことを確認するための記録 */
export class AppendOnlyWatcher {
  private readonly seen = new Map<string, string[]>()
  constructor(private readonly tables: string[]) {}

  check(db: Db, label: string): void {
    for (const t of this.tables) {
      const rows = (db.prepare(`SELECT * FROM ${t} ORDER BY id`).all() as object[]).map((r) => JSON.stringify(r))
      const prev = this.seen.get(t) ?? []
      expect(rows.length, `${label}: ${t} の行が減った`).toBeGreaterThanOrEqual(prev.length)
      // 1 行ずつ expect を呼ぶと行数に比例して遅くなるため、違いが見つかった行だけ expect で報告する（確認内容は同じ）
      for (let i = 0; i < prev.length; i++) {
        if (rows[i] !== prev[i]) expect(rows[i], `${label}: ${t} の既存行（${i + 1} 行目）が書き換えられた`).toBe(prev[i])
      }
      this.seen.set(t, rows)
    }
  }
}

/** NaN / Infinity を探す（見つかったパスを返す） */
export function findNonFinite(v: unknown, path = '$'): string | null {
  if (typeof v === 'number') return Number.isFinite(v) ? null : path
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const p = findNonFinite(v[i], `${path}[${i}]`)
      if (p) return p
    }
    return null
  }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      const p = findNonFinite(x, `${path}.${k}`)
      if (p) return p
    }
  }
  return null
}

export interface InvariantOptions {
  /** integrity_check / foreign_key_check を行う（既定 true） */
  integrity?: boolean
  /** 警告判定も行う（状態を持つため、呼び出し側の方針で切り替え） */
  warnings?: boolean
}

/**
 * 段階13の必須不変条件（ユーザー指定の 10 項目のうち、CSV 以外）。各操作の後に呼ぶ。
 */
export function checkInvariants(ctx: AppContext, eventId: number, label: string, opts: InvariantOptions = {}): { warnings: WarningList | null } {
  const db = ctx.db
  const one = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[]

  // 1. 有効な通過記録には、それを追加した操作履歴（CREATE）がある
  // （operation_history の target 列には索引がないため、SQL の NOT EXISTS だと記録数 × 履歴数の走査になる。
  //   履歴を 1 回だけ読んで照合する。確認内容は同じ）
  const created = new Set(
    one<{ k: string }>(`SELECT target_table || ':' || target_id AS k FROM operation_history WHERE action = 'CREATE' AND target_id IS NOT NULL`).map((x) => x.k)
  )
  for (const table of ['lap_records', 'competitor_passes'] as const) {
    const orphans = one<{ id: number }>(`SELECT id FROM ${table} WHERE event_id = ? AND deleted_at IS NULL`, eventId)
      .filter((r) => !created.has(`${table}:${r.id}`))
      .map((r) => ({ id: r.id }))
    expect(orphans, `${label}: 操作履歴のない有効な ${table}`).toEqual([])
  }

  // 2. UNDO は存在する元の操作（UNDO 以外、同じ対象）を参照し、同じ操作を二重に取り消していない
  const badUndo = one<{ id: number }>(
    `SELECT u.id FROM operation_history u LEFT JOIN operation_history o ON o.id = u.undo_of_history_id
      WHERE u.action = 'UNDO' AND (o.id IS NULL OR o.action = 'UNDO' OR o.target_table <> u.target_table OR o.target_id IS NOT u.target_id)`
  )
  expect(badUndo, `${label}: 不正な UNDO 参照`).toEqual([])
  const doubleUndo = one<{ undo_of_history_id: number }>(
    `SELECT undo_of_history_id FROM operation_history WHERE action = 'UNDO' GROUP BY undo_of_history_id HAVING COUNT(*) > 1`
  )
  expect(doubleUndo, `${label}: 二重に取り消された操作`).toEqual([])

  // 3. 同一チーム内で有効な通過日時が重複しない（別チーム間は許容するので確認しない）
  for (const table of ['lap_records', 'competitor_passes'] as const) {
    const dup = one<{ team_id: number }>(
      `SELECT team_id, passed_at FROM ${table} WHERE event_id = ? AND deleted_at IS NULL GROUP BY team_id, passed_at HAVING COUNT(*) > 1`,
      eventId
    )
    expect(dup, `${label}: 同一チーム内の重複した通過日時（${table}）`).toEqual([])
  }

  // 4. 通過記録の時系列・周回数・順位の整合
  const standings = ctx.standings.get(eventId)
  for (const row of standings.rows) {
    const table = row.isOwnTeam ? 'lap_records' : 'competitor_passes'
    const recs = one<{ passed_at: number }>(`SELECT passed_at FROM ${table} WHERE team_id = ? AND deleted_at IS NULL ORDER BY passed_at, id`, row.teamId)
    expect(row.laps, `${label}: 周回数と記録件数（team ${row.teamId}）`).toBe(recs.length)
    expect(row.lastPassAt, `${label}: 最終通過（team ${row.teamId}）`).toBe(recs.at(-1)?.passed_at ?? null)
  }
  for (let i = 1; i < standings.rows.length; i++) {
    const a = standings.rows[i - 1]!
    const b = standings.rows[i]!
    const ordered = a.laps > b.laps || (a.laps === b.laps && (a.lastPassAt === null || b.lastPassAt === null || a.lastPassAt <= b.lastPassAt))
    expect(ordered, `${label}: 順位の並び（${a.teamName} → ${b.teamName}）`).toBe(true)
  }

  // 5・6. 戦略計算に NaN / Infinity がなく、予測最終周回数が現在の周回数を下回らない
  const report = ctx.strategy.get(eventId)
  expect(findNonFinite(report), `${label}: 戦略計算の NaN/Infinity`).toBeNull()
  for (const t of report.teams) {
    for (const s of ['avg3', 'avg5', 'avg10'] as const) {
      const f = t.scenarios[s].predictedFinalLaps
      if (f !== null) expect(f, `${label}: 予測最終周回数 < 現在周回数（${t.name} ${s}）`).toBeGreaterThanOrEqual(t.current.laps)
    }
  }
  let warnings: WarningList | null = null
  if (opts.warnings !== false) {
    warnings = ctx.warnings.evaluate(eventId)
    expect(findNonFinite(warnings), `${label}: 警告判定の NaN/Infinity`).toBeNull()
  }

  // 7. DB の整合性
  if (opts.integrity !== false) {
    expect(db.pragma('integrity_check', { simple: true }), `${label}: integrity_check`).toBe('ok')
    expect(db.pragma('foreign_key_check'), `${label}: foreign_key_check`).toEqual([])
  }
  return { warnings }
}
