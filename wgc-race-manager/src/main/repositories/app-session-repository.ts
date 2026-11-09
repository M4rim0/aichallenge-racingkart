import type { AppSession } from '@shared/types/entities'
import type { Db } from '../db/connection'

type Row = {
  id: string
  started_wall_at: number
  latest_saved_at_before: number | null
  clock_anomaly: number
  anomaly_detail: string | null
  app_version: string | null
  created_at: number
}

const map = (r: Row): AppSession => ({
  id: r.id,
  startedWallAt: r.started_wall_at,
  latestSavedAtBefore: r.latest_saved_at_before,
  clockAnomaly: r.clock_anomaly === 1,
  anomalyDetail: r.anomaly_detail,
  appVersion: r.app_version,
  createdAt: r.created_at
})

/** 起動セッション（追記専用） */
export class AppSessionRepository {
  constructor(private readonly db: Db) {}

  insert(s: Omit<AppSession, 'createdAt'>): AppSession {
    this.db
      .prepare(
        `INSERT INTO app_sessions (id, started_wall_at, latest_saved_at_before, clock_anomaly, anomaly_detail, app_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        s.id,
        s.startedWallAt,
        s.latestSavedAtBefore,
        s.clockAnomaly ? 1 : 0,
        s.anomalyDetail,
        s.appVersion,
        s.startedWallAt
      )
    return this.get(s.id)!
  }

  get(id: string): AppSession | null {
    const r = this.db.prepare('SELECT * FROM app_sessions WHERE id = ?').get(id) as Row | undefined
    return r ? map(r) : null
  }

  listAll(): AppSession[] {
    return (this.db.prepare('SELECT * FROM app_sessions ORDER BY rowid ASC').all() as Row[]).map(map)
  }

  /** 時刻異常が記録された起動セッション */
  listAnomalous(): AppSession[] {
    return (
      this.db.prepare('SELECT * FROM app_sessions WHERE clock_anomaly = 1 ORDER BY rowid ASC').all() as Row[]
    ).map(map)
  }

  /**
   * DB に保存されている最新の日時（全テーブルの日時列の最大値）。
   * 起動時の PC 時刻異常の検出に使う（D-013）。
   */
  latestSavedAt(): number | null {
    const parts = [
      'SELECT MAX(created_at), MAX(updated_at), MAX(deleted_at), MAX(actual_start_at), MAX(actual_end_at) FROM events',
      'SELECT MAX(created_at), MAX(updated_at), MAX(deleted_at), NULL, NULL FROM teams',
      'SELECT MAX(created_at), MAX(updated_at), MAX(deleted_at), MAX(passed_at), MAX(passed_wall_at) FROM lap_records',
      'SELECT MAX(created_at), MAX(updated_at), MAX(deleted_at), MAX(passed_at), MAX(passed_wall_at) FROM competitor_passes',
      'SELECT MAX(created_at), MAX(updated_at), MAX(deleted_at), NULL, NULL FROM vehicle_data',
      'SELECT MAX(created_at), MAX(updated_at), MAX(deleted_at), NULL, NULL FROM operators',
      'SELECT MAX(created_at), MAX(updated_at), MAX(deleted_at), MAX(noted_at), NULL FROM memos',
      'SELECT MAX(operated_at), NULL, NULL, NULL, NULL FROM operation_history',
      'SELECT MAX(created_at), MAX(at), MAX(wall_at), NULL, NULL FROM race_clock_transitions',
      'SELECT MAX(created_at), MAX(updated_at), MAX(deleted_at), NULL, NULL FROM mandatory_stoppages',
      'SELECT MAX(started_wall_at), NULL, NULL, NULL, NULL FROM app_sessions',
      "SELECT MAX(at), MAX(wall_at), NULL, NULL, NULL FROM app_lifecycle_events",
      "SELECT MAX(at), MAX(wall_at), NULL, NULL, NULL FROM race_recovery_holds"
    ]
    const rows = parts.map((sql) => Object.values(this.db.prepare(sql).raw(false).get() as object))
    let max: number | null = null
    for (const row of rows) for (const v of row) if (typeof v === 'number' && (max === null || v > max)) max = v
    return max
  }
}
