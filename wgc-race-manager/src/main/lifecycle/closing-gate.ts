import { AppError, ErrorCode } from '@shared/errors'

/**
 * 終了処理中の書き込み制御（決定 D-066）。
 * 終了処理を開始したら、通常の IPC 経由の操作をすべて拒否する。
 * 正常終了の記録は IPC を通らない内部処理（shutdown.ts）で行うため、この制御の影響を受けない。
 */
export class ClosingGate {
  private closing = false

  beginClosing(): void {
    this.closing = true
  }

  isClosing(): boolean {
    return this.closing
  }

  /** IPC ハンドラの入口で呼ぶ。終了処理中なら拒否する */
  assertAccepting(channel: string): void {
    if (this.closing && !GATE_EXEMPT_CHANNELS.has(channel)) {
      throw new AppError(ErrorCode.APP_CLOSING, 'アプリの終了処理中のため、操作を受け付けません')
    }
  }
}

/** 終了処理中でも受け付ける読み取り専用の問い合わせ（書き込みを伴わないもの） */
export const GATE_EXEMPT_CHANNELS: ReadonlySet<string> = new Set(['app:get-info', 'lifecycle:get-status'])

/** アプリ全体で共有するゲート（IPC 登録と終了処理が参照する） */
export const appClosingGate = new ClosingGate()
