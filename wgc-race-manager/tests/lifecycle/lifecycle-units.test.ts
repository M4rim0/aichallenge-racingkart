import { describe, expect, it } from 'vitest'
import { ErrorCode } from '../../src/shared/errors'
import { ClosingGate } from '../../src/main/lifecycle/closing-gate'
import { ShutdownSequence } from '../../src/main/lifecycle/shutdown'
import { ReloadLimiter } from '../../src/main/lifecycle/reload-limiter'
import { evaluateResume, RESUME_DRIFT_THRESHOLD_MS, SuspendTracker } from '../../src/main/lifecycle/suspend-tracker'
import { MasterClock } from '../../src/main/clock/master-clock'
import { registerBootSession } from '../../src/main/clock/session-registry'
import { createTestDb } from '../helpers/db'
import { errorCode } from '../helpers/app'

describe('Closing gate (D-066)', () => {
  it('rejects every normal IPC channel once closing, except read-only status', () => {
    const g = new ClosingGate()
    expect(() => g.assertAccepting('laps:register')).not.toThrow()
    g.beginClosing()
    for (const ch of ['laps:register', 'competitors:register', 'memos:create', 'race:end', 'undo:run', 'events:list']) {
      expect(errorCode(() => g.assertAccepting(ch))).toBe(ErrorCode.APP_CLOSING)
    }
    expect(() => g.assertAccepting('app:get-info')).not.toThrow()
    expect(() => g.assertAccepting('lifecycle:get-status')).not.toThrow()
  })
})

describe('Shutdown sequence (D-066)', () => {
  function seq(over: Partial<{ closeOk: boolean; closeThrows: boolean; markerThrows: boolean }> = {}) {
    const calls: string[] = []
    const gate = new ClosingGate()
    const s = new ShutdownSequence({
      gate,
      releasePower: () => calls.push(`power(closing=${gate.isClosing()})`),
      closeAppDb: () => {
        calls.push('close')
        if (over.closeThrows) throw new Error('busy')
        return over.closeOk ?? true
      },
      writeCleanShutdown: () => {
        calls.push('marker')
        if (over.markerThrows) throw new Error('disk')
      }
    })
    return { s, calls, gate }
  }

  it('closes the gate first, releases power, closes the DB, then writes the marker', () => {
    const { s, calls, gate } = seq()
    expect(s.run()).toEqual({ clean: true })
    expect(calls).toEqual(['power(closing=true)', 'close', 'marker'])
    expect(gate.isClosing()).toBe(true)
  })

  it('does not write the clean-shutdown marker if closing the DB fails', () => {
    for (const over of [{ closeOk: false }, { closeThrows: true }]) {
      const { s, calls } = seq(over)
      expect(s.run()).toEqual({ clean: false, reason: 'DB_CLOSE_FAILED' })
      expect(calls).not.toContain('marker')
    }
  })

  it('reports a marker failure as not clean, and runs only once', () => {
    const { s } = seq({ markerThrows: true })
    expect(s.run()).toEqual({ clean: false, reason: 'MARKER_FAILED' })
    expect(s.run()).toEqual({ clean: false, reason: 'ALREADY_DONE' })
  })
})

describe('Suspend / resume (D-064)', () => {
  it('flags a drift change above 5 seconds (boundary)', () => {
    expect(RESUME_DRIFT_THRESHOLD_MS).toBe(5000)
    expect(evaluateResume(0, 5000)).toEqual({ deltaMs: 5000, anomaly: false })
    expect(evaluateResume(0, 5001)).toMatchObject({ anomaly: true })
    expect(evaluateResume(200, -5000)).toMatchObject({ anomaly: true }) // 逆方向も
    expect(evaluateResume(120, 150)).toMatchObject({ anomaly: false }) // 平常の小さなずれ
  })

  it('records SUSPEND/RESUME with drift, flags anomalies, and never corrects the clock', () => {
    const t = createTestDb()
    const clock = new MasterClock(t.clock, 'boot-s')
    registerBootSession(t.db, t.repos, clock, 'test')
    const gate = new ClosingGate()
    const tracker = new SuspendTracker(clock, t.repos.lifecycle, gate)
    // 1 回目：単調時計がスリープ中も進んだ場合（ずれは変わらない）
    tracker.onSuspend()
    t.clock.advance(10 * 60_000)
    expect(tracker.onResume()).toMatchObject({ kind: 'RESUME', anomaly: false })
    // 2 回目：単調時計がスリープ中に止まった場合（PC 実日時だけが 10 分進む → ずれ +10 分）
    tracker.onSuspend()
    const masterBefore = clock.now()
    t.clock.wallOffset += 10 * 60_000
    const ev = tracker.onResume()!
    expect(ev).toMatchObject({ kind: 'RESUME', anomaly: true, driftMs: 600_000 })
    expect(clock.now()).toBe(masterBefore) // マスタークロックは補正しない
    expect(t.repos.lifecycle.listResumeAnomalies('boot-s').map((e) => e.id)).toEqual([ev.id])
    expect(t.repos.history.listAll()).toEqual([])
    // 終了処理中は記録しない
    gate.beginClosing()
    expect(tracker.onResume()).toBeNull()
    t.cleanup()
  })
})

describe('Renderer reload limiter (D-068)', () => {
  it('allows at most 3 reloads within 60 seconds, then stops permanently', () => {
    const l = new ReloadLimiter()
    expect([0, 1000, 2000].map((t) => l.tryAcquire(t))).toEqual([true, true, true])
    expect(l.tryAcquire(59_000)).toBe(false)
    expect(l.isStopped()).toBe(true)
    expect(l.tryAcquire(10 * 60_000)).toBe(false)
  })

  it('counts only reloads within the last 60 seconds', () => {
    const l = new ReloadLimiter()
    expect(l.tryAcquire(0)).toBe(true)
    expect(l.tryAcquire(30_000)).toBe(true)
    expect(l.tryAcquire(59_999)).toBe(true)
    expect(l.tryAcquire(60_000)).toBe(false) // 0（ちょうど 60 秒前を含む）, 30000, 59999 が 60 秒以内 → 4 回目
    const l2 = new ReloadLimiter()
    l2.tryAcquire(0)
    l2.tryAcquire(30_000)
    l2.tryAcquire(50_000)
    expect(l2.tryAcquire(60_001)).toBe(true) // 0 は 60 秒を超えたので対象外
  })
})
