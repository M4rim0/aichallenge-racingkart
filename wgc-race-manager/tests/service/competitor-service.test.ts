import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCode } from '../../src/shared/errors'
import type { AppContext } from '../../src/main/app-context'
import { createTestDb, type TestDb } from '../helpers/db'
import { MIN, SEC, bootApp, errorCode, startedRace } from '../helpers/app'

let t: TestDb
let ctx: AppContext
beforeEach(() => {
  t = createTestDb()
  ctx = bootApp(t)
})
afterEach(() => t.cleanup())

function undoLatest(eventId: number) {
  const c = ctx.undo.peek(eventId)!
  return ctx.undo.undo(eventId, c.operationGroup)
}

describe('Competitor pass registration (spec §7, D-020, D-021)', () => {
  it('accepts only RUNNING / PAUSED', () => {
    const event = ctx.events.create({ name: 'x' })
    const r = ctx.teams.create(event.id, { name: 'R' })
    expect(errorCode(() => ctx.competitors.register(r.id))).toBe(ErrorCode.RACE_NOT_ACCEPTING_LAPS)
    ctx.raceClock.start(event.id)
    t.clock.advance(MIN)
    ctx.competitors.register(r.id)
    ctx.raceClock.pause(event.id)
    t.clock.advance(MIN)
    ctx.competitors.register(r.id) // PAUSE 中も記録できる（D-002）
    ctx.raceClock.end(event.id)
    t.clock.advance(MIN)
    expect(errorCode(() => ctx.competitors.register(r.id))).toBe(ErrorCode.RACE_NOT_ACCEPTING_LAPS)
    expect(ctx.competitors.listByTeam(r.id)).toHaveLength(2)
  })

  it('counts the first pass as lap 1 without a lap time (D-020)', () => {
    const { rival } = startedRace(t, ctx)
    t.clock.advance(7 * MIN)
    const p1 = ctx.competitors.register(rival.id)
    t.clock.advance(6 * MIN)
    const p2 = ctx.competitors.register(rival.id)
    expect([p1.lapNumber, p1.lapTimeMs]).toEqual([1, null])
    expect([p2.lapNumber, p2.lapTimeMs]).toEqual([2, 6 * MIN])
    expect(p2.passedWallAt).toBe(p2.passedAt)
  })

  it('keeps teams independent and separate from own laps', () => {
    const { event, rival } = startedRace(t, ctx)
    const r2 = ctx.teams.create(event.id, { name: 'R2' })
    t.clock.advance(MIN)
    ctx.competitors.register(rival.id)
    ctx.competitors.register(r2.id) // 異なるチームの同時刻は許可
    ctx.laps.register(event.id)
    t.clock.advance(MIN)
    ctx.competitors.register(rival.id)
    expect(ctx.competitors.listByTeam(rival.id)).toHaveLength(2)
    expect(ctx.competitors.listByTeam(r2.id)).toHaveLength(1)
    expect(ctx.laps.list(event.id)).toHaveLength(1)
    const all = ctx.competitors.listByEvent(event.id)
    expect(Object.keys(all).map(Number).sort()).toEqual([rival.id, r2.id].sort())
  })

  it('rejects own team, deleted team (live) and unknown team', () => {
    const { own, rival } = startedRace(t, ctx)
    expect(errorCode(() => ctx.competitors.register(own.id))).toBe(ErrorCode.OWN_TEAM_NOT_ALLOWED)
    expect(errorCode(() => ctx.competitors.addPast(own.id, t.clock.t))).toBe(ErrorCode.OWN_TEAM_NOT_ALLOWED)
    ctx.teams.delete(rival.id, ctx.teams.getDeletionImpact(rival.id))
    t.clock.advance(MIN)
    expect(errorCode(() => ctx.competitors.register(rival.id))).toBe(ErrorCode.TEAM_DELETED)
    expect(errorCode(() => ctx.competitors.register(999))).toBe(ErrorCode.TEAM_NOT_FOUND)
  })

  it('rejects same-millisecond double registration', () => {
    const { rival } = startedRace(t, ctx)
    t.clock.advance(MIN)
    ctx.competitors.register(rival.id)
    expect(errorCode(() => ctx.competitors.register(rival.id))).toBe(ErrorCode.DUPLICATE_PASS)
  })
})

describe('Competitor past records (D-022)', () => {
  function withPasses() {
    const r = startedRace(t, ctx)
    for (let i = 0; i < 3; i++) {
      t.clock.advance(10 * MIN)
      ctx.competitors.register(r.rival.id)
    }
    return r
  }

  it('adds, updates and deletes with the same rules as own laps', () => {
    const { rival, startAt } = withPasses()
    expect(ctx.competitors.addPast(rival.id, startAt + 15 * MIN).lapNumber).toBe(2)
    expect(errorCode(() => ctx.competitors.addPast(rival.id, startAt))).toBe(ErrorCode.VALIDATION)
    expect(errorCode(() => ctx.competitors.addPast(rival.id, t.clock.t + 1))).toBe(ErrorCode.VALIDATION)
    expect(errorCode(() => ctx.competitors.addPast(rival.id, startAt + 10 * MIN))).toBe(ErrorCode.DUPLICATE_PASS)
    const list = ctx.competitors.listByTeam(rival.id)
    expect(errorCode(() => ctx.competitors.updatePassedAt(list[1]!.recordId, startAt + 25 * MIN))).toBe(ErrorCode.TIMELINE_CONFLICT)
    expect(ctx.competitors.updatePassedAt(list[1]!.recordId, startAt + 16 * MIN).lapTimeMs).toBe(6 * MIN)
    ctx.competitors.delete(list[0]!.recordId)
    const after = ctx.competitors.listByTeam(rival.id)
    expect(after.map((l) => [l.lapNumber, l.lapTimeMs])).toEqual([
      [1, null],
      [2, 4 * MIN],
      [3, 10 * MIN]
    ])
  })

  it('rejects past additions before START and allows them after END / for deleted teams (D-009)', () => {
    const event = ctx.events.create({ name: 'x' })
    const r = ctx.teams.create(event.id, { name: 'R' })
    expect(errorCode(() => ctx.competitors.addPast(r.id, t.clock.t))).toBe(ErrorCode.RACE_NOT_STARTED)
    const start = t.clock.t
    ctx.raceClock.start(event.id)
    t.clock.advance(30 * MIN)
    ctx.raceClock.end(event.id)
    ctx.teams.delete(r.id, ctx.teams.getDeletionImpact(r.id))
    expect(ctx.competitors.addPast(r.id, start + 10 * MIN).lapNumber).toBe(1)
    expect(ctx.teams.get(r.id).deletedAt).not.toBeNull()
  })

  it('records history for every operation', () => {
    const { event, rival, startAt } = withPasses()
    ctx.competitors.addPast(rival.id, startAt + 5 * MIN)
    const h = t.repos.history.listByEvent(event.id).filter((x) => x.targetTable === 'competitor_passes')
    expect(h.map((x) => x.action)).toEqual(['CREATE', 'CREATE', 'CREATE', 'CREATE'])
    expect(h.at(-1)!.note).toBe('add past record')
  })
})

describe('Provisional standings (§8.3, D-003, D-008, D-023)', () => {
  it('merges own laps and competitor passes and updates after edits/deletes', () => {
    const { event, own, rival, startAt } = startedRace(t, ctx)
    const r2 = ctx.teams.create(event.id, { name: 'R2', bibNumber: '7' })
    t.clock.advance(10 * MIN)
    ctx.laps.register(event.id) // own 1
    t.clock.advance(SEC)
    ctx.competitors.register(rival.id) // rival 1
    t.clock.advance(SEC)
    ctx.competitors.register(r2.id) // r2 1
    t.clock.advance(10 * MIN)
    ctx.competitors.register(rival.id) // rival 2

    let s = ctx.standings.get(event.id)
    expect(s.provisional).toBe(true)
    expect(s.ruleLabel).toContain('暫定')
    expect(s.rows.map((r) => [r.teamName, r.rank, r.laps])).toEqual([
      ['Rival', 1, 2],
      ['Tamagawa', 2, 1],
      ['R2', 3, 1]
    ])
    expect(s.rows[1]).toMatchObject({ isOwnTeam: true, lapsBehindLeader: 1, lapsBehindAhead: 1, timeBehindAheadMs: null })
    expect(s.rows[2]).toMatchObject({ lapsBehindAhead: 0, timeBehindAheadMs: 2 * SEC })

    // 修正：R2 の 1 周目を自チームより前に → 順位が入れ替わる
    const r2pass = ctx.competitors.listByTeam(r2.id)[0]!
    ctx.competitors.updatePassedAt(r2pass.recordId, startAt + 10 * MIN - SEC)
    s = ctx.standings.get(event.id)
    expect(s.rows.map((r) => r.teamName)).toEqual(['Rival', 'R2', 'Tamagawa'])

    // 削除：Rival の 2 周目を削除 → 全チーム 1 周
    ctx.competitors.delete(ctx.competitors.listByTeam(rival.id)[1]!.recordId)
    s = ctx.standings.get(event.id)
    expect(s.rows.map((r) => [r.teamName, r.laps])).toEqual([
      ['R2', 1],
      ['Tamagawa', 1],
      ['Rival', 1]
    ])

    // UNDO で削除を取り消すと元に戻る
    undoLatest(event.id)
    expect(ctx.standings.get(event.id).rows[0]!.teamName).toBe('Rival')
    void own
  })

  it('includes deleted teams with their records, flagged (D-008)', () => {
    const { event, rival } = startedRace(t, ctx)
    t.clock.advance(MIN)
    ctx.competitors.register(rival.id)
    ctx.teams.delete(rival.id, ctx.teams.getDeletionImpact(rival.id))
    const s = ctx.standings.get(event.id)
    const row = s.rows.find((r) => r.teamId === rival.id)!
    expect(row).toMatchObject({ rank: 1, laps: 1, teamDeleted: true })
  })

  it('excludes deleted records', () => {
    const { event, rival } = startedRace(t, ctx)
    t.clock.advance(MIN)
    const p = ctx.competitors.register(rival.id)
    ctx.competitors.delete(p.recordId)
    expect(ctx.standings.get(event.id).rows.find((r) => r.teamId === rival.id)!.laps).toBe(0)
  })
})

describe('UNDO for competitor passes and the relaxed team-creation rule (D-017, D-024)', () => {
  it('undoes competitor add / update / delete', () => {
    const { event, rival, startAt } = startedRace(t, ctx)
    t.clock.advance(10 * MIN)
    const p = ctx.competitors.register(rival.id)
    ctx.competitors.updatePassedAt(p.recordId, startAt + 9 * MIN)
    ctx.competitors.delete(p.recordId)
    undoLatest(event.id)
    expect(ctx.competitors.listByTeam(rival.id)[0]!.passedAt).toBe(startAt + 9 * MIN)
    undoLatest(event.id)
    expect(ctx.competitors.listByTeam(rival.id)[0]!.passedAt).toBe(startAt + 10 * MIN)
    undoLatest(event.id)
    expect(ctx.competitors.listByTeam(rival.id)).toEqual([])
  })

  it('allows undoing a team creation after its records were undone first', () => {
    const event = ctx.events.create({ name: 'x' })
    ctx.raceClock.start(event.id)
    const r = ctx.teams.create(event.id, { name: 'Late entry' })
    t.clock.advance(MIN)
    ctx.competitors.register(r.id)
    undoLatest(event.id) // 通過の取り消し
    undoLatest(event.id) // チーム追加の取り消し（有効な記録がないため可能）
    expect(ctx.teams.get(r.id).deletedAt).not.toBeNull()
    // 取り消された通過記録自体は論理削除で保持されている
    expect(t.repos.competitorPasses.listByTeam(r.id, { includeDeleted: true })).toHaveLength(1)
  })

  it('refuses restoring a deleted pass that now duplicates a newer pass', () => {
    const { event, rival, startAt } = startedRace(t, ctx)
    t.clock.advance(10 * MIN)
    const p = ctx.competitors.register(rival.id)
    ctx.competitors.delete(p.recordId)
    // 同じ日時の通過を再登録（過去記録の追加）
    ctx.competitors.addPast(rival.id, startAt + 10 * MIN)
    undoLatest(event.id) // 再登録の取り消し
    undoLatest(event.id) // 削除の取り消し → 復元できる（重複はもう無い）
    expect(ctx.competitors.listByTeam(rival.id)).toHaveLength(1)
  })
})
