import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppContext } from '../../src/main/app-context'
import { CSV_FILES, CSV_HEADERS } from '../../src/main/services/csv-service'
import { createTestDb, type TestDb } from '../helpers/db'
import { MIN, SEC, bootApp, startedRace } from '../helpers/app'
import { readCsv } from '../helpers/csv-parse'

let t: TestDb
let ctx: AppContext
let out: string
beforeEach(() => {
  t = createTestDb()
  ctx = bootApp(t)
  out = mkdtempSync(join(tmpdir(), 'wgc-csv-'))
})
afterEach(() => {
  t.cleanup()
  rmSync(out, { recursive: true, force: true })
})

function read(dir: string, name: string): Record<string, string>[] {
  return readCsv(readFileSync(join(dir, name), 'utf8'))
}

/** 一通りのデータを持つ大会 */
function fullRace() {
  const r = startedRace(t, ctx)
  const op = ctx.operators.create('計測係')
  ctx.operators.select(op.id)
  const r2 = ctx.teams.create(r.event.id, { name: 'B,工業"大"', bibNumber: '07' })
  t.clock.advance(10 * MIN)
  t.clock.wallOffset = 250 // PC 実日時はマスタークロックと 250ms ずれている
  const l1 = ctx.laps.register(r.event.id)
  t.clock.advance(SEC)
  ctx.competitors.register(r.rival.id)
  ctx.competitors.register(r2.id)
  t.clock.advance(10 * MIN)
  const l2 = ctx.laps.register(r.event.id)
  ctx.competitors.register(r.rival.id)
  ctx.vehicleData.create(l1.recordId, { speed: '062.50', voltage: '', current: '0', integratedValue: '1,234 Wh?' })
  ctx.vehicleData.create(l2.recordId, { speed: '61' })
  ctx.memos.create(r.event.id, 'ピットイン,タイヤ交換\n"ドライバー"交代')
  return { ...r, r2, op, l1, l2 }
}

describe('CSV content (spec §13, D-039..D-043)', () => {
  it('writes all five files with BOM, CRLF and the fixed headers', () => {
    const { event } = fullRace()
    const res = ctx.csv.exportTo(out, event.id)
    expect(res.files.map((f) => f.split(/[\\/]/).pop())).toEqual([...CSV_FILES])
    for (const name of CSV_FILES) {
      const raw = readFileSync(join(res.directory, name))
      expect(raw.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
      const text = raw.toString('utf8')
      expect(text.slice(1).split('\r\n')[0]).toBe(CSV_HEADERS[name].join(','))
      // 引用符の外にある改行はすべて CRLF
      expect(/(^|[^\r])\n/.test(text.replace(/"(?:[^"]|"")*"/g, ''))).toBe(false)
    }
  })

  it('lap_records: master and PC times in separate columns, lap time in ms and H:mm:ss.SSS', () => {
    const { event, startAt } = fullRace()
    const rows = read(ctx.csv.exportTo(out, event.id).directory, 'lap_records.csv')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      team_name: 'Tamagawa',
      team_deleted: '0',
      lap_number: '1',
      passed_at_master_jst: '2026-10-01 09:10:00.000',
      passed_at_pc_jst: '2026-10-01 09:10:00.250',
      lap_time_ms: String(10 * MIN),
      lap_time: '0:10:00.000',
      clock_anomaly_session: ''
    })
    expect(rows[1]!.lap_time_ms).toBe(String(10 * MIN + SEC))
    expect(rows[1]!.lap_time).toBe('0:10:01.000')
    void startAt
  })

  it('competitor_records: first lap time blank (no base), names with commas/quotes intact', () => {
    const { event, rival } = fullRace()
    const rows = read(ctx.csv.exportTo(out, event.id).directory, 'competitor_records.csv')
    const rivalRows = rows.filter((r) => r.team_id === String(rival.id))
    expect(rivalRows.map((r) => [r.lap_number, r.lap_time_ms, r.lap_time])).toEqual([
      ['1', '', ''],
      ['2', String(10 * MIN), '0:10:00.000']
    ])
    const b = rows.find((r) => r.team_name === 'B,工業"大"')!
    expect(b).toMatchObject({ bib_number: '07', lap_number: '1' })
    // 自チームは含まれない（lap_records.csv 側）
    expect(rows.some((r) => r.team_name === 'Tamagawa')).toBe(false)
  })

  it('vehicle_data: raw strings, blank stays blank and 0 stays 0', () => {
    const { event } = fullRace()
    const rows = read(ctx.csv.exportTo(out, event.id).directory, 'vehicle_data.csv')
    expect(rows[0]).toMatchObject({ lap_number: '1', speed_kmh: '062.50', voltage_v: '', current_a: '0', integrated_value: '1,234 Wh?' })
    expect(rows[1]).toMatchObject({ lap_number: '2', speed_kmh: '61', voltage_v: '', current_a: '', integrated_value: '' })
  })

  it('memos: newlines, commas and quotes survive', () => {
    const { event } = fullRace()
    const rows = read(ctx.csv.exportTo(out, event.id).directory, 'memos.csv')
    expect(rows[0]!.body).toBe('ピットイン,タイヤ交換\n"ドライバー"交代')
    expect(rows[0]!.noted_at_master_jst).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/)
  })

  it('excludes deleted records from record CSVs but keeps them in operation history', () => {
    const { event, rival, l1 } = fullRace()
    const memo = ctx.memos.list(event.id)[0]!
    ctx.memos.delete(memo.id)
    const pass = ctx.competitors.listByTeam(rival.id)[0]!
    ctx.competitors.delete(pass.recordId)
    ctx.laps.delete(l1.recordId) // 車両データ付きラップの削除
    const dir = ctx.csv.exportTo(out, event.id).directory
    expect(read(dir, 'memos.csv')).toEqual([])
    expect(read(dir, 'competitor_records.csv').filter((r) => r.team_id === String(rival.id))).toHaveLength(1)
    const laps = read(dir, 'lap_records.csv')
    expect(laps.map((r) => r.lap_number)).toEqual(['1']) // 再構成された周回番号
    expect(read(dir, 'vehicle_data.csv').map((r) => r.speed_kmh)).toEqual(['61']) // 削除済みラップの車両データは出さない
    const deletes = read(dir, 'operation_history.csv').filter((r) => r.action === 'DELETE')
    expect(deletes.map((r) => r.target_table).sort()).toEqual(['competitor_passes', 'lap_records', 'memos'])
    expect(JSON.parse(deletes.find((r) => r.target_table === 'memos')!.before_json!).body).toContain('ピットイン')
  })

  it('includes deleted teams with team_deleted = 1 (D-008)', () => {
    const { event, rival } = fullRace()
    ctx.teams.delete(rival.id, ctx.teams.getDeletionImpact(rival.id))
    const rows = read(ctx.csv.exportTo(out, event.id).directory, 'competitor_records.csv')
    const rivalRows = rows.filter((r) => r.team_id === String(rival.id))
    expect(rivalRows).toHaveLength(2)
    expect(rivalRows.every((r) => r.team_deleted === '1')).toBe(true)
  })

  it('operation_history: scopes, blank event id for operator management, operator "未設定"', () => {
    const e1 = ctx.events.create({ name: 'E1' }) // 操作者未選択で作成
    const op = ctx.operators.create('佐藤')
    ctx.operators.select(op.id)
    ctx.teams.create(e1.id, { name: 'X' })
    const e2 = ctx.events.create({ name: 'E2' })
    ctx.teams.create(e2.id, { name: 'Y' })
    const rows = read(ctx.csv.exportTo(out, e1.id).directory, 'operation_history.csv')
    expect(rows.map((r) => [r.scope, r.event_id, r.target_table, r.operator_name])).toEqual([
      ['EVENT', String(e1.id), 'events', '未設定'],
      ['OPERATOR_MANAGEMENT', '', 'operators', '未設定'],
      ['EVENT', String(e1.id), 'teams', '佐藤']
    ])
    // E2 の CSV にも同じ操作者管理の行が含まれる（重複する仕様、D-042）
    const rows2 = read(ctx.csv.exportTo(out, e2.id).directory, 'operation_history.csv')
    expect(rows2.filter((r) => r.scope === 'OPERATOR_MANAGEMENT').map((r) => r.history_id)).toEqual(
      rows.filter((r) => r.scope === 'OPERATOR_MANAGEMENT').map((r) => r.history_id)
    )
    expect(rows2.some((r) => r.event_id === String(e1.id))).toBe(false)
  })

  it('marks records made in a session with a PC clock anomaly (D-013)', () => {
    const { event } = fullRace()
    t.repos.appSessions.insert({
      id: 'boot-anomaly',
      startedWallAt: 0,
      latestSavedAtBefore: 1,
      clockAnomaly: true,
      anomalyDetail: 'test',
      appVersion: null
    })
    t.repos.lapRecords.insert({ eventId: event.id, teamId: ctx.teams.list(event.id).find((x) => x.isOwnTeam)!.id, passedAt: t.clock.t + 1, bootSessionId: 'boot-anomaly' })
    const rows = read(ctx.csv.exportTo(out, event.id).directory, 'lap_records.csv')
    expect(rows.at(-1)!.clock_anomaly_session).toBe('1')
  })
})

describe('Export location (D-041)', () => {
  it('creates <id>_<name> folders, overwrites on re-export, and never mixes events', () => {
    const a = fullRace()
    const b = ctx.events.create({ name: 'WGC/2027' })
    const r1 = ctx.csv.exportTo(out, a.event.id)
    expect(r1.directory).toBe(join(out, `${a.event.id}_WGC`))
    // 再出力：最新データで上書き
    t.clock.advance(MIN)
    ctx.memos.create(a.event.id, '追加メモ')
    const r2 = ctx.csv.exportTo(out, a.event.id)
    expect(r2.directory).toBe(r1.directory)
    expect(read(r2.directory, 'memos.csv').map((m) => m.body)).toEqual(['ピットイン,タイヤ交換\n"ドライバー"交代', '追加メモ'])
    // 一時ファイルが残らない
    expect(readdirSync(r2.directory).sort()).toEqual([...CSV_FILES].sort())
    // 別大会は別フォルダ
    const r3 = ctx.csv.exportTo(out, b.id)
    expect(r3.directory).toBe(join(out, `${b.id}_WGC_2027`))
    expect(read(r3.directory, 'lap_records.csv')).toEqual([])
    expect(readdirSync(out).sort()).toEqual([`${a.event.id}_WGC`, `${b.id}_WGC_2027`].sort())
  })

  it('replaces an existing file completely (no leftover content)', () => {
    const { event } = fullRace()
    const dir = ctx.csv.exportTo(out, event.id).directory
    writeFileSync(join(dir, 'memos.csv'), 'garbage that is much longer than the real content '.repeat(100))
    ctx.csv.exportTo(out, event.id)
    expect(read(dir, 'memos.csv')).toHaveLength(1)
  })
})
