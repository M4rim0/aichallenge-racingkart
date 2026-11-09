import type { Db } from '../db/connection'
import type { Now } from './base'
import { EventRepository } from './event-repository'
import { MandatoryStoppageRepository } from './mandatory-stoppage-repository'
import { MemoRepository } from './memo-repository'
import { OperationHistoryRepository } from './operation-history-repository'
import { OperatorRepository } from './operator-repository'
import { CompetitorPassRepository, LapRecordRepository } from './pass-record-repository'
import { RaceClockTransitionRepository } from './race-clock-transition-repository'
import { TeamRepository } from './team-repository'
import { VehicleDataRepository } from './vehicle-data-repository'

export interface Repositories {
  events: EventRepository
  teams: TeamRepository
  lapRecords: LapRecordRepository
  vehicleData: VehicleDataRepository
  competitorPasses: CompetitorPassRepository
  operators: OperatorRepository
  memos: MemoRepository
  history: OperationHistoryRepository
  clockTransitions: RaceClockTransitionRepository
  stoppages: MandatoryStoppageRepository
}

/**
 * @param now 作成日時・更新日時・操作日時に使う時刻関数。
 *            段階4でマスタークロックに差し替える（それまでは呼び出し側が渡す）。
 */
export function createRepositories(db: Db, now: Now): Repositories {
  return {
    events: new EventRepository(db, now),
    teams: new TeamRepository(db, now),
    lapRecords: new LapRecordRepository(db, now),
    vehicleData: new VehicleDataRepository(db, now),
    competitorPasses: new CompetitorPassRepository(db, now),
    operators: new OperatorRepository(db, now),
    memos: new MemoRepository(db, now),
    history: new OperationHistoryRepository(db, now),
    clockTransitions: new RaceClockTransitionRepository(db, now),
    stoppages: new MandatoryStoppageRepository(db, now)
  }
}

export * from './base'
