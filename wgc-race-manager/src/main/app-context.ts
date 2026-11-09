import type { AppSession } from '@shared/types/entities'
import type { Db } from './db/connection'
import { createRepositories, type Repositories } from './repositories'
import type { MasterClock } from './clock/master-clock'
import { EventService } from './services/event-service'
import { OperatorContext } from './services/operator-context'
import { RaceClockService } from './services/race-clock-service'
import { TeamService } from './services/team-service'
import { LapService } from './services/lap-service'
import { UndoService } from './services/undo-service'
import { CompetitorService } from './services/competitor-service'
import { StandingsService } from './services/standings-service'
import { VehicleDataService } from './services/vehicle-data-service'
import { OperatorService } from './services/operator-service'
import { MemoService } from './services/memo-service'
import { CsvService } from './services/csv-service'
import { StoppageService } from './services/stoppage-service'
import { StrategyService } from './services/strategy-service'
import { WarningService } from './services/warning-service'

export interface AppContext {
  db: Db
  repos: Repositories
  clock: MasterClock
  operator: OperatorContext
  events: EventService
  teams: TeamService
  raceClock: RaceClockService
  laps: LapService
  competitors: CompetitorService
  standings: StandingsService
  vehicleData: VehicleDataService
  operators: OperatorService
  memos: MemoService
  csv: CsvService
  stoppages: StoppageService
  strategy: StrategyService
  warnings: WarningService
  undo: UndoService
  /** この起動セッションの情報（PC 時刻異常の有無を含む）。未登録なら null */
  session: AppSession | null
}

/** Service の組み立て。作成・更新・操作日時はすべてマスタークロックから取得する。 */
export function createAppContext(db: Db, clock: MasterClock, session: AppSession | null = null): AppContext {
  const repos = createRepositories(db, () => clock.now(), clock.bootSessionId)
  const operator = new OperatorContext((id) => repos.operators.findById(id))
  const strategy = new StrategyService(repos, clock)
  return {
    db,
    repos,
    clock,
    operator,
    session,
    events: new EventService(db, repos, operator),
    teams: new TeamService(db, repos, operator),
    raceClock: new RaceClockService(db, repos, clock, operator),
    laps: new LapService(db, repos, clock, operator),
    competitors: new CompetitorService(db, repos, clock, operator),
    standings: new StandingsService(repos),
    vehicleData: new VehicleDataService(db, repos, operator),
    operators: new OperatorService(db, repos, operator),
    memos: new MemoService(db, repos, clock, operator),
    csv: new CsvService(repos),
    stoppages: new StoppageService(db, repos, operator),
    strategy,
    warnings: new WarningService(strategy, clock),
    undo: new UndoService(db, repos, operator)
  }
}
