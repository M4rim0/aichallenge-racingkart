import { ipcMain } from 'electron'
import { AppError, ErrorCode, type Result } from '@shared/errors'

/**
 * IPC ハンドラを登録する。例外は Result のエラーに変換し、Renderer に内部情報を漏らさない。
 * 想定外の例外はメインプロセスのログに出力する。
 */
export function handle<A extends unknown[], T>(channel: string, fn: (...args: A) => T): void {
  ipcMain.handle(channel, (_event, ...args: unknown[]): Result<T> => {
    try {
      return { ok: true, value: fn(...(args as A)) }
    } catch (e) {
      if (e instanceof AppError) return { ok: false, error: e.toPayload() }
      console.error(`[ipc:${channel}]`, e)
      return { ok: false, error: { code: ErrorCode.INTERNAL, message: '内部エラーが発生しました' } }
    }
  })
}

/** Renderer から渡された ID を検証する */
export function asId(v: unknown, field = 'id'): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
    throw new AppError(ErrorCode.VALIDATION, 'ID が不正です', { [field]: 'ID が不正です' })
  }
  return v
}

export function asObject<T>(v: unknown, field = 'input'): T {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new AppError(ErrorCode.VALIDATION, '入力が不正です', { [field]: '入力が不正です' })
  }
  return v as T
}
