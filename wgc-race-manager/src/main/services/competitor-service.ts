import type { LapView, PassRecord, RaceEvent, Team } from '@shared/types/entities'
import { AppError, ErrorCode } from '@shared/errors'
import type { Db } from '../db/connection'
import { runAudited } from '../db/unit-of-work'
import type { Repositories } from '../repositories'
import type { MasterClock } from '../clock/master-clock'
import type { OperatorContext } from './operator-context'
import { toViews } from './lap-service'
import { assertAfterStart, assertKeepsOrder, assertNoDuplicate, assertNotFuture, assertValidEpoch } from './pass-record-rules'

/**
 * 他チーム通過記録（仕様 §7、決定 D-003, D-008, D-009, D-020〜D-022）。
 *
 * - 通過登録：RUNNING / PAUSED のみ。マスタークロックの日時で記録。削除済みチーム・自チームには登録しない
 * - 過去記録の追加・修正・削除：開始後ならいつでも（END 後も、削除済みチームでも）可能
 * - 周回数 = 通過回数（初回通過 = 1 周）。初回のラップタイムは算出しない
 * - 自チームのラップ計測とは独立（自チームは lap_records を使う）
 */
export class CompetitorService {
  constructor(
    private readonly db: Db,
    private readonly repos: Repositories,
    private readonly clock: MasterClock,
    private readonly operator: OperatorContext
  ) {}

  /** チームの通過一覧（周回番号・ラップタイム付き。初回ラップタイムは null） */
  listByTeam(teamId: number): LapView[] {
    this.requireCompetitor(teamId)
    return toViews(this.repos.competitorPasses.listByTeam(teamId), null)
  }

  /** 大会内の全他チームの通過一覧（チームごと） */
  listByEvent(eventId: number): Record<number, LapView[]> {
    this.requireEvent(eventId)
    const out: Record<number, LapView[]> = {}
    for (const team of this.repos.teams.listByEvent(eventId, { includeDeleted: true })) {
      if (team.isOwnTeam) continue
      out[team.id] = toViews(this.repos.competitorPasses.listByTeam(team.id), null)
    }
    return out
  }

  /** 通過登録（その場での登録） */
  register(teamId: number): LapView {
    const team = this.requireCompetitor(teamId)
    const id = runAudited(this.db, this.repos, this.ctx(team.eventId), () => {
      const event = this.requireEvent(team.eventId)
      if (event.status !== 'RUNNING' && event.status !== 'PAUSED') {
        throw new AppError(
          ErrorCode.RACE_NOT_ACCEPTING_LAPS,
          event.status === 'PREPARING'
            ? 'START 前は通過を登録できません'
            : 'レース終了後は通過を登録できません。過去記録の追加を使用してください'
        )
      }
      const current = this.requireCompetitor(teamId)
      if (current.deletedAt !== null) {
        throw new AppError(ErrorCode.TEAM_DELETED, '削除済みのチームには通過を登録できません（必要であれば復元してください）')
      }
      const stamp = this.clock.stamp()
      assertNoDuplicate(stamp.at, this.repos.competitorPasses.listByTeam(teamId), null)
      const created = this.repos.competitorPasses.insert({
        eventId: team.eventId,
        teamId,
        passedAt: stamp.at,
        passedWallAt: stamp.wallAt,
        bootSessionId: stamp.bootSessionId
      })
      return {
        result: created.id,
        changes: [{ action: 'CREATE', targetTable: 'competitor_passes', targetId: created.id, before: null, after: created, note: 'PASS REGISTER' }]
      }
    })
    return this.viewOf(teamId, id)
  }

  /** 過去記録の追加 */
  addPast(teamId: number, passedAt: number): LapView {
    assertValidEpoch(passedAt)
    const team = this.requireCompetitor(teamId)
    const id = runAudited(this.db, this.repos, this.ctx(team.eventId), () => {
      const event = this.requireEvent(team.eventId)
      assertAfterStart(passedAt, event.actualStartAt)
      assertNotFuture(passedAt, this.clock.now())
      assertNoDuplicate(passedAt, this.repos.competitorPasses.listByTeam(teamId), null)
      const created = this.repos.competitorPasses.insert({
        eventId: team.eventId,
        teamId,
        passedAt,
        passedWallAt: null,
        bootSessionId: this.clock.bootSessionId
      })
      return {
        result: created.id,
        changes: [{ action: 'CREATE', targetTable: 'competitor_passes', targetId: created.id, before: null, after: created, note: 'add past record' }]
      }
    })
    return this.viewOf(teamId, id)
  }

  updatePassedAt(recordId: number, passedAt: number): LapView {
    assertValidEpoch(passedAt)
    const rec = this.requireRecord(recordId)
    runAudited(this.db, this.repos, this.ctx(rec.eventId), () => {
      const event = this.requireEvent(rec.eventId)
      const sameTeam = this.repos.competitorPasses.listByTeam(rec.teamId)
      assertAfterStart(passedAt, event.actualStartAt)
      assertNotFuture(passedAt, this.clock.now())
      assertNoDuplicate(passedAt, sameTeam, recordId)
      assertKeepsOrder(recordId, passedAt, sameTeam)
      const { before, after } = this.repos.competitorPasses.update(recordId, { passedAt })
      return { result: null, changes: [{ action: 'UPDATE', targetTable: 'competitor_passes', targetId: recordId, before, after }] }
    })
    return this.viewOf(rec.teamId, recordId)
  }

  delete(recordId: number): void {
    const rec = this.requireRecord(recordId)
    runAudited(this.db, this.repos, this.ctx(rec.eventId), () => {
      const { before, after } = this.repos.competitorPasses.softDelete(recordId)
      return { result: null, changes: [{ action: 'DELETE', targetTable: 'competitor_passes', targetId: recordId, before, after }] }
    })
  }

  private viewOf(teamId: number, recordId: number): LapView {
    const v = this.listByTeam(teamId).find((x) => x.recordId === recordId)
    if (!v) throw new AppError(ErrorCode.INTERNAL, '通過記録の取得に失敗しました')
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

  /** 他チーム（自チームでない）であること。削除済みも含めて取得する */
  private requireCompetitor(teamId: number): Team {
    const t = this.repos.teams.findById(teamId, { includeDeleted: true })
    if (!t) throw new AppError(ErrorCode.TEAM_NOT_FOUND, `チームが見つかりません (id=${teamId})`)
    if (t.isOwnTeam) {
      throw new AppError(ErrorCode.OWN_TEAM_NOT_ALLOWED, '自チームは他チーム通過記録の対象外です（自チームのラップ記録を使用してください）')
    }
    return t
  }

  private requireRecord(id: number): PassRecord {
    const r = this.repos.competitorPasses.findById(id)
    if (!r) throw new AppError(ErrorCode.RECORD_NOT_FOUND, `通過記録が見つかりません (id=${id})`)
    return r
  }
}
