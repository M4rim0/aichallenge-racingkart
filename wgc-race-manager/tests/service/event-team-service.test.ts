import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppError, ErrorCode } from '../../src/shared/errors'
import { createAppContext, type AppContext } from '../../src/main/app-context'
import { MasterClock } from '../../src/main/clock/master-clock'
import { createTestDb, type TestDb } from '../helpers/db'

let t: TestDb
let ctx: AppContext
beforeEach(() => {
  t = createTestDb()
  ctx = createAppContext(t.db, new MasterClock(t.clock, 'boot-test'))
})
afterEach(() => t.cleanup())

function expectAppError(fn: () => unknown, code: ErrorCode): AppError {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(AppError)
    expect((e as AppError).code).toBe(code)
    return e as AppError
  }
  throw new Error(`expected AppError ${code}`)
}

const START = Date.UTC(2026, 9, 1, 0, 0)
const END = START + 8 * 3600_000

function newEvent(name = 'WGC 2026') {
  return ctx.events.create({
    name,
    heldOn: '2026-10-01',
    courseName: 'Suzuka',
    lapDistanceM: 5807,
    scheduledStartAt: START,
    scheduledEndAt: END
  })
}

describe('EventService (spec §3.1)', () => {
  it('creates an event in PREPARING and records history', () => {
    const e = newEvent()
    expect(e).toMatchObject({ status: 'PREPARING', actualStartAt: null, actualEndAt: null, lapDistanceM: 5807 })
    const h = t.repos.history.listAll()
    expect(h).toHaveLength(1)
    expect(h[0]).toMatchObject({ action: 'CREATE', targetTable: 'events', targetId: e.id })
  })

  it('validates input', () => {
    const err = expectAppError(
      () =>
        ctx.events.create({
          name: '  ',
          heldOn: '2026-02-30',
          lapDistanceM: 0,
          scheduledStartAt: 1.5
        }),
      ErrorCode.VALIDATION
    )
    expect(Object.keys(err.fields!)).toEqual(
      expect.arrayContaining(['name', 'heldOn', 'lapDistanceM', 'scheduledStartAt'])
    )
    expectAppError(
      () => ctx.events.create({ name: 'x', scheduledStartAt: END, scheduledEndAt: START }),
      ErrorCode.VALIDATION
    )
    expect(t.repos.events.listAll()).toEqual([])
    expect(t.repos.history.listAll()).toEqual([])
  })

  it('does not allow setting status or actual times through create/update', () => {
    expectAppError(() => ctx.events.create({ name: 'x', status: 'RUNNING' } as never), ErrorCode.VALIDATION)
    const e = newEvent()
    expectAppError(() => ctx.events.update(e.id, { status: 'FINISHED' } as never), ErrorCode.VALIDATION)
    expectAppError(() => ctx.events.update(e.id, { actualStartAt: 1 } as never), ErrorCode.VALIDATION)
  })

  it('updates with schedule order checked against stored values', () => {
    const e = newEvent()
    expectAppError(() => ctx.events.update(e.id, { scheduledEndAt: START - 1 }), ErrorCode.VALIDATION)
    t.clock.advance(1000)
    const u = ctx.events.update(e.id, { scheduledEndAt: END + 3600_000, courseName: null })
    expect(u.scheduledEndAt).toBe(END + 3600_000)
    expect(u.courseName).toBeNull()
    const h = t.repos.history.listByEvent(e.id)
    expect(h.at(-1)).toMatchObject({ action: 'UPDATE', targetTable: 'events' })
    expect(JSON.parse(h.at(-1)!.beforeJson!).scheduledEndAt).toBe(END)
  })

  it('allows editing a FINISHED event (past events are editable)', () => {
    const e = newEvent()
    t.repos.events.update(e.id, { status: 'FINISHED' })
    expect(ctx.events.update(e.id, { name: '修正後' }).name).toBe('修正後')
  })

  it('reports missing event', () => {
    expectAppError(() => ctx.events.get(999), ErrorCode.EVENT_NOT_FOUND)
  })
})

describe('TeamService (spec §3.2, D-007..D-010)', () => {
  it('creates teams per event; does not carry teams over to a new event', () => {
    const a = newEvent('A')
    ctx.teams.create(a.id, { name: 'Tamagawa', bibNumber: '1', isOwnTeam: true })
    ctx.teams.create(a.id, { name: 'Rival', bibNumber: '2', color: '#ff0000' })
    const b = newEvent('B')
    expect(ctx.teams.list(b.id)).toEqual([])
    expect(ctx.teams.list(a.id).map((x) => x.name)).toEqual(['Tamagawa', 'Rival'])
  })

  it('enforces one own team with a clear error', () => {
    const e = newEvent()
    ctx.teams.create(e.id, { name: 'Own', isOwnTeam: true })
    expectAppError(() => ctx.teams.create(e.id, { name: 'Own2', isOwnTeam: true }), ErrorCode.OWN_TEAM_ALREADY_EXISTS)
    const other = ctx.teams.create(e.id, { name: 'Other' })
    expectAppError(() => ctx.teams.update(other.id, { isOwnTeam: true }), ErrorCode.OWN_TEAM_ALREADY_EXISTS)
  })

  it('validates input and event existence', () => {
    const e = newEvent()
    expectAppError(() => ctx.teams.create(e.id, { name: '' }), ErrorCode.VALIDATION)
    expectAppError(() => ctx.teams.create(e.id, { name: 'x', eventId: 99 } as never), ErrorCode.VALIDATION)
    expectAppError(() => ctx.teams.create(999, { name: 'x' }), ErrorCode.EVENT_NOT_FOUND)
  })

  it('prevents own-team flag changes that would mix record types', () => {
    const e = newEvent()
    const own = ctx.teams.create(e.id, { name: 'Own', isOwnTeam: true })
    const rival = ctx.teams.create(e.id, { name: 'Rival' })
    t.repos.lapRecords.insert({ eventId: e.id, teamId: own.id, passedAt: START + 1 })
    t.repos.competitorPasses.insert({ eventId: e.id, teamId: rival.id, passedAt: START + 2 })
    expectAppError(() => ctx.teams.update(own.id, { isOwnTeam: false }), ErrorCode.OWN_TEAM_HAS_LAP_RECORDS)
    // 自チームが不在でも、通過記録があるチームは自チームにできない
    const empty = newEvent('E2')
    const r2 = ctx.teams.create(empty.id, { name: 'R2' })
    t.repos.competitorPasses.insert({ eventId: empty.id, teamId: r2.id, passedAt: 1 })
    expectAppError(() => ctx.teams.update(r2.id, { isOwnTeam: true }), ErrorCode.TEAM_HAS_COMPETITOR_PASSES)
    // 記録が無ければ切り替え可能
    const r3 = ctx.teams.create(empty.id, { name: 'R3' })
    expect(ctx.teams.update(r3.id, { isOwnTeam: true }).isOwnTeam).toBe(true)
  })

  it('deletes logically after impact confirmation and keeps records (D-007, D-008)', () => {
    const e = newEvent()
    const rival = ctx.teams.create(e.id, { name: 'Rival' })
    t.repos.competitorPasses.insert({ eventId: e.id, teamId: rival.id, passedAt: START + 1 })
    t.repos.competitorPasses.insert({ eventId: e.id, teamId: rival.id, passedAt: START + 2 })

    const impact = ctx.teams.getDeletionImpact(rival.id)
    expect(impact).toEqual({ lapRecords: 0, competitorPasses: 2, vehicleData: 0 })

    const deleted = ctx.teams.delete(rival.id, impact)
    expect(deleted.deletedAt).not.toBeNull()
    expect(ctx.teams.list(e.id)).toEqual([])
    expect(ctx.teams.list(e.id, { includeDeleted: true })).toHaveLength(1)
    expect(t.repos.competitorPasses.listByTeam(rival.id)).toHaveLength(2)

    const h = t.repos.history.listByEvent(e.id).at(-1)!
    expect(h).toMatchObject({ action: 'DELETE', targetTable: 'teams', targetId: rival.id })
    expect(h.note).toContain('competitor=2')
  })

  it('refuses deletion when the impact changed after confirmation', () => {
    const e = newEvent()
    const rival = ctx.teams.create(e.id, { name: 'Rival' })
    const impact = ctx.teams.getDeletionImpact(rival.id)
    t.repos.competitorPasses.insert({ eventId: e.id, teamId: rival.id, passedAt: START + 1 })
    expectAppError(() => ctx.teams.delete(rival.id, impact), ErrorCode.DELETION_IMPACT_CHANGED)
    expect(ctx.teams.get(rival.id).deletedAt).toBeNull()
    expect(t.repos.history.listByEvent(e.id).filter((h) => h.action === 'DELETE')).toEqual([])
  })

  it('restores a deleted team with history and keeps records intact', () => {
    const e = newEvent()
    const rival = ctx.teams.create(e.id, { name: 'Rival' })
    t.repos.competitorPasses.insert({ eventId: e.id, teamId: rival.id, passedAt: START + 1 })
    ctx.teams.delete(rival.id, ctx.teams.getDeletionImpact(rival.id))
    expectAppError(() => ctx.teams.update(rival.id, { name: 'x' }), ErrorCode.TEAM_DELETED)
    expectAppError(() => ctx.teams.delete(rival.id, { lapRecords: 0, competitorPasses: 1, vehicleData: 0 }), ErrorCode.TEAM_DELETED)

    const restored = ctx.teams.restore(rival.id)
    expect(restored.deletedAt).toBeNull()
    expect(ctx.teams.getDeletionImpact(rival.id).competitorPasses).toBe(1)
    expect(t.repos.history.listByEvent(e.id).at(-1)).toMatchObject({ action: 'UPDATE', note: 'restore' })
    expectAppError(() => ctx.teams.restore(rival.id), ErrorCode.TEAM_NOT_DELETED)
  })

  it('refuses restoring an old own team if a new own team exists', () => {
    const e = newEvent()
    const oldOwn = ctx.teams.create(e.id, { name: 'Old', isOwnTeam: true })
    ctx.teams.delete(oldOwn.id, ctx.teams.getDeletionImpact(oldOwn.id))
    ctx.teams.create(e.id, { name: 'New', isOwnTeam: true })
    expectAppError(() => ctx.teams.restore(oldOwn.id), ErrorCode.OWN_TEAM_ALREADY_EXISTS)
  })

  it('stores the operator name snapshot in history', () => {
    const op = t.repos.operators.insert({ name: '田中' })
    ctx.operator.set({ id: op.id, name: op.name })
    const e = newEvent()
    ctx.teams.create(e.id, { name: 'A' })
    const h = t.repos.history.listByEvent(e.id).at(-1)!
    expect(h).toMatchObject({ operatorId: op.id, operatorNameSnapshot: '田中' })
  })
})
