import type { LapView, PassRecord, RaceEvent, Team } from '@shared/types/entities'
import { AppError, ErrorCode } from '@shared/errors'
import { deriveLaps } from '@shared/race/laps'
import type { Db } from '../db/connection'
import { runAudited } from '../db/unit-of-work'
import type { Repositories } from '../repositories'
import type { MasterClock } from '../clock/master-clock'
import type { OperatorContext } from './operator-context'
import { assertAfterStart, assertKeepsOrder, assertNoDuplicate, assertNotFuture, assertValidEpoch } from './pass-record-rules'

/**
 * 自チームのラップ記録（仕様 §5、決定 D-005, D-009, D-011, D-016, D-018）。
 *
 * - LAP REGISTER：RUNNING / PAUSED のみ。マスタークロックの日時で記録する。削除済みの自チームには登録しない（D-008）
 * - 過去記録の追加・修正・削除：開始後であればいつでも（END 後も）可能。削除済みの自チームでも可能（D-009）
 * - 周回番号・ラップタイムは通過日時から算出する（初回は実際の開始時刻が基準）
 */
export class LapService {
  constructor(
    private readonly db: Db,
    private readonly repos: Repositories,
    private readonly clock: MasterClock,
    private readonly operator: OperatorContext
  ) {}

  /** 算出済みのラップ一覧（有効な記録のみ、周回番号順） */
  list(eventId: number): LapView[] {
    const event = this.requireEvent(eventId)
    const own = this.resolveOwnTeam(eventId, { allowDeleted: true, required: false })
    if (!own) return []
    return toViews(this.repos.lapRecords.listByTeam(own.id), event.actualStartAt)
  }

  /** LAP REGISTER（その場での登録） */
  register(eventId: number): LapView {
    const id = runAudited(this.db, this.repos, this.ctx(eventId), () => {
      const event = this.requireEvent(eventId)
      if (event.status !== 'RUNNING' && event.status !== 'PAUSED') {
        throw new AppError(
          ErrorCode.RACE_NOT_ACCEPTING_LAPS,
          event.status === 'PREPARING'
            ? 'START 前はラップを登録できません'
            : 'レース終了後はラップを登録できません。過去記録の追加を使用してください'
        )
      }
      const own = this.resolveOwnTeam(eventId, { allowDeleted: false, required: true })!
      const stamp = this.clock.stamp()
      // 同一ミリ秒の二重登録（ラップタイム 0）を防ぐ。時系列の前後は問わず記録を優先する
      assertNoDuplicate(stamp.at, this.repos.lapRecords.listByTeam(own.id), null)
      const created = this.repos.lapRecords.insert({
        eventId,
        teamId: own.id,
        passedAt: stamp.at,
        passedWallAt: stamp.wallAt,
        bootSessionId: stamp.bootSessionId
      })
      return {
        result: created.id,
        changes: [{ action: 'CREATE', targetTable: 'lap_records', targetId: created.id, before: null, after: created, note: 'LAP REGISTER' }]
      }
    })
    return this.viewOf(eventId, id)
  }

  /** 過去記録の追加 */
  addPast(eventId: number, passedAt: number): LapView {
    assertValidEpoch(passedAt)
    const id = runAudited(this.db, this.repos, this.ctx(eventId), () => {
      const event = this.requireEvent(eventId)
      const own = this.resolveOwnTeam(eventId, { allowDeleted: true, required: true })!
      assertAfterStart(passedAt, event.actualStartAt)
      assertNotFuture(passedAt, this.clock.now())
      assertNoDuplicate(passedAt, this.repos.lapRecords.listByTeam(own.id), null)
      const stamp = this.clock.stamp()
      const created = this.repos.lapRecords.insert({
        eventId,
        teamId: own.id,
        passedAt,
        passedWallAt: null, // 手入力のため、通過時点の PC 実日時は存在しない
        bootSessionId: stamp.bootSessionId
      })
      return {
        result: created.id,
        changes: [{ action: 'CREATE', targetTable: 'lap_records', targetId: created.id, before: null, after: created, note: 'add past record' }]
      }
    })
    return this.viewOf(eventId, id)
  }

  /** 通過日時の修正。周回の順序が入れ替わる修正は拒否する（D-018） */
  updatePassedAt(recordId: number, passedAt: number): LapView {
    assertValidEpoch(passedAt)
    const rec = this.requireRecord(recordId)
    runAudited(this.db, this.repos, this.ctx(rec.eventId), () => {
      const event = this.requireEvent(rec.eventId)
      const sameTeam = this.repos.lapRecords.listByTeam(rec.teamId)
      assertAfterStart(passedAt, event.actualStartAt)
      assertNotFuture(passedAt, this.clock.now())
      assertNoDuplicate(passedAt, sameTeam, recordId)
      assertKeepsOrder(recordId, passedAt, sameTeam)
      const { before, after } = this.repos.lapRecords.update(recordId, { passedAt })
      return { result: null, changes: [{ action: 'UPDATE', targetTable: 'lap_records', targetId: recordId, before, after }] }
    })
    return this.viewOf(rec.eventId, recordId)
  }

  /** 記録の削除（論理削除）。後続の周回番号・ラップタイムは算出時に再構成される */
  delete(recordId: number): void {
    const rec = this.requireRecord(recordId)
    runAudited(this.db, this.repos, this.ctx(rec.eventId), () => {
      const { before, after } = this.repos.lapRecords.softDelete(recordId)
      return { result: null, changes: [{ action: 'DELETE', targetTable: 'lap_records', targetId: recordId, before, after }] }
    })
  }

  private viewOf(eventId: number, recordId: number): LapView {
    const v = this.list(eventId).find((x) => x.recordId === recordId)
    if (!v) throw new AppError(ErrorCode.INTERNAL, 'ラップ記録の取得に失敗しました')
    return v
  }

  private ctx(eventId: number) {
    return { eventId, operator: this.operator.get() }
  }

  private requireEvent(eventId: number): RaceEvent {
    const e = this.repos.events.findById(eventId)
    if (!e) throw new AppError(ErrorCode.EVENT_NOT_FOUND, `大会が見つかりません (id=${eventId})`)
    return e
  }

  private requireRecord(id: number): PassRecord {
    const r = this.repos.lapRecords.findById(id)
    if (!r) throw new AppError(ErrorCode.RECORD_NOT_FOUND, `ラップ記録が見つかりません (id=${id})`)
    return r
  }

  /**
   * 自チームの特定。有効な自チームを優先し、allowDeleted の場合は削除済みの自チーム（1 つに限る）も対象にする。
   */
  private resolveOwnTeam(eventId: number, opts: { allowDeleted: boolean; required: boolean }): Team | null {
    const active = this.repos.teams.findOwnTeam(eventId)
    if (active) return active
    if (opts.allowDeleted) {
      const deleted = this.repos.teams.listByEvent(eventId, { includeDeleted: true }).filter((t) => t.isOwnTeam && t.deletedAt !== null)
      if (deleted.length === 1) return deleted[0]!
      if (deleted.length > 1 && opts.required) {
        throw new AppError(ErrorCode.OWN_TEAM_NOT_FOUND, '削除済みの自チームが複数あります。対象の自チームを復元してください')
      }
    }
    if (!opts.required) return null
    throw new AppError(
      ErrorCode.OWN_TEAM_NOT_FOUND,
      opts.allowDeleted ? '自チームが登録されていません' : '有効な自チームがありません（削除済みの場合は復元してください）'
    )
  }
}

export function toViews(records: readonly PassRecord[], baseAt: number | null): LapView[] {
  return deriveLaps(records, baseAt).map((d) => ({
    recordId: d.record.id,
    teamId: d.record.teamId,
    lapNumber: d.lapNumber,
    passedAt: d.record.passedAt,
    passedWallAt: d.record.passedWallAt,
    lapTimeMs: d.lapTimeMs,
    bootSessionId: d.record.bootSessionId
  }))
}
