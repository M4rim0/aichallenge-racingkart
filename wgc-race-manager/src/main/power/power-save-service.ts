/**
 * 電源管理（決定 D-063、仕様 §16）。
 *
 * - 進行中（RUNNING / PAUSED）の大会が 1 つ以上あれば、ディスプレイの自動消灯と自動スリープを抑制する
 *   （Electron の powerSaveBlocker 'prevent-display-sleep'。Windows では OS への電源要求として登録される）
 * - 進行中の大会がなくなったら（END）解除する。アプリの正常終了時にも解除する
 * - 抑制要求はプロセスに紐づくため、異常終了・強制終了時はプロセス終了とともに OS が解除する
 * - OS の電源プランは変更しない
 * - 状態は保存せず、毎回大会の状態から決める（起動時に呼べば、異常終了後の再起動でも抑制が復元される）
 */

export interface PowerBlocker {
  start(type: 'prevent-display-sleep'): number
  stop(id: number): void
  isStarted(id: number): boolean
}

/** テスト・電源管理なしの環境用 */
export const noopPowerBlocker: PowerBlocker = {
  start: () => -1,
  stop: () => undefined,
  isStarted: () => false
}

export interface PowerStatus {
  /** 抑制中か */
  active: boolean
  /** 抑制の理由となっている大会（RUNNING / PAUSED） */
  eventIds: number[]
}

export class PowerSaveService {
  private blockerId: number | null = null
  private eventIds: number[] = []

  constructor(
    private readonly blocker: PowerBlocker,
    private readonly listActiveEventIds: () => number[]
  ) {}

  /** 大会の状態に合わせて抑制を開始・維持・解除する */
  reconcile(): PowerStatus {
    this.eventIds = this.listActiveEventIds()
    if (this.eventIds.length > 0) {
      if (this.blockerId === null || !this.blocker.isStarted(this.blockerId)) {
        this.blockerId = this.blocker.start('prevent-display-sleep')
      }
    } else {
      this.release()
    }
    return this.status()
  }

  /** 解除（正常終了時） */
  release(): void {
    if (this.blockerId !== null) {
      if (this.blocker.isStarted(this.blockerId)) this.blocker.stop(this.blockerId)
      this.blockerId = null
    }
  }

  status(): PowerStatus {
    return {
      active: this.blockerId !== null && this.blocker.isStarted(this.blockerId),
      eventIds: [...this.eventIds]
    }
  }
}
