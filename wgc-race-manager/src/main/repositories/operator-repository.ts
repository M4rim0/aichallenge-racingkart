import type { Operator } from '@shared/types/entities'
import type { Db } from '../db/connection'
import { BaseRepository, timestampColumns, type ListOptions, type Now } from './base'

export class OperatorRepository extends BaseRepository<Operator, 'name', 'name'> {
  constructor(db: Db, now: Now) {
    super(db, now, {
      table: 'operators',
      columns: { id: 'id', name: 'name', ...timestampColumns },
      insertable: ['name'],
      updatable: ['name'],
      orderBy: 'id ASC'
    })
  }

  listAll(opts: ListOptions = {}): Operator[] {
    return this.list('', [], opts)
  }
}
