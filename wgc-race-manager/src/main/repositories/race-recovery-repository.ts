import type { RecoveryConfirmation, RecoveryHold } from '@shared/types/entities'
import type { Db } from '../db/connection'

type HoldRow = {
  id: number
  event_id: number
  event_name: string
  event_status: 'RUNNING' | 'PAUSED'
  boot_session_id: string
  crashed_session_id: string | null
  at: number
}

const mapHold = (r: HoldRow): RecoveryHold => ({
  holdId: r.id,
  eventId: r.event_id,
  eventName: r.event_name,
  eventStatus: r.event_status,
  bootSessionId: r.boot_session_id,
  crashedSessionId: r.crashed_session_id,
  createdAt: r.at
})

const PENDING_SQL = `
  SELECT h.id, h.event_id, e.name AS event_name, h.event_status, h.boot_session_id, h.crashed_session_id, h.at
    FROM race_recovery_holds h
    JOIN events e ON e.id = h.event_id
   WHERE h.kind = 'HOLD'
     AND NOT EXISTS (SELECT 1 FROM race_recovery_holds c WHERE c.kind = 'CONFIRM' AND c.hold_id = h.id)`

/** 復旧確認待ち・確認の記録（追記専用、D-072） */
export class RaceRecoveryRepository {
  constructor(private readonly db: Db) {}

  insertHold(h: { eventId: number; eventStatus: 'RUNNING' | 'PAUSED'; bootSessionId: string; crashedSessionId: string | null; at: number; wallAt: number }): RecoveryHold {
    const info = this.db
      .prepare(
        `INSERT INTO race_recovery_holds (event_id, kind, boot_session_id, crashed_session_id, event_status, at, wall_at, created_at)
         VALUES (?, 'HOLD', ?, ?, ?, ?, ?, ?)`
      )
      .run(h.eventId, h.bootSessionId, h.crashedSessionId, h.eventStatus, h.at, h.wallAt, h.at)
    return this.getHold(Number(info.lastInsertRowid))!
  }

  insertConfirm(c: { eventId: number; holdId: number; bootSessionId: string; operatorId: number | null; operatorName: string | null; at: number; wallAt: number }): RecoveryConfirmation {
    const info = this.db
      .prepare(
        `INSERT INTO race_recovery_holds (event_id, kind, hold_id, boot_session_id, operator_id, operator_name_snapshot, at, wall_at, created_at)
         VALUES (?, 'CONFIRM', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(c.eventId, c.holdId, c.bootSessionId, c.operatorId, c.operatorName, c.at, c.wallAt, c.at)
    return {
      confirmId: Number(info.lastInsertRowid),
      holdId: c.holdId,
      eventId: c.eventId,
      operatorId: c.operatorId,
      operatorNameSnapshot: c.operatorName,
      confirmedAt: c.at
    }
  }

  getHold(id: number): RecoveryHold | null {
    const r = this.db.prepare(`SELECT h.id, h.event_id, e.name AS event_name, h.event_status, h.boot_session_id, h.crashed_session_id, h.at
      FROM race_recovery_holds h JOIN events e ON e.id = h.event_id WHERE h.id = ? AND h.kind = 'HOLD'`).get(id) as HoldRow | undefined
    return r ? mapHold(r) : null
  }

  /** 確認待ちの一覧（全大会） */
  listPending(): RecoveryHold[] {
    return (this.db.prepare(`${PENDING_SQL} ORDER BY h.id`).all() as HoldRow[]).map(mapHold)
  }

  /** 大会の確認待ち（なければ null） */
  findPending(eventId: number): RecoveryHold | null {
    const r = this.db.prepare(`${PENDING_SQL} AND h.event_id = ? ORDER BY h.id LIMIT 1`).get(eventId) as HoldRow | undefined
    return r ? mapHold(r) : null
  }

  listConfirmations(eventId: number): RecoveryConfirmation[] {
    return (
      this.db
        .prepare(`SELECT id, hold_id, event_id, operator_id, operator_name_snapshot, at FROM race_recovery_holds WHERE kind = 'CONFIRM' AND event_id = ? ORDER BY id`)
        .all(eventId) as { id: number; hold_id: number; event_id: number; operator_id: number | null; operator_name_snapshot: string | null; at: number }[]
    ).map((r) => ({ confirmId: r.id, holdId: r.hold_id, eventId: r.event_id, operatorId: r.operator_id, operatorNameSnapshot: r.operator_name_snapshot, confirmedAt: r.at }))
  }
}
