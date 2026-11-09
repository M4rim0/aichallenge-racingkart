import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/db/connection'
import { createRepositories, type Repositories } from '../../src/main/repositories'

/** テスト用の手動時計 */
export class FakeNow {
  constructor(public t = Date.UTC(2026, 9, 1, 0, 0, 0)) {}
  readonly fn = (): number => this.t
  advance(ms: number): number {
    this.t += ms
    return this.t
  }
}

export interface TestDb {
  db: Db
  repos: Repositories
  clock: FakeNow
  file: string
  reopen(): TestDb
  cleanup(): void
}

/** 一時ディレクトリにファイル DB を作る（WAL を含めた実際の動作を確認するため :memory: は使わない） */
export function createTestDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), 'wgc-db-'))
  const file = join(dir, 'test.sqlite')
  const clock = new FakeNow()
  const make = (): TestDb => {
    const db = openDatabase(file)
    return {
      db,
      repos: createRepositories(db, clock.fn),
      clock,
      file,
      reopen() {
        db.close()
        return make()
      },
      cleanup() {
        if (db.open) db.close()
        rmSync(dir, { recursive: true, force: true })
      }
    }
  }
  return make()
}
