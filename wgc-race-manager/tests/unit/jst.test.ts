import { describe, expect, it } from 'vitest'
import { formatDuration, formatJst, parseJst } from '../../src/shared/time/jst'

describe('JST formatting (D-015)', () => {
  it('formats UTC ms as JST with milliseconds regardless of host TZ', () => {
    expect(formatJst(Date.UTC(2026, 9, 1, 0, 0, 0, 7))).toBe('2026-10-01 09:00:00.007')
    expect(formatJst(Date.UTC(2026, 11, 31, 15, 30, 59, 999))).toBe('2027-01-01 00:30:59.999')
  })

  it('parses JST strings back to UTC ms', () => {
    expect(parseJst('2026-10-01 09:00:00.007')).toBe(Date.UTC(2026, 9, 1, 0, 0, 0, 7))
    expect(parseJst('2026-10-01T09:00')).toBe(Date.UTC(2026, 9, 1, 0, 0))
    expect(parseJst('2026-10-01 09:00:00.5')).toBe(Date.UTC(2026, 9, 1, 0, 0, 0, 500))
    expect(parseJst('2026-02-30 09:00')).toBeNull()
    expect(parseJst('2026-10-01 24:00')).toBeNull()
    expect(parseJst('nope')).toBeNull()
    const ms = Date.UTC(2026, 4, 5, 6, 7, 8, 9)
    expect(parseJst(formatJst(ms))).toBe(ms)
  })

  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00:00.000')
    expect(formatDuration(3600_000 * 8 + 61_001)).toBe('8:01:01.001')
    expect(formatDuration(-1500)).toBe('-0:00:01.500')
  })
})
