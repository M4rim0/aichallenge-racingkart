import { AppError, ErrorCode } from '@shared/errors'
import { provisionalRule, type RankingRule } from '@shared/race/ranking'
import { computeStrategy, type StrategyReport } from '@shared/strategy/engine'
import type { Repositories } from '../repositories'
import type { MasterClock } from '../clock/master-clock'

/**
 * 戦略計算（§8）。DB の元データ（有効な記録・削除済みチームを含む・有効な強制停止）を読み、
 * 純粋関数の computeStrategy で毎回再計算する。結果は保存しない（§14）。
 * そのため記録の追加・修正・削除・UNDO、強制停止・終了予定時刻の変更は、次の取得時に必ず反映される（§8.9）。
 */
export class StrategyService {
  constructor(
    private readonly repos: Repositories,
    private readonly clock: MasterClock,
    private readonly rule: RankingRule = provisionalRule
  ) {}

  get(eventId: number): StrategyReport {
    const event = this.repos.events.findById(eventId)
    if (!event) throw new AppError(ErrorCode.EVENT_NOT_FOUND, `大会が見つかりません (id=${eventId})`)
    const teams = this.repos.teams.listByEvent(eventId, { includeDeleted: true }).map((t) => ({
      teamId: t.id,
      name: t.name,
      bibNumber: t.bibNumber,
      isOwnTeam: t.isOwnTeam,
      teamDeleted: t.deletedAt !== null,
      passes: (t.isOwnTeam ? this.repos.lapRecords : this.repos.competitorPasses)
        .listByTeam(t.id)
        .map((r) => ({ id: r.id, passedAt: r.passedAt }))
    }))
    return computeStrategy({
      now: this.clock.now(),
      status: event.status,
      actualStartAt: event.actualStartAt,
      actualEndAt: event.actualEndAt,
      scheduledEndAt: event.scheduledEndAt,
      stoppages: this.repos.stoppages.listByEvent(eventId).map((s) => ({ startsAt: s.startsAt, endsAt: s.endsAt })),
      teams,
      rule: this.rule
    })
  }
}
