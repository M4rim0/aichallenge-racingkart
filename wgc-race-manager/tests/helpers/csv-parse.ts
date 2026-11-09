/** テスト用の RFC 4180 パーサ（出力した CSV を読み戻して検証する） */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let i = 0
  let quoted = false
  while (i < text.length) {
    const c = text[i]!
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      cell += c
      i++
      continue
    }
    if (c === '"') {
      quoted = true
      i++
    } else if (c === ',') {
      row.push(cell)
      cell = ''
      i++
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      i += 2
    } else if (c === '\n' || c === '\r') {
      throw new Error(`bare line break outside quotes at ${i}`)
    } else {
      cell += c
      i++
    }
  }
  if (cell !== '' || row.length > 0) throw new Error('missing trailing CRLF')
  return rows
}

/** ヘッダー付き CSV をオブジェクト配列にする（BOM を確認して除去） */
export function readCsv(text: string): Record<string, string>[] {
  if (!text.startsWith('﻿')) throw new Error('missing BOM')
  const [header, ...rows] = parseCsv(text.slice(1))
  return rows.map((r) => {
    if (r.length !== header!.length) throw new Error(`column count mismatch: ${r.length} vs ${header!.length}`)
    return Object.fromEntries(header!.map((h, i) => [h, r[i]!]))
  })
}
