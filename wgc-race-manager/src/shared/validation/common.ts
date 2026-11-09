/** 入力検証の共通部品。Renderer でも同じ規則を使えるよう Node/DOM 非依存にする。 */

export type FieldErrors = Record<string, string>

export class Validator {
  readonly errors: FieldErrors = {}

  get ok(): boolean {
    return Object.keys(this.errors).length === 0
  }

  fail(field: string, message: string): void {
    this.errors[field] ??= message
  }

  /** 空白のみを含まない文字列（値は変更しない） */
  requiredText(field: string, v: unknown): void {
    if (typeof v !== 'string' || v.trim() === '') this.fail(field, '必須項目です')
  }

  optionalText(field: string, v: unknown): void {
    if (v !== null && v !== undefined && typeof v !== 'string') this.fail(field, '文字列で入力してください')
  }

  optionalBoolean(field: string, v: unknown): void {
    if (v !== undefined && typeof v !== 'boolean') this.fail(field, '真偽値で指定してください')
  }

  /** epoch ミリ秒（整数）または null */
  optionalEpochMs(field: string, v: unknown): void {
    if (v === null || v === undefined) return
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) this.fail(field, '日時が不正です')
  }

  optionalPositiveNumber(field: string, v: unknown): void {
    if (v === null || v === undefined) return
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) this.fail(field, '0より大きい数値で入力してください')
  }

  /** YYYY-MM-DD の実在する日付、または null */
  optionalDate(field: string, v: unknown): void {
    if (v === null || v === undefined) return
    if (typeof v !== 'string' || !isValidIsoDate(v)) this.fail(field, '日付は YYYY-MM-DD で入力してください')
  }

  /** 未知のキーを拒否する（IPC 経由で想定外の列を書き換えられないようにする） */
  onlyKeys(obj: object, allowed: readonly string[]): void {
    for (const k of Object.keys(obj)) {
      if (!allowed.includes(k)) this.fail(k, '指定できない項目です')
    }
  }
}

export function isValidIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
