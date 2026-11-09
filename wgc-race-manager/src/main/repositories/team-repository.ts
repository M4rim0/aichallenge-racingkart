import type { Team } from '@shared/types/entities'
import type { Db } from '../db/connection'
import { BaseRepository, boolCodec, timestampColumns, type ListOptions, type Now } from './base'

export type TeamInsert = Pick<Team, 'eventId' | 'name'> &
  Partial<Pick<Team, 'bibNumber' | 'color' | 'isOwnTeam'>>

export interface TeamRelatedCounts {
  /** 有効な（論理削除されていない）自チームラップ記録の件数 */
  lapRecords: number
  /** 有効な他チーム通過記録の件数 */
  competitorPasses: number
  /** 有効な車両データの件数（このチームのラップ記録に紐づくもの） */
  vehicleData: number
}

export class TeamRepository extends BaseRepository<
  Team,
  keyof TeamInsert & string,
  'name' | 'bibNumber' | 'color' | 'isOwnTeam'
> {
  constructor(db: Db, now: Now) {
    super(db, now, {
      table: 'teams',
      columns: {
        id: 'id',
        eventId: 'event_id',
        name: 'name',
        bibNumber: 'bib_number',
        color: 'color',
        isOwnTeam: 'is_own_team',
        ...timestampColumns
      },
      insertable: ['eventId', 'name', 'bibNumber', 'color', 'isOwnTeam'],
      updatable: ['name', 'bibNumber', 'color', 'isOwnTeam'],
      codec: { toDb: { isOwnTeam: boolCodec.toDb }, fromDb: { isOwnTeam: boolCodec.fromDb } },
      orderBy: 'id ASC'
    })
  }

  override insert(values: TeamInsert): Team {
    return super.insert(values as never)
  }

  listByEvent(eventId: number, opts: ListOptions = {}): Team[] {
    return this.list('event_id = ?', [eventId], opts)
  }

  /** 削除されていない自チーム（なければ null） */
  findOwnTeam(eventId: number): Team | null {
    return this.list('event_id = ? AND is_own_team = 1', [eventId], {})[0] ?? null
  }

  /** 削除前の確認用：チームに関連する有効な記録の件数（D-007） */
  countRelatedRecords(teamId: number): TeamRelatedCounts {
    const one = (sql: string): number => (this.db.prepare(sql).get(teamId) as { c: number }).c
    return {
      lapRecords: one('SELECT COUNT(*) c FROM lap_records WHERE team_id = ? AND deleted_at IS NULL'),
      competitorPasses: one(
        'SELECT COUNT(*) c FROM competitor_passes WHERE team_id = ? AND deleted_at IS NULL'
      ),
      vehicleData: one(
        `SELECT COUNT(*) c FROM vehicle_data v JOIN lap_records l ON l.id = v.lap_record_id
         WHERE l.team_id = ? AND v.deleted_at IS NULL AND l.deleted_at IS NULL`
      )
    }
  }
}
