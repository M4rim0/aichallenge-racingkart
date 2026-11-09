import type { MandatoryStoppage } from '@shared/types/entities'
import type { Db } from '../db/connection'
import { BaseRepository, timestampColumns, type ListOptions, type Now } from './base'

export type MandatoryStoppageInsert = Pick<MandatoryStoppage, 'eventId' | 'startsAt'> &
  Partial<Pick<MandatoryStoppage, 'endsAt'>>

export class MandatoryStoppageRepository extends BaseRepository<
  MandatoryStoppage,
  keyof MandatoryStoppageInsert & string,
  'startsAt' | 'endsAt'
> {
  constructor(db: Db, now: Now) {
    super(db, now, {
      table: 'mandatory_stoppages',
      columns: {
        id: 'id',
        eventId: 'event_id',
        startsAt: 'starts_at',
        endsAt: 'ends_at',
        ...timestampColumns
      },
      insertable: ['eventId', 'startsAt', 'endsAt'],
      updatable: ['startsAt', 'endsAt'],
      orderBy: 'starts_at ASC, id ASC'
    })
  }

  override insert(values: MandatoryStoppageInsert): MandatoryStoppage {
    return super.insert(values as never)
  }

  listByEvent(eventId: number, opts: ListOptions = {}): MandatoryStoppage[] {
    return this.list('event_id = ?', [eventId], opts)
  }
}
