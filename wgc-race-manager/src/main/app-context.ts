import type { Db } from './db/connection'
import { createRepositories, type Now, type Repositories } from './repositories'
import { EventService } from './services/event-service'
import { OperatorContext } from './services/operator-context'
import { TeamService } from './services/team-service'

export interface AppContext {
  db: Db
  repos: Repositories
  operator: OperatorContext
  events: EventService
  teams: TeamService
}

/**
 * Service の組み立て。
 * @param now 作成・更新・操作日時に使う時刻関数。段階4でマスタークロックに差し替える。
 */
export function createAppContext(db: Db, now: Now): AppContext {
  const repos = createRepositories(db, now)
  const operator = new OperatorContext()
  return {
    db,
    repos,
    operator,
    events: new EventService(db, repos, operator),
    teams: new TeamService(db, repos, operator)
  }
}
