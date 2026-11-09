import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCode } from '../../src/shared/errors'
import type { AppContext } from '../../src/main/app-context'
import { createTestDb, type TestDb } from '../helpers/db'
import { MIN, bootApp, errorCode, startedRace } from '../helpers/app'

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

describe('Operators (spec §10, D-030..D-035)', () => {
  it('are shared across events and listed without deleted ones', () => {
    const a = ctx.operators.create('佐藤')
    const b = ctx.operators.create('鈴木')
    ctx.events.create({ name: 'E1' })
    ctx.events.create({ name: 'E2' })
    expect(ctx.operators.list().map((o) => o.name)).toEqual(['佐藤', '鈴木'])
    ctx.operators.delete(b.id)
    expect(ctx.operators.list().map((o) => o.id)).toEqual([a.id])
    expect(ctx.operators.list({ includeDeleted: true })).toHaveLength(2)
    expect(errorCode(() => ctx.operators.select(b.id))).toBe(ErrorCode.OPERATOR_NOT_FOUND)
  })

  it('validates names', () => {
    expect(errorCode(() => ctx.operators.create(''))).toBe(ErrorCode.VALIDATION)
    expect(errorCode(() => ctx.operators.create('   '))).toBe(ErrorCode.VALIDATION)
    const a = ctx.operators.create('A')
    expect(errorCode(() => ctx.operators.rename(a.id, ''))).toBe(ErrorCode.VALIDATION)
  })

  it('records operations without an operator as "unset" and never rejects them (D-032)', () => {
    const { event } = startedRace(t, ctx)
    expect(ctx.operators.current()).toBeNull()
    t.clock.advance(MIN)
    ctx.laps.register(event.id)
    expect(t.repos.history.listByEvent(event.id).at(-1)).toMatchObject({ operatorId: null, operatorNameSnapshot: null })
  })

  it('switches operators without stopping the clock and without logging the switch (D-034)', () => {
    const { event } = startedRace(t, ctx)
    const a = ctx.operators.create('A')
    const b = ctx.operators.create('B')
    const historyBefore = t.repos.history.listAll().length
    ctx.operators.select(a.id)
    ctx.operators.select(b.id)
    ctx.operators.select(null)
    expect(t.repos.history.listAll()).toHaveLength(historyBefore)
    expect(ctx.raceClock.getState(event.id).status).toBe('RUNNING')
    ctx.operators.select(a.id)
    t.clock.advance(MIN)
    ctx.laps.register(event.id)
    ctx.operators.select(b.id)
    t.clock.advance(MIN)
    ctx.laps.register(event.id)
    const h = t.repos.history.listByEvent(event.id).slice(-2)
    expect(h.map((x) => [x.operatorId, x.operatorNameSnapshot])).toEqual([
      [a.id, 'A'],
      [b.id, 'B']
    ])
  })

  it('keeps historical name snapshots after rename / delete (D-031)', () => {
    const { event } = startedRace(t, ctx)
    const a = ctx.operators.create('旧名')
    ctx.operators.select(a.id)
    t.clock.advance(MIN)
    ctx.laps.register(event.id)
    ctx.operators.rename(a.id, '新名')
    t.clock.advance(MIN)
    ctx.laps.register(event.id) // 選択中のまま改名 → 以後は新しい名前
    ctx.operators.delete(a.id)
    expect(ctx.operators.current()).toBeNull() // 削除した操作者は未選択に戻る
    t.clock.advance(MIN)
    ctx.laps.register(event.id)
    const names = t.repos.history
      .listByEvent(event.id)
      .filter((x) => x.targetTable === 'lap_records')
      .map((x) => x.operatorNameSnapshot)
    expect(names).toEqual(['旧名', '新名', null])
  })

  it('logs operator create/rename/delete in history (global, not undoable, D-035)', () => {
    const e = ctx.events.create({ name: 'x' })
    const a = ctx.operators.create('A')
    ctx.operators.rename(a.id, 'A2')
    ctx.operators.delete(a.id)
    const h = t.repos.history.listAll().filter((x) => x.targetTable === 'operators')
    expect(h.map((x) => [x.action, x.eventId])).toEqual([
      ['CREATE', null],
      ['UPDATE', null],
      ['DELETE', null]
    ])
    expect(JSON.parse(h[1]!.beforeJson!).name).toBe('A')
    expect(JSON.parse(h[1]!.afterJson!).name).toBe('A2')
    // UNDO の対象にならない（大会の UNDO 候補は大会作成のみ → 対象外なので null）
    expect(ctx.undo.peek(e.id)).toBeNull()
  })

  it('starts unselected after a restart (D-033)', () => {
    const a = ctx.operators.create('A')
    ctx.operators.select(a.id)
    t = t.reopen()
    ctx = bootApp(t)
    expect(ctx.operators.current()).toBeNull()
    expect(ctx.operators.list().map((o) => o.name)).toEqual(['A'])
  })
})

describe('Memos (spec §9, D-036..D-038)', () => {
  it('stores free text with the master-clock time, verbatim', () => {
    const { event } = startedRace(t, ctx)
    t.clock.advance(MIN)
    const body = 'ピットイン 12:03,タイヤ交換\n"ドライバー"交代　（全角空白）'
    const m = ctx.memos.create(event.id, body)
    expect(m.body).toBe(body)
    expect(m.notedAt).toBe(t.clock.t)
    expect(ctx.memos.list(event.id).map((x) => x.id)).toEqual([m.id])
  })

  it('rejects empty / whitespace-only bodies (D-038)', () => {
    const e = ctx.events.create({ name: 'x' })
    for (const b of ['', '   ', '\n\t', '　'] as const) {
      expect(errorCode(() => ctx.memos.create(e.id, b))).toBe(ErrorCode.VALIDATION)
    }
    expect(errorCode(() => ctx.memos.create(e.id, 123))).toBe(ErrorCode.VALIDATION)
    expect(ctx.memos.list(e.id)).toEqual([])
    const m = ctx.memos.create(e.id, 'ok')
    expect(errorCode(() => ctx.memos.updateBody(m.id, ' '))).toBe(ErrorCode.VALIDATION)
  })

  it('edits body only; the time never changes (D-036, D-037)', () => {
    const e = ctx.events.create({ name: 'x' })
    const m = ctx.memos.create(e.id, '雨が降り始めた')
    t.clock.advance(5 * MIN)
    const u = ctx.memos.updateBody(m.id, '小雨が降り始めた')
    expect(u.body).toBe('小雨が降り始めた')
    expect(u.notedAt).toBe(m.notedAt)
    // Repository レベルでも日時は更新できない
    expect(() => t.repos.memos.update(m.id, { notedAt: 1 } as never)).toThrow(/not updatable/)
    const h = t.repos.history.listByEvent(e.id).at(-1)!
    expect(JSON.parse(h.beforeJson!)).toMatchObject({ body: '雨が降り始めた', notedAt: m.notedAt })
    expect(JSON.parse(h.afterJson!)).toMatchObject({ body: '小雨が降り始めた', notedAt: m.notedAt })
  })

  it('works in any race state, including after END', () => {
    const { event } = startedRace(t, ctx)
    ctx.raceClock.end(event.id)
    expect(ctx.memos.create(event.id, '終了後のメモ').body).toBe('終了後のメモ')
  })

  it('deletes logically and supports UNDO of create / edit / delete', () => {
    const e = ctx.events.create({ name: 'x' })
    const m = ctx.memos.create(e.id, 'v1')
    ctx.memos.updateBody(m.id, 'v2')
    ctx.memos.updateBody(m.id, 'v3')
    ctx.memos.delete(m.id)
    expect(ctx.memos.list(e.id)).toEqual([])
    expect(t.repos.memos.findById(m.id, { includeDeleted: true })?.body).toBe('v3')
    undoLatest(e.id)
    expect(ctx.memos.list(e.id)[0]!.body).toBe('v3')
    undoLatest(e.id)
    expect(ctx.memos.list(e.id)[0]!.body).toBe('v2')
    undoLatest(e.id)
    expect(ctx.memos.list(e.id)[0]).toMatchObject({ body: 'v1', notedAt: m.notedAt })
    undoLatest(e.id)
    expect(ctx.memos.list(e.id)).toEqual([])
  })

  it('validates event existence and memo existence', () => {
    expect(errorCode(() => ctx.memos.create(999, 'x'))).toBe(ErrorCode.EVENT_NOT_FOUND)
    expect(errorCode(() => ctx.memos.updateBody(999, 'x'))).toBe(ErrorCode.RECORD_NOT_FOUND)
  })
})

describe('Operation history requirements (spec §11, §18)', () => {
  it('records add / edit / delete / undo with operator, time, target and before/after', () => {
    const e = ctx.events.create({ name: 'x' })
    const op = ctx.operators.create('記録係')
    ctx.operators.select(op.id)
    t.clock.advance(1000)
    const m = ctx.memos.create(e.id, 'a')
    ctx.memos.updateBody(m.id, 'b')
    ctx.memos.delete(m.id)
    undoLatest(e.id)
    const h = t.repos.history.listByEvent(e.id).filter((x) => x.targetTable === 'memos')
    expect(h.map((x) => x.action)).toEqual(['CREATE', 'UPDATE', 'DELETE', 'UNDO'])
    for (const x of h) {
      expect(x).toMatchObject({ operatorId: op.id, operatorNameSnapshot: '記録係', targetTable: 'memos', targetId: m.id })
      expect(typeof x.operatedAt).toBe('number')
    }
    expect(h[0]!.beforeJson).toBeNull()
    expect(JSON.parse(h[1]!.beforeJson!).body).toBe('a')
    expect(JSON.parse(h[1]!.afterJson!).body).toBe('b')
    expect(JSON.parse(h[2]!.afterJson!).deletedAt).not.toBeNull()
    expect(h[3]!.undoOfHistoryId).toBe(h[2]!.id)
  })
})
