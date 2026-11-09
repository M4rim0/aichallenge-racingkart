import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

/** 時刻の取得元。テストで差し替えられるようにする。 */
export interface TimeSource {
  /** OS の実日時（epoch ms） */
  wallNow(): number
  /** 単調増加時計（ms）。OS の時刻変更の影響を受けない */
  monoNow(): number
}

export const systemTimeSource: TimeSource = {
  wallNow: () => Date.now(),
  monoNow: () => performance.now()
}

/**
 * マスタークロック（仕様 §4.1, §4.4）。
 *
 * 起動時に OS 実日時と単調時計の組（アンカー）を取得し、以後は
 *   マスタークロック日時 = アンカー実日時 + (単調時計 − アンカー単調時計)
 * で進める。起動中に OS の時刻が変更されても、マスタークロックは影響を受けない。
 * 記録には PC の実日時（wallNow）も併せて保存する（D-015）。
 */
export class MasterClock {
  readonly bootSessionId: string
  readonly anchorWall: number
  private readonly anchorMono: number

  constructor(
    private readonly source: TimeSource = systemTimeSource,
    bootSessionId: string = randomUUID()
  ) {
    this.bootSessionId = bootSessionId
    this.anchorWall = source.wallNow()
    this.anchorMono = source.monoNow()
  }

  /** マスタークロックの現在日時（整数 ms） */
  now(): number {
    return this.anchorWall + Math.round(this.source.monoNow() - this.anchorMono)
  }

  /** PC の実日時 */
  wallNow(): number {
    return this.source.wallNow()
  }

  /** 単調時計の値 */
  monoNow(): number {
    return this.source.monoNow()
  }

  /** PC 実日時 − マスタークロック。起動中に OS 時刻が変更されると 0 から離れる（参考情報） */
  wallDriftMs(): number {
    return this.source.wallNow() - this.now()
  }

  /** 記録用のスタンプ（マスタークロック日時・PC 実日時・単調時計・起動セッション） */
  stamp(): { at: number; wallAt: number; monoMs: number; bootSessionId: string } {
    const mono = this.source.monoNow()
    return {
      at: this.anchorWall + Math.round(mono - this.anchorMono),
      wallAt: this.source.wallNow(),
      monoMs: mono,
      bootSessionId: this.bootSessionId
    }
  }
}
