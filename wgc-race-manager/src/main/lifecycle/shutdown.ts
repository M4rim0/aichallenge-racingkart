import { configure } from '../db/connection'
import { openSqlite } from '../db/sqlite-native'
import type { ClosingGate } from './closing-gate'

/**
 * 正常終了の手順（決定 D-066）。
 *
 *   1. 終了処理中にする（以後、通常の IPC 経由の操作はすべて拒否）
 *   2. 電源の抑制を解除する
 *   3. アプリの DB 接続を閉じる。**閉じられなかった場合は正常終了の記録を書かない**（= 次回起動時に異常終了と判定）
 *   4. 閉じられた場合のみ、別の短い接続で正常終了の記録（CLEAN_SHUTDOWN）を 1 件追記し、その接続を閉じる
 *
 * 正常終了の記録を「アプリの DB 接続を閉じた後」に書くことで、
 * 「記録を書いた後、アプリの接続を閉じる前に落ちた」場合に正常終了と誤判定する問題をなくしている。
 *
 * 残る限界（docs/design/recovery-power.md に記載）：
 * - 4 の記録用接続で、記録の確定後・接続を閉じる前に落ちた場合は「正常終了」と判定される。
 *   ただしこの時点でアプリの記録はすべて確定・クローズ済みで、記録用接続が書いたのはこの 1 件だけなので、記録の欠落はない。
 * - 3 と 4 の間で落ちた場合は「異常終了」と判定される（安全側の誤判定）。
 * - ストレージの書き込みキャッシュが電源断時に失われるなど、OS・ハードウェア側の障害は検出できない。
 */

export interface ShutdownDeps {
  gate: ClosingGate
  releasePower: () => void
  /** アプリの DB を閉じ、閉じられたら true。失敗は例外または false */
  closeAppDb: () => boolean
  /** 正常終了の記録を追記する（アプリの DB を閉じた後に呼ばれる） */
  writeCleanShutdown: () => void
  log?: (msg: string, e?: unknown) => void
}

export type ShutdownOutcome =
  | { clean: true }
  | { clean: false; reason: 'DB_CLOSE_FAILED' | 'MARKER_FAILED' | 'ALREADY_DONE' }

export class ShutdownSequence {
  private done = false

  constructor(private readonly deps: ShutdownDeps) {}

  run(): ShutdownOutcome {
    if (this.done) return { clean: false, reason: 'ALREADY_DONE' }
    this.done = true
    const { gate, log } = this.deps
    gate.beginClosing()
    try {
      this.deps.releasePower()
    } catch (e) {
      log?.('power release failed', e) // OS はプロセス終了時に解除する
    }
    let closed = false
    try {
      closed = this.deps.closeAppDb()
    } catch (e) {
      log?.('closing the database failed', e)
      closed = false
    }
    if (!closed) return { clean: false, reason: 'DB_CLOSE_FAILED' }
    try {
      this.deps.writeCleanShutdown()
      return { clean: true }
    } catch (e) {
      log?.('writing the clean shutdown record failed', e)
      return { clean: false, reason: 'MARKER_FAILED' }
    }
  }

  isDone(): boolean {
    return this.done
  }
}

/** 正常終了の記録を別の短い接続で追記する（通常の書き込み経路・IPC とは分離した内部処理） */
export function appendCleanShutdownRecord(
  dbPath: string,
  rec: { bootSessionId: string; at: number; wallAt: number; monoMs: number }
): void {
  const db = openSqlite(dbPath, { fileMustExist: true })
  try {
    configure(db)
    db.transaction(() => {
      db.prepare(
        `INSERT INTO app_lifecycle_events (boot_session_id, kind, at, wall_at, mono_ms, anomaly, created_at)
         VALUES (?, 'CLEAN_SHUTDOWN', ?, ?, ?, 0, ?)`
      ).run(rec.bootSessionId, rec.at, rec.wallAt, rec.monoMs, rec.at)
    }).immediate()
  } finally {
    db.close()
  }
}
