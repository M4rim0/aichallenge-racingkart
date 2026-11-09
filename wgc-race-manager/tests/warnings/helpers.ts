import { computeStrategy, type StrategyInput, type StrategyReport, type StrategyTeamInput, type Uncertainty } from '../../src/shared/strategy/engine'
import type { ScenarioId } from '../../src/shared/strategy/pace'

export const M = 60_000
export const T0 = Date.UTC(2026, 9, 1, 0, 0)
export const END = T0 + 480 * M
let id = 1

export function team(teamId: number, name: string, minutes: number[], opts: Partial<StrategyTeamInput> = {}): StrategyTeamInput {
  return { teamId, name, bibNumber: null, isOwnTeam: false, teamDeleted: false, passes: minutes.map((m) => ({ id: id++, passedAt: T0 + m * M })), ...opts }
}
export const own = (minutes: number[]): StrategyTeamInput => team(1, 'Own', minutes, { isOwnTeam: true })

export const every = (first: number, step: number, upTo: number): number[] => {
  const out: number[] = []
  for (let m = first; m <= upTo + 1e-9; m += step) out.push(Math.round(m * 1000) / 1000)
  return out
}

/** 初回通過 first 分、続いて lapTimes（分）で通過 */
export const laps = (first: number, lapTimes: number[]): number[] => {
  const out = [first]
  let t = first
  for (const x of lapTimes) out.push(Math.round((t += x) * 1000) / 1000)
  return out
}

export function input(teams: StrategyTeamInput[], nowMin: number, extra: Partial<StrategyInput> = {}): StrategyInput {
  return { now: T0 + nowMin * M, status: 'RUNNING', actualStartAt: T0, actualEndAt: null, scheduledEndAt: END, stoppages: [], teams, ...extra }
}

export const report = (teams: StrategyTeamInput[], nowMin: number, extra: Partial<StrategyInput> = {}): StrategyReport =>
  computeStrategy(input(teams, nowMin, extra))

/** 境界値テスト用：計算済みレポートの一部を書き換える */
export function patchScenario(
  r: StrategyReport,
  name: string,
  s: ScenarioId,
  p: { predictedRank?: number; predicted?: boolean; predictedFinalLaps?: number | null; addUncertainty?: Uncertainty }
): void {
  const sc = r.teams.find((t) => t.name === name)!.scenarios[s]
  if (p.predictedRank !== undefined) sc.predictedRank = p.predictedRank
  if (p.predicted !== undefined) sc.predicted = p.predicted
  if (p.predictedFinalLaps !== undefined) sc.predictedFinalLaps = p.predictedFinalLaps
  if (p.addUncertainty) sc.uncertainties = [...sc.uncertainties, p.addUncertainty]
}

export function setPaceChange(r: StrategyReport, name: string, percent: number): void {
  const t = r.teams.find((x) => x.name === name)!
  const a10 = 10 * M
  t.pace.change = { diffMs: (a10 * percent) / 100, percent, direction: percent < 0 ? 'FASTER' : percent > 0 ? 'SLOWER' : 'SAME' }
}

/** NaN / Infinity が含まれないこと */
export function finiteDeep(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v)
  if (Array.isArray(v)) return v.every(finiteDeep)
  if (v && typeof v === 'object') return Object.values(v).every(finiteDeep)
  return true
}
