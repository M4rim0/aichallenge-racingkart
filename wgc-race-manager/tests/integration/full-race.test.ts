import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ErrorCode } from '../../src/shared/errors'
import { formatDuration, formatJst } from '../../src/shared/time/jst'
import { CSV_FILES } from '../../src/main/services/csv-service'
import { readCsv } from '../helpers/csv-parse'
import type { WarningList } from '../../src/shared/warnings/types'
import { errorCode } from '../helpers/app'
import { Harness } from './harness'
import { AppendOnlyWatcher, checkInvariants } from './invariants'
import { ExpectedRecords, expectedElapsed, expectedLapTimes, expectedRanking, rng } from './scenario'

/**
 * 段階13 自動通しテスト：8 時間・10 チーム・操作者 2 人の仮想レースを、起動から END・CSV 出力まで 1 本通す。
 *
 * - アプリ側は本番と同じサービス・DB・マスタークロック・戦略計算・警告・CSV 出力（本番コードは変更しない）
 * - 期待値はテスト側で独立に計算する（scenario.ts）。実装の出力を期待値にしない
 * - 各操作の後に不変条件（invariants.ts）を検証する
 */

const M = 60_000
const S = 1_000
const T0 = Date.UTC(2026, 9, 1, 0, 0) // 09:00 JST スタート
const END_AT = T0 + 480 * M // 8 時間
const at = (min: number, sec = 0): number => T0 + min * M + sec * S

/** 実際の強制停止（車両は停止。停止区間は走行時間に含まれない）。DB への登録はシナリオの途中で行う */
const STOPS: [number, number][] = [
  [at(200), at(215)], // 230 分に「過去の強制停止」として登録
  [at(330), at(350)] //  250 分に [330,345]、260 分に重なる [335,350] を「予定の強制停止」として登録（結合して 330〜350）
]

interface TeamPlan {
  key: string
  name: string
  own?: boolean
  /** 1 回目の通過（他チーム）の時刻（分）。自チームは START からの 1 周 */
  firstMin: number
  /** ラップタイム（分）。時刻（分）を受け取る */
  pace: (min: number) => number
  /** ±秒のゆらぎ（0 ならなし） */
  jitterSec: number
}

const PLANS: TeamPlan[] = [
  { key: 'own', name: 'Tamagawa', own: true, firstMin: 9.5, pace: () => 9.5, jitterSec: 0 },
  { key: 'r1', name: 'R1', firstMin: 8.5, pace: () => 8.5, jitterSec: 0 }, // R1 と R2 は 51 分ごとに同時刻に通過（別チームの同時刻）
  { key: 'r2', name: 'R2', firstMin: 10.2, pace: () => 10.2, jitterSec: 0 },
  { key: 'r3', name: 'R3', firstMin: 3, pace: () => 9.0, jitterSec: 3 },
  { key: 'r4', name: 'R4', firstMin: 4, pace: () => 9.8, jitterSec: 3 },
  { key: 'r5', name: 'R5', firstMin: 5, pace: () => 10.3, jitterSec: 3 },
  { key: 'r6', name: 'R6', firstMin: 6, pace: () => 10.6, jitterSec: 3 },
  // ペースが一時的に落ちるチーム（ペース変化の警告の発生・解除）
  { key: 'fader', name: 'Fader', firstMin: 2, pace: (m) => (m >= 360 && m < 410 ? 12.0 : 9.5), jitterSec: 0 },
  // 自チームの後方から追い上げるチーム（後方チームの急接近・予測順位の変化・実際の追い抜き）
  { key: 'chaser', name: 'Chaser', firstMin: 22, pace: () => 9.0, jitterSec: 0 },
  { key: 'r9', name: 'R9', firstMin: 7, pace: () => 9.3, jitterSec: 3 }
]

/** 停止区間を飛ばして走行時間を積み上げる（テスト側の独立実装） */
function afterDriving(from: number, driveMs: number): number {
  let t = from
  let remaining = driveMs
  for (const [a, b] of STOPS) {
    if (b <= t) continue
    if (a > t) {
      if (remaining <= a - t) return t + remaining
      remaining -= a - t
    }
    t = Math.max(t, b)
  }
  return t + remaining
}

/** チームごとの通過予定（真の時刻） */
function schedule(plan: TeamPlan, rand: () => number): number[] {
  const out: number[] = []
  const jitter = (): number => Math.round((rand() * 2 - 1) * plan.jitterSec) * S
  let t = plan.own ? afterDriving(T0, plan.pace(0) * M) : afterDriving(T0, plan.firstMin * M)
  while (t <= END_AT - 30 * S) {
    out.push(t)
    const next = afterDriving(t, plan.pace((t - T0) / M) * M) + jitter()
    t = next
  }
  return out
}

describe('段階13 自動通しテスト：8 時間・10 チームの仮想レース', () => {
  const h = new Harness(at(-30))
  afterAll(() => h.dispose())

  it('レース開始から END・CSV 出力まで、仕様どおりに整合して動作する', () => {
    const rand = rng(20261110)
    const expected = new ExpectedRecords()
    const transitions: { kind: 'START' | 'PAUSE' | 'RESUME' | 'END'; at: number }[] = []
    const watcher = new AppendOnlyWatcher(['race_clock_transitions', 'operation_history', 'app_lifecycle_events', 'race_recovery_holds'])
    const log: string[] = []
    const stats = { passes: 0, checks: 0, warningsSeen: new Set<string>() }

    // ───────── 1. 操作者と大会・チームの登録 ─────────
    let app = h.boot()
    let ctx = app.ctx
    const opA = ctx.operators.create('計測係A')
    const opB = ctx.operators.create('計測係B')
    ctx.operators.select(opA.id)
    const event = ctx.events.create({ name: 'WGC 2026 統合テスト', scheduledStartAt: T0, scheduledEndAt: END_AT, lapDistanceM: 5807 })
    const teamIds = new Map<string, number>()
    for (const p of PLANS) teamIds.set(p.key, ctx.teams.create(event.id, { name: p.name, bibNumber: p.key, isOwnTeam: !!p.own }).id)
    const id = (k: string): number => teamIds.get(k)!
    const ownId = id('own')
    expect(ctx.teams.list(event.id).filter((t) => t.isOwnTeam)).toHaveLength(1)

    // 通過予定（真の時刻）
    const passEvents: { at: number; key: string }[] = []
    for (const p of PLANS) for (const t of schedule(p, rand)) passEvents.push({ at: t, key: p.key })
    passEvents.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key))

    // ───────── 共通の検証 ─────────
    const verify = (label: string): void => {
      stats.checks++
      watcher.check(ctx.db, label)
      const { warnings } = checkInvariants(ctx, event.id, label)
      for (const w of warnings?.visible ?? []) stats.warningsSeen.add(w.key)
      last.warnings = warnings
    }
    const last: { warnings: WarningList | null } = { warnings: null }

    /** マスタークロック・レース経過時間・残り時間を独立計算と照合（ms 単位） */
    const verifyClock = (label: string): void => {
      const now = h.world.t
      expect(app.clock.now(), `${label}: マスタークロック = 真の時刻`).toBe(now)
      const st = ctx.raceClock.getState(event.id)
      if (transitions.length === 0) {
        expect(st.elapsedMs).toBeNull()
        return
      }
      const ended = transitions.at(-1)!.kind === 'END'
      const evalNow = ended ? transitions.at(-1)!.at : now
      expect(st.elapsedMs, `${label}: レース経過時間`).toBe(expectedElapsed(transitions, startAt, evalNow))
      expect(st.remainingClockMs, `${label}: 残り時間（予定終了 − 現在、PAUSE の影響なし）`).toBe(END_AT - evalNow)
      expect(st.anomalies, `${label}: 時系列の異常`).toEqual([])
    }

    /** 周回数・ラップタイム・暫定順位を独立計算と照合 */
    const verifyRecords = (label: string): void => {
      const ownLaps = ctx.laps.list(event.id)
      expect(ownLaps.map((l) => l.passedAt), `${label}: 自チームの通過`).toEqual(expected.of(ownId))
      expect(ownLaps.map((l) => l.lapTimeMs), `${label}: 自チームのラップタイム`).toEqual(expectedLapTimes(expected.of(ownId), startAt))
      expect(ownLaps.map((l) => l.lapNumber)).toEqual(ownLaps.map((_, i) => i + 1))
      for (const p of PLANS.filter((x) => !x.own)) {
        const v = ctx.competitors.listByTeam(id(p.key))
        expect(v.map((x) => x.passedAt), `${label}: ${p.name} の通過`).toEqual(expected.of(id(p.key)))
        expect(v.map((x) => x.lapTimeMs), `${label}: ${p.name} のラップタイム（初回は算出しない）`).toEqual(expectedLapTimes(expected.of(id(p.key)), null))
      }
      const want = expectedRanking(PLANS.map((p) => ({ teamId: id(p.key), passes: expected.of(id(p.key)) })))
      const got = ctx.standings.get(event.id)
      expect(got.provisional).toBe(true)
      for (const r of got.rows) expect(r.rank, `${label}: ${r.teamName} の暫定順位`).toBe(want.get(r.teamId))
    }

    const hold = (): boolean => ctx.recovery.findPending(event.id) !== null
    let startAt = 0
    const missed: { at: number; key: string }[] = []
    const deletedKeys = new Set<string>()
    let appDown = false
    let lateOwn: { trueAt: number } | null = null

    /** 実況の通過登録（その時点のマスタークロックで記録） */
    const livePass = (key: string): void => {
      const tid = id(key)
      if (key === 'own') {
        const v = ctx.laps.register(event.id)
        expect(v.passedAt).toBe(h.world.t)
      } else {
        const v = ctx.competitors.register(tid)
        expect(v.passedAt).toBe(h.world.t)
      }
      expected.add(tid, h.world.t)
      stats.passes++
    }

    const addPast = (key: string, t: number): void => {
      if (key === 'own') ctx.laps.addPast(event.id, t)
      else ctx.competitors.addPast(id(key), t)
      expected.add(id(key), t)
      stats.passes++
    }

    // ───────── シナリオの操作（時刻順） ─────────
    type Action = { at: number; label: string; run: () => void }
    const actions: Action[] = [
      {
        at: at(0),
        label: '2. START',
        run: () => {
          ctx.raceClock.start(event.id)
          startAt = h.world.t
          transitions.push({ kind: 'START', at: h.world.t })
          expect(ctx.power.status().active).toBe(true)
        }
      },
      {
        at: at(40),
        label: '4. 車両データとメモ',
        run: () => {
          const laps = ctx.laps.list(event.id)
          ctx.vehicleData.create(laps[0]!.recordId, { speed: '062.50', voltage: '98.1', current: '', integratedValue: '1,234 ?' })
          ctx.vehicleData.create(laps[1]!.recordId, { speed: '61', current: '0' })
          ctx.memos.create(event.id, 'ピットイン,タイヤ交換\n"ドライバー"交代')
        }
      },
      { at: at(60), label: '5. 操作者の交代（A → B）', run: () => void ctx.operators.select(opB.id) },
      {
        at: at(90),
        label: '6. PAUSE',
        run: () => {
          ctx.raceClock.pause(event.id)
          transitions.push({ kind: 'PAUSE', at: h.world.t })
        }
      },
      {
        at: at(96),
        label: '6. RESUME',
        run: () => {
          ctx.raceClock.resume(event.id)
          transitions.push({ kind: 'RESUME', at: h.world.t })
        }
      },
      { at: at(100), label: 'OS の時刻を 1 時間戻す（マスタークロックは影響を受けない）', run: () => void (h.world.wallOffset = -3600 * S) },
      { at: at(110), label: 'OS の時刻を戻す', run: () => void (h.world.wallOffset = 0) },
      {
        at: at(120),
        label: '8. 記録漏れの追加（R3）',
        run: () => {
          const m = missed.filter((x) => x.key === 'r3')
          expect(m.length).toBeGreaterThan(0)
          for (const x of m) addPast('r3', x.at)
          missed.splice(0, missed.length, ...missed.filter((x) => x.key !== 'r3'))
        }
      },
      {
        at: at(140),
        label: '10. 誤った通過の登録（R4）',
        run: () => livePass('r4')
      },
      {
        at: at(141),
        label: '10. 誤った通過の削除（R4）',
        run: () => {
          const wrong = ctx.competitors.listByTeam(id('r4')).find((x) => x.passedAt === at(140))!
          ctx.competitors.delete(wrong.recordId)
          expected.remove(id('r4'), at(140))
        }
      },
      {
        at: at(165),
        label: '11. 誤った削除（R5）→ メモ → 車両データ修正 → UNDO ×3',
        run: () => {
          const last = ctx.competitors.listByTeam(id('r5')).at(-1)!
          ctx.competitors.delete(last.recordId)
          expected.remove(id('r5'), last.passedAt)
          ctx.memos.create(event.id, '取り消すメモ')
          const vd = ctx.vehicleData.listByEvent(event.id).find((r) => r.vehicleData)!.vehicleData!
          ctx.vehicleData.update(vd.id, { speed: '99' })
          const descs: string[] = []
          for (let i = 0; i < 3; i++) {
            const c = ctx.undo.peek(event.id)!
            descs.push(c.description)
            ctx.undo.undo(event.id, c.operationGroup)
          }
          expect(descs[0]).toContain('車両データの編集')
          expect(descs[1]).toContain('メモの追加')
          expect(descs[2]).toContain('他チーム通過記録の削除')
          expected.add(id('r5'), last.passedAt)
          expect(ctx.vehicleData.listByEvent(event.id).find((r) => r.vehicleData?.id === vd.id)!.vehicleData!.speed).toBe(vd.speed)
          expect(ctx.memos.list(event.id).map((m) => m.body)).not.toContain('取り消すメモ')
        }
      },
      {
        at: at(180),
        label: '12. チームの削除（R9）',
        run: () => {
          const impact = ctx.teams.getDeletionImpact(id('r9'))
          expect(impact.competitorPasses).toBe(expected.of(id('r9')).length)
          ctx.teams.delete(id('r9'), impact)
          deletedKeys.add('r9')
          const row = ctx.standings.get(event.id).rows.find((r) => r.teamId === id('r9'))!
          expect(row.teamDeleted).toBe(true) // 削除済みでも順位に残る（D-008）
        }
      },
      {
        at: at(190),
        label: '12. チームの復元（R9）と、削除中の通過の追加',
        run: () => {
          ctx.teams.restore(id('r9'))
          deletedKeys.delete('r9')
          for (const x of missed.filter((m) => m.key === 'r9')) addPast('r9', x.at)
          missed.splice(0, missed.length, ...missed.filter((m) => m.key !== 'r9'))
        }
      },
      {
        at: at(230),
        label: '7. 過去の強制停止の登録（200〜215 分）',
        run: () => {
          ctx.stoppages.create(event.id, STOPS[0]![0], STOPS[0]![1])
          // 停止と重なったラップは平均から除外され、記録自体は残る（D-045）
          const own = ctx.strategy.get(event.id).teams.find((t) => t.teamId === ownId)!
          expect(own.pace.excluded.some((e) => e.reason === 'STOPPAGE_OVERLAP')).toBe(true)
        }
      },
      {
        at: at(240),
        label: '13. 異常終了（走行中）→ 4 分後に再起動',
        run: () => {
          const elapsedBefore = ctx.raceClock.getState(event.id).elapsedMs!
          h.crash()
          appDown = true
          app = h.restartAfter(4 * M)
          ctx = app.ctx
          appDown = false
          expect(ctx.previousShutdown).toMatchObject({ clean: false })
          expect(ctx.recovery.listPending()).toMatchObject([{ eventId: event.id, eventStatus: 'RUNNING' }])
          // 止まっていた時間も経過時間に含まれ、時計の操作記録は追加されていない（D-070）
          expect(ctx.raceClock.getState(event.id).elapsedMs).toBe(elapsedBefore + 4 * M)
          expect(ctx.repos.clockTransitions.listByEvent(event.id).map((x) => x.kind)).toEqual(transitions.map((x) => x.kind))
          expect(ctx.power.status().active).toBe(true) // 確認待ちでもスリープ抑止を維持
          // 確認前：レースに影響する操作は拒否、操作者の切り替え・メモは可能（D-071）
          expect(errorCode(() => ctx.laps.register(event.id))).toBe(ErrorCode.RECOVERY_CONFIRMATION_REQUIRED)
          expect(errorCode(() => ctx.raceClock.pause(event.id))).toBe(ErrorCode.RECOVERY_CONFIRMATION_REQUIRED)
          ctx.operators.select(opA.id)
          ctx.memos.create(event.id, '異常終了から復旧中')
        }
      },
      {
        at: at(245),
        label: '14. 復旧確認 → 停止中の通過を追加',
        run: () => {
          const c = ctx.recovery.confirm(event.id, ctx.recovery.findPending(event.id)!.holdId)
          expect(c.operatorNameSnapshot).toBe('計測係A')
          expect(hold()).toBe(false)
          for (const x of missed.splice(0)) addPast(x.key, x.at)
        }
      },
      { at: at(250), label: '7. 予定の強制停止の登録（330〜345 分）', run: () => void ctx.stoppages.create(event.id, at(330), at(345)) },
      {
        at: at(260),
        label: '7. 重なる強制停止の登録（335〜350 分）→ 結合して二重計上しない',
        run: () => {
          ctx.stoppages.create(event.id, at(335), at(350))
          expect(ctx.strategy.get(event.id).clock.remainingStoppageMs).toBe(20 * M)
        }
      },
      {
        at: at(280),
        label: '6. PAUSE（再起動前）',
        run: () => {
          ctx.raceClock.pause(event.id)
          transitions.push({ kind: 'PAUSE', at: h.world.t })
        }
      },
      {
        at: at(285),
        label: '15. 正常終了（PAUSE 中）→ 3 分後に再起動',
        run: () => {
          const elapsedBefore = ctx.raceClock.getState(event.id).elapsedMs
          expect(h.cleanShutdown()).toEqual({ clean: true })
          appDown = true
          app = h.restartAfter(3 * M)
          ctx = app.ctx
          appDown = false
          expect(ctx.previousShutdown).toMatchObject({ clean: true })
          expect(hold()).toBe(false) // 正常終了後は復旧確認待ちにしない
          const st = ctx.raceClock.getState(event.id)
          expect(st.status).toBe('PAUSED')
          expect(st.elapsedMs).toBe(elapsedBefore) // 一時停止中は経過時間が進まない
          expect(ctx.operators.current()).toBeNull() // 再起動後は操作者未選択（D-033）
          ctx.operators.select(opB.id)
          for (const x of missed.splice(0)) addPast(x.key, x.at)
        }
      },
      {
        at: at(290),
        label: '6. RESUME（再起動後）',
        run: () => {
          ctx.raceClock.resume(event.id)
          transitions.push({ kind: 'RESUME', at: h.world.t })
        }
      },
      {
        at: at(470),
        label: '12. チームの削除（R6、そのまま終了）',
        run: () => {
          ctx.teams.delete(id('r6'), ctx.teams.getDeletionImpact(id('r6')))
          deletedKeys.add('r6')
        }
      },
      {
        at: at(480),
        label: '18. END',
        run: () => {
          ctx.raceClock.end(event.id)
          transitions.push({ kind: 'END', at: h.world.t })
          expect(ctx.power.status().active).toBe(false)
          expect(errorCode(() => ctx.laps.register(event.id))).toBe(ErrorCode.RACE_NOT_ACCEPTING_LAPS)
          expect(errorCode(() => ctx.competitors.register(id('r1')))).toBe(ErrorCode.RACE_NOT_ACCEPTING_LAPS)
          for (const x of missed.splice(0)) addPast(x.key, x.at)
        }
      },
      {
        at: at(482),
        label: '終了後の過去記録の修正（R2 の最後の通過を 1 秒早く）',
        run: () => {
          const last = ctx.competitors.listByTeam(id('r2')).at(-1)!
          ctx.competitors.updatePassedAt(last.recordId, last.passedAt - S)
          expected.move(id('r2'), last.passedAt, last.passedAt - S)
        }
      }
    ]

    // 自チームの通過を 1 回だけ 20 秒遅れて登録し、2 分後に正しい時刻へ修正する（9. 通過時刻の修正）
    const ownLateTarget = passEvents.find((e) => e.key === 'own' && e.at >= at(145))!

    // 時刻順に実行
    type Step = { at: number; kind: 'pass'; key: string } | { at: number; kind: 'action'; a: Action }
    const steps: Step[] = [
      ...passEvents.map((e): Step => ({ at: e.at, kind: 'pass', key: e.key })),
      ...actions.map((a): Step => ({ at: a.at, kind: 'action', a })),
      { at: ownLateTarget.at + 20 * S, kind: 'action' as const, a: { at: 0, label: '9. 自チームの通過を 20 秒遅れて登録', run: () => {
        const v = ctx.laps.register(event.id)
        expect(v.passedAt).toBe(ownLateTarget.at + 20 * S)
        expected.add(ownId, v.passedAt)
        lateOwn = { trueAt: ownLateTarget.at }
        stats.passes++
      } } },
      { at: ownLateTarget.at + 2 * M, kind: 'action' as const, a: { at: 0, label: '9. 通過時刻を正しい時刻へ修正', run: () => {
        const rec = ctx.laps.list(event.id).find((l) => l.passedAt === ownLateTarget.at + 20 * S)!
        ctx.laps.updatePassedAt(rec.recordId, lateOwn!.trueAt)
        expected.move(ownId, ownLateTarget.at + 20 * S, lateOwn!.trueAt)
        expect(ctx.raceClock.getState(event.id).elapsedMs).toBe(expectedElapsed(transitions, startAt, h.world.t)) // 修正は時計に影響しない
      } } }
    ].sort((a, b) => a.at - b.at || (a.kind === 'action' ? -1 : 1))

    verify('準備完了')
    let lastClockCheck = 0
    let rearActive: { occurrenceId: string } | null = null
    let rearRaisedWhileBehind = false
    let rearClearedAfterOvertake = false
    let faderSlowSeen = false
    let faderAcked: { occurrenceId: string; severity: string } | null = null
    let rankChangeSeen = false
    let trackedBoot = app.bootNumber
    const faderEvents: string[] = []

    for (const step of steps) {
      if (step.at < h.world.t) {
        // アプリが停止していた間の通過（後で過去記録として追加する）
        if (step.kind === 'pass') missed.push({ at: step.at, key: step.key })
        continue
      }
      h.world.t = step.at
      if (step.kind === 'action') {
        log.push(`${formatJst(step.at)} ${step.a.label}`)
        step.a.run()
        verify(step.a.label)
        verifyClock(step.a.label)
        verifyRecords(step.a.label)
        continue
      }
      // 通過
      if (step.key === 'own' && step.at === ownLateTarget.at) continue // 遅れて登録する（上の 9.）
      if (transitions.length === 0 || transitions.at(-1)!.kind === 'END') continue
      if (step.key === 'r3' && step.at >= at(105) && step.at <= at(115)) {
        missed.push({ at: step.at, key: step.key }) // 記録漏れ
        continue
      }
      if (deletedKeys.has(step.key)) {
        // 削除済みチームの新規の通過登録は拒否（D-008）。R6 は終了直前に削除したのでそのまま
        expect(errorCode(() => ctx.competitors.register(id(step.key)))).toBe(ErrorCode.TEAM_DELETED)
        if (step.key === 'r9') missed.push({ at: step.at, key: step.key })
        else expected.of(id(step.key)) // R6：記録しない
        continue
      }
      if (hold()) {
        expect(errorCode(() => livePass(step.key))).toBe(ErrorCode.RECOVERY_CONFIRMATION_REQUIRED)
        missed.push({ at: step.at, key: step.key })
        continue
      }
      livePass(step.key)
      verify(`通過 ${step.key} ${formatJst(step.at)}`)

      // 警告の追跡（ユーザー指定 16・17）
      // 警告の状態と occurrenceId はメモリ上のみで、再起動するとリセットされる（D-060）ため、起動ごとに追跡し直す
      if (app.bootNumber !== trackedBoot) {
        trackedBoot = app.bootNumber
        rearActive = null
        faderAcked = null
      }
      const vis = last.warnings?.visible ?? []
      const rank = expectedRanking(PLANS.map((p) => ({ teamId: id(p.key), passes: expected.of(id(p.key)) })))
      const chaserBehind = rank.get(id('chaser'))! > rank.get(ownId)!
      const rear = vis.find((w) => w.key === `REAR_APPROACH:${id('chaser')}`)
      if (rear) {
        if (rearActive) expect(rear.occurrenceId, '継続中の警告は同じ警告のまま（重複しない）').toBe(rearActive.occurrenceId)
        rearActive = { occurrenceId: rear.occurrenceId }
        if (chaserBehind) rearRaisedWhileBehind = true
      } else {
        if (rearActive && !chaserBehind) rearClearedAfterOvertake = true
        rearActive = null
      }
      if (vis.some((w) => w.type === 'PREDICTED_RANK_CHANGE')) rankChangeSeen = true
      const fader = vis.find((w) => w.key === `TEAM_PACE:${id('fader')}:SLOWER`)
      if (fader) {
        faderSlowSeen = true
        if (!faderAcked) {
          ctx.warnings.acknowledge(event.id, fader.occurrenceId) // 確認済みにする
          faderAcked = { occurrenceId: fader.occurrenceId, severity: fader.severity }
        } else {
          // 確認済みの警告が再表示されてよいのは、(a) 同じ警告の重要度が上がった場合、(b) 解消後に新しい警告として再発生した場合（D-060）
          const levels: Record<string, number> = { INFO: 1, CAUTION: 2, CRITICAL: 3 }
          const sameOccurrence = fader.occurrenceId === faderAcked.occurrenceId
          faderEvents.push(`${formatJst(h.world.t)} ${sameOccurrence ? '同じ警告' : '新しい警告'} ${faderAcked.severity}→${fader.severity}`)
          if (sameOccurrence) {
            expect(levels[fader.severity]! > levels[faderAcked.severity]!, '確認済みの同じ警告が、重要度上昇なしに再表示された').toBe(true)
            expect(fader.escalatedAt).not.toBeNull()
          } else {
            expect(fader.phase).toBe('NEW')
          }
          ctx.warnings.acknowledge(event.id, fader.occurrenceId)
          faderAcked = { occurrenceId: fader.occurrenceId, severity: fader.severity }
        }
      }
      if (h.world.t - lastClockCheck >= 30 * M) {
        verifyClock(`定期確認 ${formatJst(h.world.t)}`)
        verifyRecords(`定期確認 ${formatJst(h.world.t)}`)
        lastClockCheck = h.world.t
      }
    }

    // ───────── 16・17. 予測による順位変動と警告のライフサイクル ─────────
    const finalRank = expectedRanking(PLANS.map((p) => ({ teamId: id(p.key), passes: expected.of(id(p.key)) })))
    expect(finalRank.get(id('chaser'))!, 'Chaser は最終的に自チームを追い抜いている').toBeLessThan(finalRank.get(ownId)!)
    expect(rearRaisedWhileBehind, '後方にいる間に「後方チームの急接近」が発生した').toBe(true)
    expect(rearClearedAfterOvertake, '実際に追い抜いた後に「後方チームの急接近」が解除された').toBe(true)
    expect(rankChangeSeen, '予測順位の変化の警告が発生した').toBe(true)
    expect(faderSlowSeen, 'Fader のペース低下の警告が発生した').toBe(true)
    // Fader のペースが戻った後（10 周平均に遅いラップが残る間を除く）、低下の警告は解除されている
    expect(stats.warningsSeen.has(`TEAM_PACE:${id('fader')}:SLOWER`)).toBe(true)

    // 終了後：警告は出ない（W-8）、予測は実績どおり
    const finalWarnings = ctx.warnings.evaluate(event.id)
    expect(finalWarnings.visible).toEqual([])
    const report = ctx.strategy.get(event.id)
    for (const t of report.teams) expect(t.scenarios.avg5.predictedFinalLaps).toBe(t.current.laps)

    // ───────── 19. CSV 全 5 種類の出力と内容確認 ─────────
    h.world.t = at(485)
    const out = ctx.csv.exportTo(h.dir, event.id)
    expect(out.files.map((f) => f.split(/[\\/]/).pop())).toEqual([...CSV_FILES])
    const csv = (name: string) => readCsv(readFileSync(join(out.directory, name), 'utf8'))

    // lap_records.csv：自チームの全周回（通過日時・ラップタイム ms と表示）
    const lapRows = csv('lap_records.csv')
    const ownPasses = expected.of(ownId)
    const ownTimes = expectedLapTimes(ownPasses, startAt)
    expect(lapRows.map((r) => r.lap_number)).toEqual(ownPasses.map((_, i) => String(i + 1)))
    expect(lapRows.map((r) => r.passed_at_master_jst)).toEqual(ownPasses.map(formatJst))
    expect(lapRows.map((r) => r.lap_time_ms)).toEqual(ownTimes.map(String))
    expect(lapRows.map((r) => r.lap_time)).toEqual(ownTimes.map((x) => formatDuration(x!)))
    // OS 時刻を戻していた間の通過は、PC 実日時の列だけが 1 時間ずれる（D-039）
    const shifted = lapRows.filter((r) => r.passed_at_pc_jst !== '' && r.passed_at_pc_jst !== r.passed_at_master_jst)
    expect(shifted.length).toBeGreaterThan(0)
    // 手入力の過去記録は PC 実日時が空欄
    expect(lapRows.some((r) => r.passed_at_pc_jst === '')).toBe(true)

    // competitor_records.csv：各チームの周回数・初回ラップタイム空欄・削除済みチームの印
    const compRows = csv('competitor_records.csv')
    for (const p of PLANS.filter((x) => !x.own)) {
      const rows = compRows.filter((r) => r.team_id === String(id(p.key)))
      const passes = expected.of(id(p.key))
      expect(rows.map((r) => r.passed_at_master_jst), `CSV: ${p.name}`).toEqual(passes.map(formatJst))
      expect(rows.map((r) => r.lap_time_ms)).toEqual(expectedLapTimes(passes, null).map((x) => (x === null ? '' : String(x))))
      expect(new Set(rows.map((r) => r.team_deleted))).toEqual(new Set([p.key === 'r6' ? '1' : '0']))
    }
    // 別チームの同時刻（R1 と R2）が両方記録されている
    const r1 = new Set(expected.of(id('r1')))
    expect(expected.of(id('r2')).some((t) => r1.has(t)), '別チーム間の同時刻の通過').toBe(true)
    // 削除した誤登録（R4 の 140 分）は通常 CSV に出ない
    expect(compRows.some((r) => r.team_id === String(id('r4')) && r.passed_at_master_jst === formatJst(at(140)))).toBe(false)
    // 順位の集計と一致（CSV の周回数 = 暫定順位の周回数）
    for (const row of ctx.standings.get(event.id).rows) {
      const n = row.isOwnTeam ? lapRows.length : compRows.filter((r) => r.team_id === String(row.teamId)).length
      expect(n, `CSV 周回数 = 順位の周回数（${row.teamName}）`).toBe(row.laps)
    }

    // vehicle_data.csv：入力文字列のまま、空欄は空欄、0 は 0
    const vRows = csv('vehicle_data.csv')
    expect(vRows.map((r) => [r.lap_number, r.speed_kmh, r.voltage_v, r.current_a, r.integrated_value])).toEqual([
      ['1', '062.50', '98.1', '', '1,234 ?'],
      ['2', '61', '', '0', '']
    ])

    // memos.csv：取り消したメモは出ず、改行・カンマ・引用符はそのまま
    const memoRows = csv('memos.csv')
    expect(memoRows.map((r) => r.body)).toEqual(['ピットイン,タイヤ交換\n"ドライバー"交代', '異常終了から復旧中'])

    // operation_history.csv：DB の履歴と 1 対 1、UNDO・復旧確認・操作者名を含む
    const histRows = csv('operation_history.csv')
    const dbHist = ctx.db.prepare('SELECT id FROM operation_history WHERE event_id = ? OR event_id IS NULL ORDER BY id').all(event.id) as { id: number }[]
    expect(histRows.map((r) => Number(r.history_id))).toEqual(dbHist.map((x) => x.id))
    expect(histRows.filter((r) => r.action === 'UNDO')).toHaveLength(3)
    expect(histRows.filter((r) => r.target_table === 'race_recovery_holds').map((r) => [r.note, r.operator_name])).toEqual([
      ['recovery hold (system, unclean shutdown)', '未設定'],
      ['recovery confirmed', '計測係A']
    ])
    expect(new Set(histRows.filter((r) => r.scope === 'EVENT').map((r) => r.operator_name))).toEqual(new Set(['計測係A', '計測係B', '未設定']))
    expect(histRows.filter((r) => r.scope === 'OPERATOR_MANAGEMENT').every((r) => r.event_id === '')).toBe(true)

    // 規模の確認（約 500 件の通過）
    const total = expected.total()
    expect(total).toBeGreaterThanOrEqual(430)
    expect(total).toBeLessThanOrEqual(550)
    verify('最終')
    console.log(
      `[段階13 通しテスト] 通過記録 ${total} 件（実況 ${stats.passes} 件の登録操作を含む）、検証 ${stats.checks} 回、` +
        `警告キー ${stats.warningsSeen.size} 種類、起動 ${h.require().bootNumber} 回\n` +
        `  Fader の確認済み警告の再表示: ${faderEvents.join(' / ') || 'なし'}`
    )
    void log
  }, 120_000)
})
