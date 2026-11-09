import type { Team } from '@shared/types/entities'
import { AppError, ErrorCode } from '@shared/errors'
import { provisionalRule, rankTeams, type RankingRule } from '@shared/race/ranking'
import type { Repositories } from '../repositories'

export interface StandingRow {
  rank: number
  tied: boolean
  teamId: number
  teamName: string
  bibNumber: string | null
  isOwnTeam: boolean
  /** 入力対象から外されたチーム（順位には含める。D-008） */
  teamDeleted: boolean
  laps: number
  lastPassAt: number | null
  lapsBehindLeader: number
  lapsBehindAhead: number | null
  /** 同周回数の場合のみの実測時間差（ms） */
  timeBehindAheadMs: number | null
}

export interface Standings {
  ruleId: string
  ruleLabel: string
  provisional: boolean
  rows: StandingRow[]
}

/**
 * 現在順位（仕様 §8.3、決定 D-003, D-008, D-023）。
 * - 自チームは lap_records、他チームは competitor_passes を統合して扱う
 * - 削除済みチームも含める（チームの削除は入力対象から外すだけ）。記録自体が削除されたものは除外
 * - 保存せず、毎回元データから算出する（記録の追加・修正・削除・UNDO が即座に反映される）
 * - 順位対象外（失格等）の扱いは未実装（D-010）
 */
export class StandingsService {
  constructor(
    private readonly repos: Repositories,
    private readonly rule: RankingRule = provisionalRule
  ) {}

  get(eventId: number): Standings {
    if (!this.repos.events.findById(eventId)) {
      throw new AppError(ErrorCode.EVENT_NOT_FOUND, `大会が見つかりません (id=${eventId})`)
    }
    const teams = this.repos.teams.listByEvent(eventId, { includeDeleted: true })
    const byId = new Map<number, Team>(teams.map((t) => [t.id, t]))
    const progress = teams.map((t) => {
      const recs = t.isOwnTeam ? this.repos.lapRecords.listByTeam(t.id) : this.repos.competitorPasses.listByTeam(t.id)
      return { teamId: t.id, laps: recs.length, lastPassAt: recs.at(-1)?.passedAt ?? null }
    })
    return {
      ruleId: this.rule.id,
      ruleLabel: this.rule.label,
      provisional: this.rule.provisional,
      rows: rankTeams(progress, this.rule).map((r) => {
        const t = byId.get(r.teamId)!
        return {
          ...r,
          teamName: t.name,
          bibNumber: t.bibNumber,
          isOwnTeam: t.isOwnTeam,
          teamDeleted: t.deletedAt !== null
        }
      })
    }
  }
}
