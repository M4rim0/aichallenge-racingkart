import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAppContext, type AppContext } from '../../src/main/app-context'
import { closeAppDatabase, openAppDatabase, type DatabaseStatus } from '../../src/main/db/app-database'
import type { Db } from '../../src/main/db/connection'
import { MasterClock, type TimeSource } from '../../src/main/clock/master-clock'
import { registerBootSession } from '../../src/main/clock/session-registry'
import { createRepositories } from '../../src/main/repositories'
import { ClosingGate } from '../../src/main/lifecycle/closing-gate'
import { appendCleanShutdownRecord, ShutdownSequence, type ShutdownOutcome } from '../../src/main/lifecycle/shutdown'
import { SuspendTracker } from '../../src/main/lifecycle/suspend-tracker'
import type { PowerBlocker } from '../../src/main/power/power-save-service'
import type { AppSession } from '../../src/shared/types/entities'

/**
 * 段階13 統合テスト用のハーネス。
 *
 * 本番の起動処理（src/main/index.ts の app.whenReady() 内）を、本番のコードを変更せずにテスト側で同じ順序で再現する（段階13 確認事項 1 = A）。
 * 本番側の順序が変わった場合は、下の BOOT_ORDER と boot() を照合して更新すること。
 */
export const BOOT_ORDER = [
  '1. openAppDatabase(userData)            … 整合性の事前チェック（DB と WAL のコピーを検査）→ DB を開く → マイグレーション',
  '2. registerBootSession(...)             … 起動セッションと BOOT を記録、PC 時刻異常の検出',
  '3. createAppContext(db, masterClock, session, { powerBlocker })',
  '4. new ShutdownSequence({ gate, releasePower, closeAppDb: closeAppDatabase, writeCleanShutdown: appendCleanShutdownRecord })',
  '5. context.recovery.holdAfterUncleanShutdown(context.previousShutdown)   … 異常終了後のみ復旧確認待ち',
  '6. context.power.reconcile()            … 進行中の大会があればスリープ抑止',
  '7. new SuspendTracker(masterClock, context.repos.lifecycle, appClosingGate)',
  '（8. createMainWindow … 画面。統合テストの対象外）'
] as const

/**
 * テストの「現実の時間」。全起動で共有する。
 * - t：真の時刻（ms）。進むのは advance() だけ
 * - wallOffset：PC の時計のずれ（OS の時刻変更の再現）
 */
export class World {
  wallOffset = 0
  constructor(public t: number) {}
  advance(ms: number): number {
    this.t += ms
    return this.t
  }
}

/**
 * 起動ごとの時刻の取得元。本番の systemTimeSource と同じ契約（wallNow = PC の時刻、monoNow = 単調時計）。
 * 実際の PC と同じく、単調時計の原点は起動（プロセス）ごとに異なる（monoOrigin）。
 * MasterClock 本体は本番のコードをそのまま使う。
 */
export class BootTimeSource implements TimeSource {
  private readonly bootT: number
  constructor(
    private readonly world: World,
    private readonly monoOrigin: number
  ) {
    this.bootT = world.t
  }
  wallNow(): number {
    return this.world.t + this.world.wallOffset
  }
  monoNow(): number {
    return this.monoOrigin + (this.world.t - this.bootT)
  }
}

/** powerSaveBlocker の偽物（OS 側の要求はプロセス終了で消える＝起動ごとに新しい） */
export class FakePowerBlocker implements PowerBlocker {
  readonly started = new Set<number>()
  private next = 1
  start(): number {
    const id = this.next++
    this.started.add(id)
    return id
  }
  stop(id: number): void {
    this.started.delete(id)
  }
  isStarted(id: number): boolean {
    return this.started.has(id)
  }
}

export interface RunningApp {
  bootNumber: number
  db: Db
  status: DatabaseStatus
  clock: MasterClock
  session: AppSession
  ctx: AppContext
  gate: ClosingGate
  power: FakePowerBlocker
  shutdown: ShutdownSequence
  suspend: SuspendTracker
}

export class Harness {
  readonly dir: string
  readonly world: World
  private bootCount = 0
  app: RunningApp | null = null

  constructor(startAt: number) {
    this.dir = mkdtempSync(join(tmpdir(), 'wgc-integration-'))
    this.world = new World(startAt)
  }

  /** 本番の起動順序（BOOT_ORDER）で起動する */
  boot(): RunningApp {
    if (this.app) throw new Error('already running')
    const bootNumber = ++this.bootCount
    // 単調時計の原点は起動ごとに異なる（本番の performance.now() はプロセスごとに 0 付近から始まる）
    const clock = new MasterClock(new BootTimeSource(this.world, 1_000 + bootNumber * 7_777.25), `boot-${bootNumber}`)
    // 1
    const { db, status } = openAppDatabase(this.dir)
    // 2
    const session = registerBootSession(db, createRepositories(db, () => clock.now(), clock.bootSessionId), clock, 'integration')
    // 3
    const power = new FakePowerBlocker()
    const ctx = createAppContext(db, clock, session, { powerBlocker: power })
    // 4（本番は appClosingGate（プロセスで 1 つ）。テストでは起動＝プロセスごとに新しいゲート）
    const gate = new ClosingGate()
    const shutdown = new ShutdownSequence({
      gate,
      releasePower: () => ctx.power.release(),
      closeAppDb: () => closeAppDatabase(),
      writeCleanShutdown: () =>
        appendCleanShutdownRecord(status.path, {
          bootSessionId: clock.bootSessionId,
          at: clock.now(),
          wallAt: clock.wallNow(),
          monoMs: clock.monoNow()
        })
    })
    // 5
    ctx.recovery.holdAfterUncleanShutdown(ctx.previousShutdown)
    // 6
    ctx.power.reconcile()
    // 7
    const suspend = new SuspendTracker(clock, ctx.repos.lifecycle, gate)
    this.app = { bootNumber, db, status, clock, session, ctx, gate, power, shutdown, suspend }
    return this.app
  }

  /** 正常終了（本番の ShutdownSequence をそのまま実行） */
  cleanShutdown(): ShutdownOutcome {
    const a = this.require()
    const outcome = a.shutdown.run()
    this.app = null
    return outcome
  }

  /**
   * 異常終了の再現：正常終了の手順を通らずにプロセスが消えた状態（CLEAN_SHUTDOWN が書かれない）。
   * DB 接続はテストプロセス内で閉じる必要があるため閉じるが、確定済みのデータ以外に影響しない。
   * （実際の強制終了（SIGKILL）での耐久性は tests/durability/crash.test.ts で別に検証している）
   */
  crash(): void {
    this.require()
    closeAppDatabase()
    this.app = null
  }

  /** 停止していた時間を進めてから起動する */
  restartAfter(downMs: number): RunningApp {
    this.world.advance(downMs)
    return this.boot()
  }

  require(): RunningApp {
    if (!this.app) throw new Error('app is not running')
    return this.app
  }

  dispose(): void {
    if (this.app) closeAppDatabase()
    this.app = null
    rmSync(this.dir, { recursive: true, force: true })
  }
}
