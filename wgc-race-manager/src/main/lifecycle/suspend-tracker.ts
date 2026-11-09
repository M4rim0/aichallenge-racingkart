import type { AppLifecycleEvent } from '@shared/types/entities'
import type { MasterClock } from '../clock/master-clock'
import type { AppLifecycleRepository } from '../repositories/app-lifecycle-repository'
import type { ClosingGate } from './closing-gate'

/** 復帰時の時刻ずれのしきい値（D-064）：ずれの変化がこれを超えたら警告 */
export const RESUME_DRIFT_THRESHOLD_MS = 5_000

/** 復帰前後の「PC 実日時 − マスタークロック」の変化を評価する（純粋関数） */
export function evaluateResume(driftBeforeMs: number, driftAfterMs: number): { deltaMs: number; anomaly: boolean } {
  const deltaMs = driftAfterMs - driftBeforeMs
  return { deltaMs, anomaly: Math.abs(deltaMs) > RESUME_DRIFT_THRESHOLD_MS }
}

/**
 * スリープ・休止からの復帰の検知（決定 D-064）。警告と記録のみ。
 * 時計の基準は取り直さず、レース時間も補正しない。
 * 比較の基準は直前のスリープ時のずれ（スリープ通知を受けられなかった場合は、最後に確認したずれ）。
 */
export class SuspendTracker {
  private lastDriftMs: number

  constructor(
    private readonly clock: MasterClock,
    private readonly lifecycle: AppLifecycleRepository,
    private readonly gate: ClosingGate
  ) {
    this.lastDriftMs = clock.wallDriftMs()
  }

  onSuspend(): AppLifecycleEvent | null {
    this.lastDriftMs = this.clock.wallDriftMs()
    if (this.gate.isClosing()) return null
    return this.lifecycle.insert({
      bootSessionId: this.clock.bootSessionId,
      kind: 'SUSPEND',
      at: this.clock.now(),
      wallAt: this.clock.wallNow(),
      monoMs: this.clock.monoNow(),
      driftMs: Math.round(this.lastDriftMs)
    })
  }

  onResume(): AppLifecycleEvent | null {
    const after = this.clock.wallDriftMs()
    const r = evaluateResume(this.lastDriftMs, after)
    this.lastDriftMs = after
    if (this.gate.isClosing()) return null
    return this.lifecycle.insert({
      bootSessionId: this.clock.bootSessionId,
      kind: 'RESUME',
      at: this.clock.now(),
      wallAt: this.clock.wallNow(),
      monoMs: this.clock.monoNow(),
      driftMs: Math.round(after),
      anomaly: r.anomaly,
      detail: `drift change ${Math.round(r.deltaMs)} ms (threshold ${RESUME_DRIFT_THRESHOLD_MS} ms)`
    })
  }
}
