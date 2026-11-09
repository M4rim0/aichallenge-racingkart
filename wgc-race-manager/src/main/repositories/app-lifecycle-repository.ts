import type { AppLifecycleEvent, LifecycleKind, PreviousShutdownStatus } from '@shared/types/entities'
import type { Db } from '../db/connection'

type Row = {
  id: number
  boot_session_id: string
  kind: LifecycleKind
  at: number
  wall_at: number
  mono_ms: number | null
  drift_ms: number | null
  anomaly: number
  detail: string | null
  created_at: number
}

const map = (r: Row): AppLifecycleEvent => ({
  id: r.id,
  bootSessionId: r.boot_session_id,
  kind: r.kind,
  at: r.at,
  wallAt: r.wall_at,
  monoMs: r.mono_ms,
  driftMs: r.drift_ms,
  anomaly: r.anomaly === 1,
  detail: r.detail,
  createdAt: r.created_at
})

export interface LifecycleInsert {
  bootSessionId: string
  kind: LifecycleKind
  at: number
  wallAt: number
  monoMs?: number | null
  driftMs?: number | null
  anomaly?: boolean
  detail?: string | null
}

/** 起動・正常終了・スリープ／復帰の記録（追記専用、操作履歴とは別。D-066） */
export class AppLifecycleRepository {
  constructor(private readonly db: Db) {}

  insert(e: LifecycleInsert): AppLifecycleEvent {
    const info = this.db
      .prepare(
        `INSERT INTO app_lifecycle_events (boot_session_id, kind, at, wall_at, mono_ms, drift_ms, anomaly, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(e.bootSessionId, e.kind, e.at, e.wallAt, e.monoMs ?? null, e.driftMs ?? null, e.anomaly ? 1 : 0, e.detail ?? null, e.at)
    return map(this.db.prepare('SELECT * FROM app_lifecycle_events WHERE id = ?').get(Number(info.lastInsertRowid)) as Row)
  }

  listBySession(bootSessionId: string): AppLifecycleEvent[] {
    return (this.db.prepare('SELECT * FROM app_lifecycle_events WHERE boot_session_id = ? ORDER BY id').all(bootSessionId) as Row[]).map(map)
  }

  /** 復帰時の時刻異常（anomaly = 1 の RESUME）。boot セッション指定なしなら全件 */
  listResumeAnomalies(bootSessionId?: string): AppLifecycleEvent[] {
    const sql = `SELECT * FROM app_lifecycle_events WHERE kind = 'RESUME' AND anomaly = 1${bootSessionId ? ' AND boot_session_id = ?' : ''} ORDER BY id`
    const rows = (bootSessionId ? this.db.prepare(sql).all(bootSessionId) : this.db.prepare(sql).all()) as Row[]
    return rows.map(map)
  }

  /**
   * 現在の起動より前で、BOOT の記録がある最も新しい起動の終了状態（D-066）。
   * BOOT の記録がない起動（このテーブルができる前の起動）は判定しない（誤って異常終了と判定しないため）。
   */
  previousShutdownStatus(currentBootSessionId: string): PreviousShutdownStatus | null {
    const row = this.db
      .prepare(
        `SELECT s.id AS id, s.started_wall_at AS started
           FROM app_sessions s
          WHERE s.id <> ?
            AND s.rowid < (SELECT rowid FROM app_sessions WHERE id = ?)
            AND EXISTS (SELECT 1 FROM app_lifecycle_events e WHERE e.boot_session_id = s.id AND e.kind = 'BOOT')
          ORDER BY s.rowid DESC
          LIMIT 1`
      )
      .get(currentBootSessionId, currentBootSessionId) as { id: string; started: number } | undefined
    if (!row) return null
    const clean =
      this.db
        .prepare(`SELECT 1 FROM app_lifecycle_events WHERE boot_session_id = ? AND kind = 'CLEAN_SHUTDOWN' LIMIT 1`)
        .get(row.id) !== undefined
    return { bootSessionId: row.id, startedWallAt: row.started, clean }
  }
}
