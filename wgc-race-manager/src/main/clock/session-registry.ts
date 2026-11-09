import type { AppSession } from '@shared/types/entities'
import { formatJst } from '@shared/time/jst'
import type { Db } from '../db/connection'
import type { Repositories } from '../repositories'
import type { MasterClock } from './master-clock'

/**
 * 起動セッションを登録し、PC 時刻異常を検出する（D-013）。BOOT の記録も同じトランザクションで追記する（D-066）。
 * 起動時の PC 実日時が、DB に保存済みの最新日時より過去なら異常として記録する。
 * 保存済みの日時は一切書き換えない。
 */
export function registerBootSession(db: Db, repos: Repositories, clock: MasterClock, appVersion: string): AppSession {
  return db
    .transaction(() => {
      const latest = repos.appSessions.latestSavedAt()
      const wall = clock.anchorWall
      const anomaly = latest !== null && wall < latest
      const session = repos.appSessions.insert({
        id: clock.bootSessionId,
        startedWallAt: wall,
        latestSavedAtBefore: latest,
        clockAnomaly: anomaly,
        anomalyDetail: anomaly
          ? `PC の時刻（${formatJst(wall)}）が、保存済みの最新日時（${formatJst(latest)}）より ${latest - wall} ms 過去です`
          : null,
        appVersion
      })
      // 起動の記録（D-066）。正常終了の判定は、この BOOT がある起動だけを対象にする
      repos.lifecycle.insert({
        bootSessionId: session.id,
        kind: 'BOOT',
        at: clock.now(),
        wallAt: clock.wallNow(),
        monoMs: clock.monoNow(),
        detail: anomaly ? 'clock anomaly at boot' : null
      })
      return session
    })
    .immediate()
}
