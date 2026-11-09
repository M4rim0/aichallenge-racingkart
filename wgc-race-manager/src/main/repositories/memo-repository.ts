import type { Memo } from '@shared/types/entities'
import type { Db } from '../db/connection'
import { BaseRepository, timestampColumns, type ListOptions, type Now } from './base'

export type MemoInsert = Pick<Memo, 'eventId' | 'body' | 'notedAt'>

export class MemoRepository extends BaseRepository<Memo, keyof MemoInsert & string, 'body'> {
  constructor(db: Db, now: Now) {
    super(db, now, {
      table: 'memos',
      columns: {
        id: 'id',
        eventId: 'event_id',
        body: 'body',
        notedAt: 'noted_at',
        ...timestampColumns
      },
      insertable: ['eventId', 'body', 'notedAt'],
      updatable: ['body'], // 日時は作成後に変更しない（D-036）
      orderBy: 'noted_at ASC, id ASC'
    })
  }

  listByEvent(eventId: number, opts: ListOptions = {}): Memo[] {
    return this.list('event_id = ?', [eventId], opts)
  }
}
