import type { PassRecord } from '@shared/types/entities'
import type { Db } from '../db/connection'
import { BaseRepository, timestampColumns, type ListOptions, type Now } from './base'

export type PassRecordInsert = Pick<PassRecord, 'eventId' | 'teamId' | 'passedAt'> &
  Partial<Pick<PassRecord, 'passedWallAt' | 'bootSessionId'>>

/**
 * 通過日時を持つ記録（lap_records / competitor_passes）の共通 Repository。
 * 周回番号・ラップタイムは保存しない（D-005）。並び順は通過日時→ID。
 */
class PassRecordRepository extends BaseRepository<
  PassRecord,
  keyof PassRecordInsert & string,
  'passedAt'
> {
  constructor(db: Db, now: Now, table: 'lap_records' | 'competitor_passes') {
    super(db, now, {
      table,
      columns: {
        id: 'id',
        eventId: 'event_id',
        teamId: 'team_id',
        passedAt: 'passed_at',
        passedWallAt: 'passed_wall_at',
        bootSessionId: 'boot_session_id',
        ...timestampColumns
      },
      insertable: ['eventId', 'teamId', 'passedAt', 'passedWallAt', 'bootSessionId'],
      updatable: ['passedAt'],
      orderBy: 'passed_at ASC, id ASC'
    })
  }

  override insert(values: PassRecordInsert): PassRecord {
    return super.insert(values as never)
  }

  listByTeam(teamId: number, opts: ListOptions = {}): PassRecord[] {
    return this.list('team_id = ?', [teamId], opts)
  }

  listByEvent(eventId: number, opts: ListOptions = {}): PassRecord[] {
    return this.list('event_id = ?', [eventId], opts)
  }
}

export class LapRecordRepository extends PassRecordRepository {
  constructor(db: Db, now: Now) {
    super(db, now, 'lap_records')
  }
}

export class CompetitorPassRepository extends PassRecordRepository {
  constructor(db: Db, now: Now) {
    super(db, now, 'competitor_passes')
  }
}
