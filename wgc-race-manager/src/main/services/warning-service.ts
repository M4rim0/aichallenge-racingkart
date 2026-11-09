import { AppError, ErrorCode } from '@shared/errors'
import { computeStrategy, type StrategyInput, type StrategyReport } from '@shared/strategy/engine'
import {
  SEVERITY_LEVEL,
  detectWarnings,
  type RankChangeInput,
  type Severity,
  type WarningCandidate
} from '@shared/warnings/detect'
import type { ActiveWarning, WarningList } from '@shared/warnings/types'
import type { MasterClock } from '../clock/master-clock'
import type { StrategyService } from './strategy-service'

/**
 * 警告の状態管理（決定 D-059〜D-061、D-069 の W-5・W-10）。
 *
 * - 判定は純粋関数 detectWarnings に任せ、ここでは発生・継続・解除・確認済みを管理する
 * - すべてメモリ上のみ。DB には保存しない。アプリを再起動すると（新しいインスタンスになり）すべてリセットされる
 * - 警告はキー（種別・チーム・方向）で識別し、同じ条件が続く間は同じ警告（同じ occurrenceId）を維持する
 * - 条件が解消したら解除。再成立したら新しい occurrenceId で発生
 * - 重要度が上昇したら更新し、確認済みを解除して再表示する（低下時は確認状態を維持）
 * - 確認済みにする操作と条件の解消は独立（確認済みでも条件が続く間は内部的に維持し、解消で消える）
 * - 通知（音・ポップアップ等）は行わない。将来は evaluate の結果（phase = NEW）を通知部に渡して拡張する
 */

interface EventState {
  active: Map<string, ActiveWarning>
  seq: number
  /** 予測順位の比較用（W-5）：元データの指紋が変わったときだけ前回値を更新する */
  rank: { fingerprint: string; teamId: number | null; previous: number | null; current: number | null } | null
}

/** 新規警告の表示を維持する時間（W-10、D-069）：発生または重要度上昇から 10 秒間 */
export const NEW_WARNING_DURATION_MS = 10_000

export class WarningService {
  private readonly states = new Map<number, EventState>()

  constructor(
    private readonly strategy: StrategyService,
    private readonly clock: MasterClock
  ) {}

  /** 現在の状況で警告を判定し、状態を更新して一覧を返す */
  evaluate(eventId: number): WarningList {
    const input = this.strategy.buildInput(eventId)
    const report = computeStrategy(input)
    const state = this.state(eventId)
    const rankChange = this.updateRankBaseline(state, input, report)
    const { warnings, suppressed } = detectWarnings({ report, rankChange })
    const now = this.clock.now()
    this.reconcile(eventId, state, warnings, now)
    // 「新規」は発生（または重要度上昇）から 10 秒間（W-10）。それ以降は「継続中」
    const all = [...state.active.values()].map((w) => ({
      ...w,
      phase: (now - (w.escalatedAt ?? w.raisedAt) < NEW_WARNING_DURATION_MS ? 'NEW' : 'CONTINUING') as ActiveWarning['phase']
    }))
    return {
      eventId,
      evaluatedAt: now,
      visible: sortWarnings(all.filter((w) => !w.acknowledged), report),
      acknowledgedCount: all.filter((w) => w.acknowledged).length,
      suppressed
    }
  }

  /** 確認済みにする（一覧から非表示）。既に解除・再発生した警告の古い ID は受け付けない */
  acknowledge(eventId: number, occurrenceId: string): void {
    const state = this.state(eventId)
    const w = [...state.active.values()].find((x) => x.occurrenceId === occurrenceId)
    if (!w) {
      throw new AppError(ErrorCode.WARNING_NOT_FOUND, 'この警告は既に解除されたか、新しい警告として再発生しています')
    }
    w.acknowledged = true
  }

  private state(eventId: number): EventState {
    let s = this.states.get(eventId)
    if (!s) {
      s = { active: new Map(), seq: 0, rank: null }
      this.states.set(eventId, s)
    }
    return s
  }

  private reconcile(eventId: number, state: EventState, candidates: WarningCandidate[], now: number): void {
    const seen = new Set<string>()
    for (const c of candidates) {
      seen.add(c.key)
      const prev = state.active.get(c.key)
      if (!prev) {
        state.active.set(c.key, {
          ...c,
          occurrenceId: `${eventId}-${++state.seq}`,
          phase: 'NEW',
          raisedAt: now,
          updatedAt: now,
          escalatedAt: null,
          acknowledged: false
        })
        continue
      }
      const escalated = SEVERITY_LEVEL[c.severity] > SEVERITY_LEVEL[prev.severity]
      state.active.set(c.key, {
        ...c,
        occurrenceId: prev.occurrenceId,
        phase: escalated ? 'NEW' : 'CONTINUING',
        raisedAt: prev.raisedAt,
        updatedAt: now,
        escalatedAt: escalated ? now : prev.escalatedAt,
        acknowledged: escalated ? false : prev.acknowledged
      })
    }
    // 条件が解消した警告は解除（確認済みかどうかに関係なく）
    for (const key of [...state.active.keys()]) if (!seen.has(key)) state.active.delete(key)
  }

  /**
   * 前回計算時の予測順位（W-5）。元データ（記録・強制停止・終了予定・状態など。現在時刻は除く）が変わった最初の計算で
   * 「今回」を確定し、それまでの「今回」を「前回」に移す。時間の経過だけでは更新しない。
   */
  private updateRankBaseline(state: EventState, input: StrategyInput, report: StrategyReport): RankChangeInput | null {
    const fp = fingerprint(input)
    const own = report.teams.find((t) => t.isOwnTeam) ?? null
    const cur = own && own.scenarios.avg5.predicted ? own.scenarios.avg5.predictedRank : null
    const teamId = own?.teamId ?? null
    if (!state.rank || state.rank.fingerprint !== fp) {
      const previous = state.rank && state.rank.teamId === teamId ? state.rank.current : null
      state.rank = { fingerprint: fp, teamId, previous, current: cur }
    }
    const r = state.rank
    if (r.teamId === null || r.previous === null || r.current === null || r.previous === r.current) return null
    return { teamId: r.teamId, previousRank: r.previous, currentRank: r.current }
  }
}

/** 現在時刻を除いた計算入力の指紋 */
export function fingerprint(input: StrategyInput): string {
  return JSON.stringify({
    status: input.status,
    actualStartAt: input.actualStartAt,
    actualEndAt: input.actualEndAt,
    scheduledEndAt: input.scheduledEndAt,
    stoppages: input.stoppages,
    teams: input.teams.map((t) => [t.teamId, t.isOwnTeam, t.teamDeleted, t.passes.map((p) => [p.id, p.passedAt])])
  })
}

function sortWarnings(list: ActiveWarning[], report: StrategyReport): ActiveWarning[] {
  const rank = new Map(report.teams.map((t) => [t.teamId, t.current.rank]))
  const order = ['REAR_APPROACH', 'FRONT_OVERTAKE', 'PREDICTED_RANK_CHANGE', 'OWN_PACE', 'TEAM_PACE']
  return [...list].sort(
    (a, b) =>
      SEVERITY_LEVEL[b.severity as Severity] - SEVERITY_LEVEL[a.severity as Severity] ||
      Number(b.phase === 'NEW') - Number(a.phase === 'NEW') ||
      order.indexOf(a.type) - order.indexOf(b.type) ||
      (rank.get(a.teamId) ?? 0) - (rank.get(b.teamId) ?? 0) ||
      a.key.localeCompare(b.key)
  )
}
