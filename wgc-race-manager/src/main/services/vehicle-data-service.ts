import type { LapRecord, VehicleData, VehicleDataFields, VehicleDataRow } from '@shared/types/entities'
import { AppError, ErrorCode } from '@shared/errors'
import { deriveLaps } from '@shared/race/laps'
import { isPlainObject } from '@shared/validation/common'
import type { Db } from '../db/connection'
import { runAudited } from '../db/unit-of-work'
import type { Repositories } from '../repositories'
import type { OperatorContext } from './operator-context'

const FIELDS = ['speed', 'voltage', 'current', 'integratedValue'] as const

/**
 * 車両データ（仕様 §6、決定 D-006, D-025〜D-029）。
 *
 * - 自チームのラップ記録にのみ紐づく（vehicle_data は lap_records だけを参照する。D-029）
 * - 1 ラップにつき有効な 1 セット。ラップ登録とは独立して入力・修正できる
 * - 4 項目とも入力文字列のまま保存。空欄は未入力（null）で、0 にはしない。4 項目すべて空欄でも行は残す（D-027）
 * - 削除済みラップへの登録・修正・削除は拒否（D-026）。ラップを削除しても車両データは保持し、復元すれば再び参照できる（D-025）
 * - SOC・航続距離・エネルギー消費の計算は行わない。積算値の意味・単位は推測しない
 */
export class VehicleDataService {
  constructor(
    private readonly db: Db,
    private readonly repos: Repositories,
    private readonly operator: OperatorContext
  ) {}

  /** 有効な自チームラップごとの車両データ一覧（削除済みラップは含めない） */
  listByEvent(eventId: number): VehicleDataRow[] {
    const event = this.repos.events.findById(eventId)
    if (!event) throw new AppError(ErrorCode.EVENT_NOT_FOUND, `大会が見つかりません (id=${eventId})`)
    const laps = this.repos.lapRecords.listByEvent(eventId)
    return deriveLaps(laps, event.actualStartAt).map((d) => ({
      lapRecordId: d.record.id,
      lapNumber: d.lapNumber,
      passedAt: d.record.passedAt,
      vehicleData: this.repos.vehicleData.findByLapRecord(d.record.id)
    }))
  }

  create(lapRecordId: number, fields: Partial<VehicleDataFields>): VehicleData {
    const input = validateFields(fields)
    const lap = this.requireActiveLap(lapRecordId)
    return runAudited(this.db, this.repos, this.ctx(lap.eventId), () => {
      if (this.repos.vehicleData.findByLapRecord(lapRecordId)) {
        throw new AppError(ErrorCode.VEHICLE_DATA_EXISTS, 'このラップには既に車両データがあります。修正を使用してください')
      }
      const created = this.repos.vehicleData.insert({ lapRecordId, ...input })
      return {
        result: created,
        changes: [{ action: 'CREATE', targetTable: 'vehicle_data', targetId: created.id, before: null, after: created }]
      }
    })
  }

  /** 修正。指定した項目のみ変更する（null / 空欄を指定すると未入力に戻す）。履歴には変更前後の全項目を記録する（D-028） */
  update(vehicleDataId: number, fields: Partial<VehicleDataFields>): VehicleData {
    const patch = validateFields(fields)
    const current = this.requireVehicleData(vehicleDataId)
    const lap = this.requireActiveLap(current.lapRecordId)
    return runAudited(this.db, this.repos, this.ctx(lap.eventId), () => {
      const { before, after } = this.repos.vehicleData.update(vehicleDataId, patch)
      return { result: after, changes: [{ action: 'UPDATE', targetTable: 'vehicle_data', targetId: vehicleDataId, before, after }] }
    })
  }

  /** 車両データ自体の削除（論理削除）。全項目を空欄にする操作とは別（D-027） */
  delete(vehicleDataId: number): void {
    const current = this.requireVehicleData(vehicleDataId)
    const lap = this.requireActiveLap(current.lapRecordId)
    runAudited(this.db, this.repos, this.ctx(lap.eventId), () => {
      const { before, after } = this.repos.vehicleData.softDelete(vehicleDataId)
      return { result: null, changes: [{ action: 'DELETE', targetTable: 'vehicle_data', targetId: vehicleDataId, before, after }] }
    })
  }

  private ctx(eventId: number) {
    return { eventId, operator: this.operator.get() }
  }

  private requireVehicleData(id: number): VehicleData {
    const v = this.repos.vehicleData.findById(id)
    if (!v) throw new AppError(ErrorCode.RECORD_NOT_FOUND, `車両データが見つかりません (id=${id})`)
    return v
  }

  private requireActiveLap(lapRecordId: number): LapRecord {
    const lap = this.repos.lapRecords.findById(lapRecordId, { includeDeleted: true })
    if (!lap) throw new AppError(ErrorCode.RECORD_NOT_FOUND, `ラップ記録が見つかりません (id=${lapRecordId})`)
    if (lap.deletedAt !== null) {
      throw new AppError(ErrorCode.LAP_DELETED, '削除済みのラップには車両データを登録・修正できません。先にラップを復元してください')
    }
    return lap
  }
}

/** 入力の形式確認のみ（値の内容は検証・変換しない） */
function validateFields(fields: unknown): Partial<VehicleDataFields> {
  if (!isPlainObject(fields)) throw new AppError(ErrorCode.VALIDATION, '入力が不正です')
  const errors: Record<string, string> = {}
  const out: Partial<VehicleDataFields> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (!(FIELDS as readonly string[]).includes(k)) {
      errors[k] = '指定できない項目です'
    } else if (v !== null && v !== undefined && typeof v !== 'string') {
      errors[k] = '文字列で入力してください'
    } else if (v !== undefined) {
      out[k as (typeof FIELDS)[number]] = v as string | null
    }
  }
  if (Object.keys(errors).length > 0) throw new AppError(ErrorCode.VALIDATION, '入力内容に誤りがあります', errors)
  return out
}
