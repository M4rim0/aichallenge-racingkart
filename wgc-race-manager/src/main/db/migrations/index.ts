import { migration001 } from './001_init'
import { migration002 } from './002_app_sessions'
import { migration003 } from './003_operation_group'
import { migration004 } from './004_app_lifecycle_events'
import { migration005 } from './005_race_recovery_holds'

export interface Migration {
  version: number
  name: string
  sql: string
}

/** 番号順・前進のみ。適用済みのマイグレーションは変更しないこと。 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'init', sql: migration001 },
  { version: 2, name: 'app_sessions', sql: migration002 },
  { version: 3, name: 'operation_group', sql: migration003 },
  { version: 4, name: 'app_lifecycle_events', sql: migration004 },
  { version: 5, name: 'race_recovery_holds', sql: migration005 }
]
