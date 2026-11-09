import type { RaceClockTransition } from '@shared/types/entities'
import type { Db } from '../db/connection'
import { BaseRepository, type Now } from './base'

export type RaceClockTransitionInsert = Pick<
  RaceClockTransition,
  'eventId' | 'kind' | 'at' | 'wallAt' | 'monoMs' | 'bootSessionId'
>

/** 時計の状態遷移。追記専用（更新・削除は DB 側で拒否）。 */
export class RaceClockTransitionRepository extends BaseRepository<
  RaceClockTransition,
  keyof RaceClockTransitionInsert & string,
  never
> {
  constructor(db: Db, now: Now) {
    super(db, now, {
      table: 'race_clock_transitions',
      columns: {
        id: 'id',
        eventId: 'event_id',
        kind: 'kind',
        at: 'at',
        wallAt: 'wall_at',
        monoMs: 'mono_ms',
        bootSessionId: 'boot_session_id',
        createdAt: 'created_at'
      },
      insertable: ['eventId', 'kind', 'at', 'wallAt', 'monoMs', 'bootSessionId'],
      updatable: [],
      orderBy: 'id ASC'
    })
  }

  listByEvent(eventId: number): RaceClockTransition[] {
    return this.list('event_id = ?', [eventId], {})
  }
}
