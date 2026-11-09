import { describe, expect, it } from 'vitest'
import { escapeCsvCell, toCsv } from '../../src/shared/csv/csv'
import { eventFolderName } from '../../src/main/services/csv-service'
import { parseCsv } from '../helpers/csv-parse'

describe('CSV primitives (spec §13)', () => {
  it('escapes commas, quotes and newlines (RFC 4180)', () => {
    expect(escapeCsvCell('plain')).toBe('plain')
    expect(escapeCsvCell('a,b')).toBe('"a,b"')
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""')
    expect(escapeCsvCell('line1\nline2')).toBe('"line1\nline2"')
    expect(escapeCsvCell('cr\r\nlf')).toBe('"cr\r\nlf"')
  })

  it('distinguishes blank (not entered) from 0', () => {
    expect(escapeCsvCell(null)).toBe('')
    expect(escapeCsvCell(undefined)).toBe('')
    expect(escapeCsvCell(0)).toBe('0')
    expect(escapeCsvCell('0')).toBe('0')
  })

  it('writes BOM + header + CRLF lines and round-trips', () => {
    const out = toCsv(['a', 'b'], [['日本語,カンマ', 'x\r\ny'], [null, 0]])
    expect(out.startsWith('﻿')).toBe(true)
    expect(out.endsWith('\r\n')).toBe(true)
    expect(Buffer.from(out, 'utf8').subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    expect(parseCsv(out.slice(1))).toEqual([
      ['a', 'b'],
      ['日本語,カンマ', 'x\r\ny'],
      ['', '0']
    ])
  })
})

describe('eventFolderName (D-041)', () => {
  it('prefixes the event id and removes characters invalid on Windows', () => {
    expect(eventFolderName({ id: 3, name: 'WGC 2026' })).toBe('3_WGC 2026')
    expect(eventFolderName({ id: 4, name: 'a/b\\c:d*e?f"g<h>i|j' })).toBe('4_a_b_c_d_e_f_g_h_i_j')
    expect(eventFolderName({ id: 5, name: 'trailing. . ' })).toBe('5_trailing')
    expect(eventFolderName({ id: 6, name: '   ' })).toBe('6')
  })
})
