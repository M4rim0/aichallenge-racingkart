import { fork } from 'node:child_process'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { precheckDatabase } from '../../src/main/db/integrity-precheck'
import { createTestDb, type TestDb } from '../helpers/db'
import { bootApp, MIN } from '../helpers/app'

const require_ = createRequire(import.meta.url)
let t: TestDb | null = null
afterEach(() => t?.cleanup())

describe('Forced termination during writes (§15, D-065, D-066)', () => {
  it('keeps every committed write consistent after SIGKILL mid-write', async () => {
    t = createTestDb()
    const ctx = bootApp(t)
    const event = ctx.events.create({ name: 'crash' })
    const own = ctx.teams.create(event.id, { name: 'Own', isOwnTeam: true })
    ctx.raceClock.start(event.id)
    t.clock.advance(5 * MIN)
    ctx.raceClock.pause(event.id)
    const file = t.file
    t.db.close() // 子プロセスだけが書き込む状態にする

    const child = fork(join(__dirname, 'writer-child.cjs'), [file, require_.resolve('better-sqlite3'), String(event.id), String(own.id)], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc']
    })
    let reported = 0
    await new Promise<void>((resolve, reject) => {
      child.on('message', (m) => {
        if (typeof m === 'number') reported = m
        if (reported >= 400) {
          child.kill('SIGKILL') // 書き込み中に強制終了
          resolve()
        }
      })
      child.on('error', reject)
    })
    await new Promise((r) => child.on('exit', r))
    expect(child.signalCode).toBe('SIGKILL')

    // 1) 起動時の事前チェック：WAL を含めて整合性・参照整合性とも正常
    const pre = precheckDatabase(file)
    expect(pre).toMatchObject({ status: 'OK', integrity: ['ok'], foreignKeyViolations: 0 })

    // 2) 再起動：確定した書き込みはすべて残り、記録と履歴の食い違いがない
    t = t.reopen()
    const ctx2 = bootApp(t)
    const laps = t.repos.lapRecords.listByTeam(own.id)
    expect(laps.length).toBeGreaterThanOrEqual(reported) // 報告済みの件数は確定している
    const hist = t.db.prepare("SELECT target_id FROM operation_history WHERE target_table = 'lap_records'").all() as { target_id: number }[]
    expect(new Set(hist.map((h) => h.target_id))).toEqual(new Set(laps.map((l) => l.id))) // 1 対 1（片方だけ残った行がない）

    // 3) 時計：一時停止状態が保存済みの情報から復元される
    const s = ctx2.raceClock.getState(event.id)
    expect(s.status).toBe('PAUSED')
    expect(s.elapsedMs).toBe(5 * MIN)
  }, 60_000)
})
