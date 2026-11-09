/**
 * 順位計算（仕様 §8.3、決定 D-023）。
 *
 * 順位ルールは RankingRule として差し替え可能にする。現在は §8.3 の暫定ルールのみ。
 * 正式な大会規則が判明したら、新しい RankingRule を実装して切り替える。
 *
 * 周回差と時間差は別々に管理する（§8.3）：
 * - 周回差：周回数の差（整数）
 * - 時間差：同じ周回数のチーム間でのみ、その周回の通過時刻の差として算出する（実測値）。
 *   周回数が異なるチーム間の時間差は算出しない（推定値は段階10で「推定」と明示して扱う）。
 */

export interface TeamProgress {
  teamId: number
  /** 周回数（= 有効な通過記録の件数。D-020） */
  laps: number
  /** 最後の通過日時（= laps 周目の通過日時）。0 周なら null */
  lastPassAt: number | null
}

export interface RankedTeam extends TeamProgress {
  /** 順位（1 始まり）。完全に同じ条件のチームは同順位 */
  rank: number
  /** 同順位のチームが他にいる */
  tied: boolean
  /** トップとの周回差（0 以上の整数） */
  lapsBehindLeader: number
  /** 1 つ上の順位のチームとの周回差（トップは null） */
  lapsBehindAhead: number | null
  /** 1 つ上の順位のチームとの時間差（ms）。同周回数の場合のみ。それ以外は null */
  timeBehindAheadMs: number | null
}

export interface RankingRule {
  id: string
  label: string
  /** 暫定ルールか（画面で「暫定順位」と明示する） */
  provisional: boolean
  /** a が b より上位なら負、下位なら正、同条件なら 0 */
  compare(a: TeamProgress, b: TeamProgress): number
}

/** §8.3 の暫定ルール：周回数が多い順、同周回数ならその周回の通過時刻が早い順 */
export const provisionalRule: RankingRule = {
  id: 'provisional-8.3',
  label: '§8.3 暫定ルール：周回数 → 同周回の通過時刻',
  provisional: true,
  compare(a, b) {
    if (a.laps !== b.laps) return b.laps - a.laps
    if (a.lastPassAt === null || b.lastPassAt === null) return 0 // 0 周同士
    return a.lastPassAt - b.lastPassAt
  }
}

export function rankTeams(teams: readonly TeamProgress[], rule: RankingRule = provisionalRule): RankedTeam[] {
  // 同条件のチームは teamId 順で並べる（表示の安定のため。順位は同じ）
  const sorted = [...teams].sort((a, b) => rule.compare(a, b) || a.teamId - b.teamId)
  const leader = sorted[0]
  const result: RankedTeam[] = []
  sorted.forEach((t, i) => {
    const prev = sorted[i - 1]
    const sameAsPrev = prev !== undefined && rule.compare(prev, t) === 0
    const rank = sameAsPrev ? result[i - 1]!.rank : i + 1
    result.push({
      ...t,
      rank,
      tied: false,
      lapsBehindLeader: leader ? leader.laps - t.laps : 0,
      lapsBehindAhead: prev ? prev.laps - t.laps : null,
      timeBehindAheadMs:
        prev && prev.laps === t.laps && prev.lastPassAt !== null && t.lastPassAt !== null
          ? t.lastPassAt - prev.lastPassAt
          : null
    })
  })
  for (const r of result) r.tied = result.some((o) => o !== r && o.rank === r.rank)
  return result
}
