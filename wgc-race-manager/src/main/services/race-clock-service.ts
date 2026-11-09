import type { ClockTransitionKind, RaceEvent } from '@shared/types/entities'
import { AppError, ErrorCode } from '@shared/errors'
import { ALLOWED_TRANSITIONS, NEXT_STATUS, computeRaceClock, type RaceClockSnapshot } from '@shared/time/race-clock'
import { formatJst } from '@shared/time/jst'
import type { Db } from '../db/connection'
import { runAudited, type AuditedChange } from '../db/unit-of-work'
import type { Repositories } from '../repositories'
import type { MasterClock } from '../clock/master-clock'
import type { OperatorContext } from './operator-context'
import { noRecoveryGuard, type RecoveryGuard } from './recovery-service'

const STATUS_LABEL = { PREPARING: '準備中', RUNNING: '走行中', PAUSED: '一時停止中', FINISHED: '終了' } as const

/**
 * レース時計（仕様 §4.2〜4.4、決定 D-002, D-011〜D-014）。
 *
 * - START / PAUSE / RESUME / END を race_clock_transitions に追記し、大会の状態を更新する（同一トランザクション・操作履歴付き）
 * - 経過時間・残り時間は保存せず、遷移記録から毎回算出する（再起動後も同じ値に復元される）
 * - 実際の開始時刻は後から修正できる（D-012）。START の遷移記録自体は書き換えない
 * - 終了した大会を再開する操作は提供しない（仕様 §12）
 */
export class RaceClockService {
  /** 時計の状態遷移が確定した後に呼ばれる（電源管理の再判定、D-063）。例外は記録処理に影響させない */
  onStateChanged: (() => void) | null = null

  constructor(
    private readonly db: Db,
    private readonly repos: Repositories,
    private readonly clock: MasterClock,
    private readonly operator: OperatorContext,
    private readonly guard: RecoveryGuard = noRecoveryGuard
  ) {}

  getState(eventId: number): RaceClockSnapshot {
    const e = this.requireEvent(eventId)
    return computeRaceClock({
      status: e.status,
      actualStartAt: e.actualStartAt,
      actualEndAt: e.actualEndAt,
      scheduledEndAt: e.scheduledEndAt,
      transitions: this.repos.clockTransitions.listByEvent(eventId),
      now: this.clock.now()
    })
  }

  start(eventId: number): RaceClockSnapshot {
    return this.transition(eventId, 'START')
  }

  pause(eventId: number): RaceClockSnapshot {
    return this.transition(eventId, 'PAUSE')
  }

  resume(eventId: number): RaceClockSnapshot {
    return this.transition(eventId, 'RESUME')
  }

  end(eventId: number): RaceClockSnapshot {
    return this.transition(eventId, 'END')
  }

  /**
   * 実際の開始時刻の修正（D-012）。レース終了後も可能。
   * 制約（記録の時系列を壊さないため）：
   * - 開始後であること
   * - 現在日時以前であること
   * - START 以降の最初の時計操作（PAUSE / END 等）以前であること
   * - 有効な自チームラップ記録の最初の通過日時より前であること（初回ラップタイムが 0 以下にならない）
   */
  correctActualStart(eventId: number, newStartAt: number): RaceClockSnapshot {
    if (typeof newStartAt !== 'number' || !Number.isSafeInteger(newStartAt) || newStartAt < 0) {
      throw new AppError(ErrorCode.VALIDATION, '日時が不正です', { actualStartAt: '日時が不正です' })
    }
    const e = this.requireEvent(eventId)
    this.guard.assertNotPending(eventId) // 復旧確認待ち（D-071）
    if (e.actualStartAt === null) {
      throw new AppError(ErrorCode.RACE_NOT_STARTED, 'レースが開始されていないため、開始時刻を修正できません')
    }
    const fail = (msg: string): never => {
      throw new AppError(ErrorCode.VALIDATION, msg, { actualStartAt: msg })
    }
    if (newStartAt > this.clock.now()) fail('開始時刻を現在より後にはできません')
    const firstAfterStart = this.repos.clockTransitions.listByEvent(eventId).find((t) => t.kind !== 'START')
    if (firstAfterStart && newStartAt > firstAfterStart.at) {
      fail(`開始時刻を最初の ${firstAfterStart.kind}（${formatJst(firstAfterStart.at)}）より後にはできません`)
    }
    const firstLap = this.repos.lapRecords.listByEvent(eventId)[0]
    if (firstLap && newStartAt >= firstLap.passedAt) {
      fail(`開始時刻を最初のラップ通過（${formatJst(firstLap.passedAt)}）以降にはできません`)
    }

    runAudited(this.db, this.repos, { eventId, operator: this.operator.get() }, () => {
      const { before, after } = this.repos.events.update(eventId, { actualStartAt: newStartAt })
      return {
        result: null,
        changes: [
          {
            action: 'UPDATE',
            targetTable: 'events',
            targetId: eventId,
            before,
            after,
            note: `correct actual start: ${formatJst(before.actualStartAt!)} -> ${formatJst(newStartAt)}`
          }
        ]
      }
    })
    return this.getState(eventId)
  }

  private transition(eventId: number, kind: ClockTransitionKind): RaceClockSnapshot {
    this.guard.assertNotPending(eventId) // 復旧確認待ち：時計操作を受け付けない（D-071）
    runAudited(this.db, this.repos, { eventId, operator: this.operator.get() }, () => {
      // 状態確認もトランザクション内で行い、二重操作を防ぐ
      const e = this.requireEvent(eventId)
      if (!ALLOWED_TRANSITIONS[kind].includes(e.status)) {
        throw new AppError(
          ErrorCode.INVALID_RACE_TRANSITION,
          `${STATUS_LABEL[e.status]}の大会に ${kind} は実行できません`
        )
      }
      const stamp = this.clock.stamp()
      const tr = this.repos.clockTransitions.insert({ eventId, kind, ...stamp })
      const patch: Partial<Pick<RaceEvent, 'status' | 'actualStartAt' | 'actualEndAt'>> = { status: NEXT_STATUS[kind] }
      if (kind === 'START') patch.actualStartAt = stamp.at
      if (kind === 'END') patch.actualEndAt = stamp.at
      const { before, after } = this.repos.events.update(eventId, patch)
      const changes: AuditedChange<unknown>[] = [
        { action: 'CREATE', targetTable: 'race_clock_transitions', targetId: tr.id, before: null, after: tr },
        { action: 'UPDATE', targetTable: 'events', targetId: eventId, before, after, note: kind }
      ]
      return { result: null, changes }
    })
    try {
      this.onStateChanged?.()
    } catch (e) {
      console.error('[race-clock] onStateChanged failed', e)
    }
    return this.getState(eventId)
  }

  private requireEvent(eventId: number): RaceEvent {
    const e = this.repos.events.findById(eventId)
    if (!e) throw new AppError(ErrorCode.EVENT_NOT_FOUND, `大会が見つかりません (id=${eventId})`)
    return e
  }
}
