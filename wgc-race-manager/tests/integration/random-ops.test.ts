import { describe, expect, it } from 'vitest'
import { AppError } from '../../src/shared/errors'
import { formatJst } from '../../src/shared/time/jst'
import { Harness } from './harness'
import { AppendOnlyWatcher, checkInvariants } from './invariants'
import { expectedElapsed, rng } from './scenario'

/**
 * 段階13 ランダム操作テスト（再現可能な乱数）。
 *
 * - 通常の npm test：シード 1 つ・1,000 操作
 * - npm run test:random：複数シード・各数千操作（scripts/test-random.mjs が環境変数で指定）
 *   WGC_RANDOM_SEEDS="1,2,3"、WGC_RANDOM_OPS="3000" で変更できる
 * - アプリが仕様どおりに返すエラー（AppError）は正常な結果として数える。それ以外の例外・不変条件の違反は失敗
 * - 失敗時はシードと直前の操作履歴を出力する（同じシードで再実行すれば同じ操作列になる）
 */

const SEEDS = (process.env['WGC_RANDOM_SEEDS'] ?? '20261110')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n))
const OPS = Number(process.env['WGC_RANDOM_OPS'] ?? '1000')
const INTEGRITY_EVERY = 50

const M = 60_000
const S = 1_000
const T0 = Date.UTC(2026, 9, 1, 0, 0)

type Op = { name: string; weight: number; run: () => string | void }

function runSeed(seed: number, ops: number): { counts: Record<string, number>; errors: Record<string, number>; passes: number; boots: number } {
  const r = rng(seed)
  const pick = <T>(arr: readonly T[]): T | undefined => (arr.length === 0 ? undefined : arr[Math.floor(r() * arr.length)])
  const int = (lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1))

  const h = new Harness(T0 - 10 * M)
  const history: string[] = []
  const counts: Record<string, number> = {}
  const errors: Record<string, number> = {}
  const watcher = new AppendOnlyWatcher(['race_clock_transitions', 'operation_history', 'app_lifecycle_events', 'race_recovery_holds'])
  try {
    let app = h.boot()
    let ctx = app.ctx
    const ops0 = [ctx.operators.create('A'), ctx.operators.create('B')]
    ctx.operators.select(ops0[0]!.id)
    let scheduledEnd = T0 + 480 * M
    const event = ctx.events.create({ name: `random-${seed}`, scheduledStartAt: T0, scheduledEndAt: scheduledEnd })
    ctx.teams.create(event.id, { name: 'Own', isOwnTeam: true })
    for (let i = 1; i <= 6; i++) ctx.teams.create(event.id, { name: `T${i}` })
    h.world.t = T0
    ctx.raceClock.start(event.id)
    // テスト側の独立した時計の記録（成功した時計操作だけを追加。再起動では追加しない）
    const transitions: { kind: 'START' | 'PAUSE' | 'RESUME' | 'END'; at: number }[] = [{ kind: 'START', at: h.world.t }]
    let startAt = h.world.t

    const status = () => ctx.events.get(event.id).status
    const competitors = () => ctx.teams.list(event.id, { includeDeleted: true }).filter((t) => !t.isOwnTeam)
    const activeRecords = () => [
      ...ctx.repos.lapRecords.listByEvent(event.id).map((x) => ({ table: 'lap' as const, rec: x })),
      ...ctx.repos.competitorPasses.listByEvent(event.id).map((x) => ({ table: 'pass' as const, rec: x }))
    ]
    const randomPastTime = () => int(startAt + 1, h.world.t)

    const list: Op[] = [
      {
        name: 'lap.register',
        weight: 14,
        run: () => {
          const v = ctx.laps.register(event.id)
          expect(v.passedAt).toBe(h.world.t)
          return `own @${formatJst(v.passedAt)}`
        }
      },
      {
        name: 'pass.register',
        weight: 30,
        run: () => {
          const t = pick(competitors())!
          const v = ctx.competitors.register(t.id)
          expect(v.passedAt).toBe(h.world.t)
          return `${t.name}`
        }
      },
      {
        name: 'lap.addPast',
        weight: 3,
        run: () => {
          const at = randomPastTime()
          const v = ctx.laps.addPast(event.id, at)
          expect(ctx.repos.lapRecords.findById(v.recordId)?.passedAt).toBe(at)
          return `own @${formatJst(at)}`
        }
      },
      {
        name: 'pass.addPast',
        weight: 3,
        run: () => {
          const t = pick(competitors())!
          const at = randomPastTime()
          const v = ctx.competitors.addPast(t.id, at)
          expect(ctx.repos.competitorPasses.findById(v.recordId)?.passedAt).toBe(at)
          return `${t.name} @${formatJst(at)}`
        }
      },
      {
        name: 'record.update',
        weight: 4,
        run: () => {
          const x = pick(activeRecords())
          if (!x) return 'none'
          const to = x.rec.passedAt + int(-120, 120) * S
          if (x.table === 'lap') ctx.laps.updatePassedAt(x.rec.id, to)
          else ctx.competitors.updatePassedAt(x.rec.id, to)
          const after = x.table === 'lap' ? ctx.repos.lapRecords.findById(x.rec.id) : ctx.repos.competitorPasses.findById(x.rec.id)
          expect(after?.passedAt).toBe(to)
          return `${x.table}#${x.rec.id} → ${formatJst(to)}`
        }
      },
      {
        name: 'record.delete',
        weight: 3,
        run: () => {
          const x = pick(activeRecords())
          if (!x) return 'none'
          if (x.table === 'lap') ctx.laps.delete(x.rec.id)
          else ctx.competitors.delete(x.rec.id)
          const after = x.table === 'lap' ? ctx.repos.lapRecords.findById(x.rec.id) : ctx.repos.competitorPasses.findById(x.rec.id)
          expect(after).toBeNull()
          return `${x.table}#${x.rec.id}`
        }
      },
      {
        name: 'vehicle',
        weight: 3,
        run: () => {
          const row = pick(ctx.vehicleData.listByEvent(event.id))
          if (!row) return 'none'
          if (!row.vehicleData) {
            ctx.vehicleData.create(row.lapRecordId, { speed: String(int(40, 90)), voltage: r() < 0.3 ? '' : String(int(90, 110)) })
            return `create lap ${row.lapNumber}`
          }
          if (r() < 0.7) {
            ctx.vehicleData.update(row.vehicleData.id, { current: String(int(0, 20)) })
            return `update lap ${row.lapNumber}`
          }
          ctx.vehicleData.delete(row.vehicleData.id)
          return `delete lap ${row.lapNumber}`
        }
      },
      {
        name: 'memo',
        weight: 2,
        run: () => {
          const m = pick(ctx.memos.list(event.id))
          if (!m || r() < 0.5) return `create #${ctx.memos.create(event.id, `メモ ${int(1, 9999)},改行\nあり`).id}`
          if (r() < 0.6) return `update #${ctx.memos.updateBody(m.id, `修正 ${int(1, 99)}`).id}`
          ctx.memos.delete(m.id)
          return `delete #${m.id}`
        }
      },
      {
        name: 'operator',
        weight: 2,
        run: () => {
          if (r() < 0.2) return `create ${ctx.operators.create(`Op${int(1, 99)}`).name}`
          const o = pick(ctx.operators.list())
          ctx.operators.select(r() < 0.1 ? null : (o?.id ?? null))
          return `select ${ctx.operators.current()?.name ?? '未設定'}`
        }
      },
      {
        name: 'undo',
        weight: 5,
        run: () => {
          const c = ctx.undo.peek(event.id)
          if (!c) return 'nothing'
          ctx.undo.undo(event.id, c.operationGroup)
          return c.description
        }
      },
      {
        name: 'clock',
        weight: 3,
        run: () => {
          const st = status()
          if (st === 'RUNNING' && r() < 0.8) {
            ctx.raceClock.pause(event.id)
            transitions.push({ kind: 'PAUSE', at: h.world.t })
            return 'PAUSE'
          }
          if (st === 'PAUSED') {
            ctx.raceClock.resume(event.id)
            transitions.push({ kind: 'RESUME', at: h.world.t })
            return 'RESUME'
          }
          // 状態に合わない操作（拒否されるのが仕様）
          ctx.raceClock.resume(event.id)
          return 'RESUME (state mismatch)'
        }
      },
      {
        name: 'correctStart',
        weight: 1,
        run: () => {
          const to = startAt + int(-120, 120) * S
          ctx.raceClock.correctActualStart(event.id, to)
          startAt = to
          return formatJst(to)
        }
      },
      {
        name: 'stoppage',
        weight: 2,
        run: () => {
          const s = pick(ctx.stoppages.list(event.id))
          if (!s || r() < 0.5) {
            const a = h.world.t + int(-90, 90) * M
            const created = ctx.stoppages.create(event.id, a, r() < 0.2 ? null : a + int(1, 30) * M)
            return `create #${created.id}`
          }
          if (r() < 0.5) {
            ctx.stoppages.update(s.id, s.startsAt, s.startsAt + int(1, 40) * M)
            return `update #${s.id}`
          }
          ctx.stoppages.delete(s.id)
          return `delete #${s.id}`
        }
      },
      {
        name: 'schedule',
        weight: 1,
        run: () => {
          const to = scheduledEnd + int(-30, 30) * M
          ctx.events.update(event.id, { scheduledEndAt: to })
          scheduledEnd = to // 成功したときだけ期待値を更新
          return formatJst(to)
        }
      },
      {
        name: 'team',
        weight: 2,
        run: () => {
          const t = pick(competitors())!
          if (t.deletedAt === null && r() < 0.6) {
            ctx.teams.delete(t.id, ctx.teams.getDeletionImpact(t.id))
            return `delete ${t.name}`
          }
          if (t.deletedAt !== null) {
            ctx.teams.restore(t.id)
            return `restore ${t.name}`
          }
          return `create ${ctx.teams.create(event.id, { name: `New${int(1, 999)}` }).name}`
        }
      },
      {
        name: 'warning.ack',
        weight: 2,
        run: () => {
          const w = pick(ctx.warnings.evaluate(event.id).visible)
          if (!w) return 'none'
          ctx.warnings.acknowledge(event.id, w.occurrenceId)
          return w.key
        }
      },
      {
        name: 'osClock',
        weight: 1,
        run: () => {
          h.world.wallOffset = r() < 0.5 ? 0 : int(-120, 120) * M
          return `wallOffset ${h.world.wallOffset / M} min`
        }
      },
      {
        name: 'restart',
        weight: 1,
        run: () => {
          h.world.wallOffset = 0 // 起動時の PC 時刻異常は別のテストで検証する（ここでは時刻の整合を保つ）
          const crash = r() < 0.5
          if (crash) h.crash()
          else expect(h.cleanShutdown()).toEqual({ clean: true })
          app = h.restartAfter(int(5, 600) * S)
          ctx = app.ctx
          expect(ctx.previousShutdown?.clean).toBe(!crash)
          const held = ctx.recovery.findPending(event.id) !== null
          const inProgress = status() === 'RUNNING' || status() === 'PAUSED'
          if (crash && inProgress) expect(held).toBe(true)
          return `${crash ? 'crash' : 'clean'} restart (hold=${held})`
        }
      },
      {
        name: 'recovery.confirm',
        weight: 6,
        run: () => {
          const p = ctx.recovery.findPending(event.id)
          if (!p) return 'none'
          ctx.recovery.confirm(event.id, p.holdId)
          return `hold #${p.holdId}`
        }
      },
      {
        name: 'csv',
        weight: 1,
        run: () => {
          const out = ctx.csv.build(event.id)
          // 通常 CSV の行数 = 有効な記録の件数（削除済みチームの記録も含む）
          const lapLines = out['lap_records.csv'].split('\r\n').length - 2
          const passLines = out['competitor_records.csv'].split('\r\n').length - 2
          expect(lapLines).toBe(ctx.repos.lapRecords.listByEvent(event.id).length)
          expect(passLines).toBe(ctx.repos.competitorPasses.listByEvent(event.id).length)
          return `lap ${lapLines}, pass ${passLines}`
        }
      }
    ]
    const totalWeight = list.reduce((s, o) => s + o.weight, 0)
    const choose = (): Op => {
      let x = r() * totalWeight
      for (const o of list) {
        x -= o.weight
        if (x < 0) return o
      }
      return list.at(-1)!
    }

    for (let i = 0; i < ops; i++) {
      h.world.advance(r() < 0.05 ? int(60, 600) * S : int(0, 90) * S)
      // 終盤で END（以後の実況登録は拒否、過去記録の操作は可能）
      if (i === Math.floor(ops * 0.9) && (status() === 'RUNNING' || status() === 'PAUSED') && !ctx.recovery.findPending(event.id)) {
        ctx.raceClock.end(event.id)
        transitions.push({ kind: 'END', at: h.world.t })
        history.push(`#${i} END`)
      }
      const op = choose()
      let note = ''
      try {
        note = op.run() ?? ''
        counts[op.name] = (counts[op.name] ?? 0) + 1
      } catch (e) {
        if (e instanceof AppError) {
          errors[`${op.name}:${e.code}`] = (errors[`${op.name}:${e.code}`] ?? 0) + 1
          note = `→ ${e.code}`
        } else {
          history.push(`#${i} ${op.name} → 想定外の例外: ${String(e)}`)
          throw e
        }
      }
      history.push(`#${i} ${formatJst(h.world.t)} ${op.name} ${note}`)

      // 不変条件
      const label = `seed=${seed} #${i} ${op.name}`
      watcher.check(ctx.db, label)
      checkInvariants(ctx, event.id, label, { integrity: i % INTEGRITY_EVERY === 0 })
      // マスタークロックとレース経過時間（独立計算）
      expect(app.clock.now(), `${label}: マスタークロック`).toBe(h.world.t)
      const st = ctx.raceClock.getState(event.id)
      const ended = transitions.at(-1)!.kind === 'END'
      const evalNow = ended ? transitions.at(-1)!.at : h.world.t
      expect(st.elapsedMs, `${label}: レース経過時間`).toBe(expectedElapsed(transitions, startAt, evalNow))
      expect(st.remainingClockMs, `${label}: 残り時間`).toBe(scheduledEnd - evalNow)
      expect(ctx.repos.clockTransitions.listByEvent(event.id).map((x) => x.kind), `${label}: 時計の操作記録`).toEqual(transitions.map((x) => x.kind))
    }
    checkInvariants(ctx, event.id, `seed=${seed} 最終`, { integrity: true })
    const passes = ctx.repos.lapRecords.listByEvent(event.id).length + ctx.repos.competitorPasses.listByEvent(event.id).length
    return { counts, errors, passes, boots: app.bootNumber }
  } catch (e) {
    const tail = history.slice(-40).join('\n')
    throw new Error(
      `ランダム操作テストが失敗しました（seed=${seed}, ops=${ops}）。同じ条件で再現するには WGC_RANDOM_SEEDS=${seed} WGC_RANDOM_OPS=${ops} を指定してください。\n` +
        `直前の操作:\n${tail}\n\n原因: ${e instanceof Error ? e.message : String(e)}`
    )
  } finally {
    h.dispose()
  }
}

describe(`段階13 ランダム操作テスト（シード ${SEEDS.join(', ')} × ${OPS} 操作）`, () => {
  for (const seed of SEEDS) {
    it(`seed=${seed}`, () => {
      const res = runSeed(seed, OPS)
      const ok = Object.values(res.counts).reduce((a, b) => a + b, 0)
      const rejected = Object.values(res.errors).reduce((a, b) => a + b, 0)
      expect(ok + rejected).toBe(OPS)
      console.log(
        `[ランダム操作] seed=${seed}: 成功 ${ok} / 仕様どおりの拒否 ${rejected}、最終の有効な通過記録 ${res.passes} 件、起動 ${res.boots} 回\n` +
          `  拒否の内訳: ${Object.entries(res.errors)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')}`
      )
    }, 600_000)
  }
})
