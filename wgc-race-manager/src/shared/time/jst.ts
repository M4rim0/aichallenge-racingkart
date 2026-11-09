/**
 * 日本時間（JST, UTC+9, 夏時間なし）での表示。PC のタイムゾーン設定に依存しない。
 * 内部保存は UTC epoch ミリ秒（D-015）。
 */
const JST_OFFSET_MS = 9 * 3600_000

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

/** 'YYYY-MM-DD HH:mm:ss.SSS'（日本時間、ミリ秒まで） */
export function formatJst(ms: number): string {
  const d = new Date(ms + JST_OFFSET_MS)
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`
  )
}

/** 経過時間・残り時間の表示 '[-]H:mm:ss.SSS' */
export function formatDuration(ms: number): string {
  const sign = ms < 0 ? '-' : ''
  const a = Math.abs(Math.trunc(ms))
  const h = Math.floor(a / 3600_000)
  const m = Math.floor((a % 3600_000) / 60_000)
  const s = Math.floor((a % 60_000) / 1000)
  return `${sign}${h}:${pad(m)}:${pad(s)}.${pad(a % 1000, 3)}`
}

/** 日本時間の 'YYYY-MM-DD HH:mm:ss(.SSS)' を UTC epoch ms に変換。不正な形式は null。 */
export function parseJst(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(s.trim())
  if (!m) return null
  const [y, mo, d, h, mi] = [1, 2, 3, 4, 5].map((i) => Number(m[i])) as [number, number, number, number, number]
  const sec = m[6] ? Number(m[6]) : 0
  const ms = m[7] ? Number(m[7].padEnd(3, '0')) : 0
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || sec > 59) return null
  const utc = Date.UTC(y, mo - 1, d, h, mi, sec, ms) - JST_OFFSET_MS
  // 日付の繰り上がり（2/30 等）を拒否
  const back = new Date(utc + JST_OFFSET_MS)
  if (back.getUTCDate() !== d || back.getUTCMonth() !== mo - 1) return null
  return utc
}
