import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StrategyInput } from '../../src/shared/strategy/engine'
import { ErrorCode } from '../../src/shared/errors'
import { WarningService, fingerprint } from '../../src/main/services/warning-service'
import type { StrategyService } from '../../src/main/services/strategy-service'
import { MasterClock } from '../../src/main/clock/master-clock'
import { FakeNow, createTestDb, type TestDb } from '../helpers/db'
import { bootApp, errorCode, MIN } from '../helpers/app'
import type { AppContext } from '../../src/main/app-context'
import { M, T0, every, finiteDeep, input, laps, own, team } from './helpers'

/** 入力を差し替えられる偽の戦略サービス（純粋な状態遷移を確認するため） */
function harness() {
  const time = new FakeNow(T0)
  const clock = new MasterClock(time, 'boot-w')
  let current: StrategyInput | null = null
  const fake = { buildInput: () => ({ ...current!, now: clock.now() }) } as unknown as StrategyService
  const svc = new WarningService(fake, clock)
  return {
    svc,
    time,
    set(i: StrategyInput) {
      current = i
      time.t = i.now
    },
    eval: () => svc.evaluate(1)
  }
}

/** 他チーム A：7 周 10 分のあと直近 3 周 x 分（3 周平均 x、10 周平均 (70+3x)/10） */
function paceInput(x: number, extraTeams: ReturnType<typeof team>[] = []): StrategyInput {
  const a = laps(5, [10, 10, 10, 10, 10, 10, 10, x, x, x])
  const last = a.at(-1)!
  return input([team(2, 'A', a), ...extraTeams], last + 1)
}
const teamPace = (l: ReturnType<WarningService['evaluate']>) => l.visible.filter((w) => w.type === 'TEAM_PACE')

describe('Warning lifecycle (D-059, D-060)', () => {
  it('raises once and keeps the same warning while the condition continues (no duplicates)', () => {
    const h = harness()
    h.set(paceInput(9.2)) // −5.7% → 情報
    const first = teamPace(h.eval())
    expect(first).toMatchObject([{ severity: 'INFO', phase: 'NEW', kind: 'FASTER' }])
    h.time.advance(1000)
    const second = teamPace(h.eval())
    expect(second).toHaveLength(1)
    // 同じ警告のまま（重複しない）。発生から 10 秒未満なので「新規」のまま（W-10）
    expect(second[0]).toMatchObject({ occurrenceId: first[0]!.occurrenceId, phase: 'NEW', raisedAt: first[0]!.raisedAt })
    expect(second[0]!.updatedAt).toBeGreaterThan(first[0]!.updatedAt)
  })

  it('keeps NEW for 10 seconds after raising, then CONTINUING (W-10 boundary)', () => {
    const h = harness()
    h.set(paceInput(9.2))
    const raisedAt = teamPace(h.eval())[0]!.raisedAt
    h.time.t = raisedAt + 9_999
    expect(teamPace(h.eval())[0]!.phase).toBe('NEW')
    h.time.t = raisedAt + 10_000
    expect(teamPace(h.eval())[0]!.phase).toBe('CONTINUING')
  })

  it('restarts the 10-second NEW period on escalation', () => {
    const h = harness()
    h.set(paceInput(9.2))
    const w = teamPace(h.eval())[0]!
    h.time.t = w.raisedAt + 30_000
    expect(teamPace(h.eval())[0]!.phase).toBe('CONTINUING')
    const i = paceInput(8.5)
    h.set({ ...i, now: w.raisedAt + 31_000 })
    const esc = teamPace(h.eval())[0]!
    expect(esc).toMatchObject({ occurrenceId: w.occurrenceId, severity: 'CAUTION', phase: 'NEW', escalatedAt: w.raisedAt + 31_000 })
    h.time.t = w.raisedAt + 31_000 + 10_000
    expect(teamPace(h.eval())[0]!.phase).toBe('CONTINUING')
  })

  it('clears when the condition resolves and re-raises as a new warning', () => {
    const h = harness()
    h.set(paceInput(9.2))
    const id1 = teamPace(h.eval())[0]!.occurrenceId
    h.set(paceInput(10)) // 変化なし → 解除
    expect(teamPace(h.eval())).toEqual([])
    h.set(paceInput(9.2))
    const again = teamPace(h.eval())[0]!
    expect(again.occurrenceId).not.toBe(id1)
    expect(again.phase).toBe('NEW')
  })

  it('hides acknowledged warnings; escalation resets acknowledgement; de-escalation keeps it', () => {
    const h = harness()
    h.set(paceInput(9.2))
    const w = teamPace(h.eval())[0]!
    h.svc.acknowledge(1, w.occurrenceId)
    let l = h.eval()
    expect(teamPace(l)).toEqual([])
    expect(l.acknowledgedCount).toBe(1)

    h.set(paceInput(8.5)) // −11% → 注意（上昇）
    l = h.eval()
    expect(teamPace(l)).toMatchObject([{ occurrenceId: w.occurrenceId, severity: 'CAUTION', phase: 'NEW', acknowledged: false }])
    expect(teamPace(l)[0]!.escalatedAt).not.toBeNull()

    h.svc.acknowledge(1, w.occurrenceId)
    h.set(paceInput(9.2)) // 情報に低下 → 確認済みのまま
    l = h.eval()
    expect(teamPace(l)).toEqual([])
    expect(l.acknowledgedCount).toBe(1)

    h.set(paceInput(10)) // 解消 → 確認済みかどうかに関係なく解除
    l = h.eval()
    expect(l.acknowledgedCount).toBe(0)
    h.set(paceInput(9.2)) // 再発生 → 新しい警告として表示
    expect(teamPace(h.eval())).toMatchObject([{ phase: 'NEW', acknowledged: false }])
  })

  it('treats a direction change as a different warning (separate keys)', () => {
    const h = harness()
    h.set(paceInput(9.2))
    const faster = teamPace(h.eval())[0]!
    h.set(paceInput(11)) // +6.8% → 遅くなった
    const l = teamPace(h.eval())
    expect(l).toHaveLength(1)
    expect(l[0]).toMatchObject({ kind: 'SLOWER', key: 'TEAM_PACE:2:SLOWER' })
    expect(l[0]!.occurrenceId).not.toBe(faster.occurrenceId)
  })

  it('refuses acknowledging a resolved or re-raised warning by its old id', () => {
    const h = harness()
    h.set(paceInput(9.2))
    const id = teamPace(h.eval())[0]!.occurrenceId
    h.set(paceInput(10))
    h.eval()
    expect(errorCode(() => h.svc.acknowledge(1, id))).toBe(ErrorCode.WARNING_NOT_FOUND)
    h.set(paceInput(9.2))
    h.eval()
    expect(errorCode(() => h.svc.acknowledge(1, id))).toBe(ErrorCode.WARNING_NOT_FOUND)
  })

  it('resets everything on restart (new service instance)', () => {
    const h = harness()
    h.set(paceInput(9.2))
    const w = teamPace(h.eval())[0]!
    h.svc.acknowledge(1, w.occurrenceId)
    const h2 = harness() // 再起動相当
    h2.set(paceInput(9.2))
    const l = h2.eval()
    expect(teamPace(l)).toMatchObject([{ phase: 'NEW', acknowledged: false }])
    expect(l.acknowledgedCount).toBe(0)
  })

  it('sorts visible warnings by severity', () => {
    const h = harness()
    const b = team(3, 'B', laps(20, [10, 10, 10, 10, 10, 10, 10, 8, 8, 8])) // −14.9% 注意（最後 114 分）
    const i = paceInput(13, []) // A: +19.3% 重大（最後 114 分）
    i.teams = [...i.teams, b]
    i.now = T0 + 115 * M
    h.set(i)
    expect(h.eval().visible.map((w) => w.severity)).toEqual(['CRITICAL', 'CAUTION'])
  })
})

describe('Predicted rank change baseline (W-5)', () => {
  const ownTeam = own(every(10, 10, 125))
  const slow = team(4, 'R3', every(20.5, 10.5, 125)) // 予測でも自チームが前
  const fast = team(4, 'R3', every(20.5, 9.5, 125)) // 予測で自チームを抜く（自チームの予測 2 位）

  it('compares with the prediction before the last data change, not every refresh', () => {
    const h = harness()
    h.set(input([ownTeam, slow], 125))
    expect(h.eval().visible.filter((w) => w.type === 'PREDICTED_RANK_CHANGE')).toEqual([])
    h.set(input([ownTeam, fast], 125)) // 元データが変わった → 前回 1 位、今回 2 位
    let l = h.eval().visible.filter((w) => w.type === 'PREDICTED_RANK_CHANGE')
    expect(l).toMatchObject([{ severity: 'INFO', kind: 'DOWN', basis: { previousPredictedRank: 1, currentPredictedRank: 2, currentRank: 1 } }])
    const id = l[0]!.occurrenceId
    // 時間の経過だけ（元データ不変）では前回値を更新しない → 警告は継続
    h.time.advance(30_000)
    l = h.eval().visible.filter((w) => w.type === 'PREDICTED_RANK_CHANGE')
    expect(l).toMatchObject([{ occurrenceId: id, phase: 'CONTINUING' }])
    // 次に元データが変わり、予測順位が変わらなければ解除
    const fast2 = { ...fast, passes: [...fast.passes] }
    h.set(input([ownTeam, fast2, team(9, 'Extra', [])], 125))
    expect(h.eval().visible.filter((w) => w.type === 'PREDICTED_RANK_CHANGE')).toEqual([])
  })

  it('fingerprint ignores the current time but reacts to records, stoppages and schedule', () => {
    const a = input([ownTeam, slow], 125)
    expect(fingerprint(a)).toBe(fingerprint({ ...a, now: a.now + 5000 }))
    expect(fingerprint(a)).not.toBe(fingerprint({ ...a, scheduledEndAt: a.scheduledEndAt! + 1 }))
    expect(fingerprint(a)).not.toBe(fingerprint({ ...a, stoppages: [{ startsAt: 1, endsAt: null }] }))
    expect(fingerprint(a)).not.toBe(fingerprint(input([ownTeam, fast], 125)))
  })
})

describe('Integration with the app (DB, clock, UNDO)', () => {
  let t: TestDb
  let ctx: AppContext
  beforeEach(() => {
    t = createTestDb()
    ctx = bootApp(t)
  })
  afterEach(() => t.cleanup())

  it('warns about a rival’s pace change from real records, follows UNDO, and resets on restart', () => {
    const event = ctx.events.create({ name: 'WGC', scheduledStartAt: t.clock.t, scheduledEndAt: t.clock.t + 480 * MIN })
    ctx.teams.create(event.id, { name: 'Own', isOwnTeam: true })
    const rival = ctx.teams.create(event.id, { name: 'Rival' })
    ctx.raceClock.start(event.id)
    const lapTimes = [5, 10, 10, 10, 10, 10, 10, 10, 10, 8, 8, 8] // 初回通過 5 分、以降 11 ラップ（3 周平均 8、10 周平均 9.4 → −14.9%）
    for (const m of lapTimes) {
      t.clock.advance(m * MIN)
      ctx.competitors.register(rival.id)
    }
    t.clock.advance(MIN)
    let l = ctx.warnings.evaluate(event.id)
    const w = l.visible.find((x) => x.type === 'TEAM_PACE' && x.teamId === rival.id)!
    expect(w).toMatchObject({ severity: 'CAUTION', kind: 'FASTER', phase: 'NEW' })
    expect(finiteDeep(l)).toBe(true)

    // UNDO で最後の通過を取り消す → 3 周平均が変わり、警告が更新される
    const c = ctx.undo.peek(event.id)!
    ctx.undo.undo(event.id, c.operationGroup)
    l = ctx.warnings.evaluate(event.id)
    const after = l.visible.find((x) => x.type === 'TEAM_PACE' && x.teamId === rival.id)
    // 取り消し後：3 周平均 (10+8+8)/3 = 8.67、10 周平均 (80+16)/10 = 9.6 → −9.7% → 情報（重要度が下がっても同じ警告）
    expect(after).toMatchObject({ occurrenceId: w.occurrenceId, severity: 'INFO' })

    // 警告は操作履歴・DB に何も残さない
    expect(t.repos.history.listByEvent(event.id).some((h) => h.targetTable.includes('warning'))).toBe(false)
    const tables = (t.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((x) => x.name)
    expect(tables.some((n) => n.includes('warning'))).toBe(false)

    // 再起動相当：状態はリセット
    ctx.warnings.acknowledge(event.id, w.occurrenceId)
    const ctx2 = bootApp(t)
    const l2 = ctx2.warnings.evaluate(event.id)
    expect(l2.acknowledgedCount).toBe(0)
    expect(l2.visible.find((x) => x.type === 'TEAM_PACE')!.phase).toBe('NEW')
  })

  it('issues nothing before START and after END', () => {
    const event = ctx.events.create({ name: 'x', scheduledEndAt: t.clock.t + 480 * MIN })
    ctx.teams.create(event.id, { name: 'Own', isOwnTeam: true })
    expect(ctx.warnings.evaluate(event.id).visible).toEqual([])
    ctx.raceClock.start(event.id)
    ctx.raceClock.end(event.id)
    expect(ctx.warnings.evaluate(event.id).visible).toEqual([])
  })
})

describe('Stale records do not clear existing warnings (decision B, 2026-11-10)', () => {
  /** 9.5 分 × 8 周の後に 12 分のラップが続き、その後 9.5 分に戻るチーム（初回通過 2 分）。分単位で評価する */
  function faderRun(lapTimes: number[], onEach: (min: number, l: ReturnType<WarningService['evaluate']>, svc: WarningService) => void) {
    const time = new FakeNow(T0)
    const clock = new MasterClock(time, 'boot-fader')
    const passes = laps(2, lapTimes)
    let cur = input([team(2, 'Fader', [2])], 3)
    const svc = new WarningService({ buildInput: () => ({ ...cur, now: clock.now() }) } as unknown as StrategyService, clock)
    for (let m = 2; m <= passes.at(-1)! + 5; m++) {
      time.t = T0 + m * M
      cur = input([team(2, 'Fader', passes.filter((p) => p <= m))], m)
      onEach(m, svc.evaluate(1), svc)
    }
    return passes
  }
  const slow = [9.5, 9.5, 9.5, 9.5, 9.5, 9.5, 9.5, 9.5, 12, 12, 12, 12, 12, 9.5, 9.5, 9.5, 9.5, 9.5, 9.5, 9.5, 9.5, 9.5, 9.5, 9.5, 9.5]
  const levels: Record<string, number> = { INFO: 1, CAUTION: 2, CRITICAL: 3 }

  it('keeps one occurrence through the stale windows between slow laps (no re-raise every lap)', () => {
    const occurrences = new Set<string>()
    let staleWhileActive = 0
    let prev: { id: string; severity: string } | null = null
    faderRun(slow, (_m, l) => {
      const w = l.visible.find((x) => x.key === 'TEAM_PACE:2:SLOWER')
      const stale = l.suppressed.some((s) => s.type === 'TEAM_PACE' && s.teamId === 2 && s.reason === 'STALE_RECORD')
      if (w) {
        occurrences.add(w.occurrenceId)
        if (stale && prev) {
          staleWhileActive++
          // 記録が古い間は、重要度を引き上げない（維持される）
          expect(w.severity).toBe(prev.severity)
          expect(w.occurrenceId).toBe(prev.id)
        }
        prev = { id: w.occurrenceId, severity: w.severity }
      }
    })
    expect(staleWhileActive, '記録が古くなる区間があり、その間も警告が維持されたこと').toBeGreaterThan(0)
    expect(occurrences.size, '1 周ごとに新規発生し直さない（同じ警告のまま）').toBe(1)
  })

  it('keeps the acknowledgement through stale windows; only escalation shows it again', () => {
    let acked: { id: string; severity: string } | null = null
    let reshownByEscalation = 0
    faderRun(slow, (_m, l, svc) => {
      const w = l.visible.find((x) => x.key === 'TEAM_PACE:2:SLOWER')
      if (!w) return
      if (acked) {
        // 再表示されるのは、同じ警告の重要度が上がったときだけ
        expect(w.occurrenceId).toBe(acked.id)
        expect(levels[w.severity]!).toBeGreaterThan(levels[acked.severity]!)
        expect(w.escalatedAt).not.toBeNull()
        reshownByEscalation++
      }
      svc.acknowledge(1, w.occurrenceId)
      acked = { id: w.occurrenceId, severity: w.severity }
    })
    expect(acked).not.toBeNull()
    expect(reshownByEscalation).toBeLessThanOrEqual(2) // 情報 → 注意 → 重大 の上昇分だけ
  })

  it('still clears the warning when the slowdown is actually over (normal resolution)', () => {
    let lastSeenAt = -1
    let clearedAt = -1
    const passes = faderRun(slow, (m, l) => {
      const w = l.visible.find((x) => x.key === 'TEAM_PACE:2:SLOWER') ?? (l.acknowledgedCount > 0 ? true : null)
      if (w) lastSeenAt = m
      else if (lastSeenAt >= 0 && clearedAt < 0) clearedAt = m
    })
    expect(lastSeenAt).toBeGreaterThan(0)
    expect(clearedAt, 'ペースが戻った後に解除された').toBeGreaterThan(lastSeenAt)
    // 解除は、遅いラップが終わって 9.5 分のラップが記録された後（原因の解消による通常の解除）
    const firstFastAfterSlow = passes[14]! // 初回通過 + 8 周 + 遅い 5 周 → 14 番目の通過から 9.5 分に戻る
    expect(clearedAt).toBeGreaterThan(firstFastAfterSlow)
  })

  it('does not raise a new warning while the record is stale', () => {
    // 前日まで 9.5 分 × 10 周 → 最後の通過から長時間通過なし（記録が古い）。ペース低下の警告は新しく出ない
    const time = new FakeNow(T0)
    const clock = new MasterClock(time, 'boot-stale')
    const passes = laps(2, [9.5, 9.5, 9.5, 9.5, 9.5, 9.5, 9.5, 9.5, 9.5, 9.5])
    let cur = input([team(2, 'Quiet', passes)], passes.at(-1)! + 1)
    const svc = new WarningService({ buildInput: () => ({ ...cur, now: clock.now() }) } as unknown as StrategyService, clock)
    for (let m = passes.at(-1)! + 1; m < passes.at(-1)! + 60; m++) {
      time.t = T0 + m * M
      cur = { ...cur, now: time.t }
      expect(svc.evaluate(1).visible).toEqual([])
    }
  })
})
