import type { Db } from '../db/connection'

export type Now = () => number

/** camelCase のプロパティ名 → snake_case の列名 */
export type ColumnMap<T> = { readonly [K in keyof T & string]: string }

export interface ListOptions {
  /** 論理削除済みの行も含める（既定 false） */
  includeDeleted?: boolean
}

/** 値の変換（DB ⇔ ドメイン）。既定は無変換。 */
export interface Codec<T> {
  toDb?: Partial<{ [K in keyof T]: (v: T[K]) => unknown }>
  fromDb?: Partial<{ [K in keyof T]: (v: unknown) => T[K] }>
}

export class RepositoryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RepositoryError'
  }
}

export class NotFoundError extends RepositoryError {
  constructor(table: string, id: number) {
    super(`${table}#${id} not found`)
    this.name = 'NotFoundError'
  }
}

interface TableDef<T, I extends keyof T, U extends keyof T> {
  table: string
  columns: ColumnMap<T>
  /** INSERT 時に受け付けるプロパティ */
  insertable: readonly I[]
  /** UPDATE で変更を許可するプロパティ */
  updatable: readonly U[]
  codec?: Codec<T>
  /** 一覧の並び順（SQL 断片） */
  orderBy: string
}

/**
 * テーブル共通の Repository 実装。
 * - 物理削除のメソッドは提供しない（DB 側でもトリガーで拒否）
 * - 変更系メソッドは変更前・変更後の行を返し、操作履歴の記録に使えるようにする
 */
export abstract class BaseRepository<
  T extends { id: number },
  I extends keyof T & string,
  U extends keyof T & string
> {
  protected constructor(
    protected readonly db: Db,
    protected readonly now: Now,
    protected readonly def: TableDef<T, I, U>
  ) {}

  get tableName(): string {
    return this.def.table
  }

  /** UPDATE で変更を許可するプロパティ名 */
  get updatableKeys(): readonly string[] {
    return this.def.updatable
  }

  protected selectSql(): string {
    const cols = Object.entries(this.def.columns as Record<string, string>)
      .map(([prop, col]) => (prop === col ? col : `${col} AS "${prop}"`))
      .join(', ')
    return `SELECT ${cols} FROM ${this.def.table}`
  }

  protected mapRow(row: Record<string, unknown> | undefined): T | null {
    if (!row) return null
    const fromDb = this.def.codec?.fromDb as Record<string, (v: unknown) => unknown> | undefined
    if (fromDb) {
      for (const [k, f] of Object.entries(fromDb)) row[k] = f(row[k])
    }
    return row as unknown as T
  }

  protected encode(prop: string, value: unknown): unknown {
    const f = (this.def.codec?.toDb as Record<string, (v: unknown) => unknown> | undefined)?.[prop]
    const v = f ? f(value) : value
    if (typeof v === 'boolean') return v ? 1 : 0
    return v === undefined ? null : v
  }

  protected col(prop: string): string {
    const c = (this.def.columns as Record<string, string>)[prop]
    if (!c) throw new RepositoryError(`Unknown property ${prop} on ${this.def.table}`)
    return c
  }

  findById(id: number, opts: ListOptions = {}): T | null {
    const where = opts.includeDeleted || !this.hasSoftDelete() ? '' : ' AND deleted_at IS NULL'
    const row = this.db.prepare(`${this.selectSql()} WHERE id = ?${where}`).get(id) as
      | Record<string, unknown>
      | undefined
    return this.mapRow(row)
  }

  getById(id: number, opts: ListOptions = {}): T {
    const row = this.findById(id, opts)
    if (!row) throw new NotFoundError(this.def.table, id)
    return row
  }

  protected list(where: string, params: unknown[], opts: ListOptions): T[] {
    const conds = [where]
    if (!opts.includeDeleted && this.hasSoftDelete()) conds.push('deleted_at IS NULL')
    const active = conds.filter(Boolean)
    const whereSql = active.length > 0 ? ` WHERE ${active.join(' AND ')}` : ''
    const sql = `${this.selectSql()}${whereSql} ORDER BY ${this.def.orderBy}`
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(
      (r) => this.mapRow(r) as T
    )
  }

  protected hasSoftDelete(): boolean {
    return 'deletedAt' in (this.def.columns as Record<string, string>)
  }

  protected hasTimestamps(): boolean {
    return 'updatedAt' in (this.def.columns as Record<string, string>)
  }

  /** 行を追加し、追加後の行を返す。 */
  insert(values: Pick<T, I>): T {
    const props: string[] = []
    const params: unknown[] = []
    for (const p of this.def.insertable) {
      if (p in (values as object)) {
        props.push(p)
        params.push(this.encode(p, (values as Record<string, unknown>)[p]))
      }
    }
    const cols = props.map((p) => this.col(p))
    const ts = this.now()
    cols.push('created_at')
    params.push(ts)
    if (this.hasTimestamps()) {
      cols.push('updated_at')
      params.push(ts)
    }
    const sql = `INSERT INTO ${this.def.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
    const info = this.db.prepare(sql).run(...params)
    return this.getById(Number(info.lastInsertRowid), { includeDeleted: true })
  }

  /** 許可された列のみ更新する。変更前・変更後の行を返す。論理削除済みの行は更新できない。 */
  update(id: number, patch: Partial<Pick<T, U>>): { before: T; after: T } {
    const before = this.getById(id)
    const sets: string[] = []
    const params: unknown[] = []
    for (const [p, v] of Object.entries(patch as Record<string, unknown>)) {
      if (v === undefined) continue
      if (!(this.def.updatable as readonly string[]).includes(p)) {
        throw new RepositoryError(`Property ${p} is not updatable on ${this.def.table}`)
      }
      sets.push(`${this.col(p)} = ?`)
      params.push(this.encode(p, v))
    }
    if (sets.length === 0) return { before, after: before }
    if (this.hasTimestamps()) {
      sets.push('updated_at = ?')
      params.push(this.now())
    }
    this.db.prepare(`UPDATE ${this.def.table} SET ${sets.join(', ')} WHERE id = ?`).run(...params, id)
    return { before, after: this.getById(id) }
  }

  /** 論理削除。既に削除済みの場合はエラー。 */
  softDelete(id: number): { before: T; after: T } {
    this.assertSoftDelete()
    const before = this.getById(id)
    const ts = this.now()
    this.db
      .prepare(`UPDATE ${this.def.table} SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
      .run(ts, ts, id)
    return { before, after: this.getById(id, { includeDeleted: true }) }
  }

  /** 論理削除の取り消し（復元）。削除されていない場合はエラー。 */
  restore(id: number): { before: T; after: T } {
    this.assertSoftDelete()
    const before = this.getById(id, { includeDeleted: true })
    if ((before as unknown as { deletedAt: number | null }).deletedAt === null) {
      throw new RepositoryError(`${this.def.table}#${id} is not deleted`)
    }
    this.db
      .prepare(`UPDATE ${this.def.table} SET deleted_at = NULL, updated_at = ? WHERE id = ?`)
      .run(this.now(), id)
    return { before, after: this.getById(id) }
  }

  private assertSoftDelete(): void {
    if (!this.hasSoftDelete()) {
      throw new RepositoryError(`${this.def.table} does not support deletion`)
    }
  }
}

/** 共通カラム */
export const timestampColumns = {
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  deletedAt: 'deleted_at'
} as const

export const boolCodec = {
  toDb: (v: unknown) => (v ? 1 : 0),
  fromDb: (v: unknown) => v === 1
}
