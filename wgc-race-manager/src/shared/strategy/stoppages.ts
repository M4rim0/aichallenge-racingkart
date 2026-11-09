/**
 * 強制停止時間の区間計算（決定 D-044〜D-046, D-051）。
 *
 * - 重複・隣接する停止区間は結合し、走行不能時間を二重計上しない（D-044）
 * - 終了日時が未定の停止は、計算上「max(開始, 現在)」で終わるものとして扱う（＝分かっている最小の停止時間）。
 *   これは確定値ではないため、呼び出し側は openEnded を見て不確実性を明示すること（D-051）
 */

export interface StoppageInput {
  startsAt: number
  endsAt: number | null
}

export interface StopInterval {
  start: number
  end: number
  /** 終了日時が未定の停止を含む */
  openEnded: boolean
}

export function effectiveIntervals(stoppages: readonly StoppageInput[], now: number): StopInterval[] {
  const raw = stoppages
    .map((s) => ({
      start: s.startsAt,
      end: s.endsAt ?? Math.max(s.startsAt, now),
      openEnded: s.endsAt === null
    }))
    .filter((s) => s.end > s.start || s.openEnded)
    .sort((a, b) => a.start - b.start)
  const merged: StopInterval[] = []
  for (const s of raw) {
    const last = merged.at(-1)
    if (last && s.start <= last.end) {
      last.end = Math.max(last.end, s.end)
      last.openEnded ||= s.openEnded
    } else {
      merged.push({ ...s })
    }
  }
  return merged.filter((s) => s.end > s.start || s.openEnded)
}

/** [a, b] と停止区間の重なり（ms） */
export function overlapMs(intervals: readonly StopInterval[], a: number, b: number): number {
  if (!(b > a)) return 0
  let sum = 0
  for (const s of intervals) {
    const lo = Math.max(a, s.start)
    const hi = Math.min(b, s.end)
    if (hi > lo) sum += hi - lo
  }
  return sum
}

/** [a, b] のうち走行可能な時間（停止を除く） */
export function drivableMs(intervals: readonly StopInterval[], a: number, b: number): number {
  if (!(b > a)) return 0
  return b - a - overlapMs(intervals, a, b)
}

/** from から走行可能時間 driveMs を積み上げた時刻（停止区間は飛ばす） */
export function timeAfterDriving(intervals: readonly StopInterval[], from: number, driveMs: number): number {
  let t = from
  let remaining = Math.max(0, driveMs)
  for (const s of intervals) {
    if (s.end <= t) continue
    if (s.start > t) {
      const gap = s.start - t
      if (remaining <= gap) return t + remaining
      remaining -= gap
    }
    t = Math.max(t, s.end)
  }
  return t + remaining
}

/** 時刻 t に強制停止中か（終了未定の停止は、開始後ずっと停止中とみなす） */
export function isInStoppage(stoppages: readonly StoppageInput[], t: number): boolean {
  return stoppages.some((s) => s.startsAt <= t && (s.endsAt === null || t < s.endsAt))
}
