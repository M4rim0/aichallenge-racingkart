/**
 * CSV 生成（仕様 §13）：UTF-8 BOM 付き・カンマ区切り・CRLF・ヘッダーあり。
 * 値にカンマ・改行・ダブルクォートを含む場合は RFC 4180 に従い "..." で囲み、" は "" にする。
 * null / undefined は空欄（未入力）。0 は "0" として出力し、空欄と区別する。
 */

export const BOM = '﻿'
export const CRLF = '\r\n'

export type CsvValue = string | number | null | undefined

export function escapeCsvCell(v: CsvValue): string {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'number' ? String(v) : v
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(headers: readonly string[], rows: readonly (readonly CsvValue[])[]): string {
  const lines = [headers, ...rows].map((r) => r.map(escapeCsvCell).join(','))
  return BOM + lines.join(CRLF) + CRLF
}
