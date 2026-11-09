import { describe, expect, it } from 'vitest'
import { bootApp, MIN, SEC } from '../helpers/app'
import { createTestDb } from '../helpers/db'
import { rng } from './scenario'

/**
 * 段階13 性能測定（記録のみ）。
 *
 * - 戦略計算（strategy.get）と警告判定（warnings.evaluate）、記録登録（competitors.register）の所要時間を
 *   平均・最大・p95 で出力する
 * - 目安は 50 ms だが、数値を理由に自動で合否を判定しない（指示どおり）。この環境と本番 PC の性能は異なるため、
 *   Windows 実機での確認は手順書（docs/test/windows-full-race.md）で行う
 * - 計算結果の妥当性（有限値など）は通しテスト・ランダム操作テストで検証しているので、ここでは確認しない
 */

const WARMUP = 5
const SAMPLES = 50

function stats(xs: number[]): { avg: number; max: number; p95: number } {
  const s = [...xs].sort((a, b) => a - b)
  return {
    avg: s.reduce((a, b) => a + b, 0) / s.length,
    max: s.at(-1)!,
    p95: s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]!
  }
}
const fmt = (x: { avg: number; max: number; p95: number }) => `平均 ${x.avg.toFixed(2)} ms / 最大 ${x.max.toFixed(2)} ms / p95 ${x.p95.toFixed(2)} ms`

function measure(fn: () => unknown): number[] {
  for (let i = 0; i < WARMUP; i++) fn()
  const out: number[] = []
  for (let i = 0; i < SAMPLES; i++) {
    const a = performance.now()
    fn()
    out.push(performance.now() - a)
  }
  return out
}

/** 10 チーム（自チーム含む）で、合計 total 件の通過記録を持つ開始済みレースを作る */
function buildRace(total: number) {
  const t = createTestDb()
  const ctx = bootApp(t)
  const r = rng(2026)
  const durationMs = 8 * 60 * MIN
  const event = ctx.events.create({ name: 'perf', scheduledStartAt: t.clock.t, scheduledEndAt: t.clock.t + durationMs })
  const teams = [ctx.teams.create(event.id, { name: 'Own', isOwnTeam: true }), ...Array.from({ length: 9 }, (_, i) => ctx.teams.create(event.id, { name: `T${i + 1}` }))]
  ctx.raceClock.start(event.id)
  ctx.stoppages.create(event.id, t.clock.t + 200 * MIN, t.clock.t + 215 * MIN)
  const interval = durationMs / total
  const registerMs: number[] = []
  for (let i = 0; i < total; i++) {
    t.clock.advance(Math.max(SEC, Math.round(interval * (0.5 + r()))))
    const team = teams[i % teams.length]!
    const a = performance.now()
    if (team.isOwnTeam) ctx.laps.register(event.id)
    else ctx.competitors.register(team.id)
    registerMs.push(performance.now() - a)
  }
  return { t, ctx, event, registerMs }
}

describe('段階13 性能測定（記録のみ・合否判定なし）', () => {
  for (const total of [500, 5000]) {
    it(`10 チーム・通過記録 ${total} 件`, () => {
      const { t, ctx, event, registerMs } = buildRace(total)
      try {
        const strategy = stats(measure(() => ctx.strategy.get(event.id)))
        const warnings = stats(measure(() => ctx.warnings.evaluate(event.id)))
        const register = stats(registerMs)
        expect(ctx.repos.lapRecords.listByEvent(event.id).length + ctx.repos.competitorPasses.listByEvent(event.id).length).toBe(total)
        console.log(
          `[性能] 10 チーム・通過記録 ${total} 件（各 ${SAMPLES} 回、目安 50 ms・判定なし）\n` +
            `  戦略計算 strategy.get     : ${fmt(strategy)}\n` +
            `  警告判定 warnings.evaluate: ${fmt(warnings)}\n` +
            `  記録登録 register（${total} 回）: ${fmt(register)}`
        )
      } finally {
        t.cleanup()
      }
    }, 300_000)
  }
})
