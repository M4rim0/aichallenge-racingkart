import type { StrategyReport, TeamStrategy, Uncertainty } from '../strategy/engine'
import { SCENARIOS, type ScenarioId } from '../strategy/pace'

/**
 * 警告判定エンジン（仕様 §8.10、決定 D-056〜D-062, D-069）。
 * 純粋関数：戦略計算の結果（StrategyReport）から、その時点で成立している警告の一覧を返す。
 * 発生・継続・解除・確認済みの状態管理は行わない（サービス層の責務）。
 * 暫定解釈 W-1〜W-11 は D-069 で正式化済み（W-2 は後方の全チームを時間差条件で判定）。
 */

export const SEVERITIES = ['INFO', 'CAUTION', 'CRITICAL'] as const
export type Severity = (typeof SEVERITIES)[number]
export const SEVERITY_LEVEL: Record<Severity, number> = { INFO: 1, CAUTION: 2, CRITICAL: 3 }
export const SEVERITY_LABEL: Record<Severity, string> = { INFO: '情報', CAUTION: '注意', CRITICAL: '重大' }

export type WarningType =
  /** ① 後方チームの急接近 */
  | 'REAR_APPROACH'
  /** ② 前方チームを追い抜ける可能性 */
  | 'FRONT_OVERTAKE'
  /** ③ 自チームのペース悪化（改善も情報として） */
  | 'OWN_PACE'
  /** ④ 順位予測の大幅変化 */
  | 'PREDICTED_RANK_CHANGE'
  /** ⑤ 他チームの急激なペース変化 */
  | 'TEAM_PACE'

export const WARNING_TYPE_LABEL: Record<WarningType, string> = {
  REAR_APPROACH: '後方チームの急接近',
  FRONT_OVERTAKE: '前方チームを追い抜ける可能性',
  OWN_PACE: '自チームのペース変化',
  PREDICTED_RANK_CHANGE: '順位予測の大幅変化',
  TEAM_PACE: '他チームの急激なペース変化'
}

/** しきい値（D-057）。変更する場合は decisions.md を更新すること */
export const WARNING_THRESHOLDS = {
  /** 後方チームとの時間差：これ以内で注意以上 */
  rearGapCautionMs: 2 * 60_000,
  /** 後方チームとの時間差：これ以内で重大 */
  rearGapCriticalMs: 1 * 60_000,
  /** ペース変化（%）：情報 / 注意 / 重大 */
  pacePercent: { INFO: 5, CAUTION: 10, CRITICAL: 15 },
  /** 自チームのペース改善（%）：情報（W-4） */
  ownImprovePercent: 5,
  /** 予測順位の変動（位）：情報 / 注意 / 重大（以上） */
  rankChange: { INFO: 1, CAUTION: 2, CRITICAL: 3 }
} as const

/** 浮動小数点の誤差で境界値（ちょうど 5% など）を取りこぼさないための許容差 */
const EPS = 1e-9
/** 時間差（ms）の境界判定の許容差（推定時間差の計算誤差を吸収。1 マイクロ秒未満） */
const GAP_EPS_MS = 1e-3

export type RearKind =
  /** 予測順位が入れ替わる（追い抜かれる）可能性 */
  | 'OVERTAKE'
  /** 同じ周回に並ばれる（追いつかれる）が、順位は入れ替わらない可能性（W-3） */
  | 'CATCH_UP'
  /** 予測ではなく、現在の時間差が近い（W-2） */
  | 'PROXIMITY'

export interface WarningCandidate {
  /** 安定したキー（種別・対象チーム・方向）。同じ条件が続く間は同じキー（D-059） */
  key: string
  type: WarningType
  severity: Severity
  /** 警告の対象チーム（①=後方チーム、②=前方チーム、③④=自チーム、⑤=そのチーム） */
  teamId: number
  teamName: string
  /** ①：OVERTAKE / CATCH_UP / PROXIMITY、③⑤：SLOWER / FASTER */
  kind: string | null
  message: string
  /** 判定の根拠（数値・シナリオなど） */
  basis: Record<string, number | string | boolean | null | string[]>
  /** 重要度の調整（終了未定の停止による引き下げ等） */
  adjustments: string[]
}

export type SuppressionReason = 'INSUFFICIENT_DATA' | 'STALE_RECORD' | 'IN_STOPPAGE' | 'NO_SCHEDULED_END'

export interface SuppressedWarning {
  type: WarningType
  teamId: number
  reason: SuppressionReason
  detail: string
}

export interface RankChangeInput {
  teamId: number
  /** 前回計算時（元データが変わる前）の予測順位（5 周平均シナリオ） */
  previousRank: number
  /** 現在の予測順位 */
  currentRank: number
}

export interface DetectInput {
  report: StrategyReport
  /** サービス層がメモリ上で保持する前回の予測順位との比較（W-5）。なければ null */
  rankChange?: RankChangeInput | null
}

export interface DetectResult {
  warnings: WarningCandidate[]
  suppressed: SuppressedWarning[]
}

const SC_LABEL: Record<ScenarioId, string> = { avg3: '3周平均', avg5: '5周平均', avg10: '10周平均' }
const TYPE_ORDER: WarningType[] = ['REAR_APPROACH', 'FRONT_OVERTAKE', 'PREDICTED_RANK_CHANGE', 'OWN_PACE', 'TEAM_PACE']

const maxSev = (a: Severity, b: Severity): Severity => (SEVERITY_LEVEL[a] >= SEVERITY_LEVEL[b] ? a : b)
const downgrade = (s: Severity): Severity => (s === 'CRITICAL' ? 'CAUTION' : 'INFO')
const has = (t: TeamStrategy, s: ScenarioId, u: Uncertainty): boolean => t.scenarios[s].uncertainties.includes(u)
const overdue = (t: TeamStrategy, s: ScenarioId): boolean => has(t, s, 'OVERDUE')
const fmtGap = (ms: number): string => {
  const a = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(a / 60)}分${String(a % 60).padStart(2, '0')}秒`
}

export function detectWarnings(input: DetectInput): DetectResult {
  const { report } = input
  const warnings: WarningCandidate[] = []
  const suppressed: SuppressedWarning[] = []
  // 警告は走行中（PAUSE を含む）のみ（W-8）
  if (report.status !== 'RUNNING' && report.status !== 'PAUSED') return { warnings, suppressed }

  const openEnded = report.clock.openEndedStoppage
  const inStoppage = report.clock.inStoppage
  const noEnd = report.clock.scheduledEndAt === null
  const own = report.teams.find((t) => t.isOwnTeam) ?? null

  /** 終了未定の停止による引き下げ（残り走行可能時間に依存する警告、W-7）と、時刻異常による上限（W-9） */
  const finalize = (c: Omit<WarningCandidate, 'adjustments'> & { adjustments?: string[] }, opts: { dependsOnRemaining: boolean; teams: TeamStrategy[] }): WarningCandidate => {
    let severity = c.severity
    const adjustments = [...(c.adjustments ?? [])]
    if (opts.dependsOnRemaining && openEnded) {
      const d = downgrade(severity)
      if (d !== severity) adjustments.push('終了未定の強制停止があるため 1 段階引き下げ')
      severity = d
    }
    if (severity === 'CRITICAL' && opts.teams.some((t) => SCENARIOS.some((s) => has(t, s, 'TIMELINE_ANOMALY')))) {
      severity = 'CAUTION'
      adjustments.push('時刻異常があるため重大を注意に制限')
    }
    return { ...c, severity, adjustments }
  }

  if (own) {
    // ① 後方チームの急接近
    for (const t of report.teams) {
      if (t.current.rank <= own.current.rank || t.teamId === own.teamId) continue
      const overtake: ScenarioId[] = []
      const catchUp: ScenarioId[] = []
      const staleScenarios: ScenarioId[] = []
      for (const s of SCENARIOS) {
        const a = own.scenarios[s]
        const b = t.scenarios[s]
        if (!a.predicted || !b.predicted) continue
        const flips = b.predictedRank < a.predictedRank
        const catches =
          !flips &&
          t.current.laps < own.current.laps &&
          a.predictedFinalLaps !== null &&
          b.predictedFinalLaps === a.predictedFinalLaps
        if (!flips && !catches) continue
        if (overdue(own, s) || overdue(t, s)) {
          staleScenarios.push(s) // 記録が古いシナリオは数えない（W-6）
          continue
        }
        ;(flips ? overtake : catchUp).push(s)
      }
      if (staleScenarios.length > 0) {
        suppressed.push({ type: 'REAR_APPROACH', teamId: t.teamId, reason: 'STALE_RECORD', detail: `記録が古いため除外したシナリオ: ${staleScenarios.map((s) => SC_LABEL[s]).join(', ')}` })
      }

      // 予測に基づく重要度（W-1, W-3）
      let predSev: Severity | null = null
      if (overtake.length === 3) predSev = 'CRITICAL'
      else if (overtake.includes('avg5')) predSev = 'CAUTION'
      else if (overtake.length > 0) predSev = 'INFO'
      else if (catchUp.length > 0) predSev = 'INFO'
      const predAdj: string[] = []
      if (predSev && openEnded) {
        const d = downgrade(predSev)
        if (d !== predSev) predAdj.push('終了未定の強制停止があるため予測部分を 1 段階引き下げ')
        predSev = d
      }

      // 時間差による下限（W-2、D-069）：後方の全チームが対象。時間差が条件を満たした場合のみ。記録が古ければ使わない
      let gapSev: Severity | null = null
      let gapMs: number | null = null
      let gapMeasured = false
      const gap = rearGap(own, t)
      if (gap !== null) {
        gapMeasured = gap.measured
        if (overdue(own, 'avg5') || overdue(t, 'avg5')) {
          suppressed.push({ type: 'REAR_APPROACH', teamId: t.teamId, reason: 'STALE_RECORD', detail: '記録が古いため時間差を判定に使用しない' })
        } else {
          gapMs = Math.max(0, gap.ms)
          if (gapMs <= WARNING_THRESHOLDS.rearGapCriticalMs + GAP_EPS_MS) gapSev = 'CRITICAL'
          else if (gapMs <= WARNING_THRESHOLDS.rearGapCautionMs + GAP_EPS_MS) gapSev = 'CAUTION'
          else gapMs = null // 条件を満たさない時間差は根拠に含めない
        }
      }

      if (!predSev && !gapSev) continue
      const severity = maxSev(predSev ?? 'INFO', gapSev ?? 'INFO')
      const kind: RearKind = overtake.length > 0 ? 'OVERTAKE' : catchUp.length > 0 ? 'CATCH_UP' : 'PROXIMITY'
      const parts: string[] = []
      if (overtake.length > 0) parts.push(`追い抜かれる可能性（${overtake.map((s) => SC_LABEL[s]).join('・')}）`)
      else if (catchUp.length > 0) parts.push(`同じ周回に追いつかれる可能性・順位は維持の予測（${catchUp.map((s) => SC_LABEL[s]).join('・')}）`)
      if (gapMs !== null && gapSev) parts.push(`時間差 ${fmtGap(gapMs)}（${gapMeasured ? '実測' : '推定'}）`)
      warnings.push(
        finalize(
          {
            key: `REAR_APPROACH:${t.teamId}`,
            type: 'REAR_APPROACH',
            severity,
            teamId: t.teamId,
            teamName: t.name,
            kind,
            message: `${t.name}：${parts.join('／')}`,
            basis: {
              overtakeScenarios: overtake,
              catchUpScenarios: catchUp,
              gapMs,
              gapMeasured,
              predictionSeverity: predSev,
              gapSeverity: gapSev,
              currentRank: t.current.rank,
              ownCurrentRank: own.current.rank
            },
            adjustments: predAdj
          },
          { dependsOnRemaining: false, teams: [own, t] }
        )
      )
    }

    // ② 前方チームを追い抜ける可能性
    for (const t of report.teams) {
      if (t.current.rank >= own.current.rank || t.teamId === own.teamId) continue
      const scen: ScenarioId[] = []
      const stale: ScenarioId[] = []
      for (const s of SCENARIOS) {
        const a = own.scenarios[s]
        const b = t.scenarios[s]
        if (!a.predicted || !b.predicted || !(a.predictedRank < b.predictedRank)) continue
        if (overdue(own, s) || overdue(t, s)) stale.push(s)
        else scen.push(s)
      }
      if (stale.length > 0) {
        suppressed.push({ type: 'FRONT_OVERTAKE', teamId: t.teamId, reason: 'STALE_RECORD', detail: `記録が古いため除外したシナリオ: ${stale.map((s) => SC_LABEL[s]).join(', ')}` })
      }
      if (scen.length === 0) continue
      warnings.push(
        finalize(
          {
            key: `FRONT_OVERTAKE:${t.teamId}`,
            type: 'FRONT_OVERTAKE',
            severity: scen.length === 3 ? 'CRITICAL' : scen.length === 2 ? 'CAUTION' : 'INFO',
            teamId: t.teamId,
            teamName: t.name,
            kind: null,
            message: `${t.name} を追い抜ける可能性（${scen.map((s) => SC_LABEL[s]).join('・')}）`,
            basis: { scenarios: scen, currentRank: t.current.rank, ownCurrentRank: own.current.rank }
          },
          { dependsOnRemaining: true, teams: [own, t] }
        )
      )
    }

    // ③ 自チームのペース変化
    const ownPace = paceWarning(own, 'OWN_PACE', inStoppage, suppressed)
    if (ownPace) warnings.push(finalize(ownPace, { dependsOnRemaining: false, teams: [own] }))

    // ④ 順位予測の大幅変化（自チーム、5 周平均、W-5）
    const rc = input.rankChange
    if (rc && rc.teamId === own.teamId) {
      const delta = Math.abs(rc.previousRank - rc.currentRank)
      if (noEnd) {
        suppressed.push({ type: 'PREDICTED_RANK_CHANGE', teamId: own.teamId, reason: 'NO_SCHEDULED_END', detail: '終了予定時刻が未設定' })
      } else if (!own.scenarios.avg5.predicted) {
        suppressed.push({ type: 'PREDICTED_RANK_CHANGE', teamId: own.teamId, reason: 'INSUFFICIENT_DATA', detail: '予測順位を算出できない' })
      } else if (overdue(own, 'avg5')) {
        suppressed.push({ type: 'PREDICTED_RANK_CHANGE', teamId: own.teamId, reason: 'STALE_RECORD', detail: '自チームの記録が古い' })
      } else if (delta >= WARNING_THRESHOLDS.rankChange.INFO) {
        const severity: Severity =
          delta >= WARNING_THRESHOLDS.rankChange.CRITICAL ? 'CRITICAL' : delta >= WARNING_THRESHOLDS.rankChange.CAUTION ? 'CAUTION' : 'INFO'
        warnings.push(
          finalize(
            {
              key: `PREDICTED_RANK_CHANGE:${own.teamId}`,
              type: 'PREDICTED_RANK_CHANGE',
              severity,
              teamId: own.teamId,
              teamName: own.name,
              kind: rc.currentRank < rc.previousRank ? 'UP' : 'DOWN',
              message: `予測最終順位（5周平均）が ${rc.previousRank}位 → ${rc.currentRank}位（現在順位は ${own.current.rank}位）`,
              basis: { previousPredictedRank: rc.previousRank, currentPredictedRank: rc.currentRank, change: delta, currentRank: own.current.rank, scenario: 'avg5' }
            },
            { dependsOnRemaining: true, teams: [own] }
          )
        )
      }
    }
  }

  // ⑤ 他チームの急激なペース変化
  for (const t of report.teams) {
    if (t.isOwnTeam) continue
    const w = paceWarning(t, 'TEAM_PACE', inStoppage, suppressed)
    if (w) warnings.push(finalize(w, { dependsOnRemaining: false, teams: [t] }))
  }

  const rankOf = new Map(report.teams.map((t) => [t.teamId, t.current.rank]))
  warnings.sort(
    (a, b) =>
      SEVERITY_LEVEL[b.severity] - SEVERITY_LEVEL[a.severity] ||
      TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) ||
      (rankOf.get(a.teamId) ?? 0) - (rankOf.get(b.teamId) ?? 0) ||
      a.key.localeCompare(b.key)
  )
  return { warnings, suppressed }
}

/**
 * 自チームと後方チームの時間差（W-2、D-069。段階10の定義と同じ）。
 * - 同じ周回数：その周回の通過時刻の差（実測）
 * - 周回数が異なる：推定走行位置の差 × 後方チームの 5 周平均ペース（推定）。最終通過時刻の単純な差は使わない
 */
export function rearGap(own: TeamStrategy, t: TeamStrategy): { ms: number; measured: boolean } | null {
  if (own.current.laps === t.current.laps && own.current.lastPassAt !== null && t.current.lastPassAt !== null) {
    return { ms: t.current.lastPassAt - own.current.lastPassAt, measured: true }
  }
  const qo = own.scenarios.avg5.position?.q ?? null
  const qt = t.scenarios.avg5.position?.q ?? null
  const pt = t.scenarios.avg5.paceMs
  if (qo === null || qt === null || pt === null) return null
  return { ms: (qo - qt) * pt, measured: false }
}

/** ③⑤ 共通：3 周平均と 10 周平均の比較 */
function paceWarning(
  t: TeamStrategy,
  type: 'OWN_PACE' | 'TEAM_PACE',
  inStoppage: boolean,
  suppressed: SuppressedWarning[]
): Omit<WarningCandidate, 'adjustments'> | null {
  const c = t.pace.change
  if (!c) return null // データ不足：3 周平均または 10 周平均がない（警告を出さない）
  const p = c.percent
  const th = WARNING_THRESHOLDS.pacePercent
  const slower = p >= th.INFO - EPS
  const faster = type === 'OWN_PACE' ? p <= -WARNING_THRESHOLDS.ownImprovePercent + EPS : p <= -th.INFO + EPS
  if (!slower && !faster) return null
  if (inStoppage) {
    suppressed.push({ type, teamId: t.teamId, reason: 'IN_STOPPAGE', detail: '強制停止中はペース警告を抑制' })
    return null
  }
  if (overdue(t, 'avg5')) {
    suppressed.push({ type, teamId: t.teamId, reason: 'STALE_RECORD', detail: '記録が古いためペース警告を抑制' })
    return null
  }
  const mag = Math.abs(p)
  let severity: Severity = mag >= th.CRITICAL - EPS ? 'CRITICAL' : mag >= th.CAUTION - EPS ? 'CAUTION' : 'INFO'
  if (type === 'OWN_PACE' && faster) severity = 'INFO' // 自チームのペース改善は情報（D-057）
  const dir = slower ? 'SLOWER' : 'FASTER'
  const label = type === 'OWN_PACE' ? (slower ? 'ペース悪化' : 'ペース改善') : slower ? 'ペース低下' : 'ペース上昇'
  return {
    key: `${type}:${t.teamId}:${dir}`,
    type,
    severity,
    teamId: t.teamId,
    teamName: t.name,
    kind: dir,
    message: `${t.name}：${label}（3周平均が10周平均より ${mag.toFixed(1)}% ${slower ? '遅い' : '速い'}、差 ${(Math.abs(c.diffMs) / 1000).toFixed(1)}秒）`,
    basis: {
      percent: p,
      diffMs: c.diffMs,
      avg3Ms: t.pace.averages.avg3.avgMs,
      avg10Ms: t.pace.averages.avg10.avgMs
    }
  }
}
