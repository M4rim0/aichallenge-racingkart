import type { AppSession } from '@shared/types/entities'
import type { Db } from './db/connection'
import { createRepositories, type Repositories } from './repositories'
import type { MasterClock } from './clock/master-clock'
import { EventService } from './services/event-service'
import { OperatorContext } from './services/operator-context'
import { RaceClockService } from './services/race-clock-service'
import { TeamService } from './services/team-service'

export interface AppContext {
  db: Db
  repos: Repositories
  clock: MasterClock
  operator: OperatorContext
  events: EventService
  teams: TeamService
  raceClock: RaceClockService
  /** この起動セッションの情報（PC 時刻異常の有無を含む）。未登録なら null */
  session: AppSession | null
}

/** Service の組み立て。作成・更新・操作日時はすべてマスタークロックから取得する。 */
export function createAppContext(db: Db, clock: MasterClock, session: AppSession | null = null): AppContext {
  const repos = createRepositories(db, () => clock.now(), clock.bootSessionId)
  const operator = new OperatorContext()
  return {
    db,
    repos,
    clock,
    operator,
    session,
    events: new EventService(db, repos, operator),
    teams: new TeamService(db, repos, operator),
    raceClock: new RaceClockService(db, repos, clock, operator)
  }
}
