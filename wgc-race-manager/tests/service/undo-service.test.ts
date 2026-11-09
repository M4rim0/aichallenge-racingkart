import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCode } from '../../src/shared/errors'
import type { AppContext } from '../../src/main/app-context'
import { runAudited } from '../../src/main/db/unit-of-work'
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
  const c = ctx.undo.peek(eventId)
  if (!c) throw new Error('nothing to undo')
  return ctx.undo.undo(eventId, c.operationGroup)
}

describe('UNDO basics (D-017)', () => {
  it('has nothing to undo when only clock / event operations exist', () => {
    const event = ctx.events.create({ name: 'x' })
    ctx.events.update(event.id, { name: 'y' })
    ctx.raceClock.start(event.id)
    ctx.raceClock.pause(event.id)
    expect(ctx.undo.peek(event.id)).toBeNull()
    expect(errorCode(() => ctx.undo.undo(event.id, 'x'))).toBe(ErrorCode.NOTHING_TO_UNDO)
  })

  it('skips clock transitions and undoes the latest record operation', () => {
    const { event } = startedRace(t, ctx)
    t.clock.advance(MIN)
    const lap = ctx.laps.register(event.id)
    ctx.raceClock.pause(event.id) // 時計操作は UNDO 対象外
    const c = ctx.undo.peek(event.id)!
    expect(c.description).toContain('自チームラップ記録の追加')
    ctx.undo.undo(event.id, c.operationGroup)
    expect(ctx.laps.list(event.id)).toEqual([])
    expect(t.repos.lapRecords.findById(lap.recordId, { includeDeleted: true })?.deletedAt).not.toBeNull()
    // 時計は戻らない
    expect(ctx.raceClock.getState(event.id).status).toBe('PAUSED')
  })

  it('supports multiple levels without REDO, and records UNDO in history', () => {
    const { event, startAt } = startedRace(t, ctx)
    t.clock.advance(10 * MIN)
    const l1 = ctx.laps.register(event.id)
    t.clock.advance(10 * MIN)
    ctx.laps.register(event.id)
    ctx.laps.updatePassedAt(l1.recordId, startAt + 9 * MIN)

    undoLatest(event.id) // 修正の取り消し
    expect(ctx.laps.list(event.id)[0]!.passedAt).toBe(startAt + 10 * MIN)
    undoLatest(event.id) // 2 周目の追加の取り消し
    expect(ctx.laps.list(event.id)).toHaveLength(1)
    undoLatest(event.id) // 1 周目の追加の取り消し
    expect(ctx.laps.list(event.id)).toHaveLength(0)
    // 次はチームの追加（他チーム → 自チームの順に新しい）
    expect(ctx.undo.peek(event.id)!.description).toContain('チームの追加')

    const undos = t.repos.history.listByEvent(event.id).filter((h) => h.action === 'UNDO')
    expect(undos).toHaveLength(3)
    for (const u of undos) {
      expect(u.undoOfHistoryId).not.toBeNull()
      expect(u.beforeJson).not.toBeNull()
      expect(u.afterJson).not.toBeNull()
    }
    // UNDO 自体は取り消し対象にならない（REDO なし）
    const peeked = ctx.undo.peek(event.id)!
    expect(peeked.historyIds.every((id) => !undos.some((u) => u.id === id))).toBe(true)
  })

  it('works across operator switches and records the current operator', () => {
    const { event } = startedRace(t, ctx)
    ctx.operator.set({ id: null, name: 'A' })
    t.clock.advance(MIN)
    ctx.laps.register(event.id)
    ctx.operator.set({ id: null, name: 'B' })
    const c = ctx.undo.peek(event.id)!
    expect(c.operatorName).toBe('A')
    ctx.undo.undo(event.id, c.operationGroup)
    expect(t.repos.history.listByEvent(event.id).at(-1)).toMatchObject({ action: 'UNDO', operatorNameSnapshot: 'B' })
  })

  it('refuses a stale confirmation', () => {
    const { event } = startedRace(t, ctx)
    t.clock.advance(MIN)
    ctx.laps.register(event.id)
    const c = ctx.undo.peek(event.id)!
    t.clock.advance(MIN)
    ctx.laps.register(event.id) // 確認後に別の操作
    expect(errorCode(() => ctx.undo.undo(event.id, c.operationGroup))).toBe(ErrorCode.UNDO_STALE)
    expect(ctx.laps.list(event.id)).toHaveLength(2)
  })

  it('keeps events independent', () => {
    const a = startedRace(t, ctx)
    const b = startedRace(t, ctx)
    t.clock.advance(MIN)
    ctx.laps.register(a.event.id)
    undoLatest(b.event.id) // b のチーム追加が対象で、a のラップは対象外
    expect(ctx.laps.list(a.event.id)).toHaveLength(1)
  })
})

describe('UNDO integrity checks (D-017)', () => {
  it('undoes repeated delete/restore cycles on the same row step by step', () => {
    const event = ctx.events.create({ name: 'x' })
    const r = ctx.teams.create(event.id, { name: 'R' })
    ctx.teams.delete(r.id, ctx.teams.getDeletionImpact(r.id))
    t.clock.advance(1)
    ctx.teams.restore(r.id)
    t.clock.advance(1)
    ctx.teams.delete(r.id, ctx.teams.getDeletionImpact(r.id))
    undoLatest(event.id)
    expect(ctx.teams.get(r.id).deletedAt).toBeNull()
    undoLatest(event.id)
    expect(ctx.teams.get(r.id).deletedAt).not.toBeNull()
    undoLatest(event.id)
    expect(ctx.teams.get(r.id).deletedAt).toBeNull()
    undoLatest(event.id) // 追加の取り消し（記録なし）
    expect(ctx.teams.get(r.id).deletedAt).not.toBeNull()
    expect(ctx.undo.peek(event.id)).toBeNull()
  })

  it('refuses when the row was changed after the operation (snapshot mismatch)', () => {
    const { event } = startedRace(t, ctx)
    t.clock.advance(MIN)
    const lap = ctx.laps.register(event.id)
    // 対象外の経路（将来の機能や直接変更）で行が変更された状況
    t.repos.lapRecords.update(lap.recordId, { passedAt: lap.passedAt - 1 })
    expect(errorCode(() => undoLatest(event.id))).toBe(ErrorCode.UNDO_CONFLICT)
    expect(ctx.laps.list(event.id)).toHaveLength(1)
    expect(t.repos.history.listByEvent(event.id).filter((h) => h.action === 'UNDO')).toEqual([])
  })

  it('refuses restoring a deleted lap that would now be before the corrected start', () => {
    const { event, startAt } = startedRace(t, ctx)
    t.clock.advance(MIN)
    ctx.laps.register(event.id)
    t.clock.advance(MIN)
    ctx.laps.register(event.id)
    const [l1] = ctx.laps.list(event.id)
    ctx.laps.delete(l1!.recordId)
    // 開始時刻の修正は UNDO 対象外。修正後は 1 周目の日時が開始時刻以前になる
    ctx.raceClock.correctActualStart(event.id, startAt + MIN + 30_000 - 30_000) // = l1 の通過日時
    expect(errorCode(() => undoLatest(event.id))).toBe(ErrorCode.UNDO_CONFLICT)
    expect(ctx.laps.list(event.id)).toHaveLength(1)
  })

  it('refuses undoing a lap addition when vehicle data is attached', () => {
    const { event } = startedRace(t, ctx)
    t.clock.advance(MIN)
    const lap = ctx.laps.register(event.id)
    t.repos.vehicleData.insert({ lapRecordId: lap.recordId, speed: '60' }) // 段階7の機能を直接再現
    expect(errorCode(() => undoLatest(event.id))).toBe(ErrorCode.UNDO_CONFLICT)
  })

  it('undoes team delete/restore and refuses undoing creation of a team with records', () => {
    const { event, rival, own } = startedRace(t, ctx)
    t.repos.competitorPasses.insert({ eventId: event.id, teamId: rival.id, passedAt: t.clock.t + 1 })
    ctx.teams.delete(rival.id, ctx.teams.getDeletionImpact(rival.id))
    undoLatest(event.id) // 削除の取り消し → 復元
    expect(ctx.teams.get(rival.id).deletedAt).toBeNull()
    ctx.teams.delete(rival.id, ctx.teams.getDeletionImpact(rival.id))
    ctx.teams.restore(rival.id)
    undoLatest(event.id) // 復元の取り消し → 再び削除
    expect(ctx.teams.get(rival.id).deletedAt).not.toBeNull()
    undoLatest(event.id) // 削除の取り消し
    expect(ctx.teams.get(rival.id).deletedAt).toBeNull()
    // 1 回目の削除は取り消し済みなので飛ばされ、次の対象は rival の追加。記録があるため取り消せない
    expect(ctx.undo.peek(event.id)!.description).toContain(`チームの追加（id=${rival.id}）`)
    expect(errorCode(() => undoLatest(event.id))).toBe(ErrorCode.UNDO_CONFLICT)
    expect(ctx.teams.get(rival.id).deletedAt).toBeNull()
    expect(ctx.teams.get(own.id).deletedAt).toBeNull()
  })

  it('refuses undoing a team creation when the team has records', () => {
    const event = ctx.events.create({ name: 'x' })
    const rival = ctx.teams.create(event.id, { name: 'R' })
    t.repos.competitorPasses.insert({ eventId: event.id, teamId: rival.id, passedAt: 1 })
    expect(errorCode(() => undoLatest(event.id))).toBe(ErrorCode.UNDO_CONFLICT)
    expect(ctx.teams.get(rival.id).deletedAt).toBeNull()
  })

  it('refuses restoring an old own team when another own team now exists', () => {
    const event = ctx.events.create({ name: 'x' })
    const a = ctx.teams.create(event.id, { name: 'A', isOwnTeam: true })
    ctx.teams.delete(a.id, ctx.teams.getDeletionImpact(a.id))
    // 別の自チームを、UNDO 対象外の経路で作成した状況（直接挿入）
    t.repos.teams.insert({ eventId: event.id, name: 'B', isOwnTeam: true })
    expect(errorCode(() => undoLatest(event.id))).toBe(ErrorCode.UNDO_CONFLICT)
    expect(ctx.teams.get(a.id).deletedAt).not.toBeNull()
  })

  it('reverts team edits including the own-team flag only when consistent', () => {
    const event = ctx.events.create({ name: 'x' })
    const r = ctx.teams.create(event.id, { name: 'R', bibNumber: '5' })
    ctx.teams.update(r.id, { name: 'R2', bibNumber: null, isOwnTeam: true })
    undoLatest(event.id)
    expect(ctx.teams.get(r.id)).toMatchObject({ name: 'R', bibNumber: '5', isOwnTeam: false })
  })

  it('rolls back the whole operation group if any entry conflicts', () => {
    const { event } = startedRace(t, ctx)
    t.clock.advance(MIN)
    const l1 = ctx.laps.register(event.id)
    t.clock.advance(MIN)
    const l2 = ctx.laps.register(event.id)
    // 2 行を 1 操作で削除したグループを作る
    runAudited(t.db, t.repos, { eventId: event.id, operator: { id: null, name: null } }, () => {
      const d1 = t.repos.lapRecords.softDelete(l1.recordId)
      const d2 = t.repos.lapRecords.softDelete(l2.recordId)
      return {
        result: null,
        changes: [
          { action: 'DELETE', targetTable: 'lap_records', targetId: l1.recordId, before: d1.before, after: d1.after },
          { action: 'DELETE', targetTable: 'lap_records', targetId: l2.recordId, before: d2.before, after: d2.after }
        ]
      }
    })
    // 片方だけ後から変更された状態にする
    t.db.prepare('UPDATE lap_records SET passed_at = passed_at + 1 WHERE id = ?').run(l1.recordId)
    expect(errorCode(() => undoLatest(event.id))).toBe(ErrorCode.UNDO_CONFLICT)
    // どちらも復元されていない
    expect(ctx.laps.list(event.id)).toEqual([])
  })

  it('undoes vehicle data and memo operations recorded in history', () => {
    const { event } = startedRace(t, ctx)
    t.clock.advance(MIN)
    const lap = ctx.laps.register(event.id)
    const ctxA = { eventId: event.id, operator: { id: null, name: null } }
    const v = runAudited(t.db, t.repos, ctxA, () => {
      const c = t.repos.vehicleData.insert({ lapRecordId: lap.recordId, speed: '50' })
      return { result: c, changes: [{ action: 'CREATE', targetTable: 'vehicle_data', targetId: c.id, before: null, after: c }] }
    })
    runAudited(t.db, t.repos, ctxA, () => {
      const { before, after } = t.repos.vehicleData.update(v.id, { speed: '55' })
      return { result: null, changes: [{ action: 'UPDATE', targetTable: 'vehicle_data', targetId: v.id, before, after }] }
    })
    const m = runAudited(t.db, t.repos, ctxA, () => {
      const c = t.repos.memos.insert({ eventId: event.id, body: 'ピットイン', notedAt: t.clock.t })
      return { result: c, changes: [{ action: 'CREATE', targetTable: 'memos', targetId: c.id, before: null, after: c }] }
    })
    undoLatest(event.id)
    expect(t.repos.memos.findById(m.id)).toBeNull()
    undoLatest(event.id)
    expect(t.repos.vehicleData.findById(v.id)?.speed).toBe('50')
    undoLatest(event.id)
    expect(t.repos.vehicleData.findById(v.id)).toBeNull()
    undoLatest(event.id) // これで車両データが無くなったのでラップ追加も取り消せる
    expect(ctx.laps.list(event.id)).toEqual([])
  })
})
