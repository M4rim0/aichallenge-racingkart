import { describe, expect, it } from 'vitest'
import { provisionalRule, rankTeams, type RankingRule } from '../../src/shared/race/ranking'

describe('provisional ranking (§8.3, D-023)', () => {
  it('ranks by laps, then by the pass time of that lap', () => {
    const r = rankTeams([
      { teamId: 1, laps: 5, lastPassAt: 500 },
      { teamId: 2, laps: 6, lastPassAt: 610 },
      { teamId: 3, laps: 5, lastPassAt: 480 },
      { teamId: 4, laps: 0, lastPassAt: null }
    ])
    expect(r.map((x) => [x.teamId, x.rank])).toEqual([
      [2, 1],
      [3, 2],
      [1, 3],
      [4, 4]
    ])
  })

  it('keeps lap gaps and time gaps separate; no time gap across different laps', () => {
    const r = rankTeams([
      { teamId: 1, laps: 6, lastPassAt: 600 },
      { teamId: 2, laps: 5, lastPassAt: 450 }, // 周回数が違う：最終通過の差(-150)を時間差にしない
      { teamId: 3, laps: 5, lastPassAt: 470 }
    ])
    expect(r[0]).toMatchObject({ teamId: 1, lapsBehindLeader: 0, lapsBehindAhead: null, timeBehindAheadMs: null })
    expect(r[1]).toMatchObject({ teamId: 2, lapsBehindLeader: 1, lapsBehindAhead: 1, timeBehindAheadMs: null })
    expect(r[2]).toMatchObject({ teamId: 3, lapsBehindLeader: 1, lapsBehindAhead: 0, timeBehindAheadMs: 20 })
  })

  it('gives equal rank to exact ties (same laps & same time, or all zero laps)', () => {
    const r = rankTeams([
      { teamId: 1, laps: 3, lastPassAt: 300 },
      { teamId: 2, laps: 3, lastPassAt: 300 },
      { teamId: 3, laps: 0, lastPassAt: null },
      { teamId: 4, laps: 0, lastPassAt: null }
    ])
    expect(r.map((x) => [x.teamId, x.rank, x.tied])).toEqual([
      [1, 1, true],
      [2, 1, true],
      [3, 3, true],
      [4, 3, true]
    ])
    expect(r[1]!.timeBehindAheadMs).toBe(0)
  })

  it('handles empty input and is marked provisional', () => {
    expect(rankTeams([])).toEqual([])
    expect(provisionalRule.provisional).toBe(true)
  })

  it('allows swapping the rule (official rules later)', () => {
    const fewestLapsFirst: RankingRule = { id: 'test', label: 'test', provisional: false, compare: (a, b) => a.laps - b.laps }
    const r = rankTeams(
      [
        { teamId: 1, laps: 5, lastPassAt: 1 },
        { teamId: 2, laps: 2, lastPassAt: 1 }
      ],
      fewestLapsFirst
    )
    expect(r[0]!.teamId).toBe(2)
  })
})
