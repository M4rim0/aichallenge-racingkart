import type { OperatorSnapshot } from '../repositories/operation-history-repository'

/**
 * 現在の操作者。操作履歴に「操作当時の名前」を残すために使う（仕様 §10, §11）。
 * 操作者の登録・切り替えは段階8で実装する。それまでは未選択（null）として履歴に記録される。
 */
export class OperatorContext {
  private current: OperatorSnapshot = { id: null, name: null }

  get(): OperatorSnapshot {
    return { ...this.current }
  }

  set(op: OperatorSnapshot): void {
    this.current = { ...op }
  }
}
