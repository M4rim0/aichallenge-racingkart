import { expect } from 'vitest'
import { AppError } from '../../src/shared/errors'
import { createAppContext, type AppContext } from '../../src/main/app-context'
import { MasterClock } from '../../src/main/clock/master-clock'
import type { TestDb } from './db'

export const SEC = 1000
export const MIN = 60_000

let bootCounter = 0
export function bootApp(t: TestDb): AppContext {
  return createAppContext(t.db, new MasterClock(t.clock, `boot-${++bootCounter}`))
}

/** 例外の AppError コードを返す */
export function errorCode(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(AppError)
    return (e as AppError).code
  }
  throw new Error('expected an AppError')
}

/** 自チーム・他チーム付きで開始済みの大会を作る */
export function startedRace(t: TestDb, ctx: AppContext) {
  const event = ctx.events.create({ name: 'WGC', scheduledStartAt: t.clock.t, scheduledEndAt: t.clock.t + 8 * 3600_000 })
  const own = ctx.teams.create(event.id, { name: 'Tamagawa', isOwnTeam: true })
  const rival = ctx.teams.create(event.id, { name: 'Rival' })
  const startAt = t.clock.t
  ctx.raceClock.start(event.id)
  return { event, own, rival, startAt }
}
