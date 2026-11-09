import { describe, expect, it } from 'vitest'
import { deriveLaps } from '../../src/shared/race/laps'

describe('deriveLaps (D-005)', () => {
  it('numbers laps by passedAt and computes lap times from the base', () => {
    const laps = deriveLaps(
      [
        { id: 3, passedAt: 300 },
        { id: 1, passedAt: 100 },
        { id: 2, passedAt: 220 }
      ],
      0
    )
    expect(laps.map((l) => [l.record.id, l.lapNumber, l.lapTimeMs])).toEqual([
      [1, 1, 100],
      [2, 2, 120],
      [3, 3, 80]
    ])
  })

  it('does not compute the first lap time without a base (competitors, D-005)', () => {
    const laps = deriveLaps([{ id: 1, passedAt: 100 }, { id: 2, passedAt: 250 }], null)
    expect(laps.map((l) => l.lapTimeMs)).toEqual([null, 150])
  })

  it('handles empty input', () => {
    expect(deriveLaps([], 0)).toEqual([])
  })
})
