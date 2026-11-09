/**
 * 統合テスト用の独立した期待値の計算（アプリの実装を使わない）。
 * テストが行った操作から、周回数・ラップタイム・暫定順位・レース経過時間を別に計算し、アプリの結果と照合する。
 */

/** チームごとの「有効な通過日時」（テストが記録した操作の結果） */
export class ExpectedRecords {
  private readonly passes = new Map<number, number[]>()

  add(teamId: number, at: number): void {
    const list = this.passes.get(teamId) ?? []
    list.push(at)
    list.sort((a, b) => a - b)
    this.passes.set(teamId, list)
  }

  remove(teamId: number, at: number): void {
    const list = this.passes.get(teamId) ?? []
    const i = list.indexOf(at)
    if (i < 0) throw new Error(`expected pass ${at} not found for team ${teamId}`)
    list.splice(i, 1)
  }

  move(teamId: number, from: number, to: number): void {
    this.remove(teamId, from)
    this.add(teamId, to)
  }

  of(teamId: number): number[] {
    return [...(this.passes.get(teamId) ?? [])]
  }

  total(): number {
    let n = 0
    for (const l of this.passes.values()) n += l.length
    return n
  }
}

/** ラップタイム（ms）。自チームの 1 周目は実際の開始時刻から、他チームの 1 周目は算出しない（D-005, D-020） */
export function expectedLapTimes(passes: number[], baseAt: number | null): (number | null)[] {
  return passes.map((p, i) => (i === 0 ? (baseAt === null ? null : p - baseAt) : p - passes[i - 1]!))
}

/** §8.3 暫定ルールの独立実装：周回数の多い順、同周回は最後の通過が早い順、完全同条件は同順位 */
export function expectedRanking(teams: { teamId: number; passes: number[] }[]): Map<number, number> {
  const rows = teams.map((t) => ({ teamId: t.teamId, laps: t.passes.length, last: t.passes.at(-1) ?? null }))
  const cmp = (a: (typeof rows)[number], b: (typeof rows)[number]): number => {
    if (a.laps !== b.laps) return b.laps - a.laps
    if (a.last === null || b.last === null) return 0
    return a.last - b.last
  }
  const sorted = [...rows].sort((a, b) => cmp(a, b) || a.teamId - b.teamId)
  const rank = new Map<number, number>()
  sorted.forEach((r, i) => {
    const prev = sorted[i - 1]
    rank.set(r.teamId, prev && cmp(prev, r) === 0 ? rank.get(prev.teamId)! : i + 1)
  })
  return rank
}

/**
 * レース経過時間の独立計算（§4.2、D-002, D-011, D-070）。
 * transitions はテストが行った時計操作（真の時刻）。PAUSE〜RESUME の間は進まず、END で止まる。
 * 異常終了・再起動中も RUNNING なら進む（止まっていた時間を含む）。
 */
export function expectedElapsed(transitions: { kind: 'START' | 'PAUSE' | 'RESUME' | 'END'; at: number }[], startAt: number, now: number): number {
  let elapsed = 0
  let runningSince: number | null = null
  for (const tr of transitions) {
    const at = tr.kind === 'START' ? startAt : tr.at
    if (tr.kind === 'START' || tr.kind === 'RESUME') runningSince ??= at
    else if (runningSince !== null) {
      elapsed += at - runningSince
      runningSince = null
    }
  }
  if (runningSince !== null) elapsed += now - runningSince
  return elapsed
}

/** 再現可能な乱数（mulberry32） */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
