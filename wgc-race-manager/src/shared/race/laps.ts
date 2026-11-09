/**
 * 通過日時から周回番号・ラップタイムを算出する（D-005：保存せず毎回算出）。
 *
 * - 周回番号：有効な通過記録を通過日時の昇順に並べた 1 始まりの番号
 * - ラップタイム：前回通過日時との差。一時停止中の時間も含む（D-011, D-016）
 * - 初回ラップ：baseAt（自チーム = 実際の開始時刻）との差。baseAt が null の場合は算出しない
 *   （他チームは初回通過の基準時刻が未確定のため null を渡す。D-005）
 */

export interface PassLike {
  id: number
  passedAt: number
}

export interface DerivedLap<T extends PassLike> {
  record: T
  lapNumber: number
  /** ラップタイム（ms）。算出できない場合は null */
  lapTimeMs: number | null
}

export function deriveLaps<T extends PassLike>(records: readonly T[], baseAt: number | null): DerivedLap<T>[] {
  const sorted = [...records].sort((a, b) => a.passedAt - b.passedAt || a.id - b.id)
  return sorted.map((record, i) => {
    const prevAt = i === 0 ? baseAt : sorted[i - 1]!.passedAt
    return { record, lapNumber: i + 1, lapTimeMs: prevAt === null ? null : record.passedAt - prevAt }
  })
}
