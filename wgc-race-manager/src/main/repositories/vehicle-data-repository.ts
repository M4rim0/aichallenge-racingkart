import type { VehicleData } from '@shared/types/entities'
import type { Db } from '../db/connection'
import { BaseRepository, timestampColumns, type ListOptions, type Now } from './base'

type Field = 'speed' | 'voltage' | 'current' | 'integratedValue'
export type VehicleDataInsert = Pick<VehicleData, 'lapRecordId'> & Partial<Pick<VehicleData, Field>>

/**
 * 入力文字列をそのまま保存する（D-006）。
 * 空文字・空白のみの入力は「未入力」として null にする。それ以外は前後の空白も含めて変更しない。
 */
export function normalizeVehicleInput(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null
  return v.trim() === '' ? null : v
}

const textCodec = (v: unknown): unknown => normalizeVehicleInput(v as string | null | undefined)

export class VehicleDataRepository extends BaseRepository<
  VehicleData,
  keyof VehicleDataInsert & string,
  Field
> {
  constructor(db: Db, now: Now) {
    super(db, now, {
      table: 'vehicle_data',
      columns: {
        id: 'id',
        lapRecordId: 'lap_record_id',
        speed: 'speed',
        voltage: 'voltage',
        current: 'current',
        integratedValue: 'integrated_value',
        ...timestampColumns
      },
      insertable: ['lapRecordId', 'speed', 'voltage', 'current', 'integratedValue'],
      updatable: ['speed', 'voltage', 'current', 'integratedValue'],
      codec: {
        toDb: { speed: textCodec, voltage: textCodec, current: textCodec, integratedValue: textCodec }
      },
      orderBy: 'id ASC'
    })
  }

  override insert(values: VehicleDataInsert): VehicleData {
    return super.insert(values as never)
  }

  /** null を明示的に渡すと「未入力に戻す」更新になる（update は undefined のみ無視する） */
  override update(
    id: number,
    patch: Partial<Pick<VehicleData, Field>>
  ): { before: VehicleData; after: VehicleData } {
    return super.update(id, patch)
  }

  findByLapRecord(lapRecordId: number): VehicleData | null {
    return this.list('lap_record_id = ?', [lapRecordId], {})[0] ?? null
  }

  /** 大会内の車両データ（ラップ記録の通過日時順） */
  listByEvent(eventId: number, opts: ListOptions = {}): VehicleData[] {
    const del = opts.includeDeleted ? '' : 'AND v.deleted_at IS NULL'
    const cols = this.selectSql().replace(/^SELECT /, '').replace(/ FROM vehicle_data$/, '')
    const prefixed = cols
      .split(', ')
      .map((c) => `v.${c}`)
      .join(', ')
    const sql = `SELECT ${prefixed} FROM vehicle_data v JOIN lap_records l ON l.id = v.lap_record_id
      WHERE l.event_id = ? ${del} ORDER BY l.passed_at ASC, l.id ASC`
    return (this.db.prepare(sql).all(eventId) as Record<string, unknown>[]).map(
      (r) => this.mapRow(r) as VehicleData
    )
  }
}
