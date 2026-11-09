import type { Operator } from '@shared/types/entities'
import type { OperatorSnapshot } from '../repositories/operation-history-repository'

/**
 * 現在の操作者（仕様 §10、決定 D-032〜D-034）。
 *
 * - アプリ起動時は未選択（D-033）。選択状態はメモリ上のみで、DB には保存しない
 * - 操作履歴には、操作した時点の操作者 ID と名前（スナップショット）を記録する。
 *   名前は操作のたびに DB から取得するため、選択中に名前を修正すると以後の操作には新しい名前が残る
 * - 未選択の場合は ID・名前とも null（表示・CSV では「未設定」、D-032）
 * - 切り替え自体は操作履歴に残さない（D-034）
 */
export class OperatorContext {
  private selectedId: number | null = null
  /** テスト用：DB を介さずにスナップショットを固定する */
  private fixed: OperatorSnapshot | null = null

  constructor(private readonly resolve: (id: number) => Operator | null = () => null) {}

  get(): OperatorSnapshot {
    if (this.fixed) return { ...this.fixed }
    if (this.selectedId === null) return { id: null, name: null }
    const op = this.resolve(this.selectedId)
    if (!op) return { id: null, name: null }
    return { id: op.id, name: op.name }
  }

  getSelectedId(): number | null {
    return this.fixed ? this.fixed.id : this.selectedId
  }

  select(id: number | null): void {
    this.fixed = null
    this.selectedId = id
  }

  /** テスト用 */
  set(op: OperatorSnapshot): void {
    this.fixed = { ...op }
  }
}
