/**
 * Renderer の自動再読み込みの回数制限（決定 D-068）：60 秒以内に最大 3 回。
 * 上限を超えたら自動再読み込みを停止する（呼び出し側でエラーを表示する）。
 */
export const RELOAD_WINDOW_MS = 60_000
export const RELOAD_MAX = 3

export class ReloadLimiter {
  private readonly times: number[] = []
  private stopped = false

  constructor(
    private readonly max = RELOAD_MAX,
    private readonly windowMs = RELOAD_WINDOW_MS
  ) {}

  /** 再読み込みしてよければ true（記録する）。上限超過なら false で、以後は常に false */
  tryAcquire(now: number): boolean {
    if (this.stopped) return false
    // 「60 秒以内」はちょうど 60 秒前を含む（安全側：再読み込み回数が少なくなる）
    while (this.times.length > 0 && now - this.times[0]! > this.windowMs) this.times.shift()
    if (this.times.length >= this.max) {
      this.stopped = true
      return false
    }
    this.times.push(now)
    return true
  }

  isStopped(): boolean {
    return this.stopped
  }
}
