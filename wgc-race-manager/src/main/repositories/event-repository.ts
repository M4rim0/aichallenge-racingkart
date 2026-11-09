import type { RaceEvent } from '@shared/types/entities'
import type { Db } from '../db/connection'
import { BaseRepository, timestampColumns, type ListOptions, type Now } from './base'

export type EventInsert = Pick<RaceEvent, 'name'> &
  Partial<
    Pick<
      RaceEvent,
      'heldOn' | 'courseName' | 'lapDistanceM' | 'scheduledStartAt' | 'scheduledEndAt' | 'status'
    >
  >

type Updatable =
  | 'name'
  | 'heldOn'
  | 'courseName'
  | 'lapDistanceM'
  | 'scheduledStartAt'
  | 'scheduledEndAt'
  | 'actualStartAt'
  | 'actualEndAt'
  | 'status'

export class EventRepository extends BaseRepository<RaceEvent, keyof EventInsert & string, Updatable> {
  constructor(db: Db, now: Now) {
    super(db, now, {
      table: 'events',
      columns: {
        id: 'id',
        name: 'name',
        heldOn: 'held_on',
        courseName: 'course_name',
        lapDistanceM: 'lap_distance_m',
        scheduledStartAt: 'scheduled_start_at',
        scheduledEndAt: 'scheduled_end_at',
        actualStartAt: 'actual_start_at',
        actualEndAt: 'actual_end_at',
        status: 'status',
        ...timestampColumns
      },
      insertable: [
        'name',
        'heldOn',
        'courseName',
        'lapDistanceM',
        'scheduledStartAt',
        'scheduledEndAt',
        'status'
      ],
      updatable: [
        'name',
        'heldOn',
        'courseName',
        'lapDistanceM',
        'scheduledStartAt',
        'scheduledEndAt',
        'actualStartAt',
        'actualEndAt',
        'status'
      ],
      orderBy: 'id DESC'
    })
  }

  listAll(opts: ListOptions = {}): RaceEvent[] {
    return this.list('', [], opts)
  }

  override insert(values: EventInsert): RaceEvent {
    return super.insert(values as never)
  }
}
