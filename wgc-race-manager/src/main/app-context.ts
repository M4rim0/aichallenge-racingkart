import type { AppSession, PreviousShutdownStatus } from '@shared/types/entities'
import { PowerSaveService, noopPowerBlocker, type PowerBlocker } from './power/power-save-service'
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
import { RecoveryService } from './services/recovery-service'

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
  /** 電源管理（D-063） */
  power: PowerSaveService
  /** 異常終了後の復旧確認待ち（D-070〜D-072） */
  recovery: RecoveryService
  /** 前回の起動の終了状態（D-066）。判定できなければ null */
  previousShutdown: PreviousShutdownStatus | null
}

export interface AppContextOptions {
  powerBlocker?: PowerBlocker
}

/** Service の組み立て。作成・更新・操作日時はすべてマスタークロックから取得する。 */
export function createAppContext(
  db: Db,
  clock: MasterClock,
  session: AppSession | null = null,
  options: AppContextOptions = {}
): AppContext {
  const repos = createRepositories(db, () => clock.now(), clock.bootSessionId)
  const operator = new OperatorContext((id) => repos.operators.findById(id))
  const strategy = new StrategyService(repos, clock)
  const power = new PowerSaveService(options.powerBlocker ?? noopPowerBlocker, () =>
    repos.events
      .listAll()
      .filter((e) => e.status === 'RUNNING' || e.status === 'PAUSED')
      .map((e) => e.id)
  )
  const recovery = new RecoveryService(db, repos, clock, operator)
  const raceClock = new RaceClockService(db, repos, clock, operator, recovery)
  raceClock.onStateChanged = () => power.reconcile()
  return {
    db,
    repos,
    clock,
    operator,
    session,
    events: new EventService(db, repos, operator, recovery),
    teams: new TeamService(db, repos, operator, recovery),
    raceClock,
    power,
    recovery,
    previousShutdown: session ? repos.lifecycle.previousShutdownStatus(session.id) : null,
    laps: new LapService(db, repos, clock, operator, recovery),
    competitors: new CompetitorService(db, repos, clock, operator, recovery),
    standings: new StandingsService(repos),
    vehicleData: new VehicleDataService(db, repos, operator, recovery),
    operators: new OperatorService(db, repos, operator),
    memos: new MemoService(db, repos, clock, operator),
    csv: new CsvService(repos),
    stoppages: new StoppageService(db, repos, operator, recovery),
    strategy,
    warnings: new WarningService(strategy, clock),
    undo: new UndoService(db, repos, operator, recovery)
  }
}
