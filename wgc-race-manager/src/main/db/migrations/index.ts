import { migration001 } from './001_init'

export interface Migration {
  version: number
  name: string
  sql: string
}

/** 番号順・前進のみ。適用済みのマイグレーションは変更しないこと。 */
export const MIGRATIONS: readonly Migration[] = [{ version: 1, name: 'init', sql: migration001 }]
