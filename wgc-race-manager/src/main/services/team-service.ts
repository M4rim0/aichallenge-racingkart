import type { Team } from '@shared/types/entities'
import { AppError, ErrorCode } from '@shared/errors'
import {
  validateTeamCreate,
  validateTeamUpdate,
  type TeamCreateInput,
  type TeamUpdateInput
} from '@shared/validation/event-team'
import type { Db } from '../db/connection'
import { runAudited } from '../db/unit-of-work'
import type { Repositories } from '../repositories'
import type { TeamRelatedCounts } from '../repositories/team-repository'
import type { OperatorContext } from './operator-context'

export type TeamDeletionImpact = TeamRelatedCounts

/**
 * チーム管理（仕様 §3.2、決定 D-007〜D-010）。
 *
 * - チームの削除は「新規入力の対象から外す」論理削除のみ。記録は保持し、順位・CSV からも除外しない。
 * - 削除時は呼び出し側が確認した関連記録件数を渡し、確認後に件数が変わっていれば削除しない。
 * - 復元は「編集」として操作履歴に記録する（note = 'restore'）。
 * - 順位対象外（失格・リタイア等）の仕組みはここには含めない（D-010）。
 */
export class TeamService {
  constructor(
    private readonly db: Db,
    private readonly repos: Repositories,
    private readonly operator: OperatorContext
  ) {}

  list(eventId: number, opts: { includeDeleted?: boolean } = {}): Team[] {
    this.requireEvent(eventId)
    return this.repos.teams.listByEvent(eventId, opts)
  }

  /** 削除済みを含めて取得 */
  get(id: number): Team {
    const t = this.repos.teams.findById(id, { includeDeleted: true })
    if (!t) throw new AppError(ErrorCode.TEAM_NOT_FOUND, `チームが見つかりません (id=${id})`)
    return t
  }

  create(eventId: number, input: TeamCreateInput): Team {
    const errors = validateTeamCreate(input)
    if (Object.keys(errors).length > 0) throw new AppError(ErrorCode.VALIDATION, '入力内容に誤りがあります', errors)
    this.requireEvent(eventId)
    if (input.isOwnTeam) this.assertNoOtherOwnTeam(eventId, null)
    return runAudited(this.db, this.repos, { eventId, operator: this.operator.get() }, () => {
      const created = this.repos.teams.insert({ ...input, eventId })
      return {
        result: created,
        changes: [{ action: 'CREATE', targetTable: 'teams', targetId: created.id, before: null, after: created }]
      }
    })
  }

  update(id: number, patch: TeamUpdateInput): Team {
    const errors = validateTeamUpdate(patch)
    if (Object.keys(errors).length > 0) throw new AppError(ErrorCode.VALIDATION, '入力内容に誤りがあります', errors)
    const team = this.get(id)
    if (team.deletedAt !== null) {
      throw new AppError(ErrorCode.TEAM_DELETED, '削除済みのチームは編集できません。先に復元してください')
    }
    if (patch.isOwnTeam !== undefined && patch.isOwnTeam !== team.isOwnTeam) {
      this.assertOwnFlagChangeAllowed(team, patch.isOwnTeam)
    }
    return runAudited(this.db, this.repos, { eventId: team.eventId, operator: this.operator.get() }, () => {
      const { before, after } = this.repos.teams.update(id, patch)
      return { result: after, changes: [{ action: 'UPDATE', targetTable: 'teams', targetId: id, before, after }] }
    })
  }

  /** 削除前の確認用：関連する有効な記録の件数 */
  getDeletionImpact(id: number): TeamDeletionImpact {
    this.get(id)
    return this.repos.teams.countRelatedRecords(id)
  }

  /**
   * 論理削除。`confirmedImpact` は削除前に確認した件数。
   * 確認後に記録が追加・削除されて件数が変わっていた場合は削除せずエラーにする。
   */
  delete(id: number, confirmedImpact: TeamDeletionImpact): Team {
    const team = this.get(id)
    if (team.deletedAt !== null) throw new AppError(ErrorCode.TEAM_DELETED, 'このチームは既に削除されています')
    return runAudited(this.db, this.repos, { eventId: team.eventId, operator: this.operator.get() }, () => {
      // 件数確認と削除を同一トランザクションで行い、確認後の記録追加との競合を防ぐ
      const current = this.repos.teams.countRelatedRecords(id)
      if (!sameImpact(current, confirmedImpact)) {
        throw new AppError(
          ErrorCode.DELETION_IMPACT_CHANGED,
          '確認後に関連記録の件数が変わりました。もう一度確認してください'
        )
      }
      const { before, after } = this.repos.teams.softDelete(id)
      return {
        result: after,
        changes: [
          {
            action: 'DELETE',
            targetTable: 'teams',
            targetId: id,
            before,
            after,
            note: `related records: lap=${current.lapRecords}, competitor=${current.competitorPasses}, vehicle=${current.vehicleData}`
          }
        ]
      }
    })
  }

  restore(id: number): Team {
    const team = this.get(id)
    if (team.deletedAt === null) throw new AppError(ErrorCode.TEAM_NOT_DELETED, 'このチームは削除されていません')
    if (team.isOwnTeam) this.assertNoOtherOwnTeam(team.eventId, id)
    return runAudited(this.db, this.repos, { eventId: team.eventId, operator: this.operator.get() }, () => {
      const { before, after } = this.repos.teams.restore(id)
      return {
        result: after,
        changes: [{ action: 'UPDATE', targetTable: 'teams', targetId: id, before, after, note: 'restore' }]
      }
    })
  }

  private requireEvent(eventId: number): void {
    if (!this.repos.events.findById(eventId)) {
      throw new AppError(ErrorCode.EVENT_NOT_FOUND, `大会が見つかりません (id=${eventId})`)
    }
  }

  private assertNoOtherOwnTeam(eventId: number, exceptTeamId: number | null): void {
    const own = this.repos.teams.findOwnTeam(eventId)
    if (own && own.id !== exceptTeamId) {
      throw new AppError(
        ErrorCode.OWN_TEAM_ALREADY_EXISTS,
        `自チームは既に登録されています（${own.name}）。1大会につき自チームは1チームのみです`
      )
    }
  }

  /**
   * 自チーム判定の変更による記録の不整合を防ぐ（D-003：自チームはラップ記録、他チームは通過記録）。
   * 削除済みの記録も、取り消し・復元で有効に戻りうるため件数に含める。
   */
  private assertOwnFlagChangeAllowed(team: Team, toOwn: boolean): void {
    const count = (table: 'lap_records' | 'competitor_passes'): number =>
      (this.db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE team_id = ?`).get(team.id) as { c: number }).c
    if (toOwn) {
      this.assertNoOtherOwnTeam(team.eventId, team.id)
      if (count('competitor_passes') > 0) {
        throw new AppError(
          ErrorCode.TEAM_HAS_COMPETITOR_PASSES,
          '他チーム通過記録があるチームは自チームに変更できません'
        )
      }
    } else if (count('lap_records') > 0) {
      throw new AppError(
        ErrorCode.OWN_TEAM_HAS_LAP_RECORDS,
        '自チームのラップ記録があるため、自チーム判定を外せません'
      )
    }
  }
}

function sameImpact(a: TeamDeletionImpact, b: TeamDeletionImpact): boolean {
  return (
    a.lapRecords === b.lapRecords && a.competitorPasses === b.competitorPasses && a.vehicleData === b.vehicleData
  )
}
