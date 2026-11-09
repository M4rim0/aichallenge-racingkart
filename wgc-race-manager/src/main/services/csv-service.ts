import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OperationHistoryEntry, RaceEvent, Team } from '@shared/types/entities'
import { AppError, ErrorCode } from '@shared/errors'
import { toCsv, type CsvValue } from '@shared/csv/csv'
import { deriveLaps } from '@shared/race/laps'
import { formatDuration, formatJst } from '@shared/time/jst'
import type { Repositories } from '../repositories'

/**
 * CSV 出力（仕様 §13、決定 D-005, D-008, D-013, D-025, D-032, D-039〜D-043）。
 * 列名・列の意味は docs/design/csv.md を参照。列名は互換性のため安易に変更しない（D-043）。
 */

export const CSV_FILES = [
  'lap_records.csv',
  'vehicle_data.csv',
  'competitor_records.csv',
  'memos.csv',
  'operation_history.csv'
] as const
export type CsvFileName = (typeof CSV_FILES)[number]

export const CSV_HEADERS: Record<CsvFileName, readonly string[]> = {
  'lap_records.csv': [
    'event_id',
    'team_id',
    'team_name',
    'bib_number',
    'team_deleted',
    'lap_number',
    'passed_at_master_jst',
    'passed_at_pc_jst',
    'lap_time_ms',
    'lap_time',
    'record_id',
    'boot_session_id',
    'clock_anomaly_session'
  ],
  'vehicle_data.csv': [
    'event_id',
    'lap_number',
    'passed_at_master_jst',
    'speed_kmh',
    'voltage_v',
    'current_a',
    'integrated_value',
    'lap_record_id',
    'vehicle_data_id',
    'updated_at_master_jst'
  ],
  'competitor_records.csv': [
    'event_id',
    'team_id',
    'team_name',
    'bib_number',
    'team_deleted',
    'lap_number',
    'passed_at_master_jst',
    'passed_at_pc_jst',
    'lap_time_ms',
    'lap_time',
    'record_id',
    'boot_session_id',
    'clock_anomaly_session'
  ],
  'memos.csv': ['event_id', 'memo_id', 'noted_at_master_jst', 'body', 'updated_at_master_jst'],
  'operation_history.csv': [
    'history_id',
    'scope',
    'event_id',
    'operated_at_master_jst',
    'operator_id',
    'operator_name',
    'action',
    'target_table',
    'target_id',
    'before_json',
    'after_json',
    'undo_of_history_id',
    'operation_group',
    'note',
    'boot_session_id',
    'clock_anomaly_session'
  ]
}

const jst = (ms: number | null | undefined): string => (ms === null || ms === undefined ? '' : formatJst(ms))
const flag = (b: boolean): string => (b ? '1' : '0')

export interface ExportResult {
  directory: string
  files: string[]
}

export class CsvService {
  constructor(private readonly repos: Repositories) {}

  /** 大会の 5 つの CSV の内容を生成する（書き込みはしない） */
  build(eventId: number): Record<CsvFileName, string> {
    const event = this.repos.events.findById(eventId)
    if (!event) throw new AppError(ErrorCode.EVENT_NOT_FOUND, `大会が見つかりません (id=${eventId})`)
    const teams = new Map<number, Team>(
      this.repos.teams.listByEvent(eventId, { includeDeleted: true }).map((t) => [t.id, t])
    )
    const anomaly = new Map(this.repos.appSessions.listAll().map((s) => [s.id, s.clockAnomaly]))
    const anomalyFlag = (bootId: string | null): string => {
      if (bootId === null) return ''
      const a = anomaly.get(bootId)
      return a === undefined ? '' : flag(a)
    }

    return {
      'lap_records.csv': this.lapRecords(event, teams, anomalyFlag),
      'vehicle_data.csv': this.vehicleData(event),
      'competitor_records.csv': this.competitorRecords(event, teams, anomalyFlag),
      'memos.csv': this.memos(event),
      'operation_history.csv': this.history(event, anomalyFlag)
    }
  }

  /**
   * 指定フォルダの下に `<大会ID>_<大会名>` フォルダを作り、5 ファイルを書き出す（既存は上書き）。
   * 各ファイルは一時ファイルに書いてから置き換えるため、書き込み途中の壊れたファイルが残らない。
   */
  exportTo(baseDir: string, eventId: number): ExportResult {
    const contents = this.build(eventId)
    const event = this.repos.events.getById(eventId)
    const dir = join(baseDir, eventFolderName(event))
    mkdirSync(dir, { recursive: true })
    const written: string[] = []
    const tmpSuffix = `.tmp-${process.pid}-${Date.now()}`
    try {
      for (const name of CSV_FILES) writeFileSync(join(dir, name + tmpSuffix), contents[name], { encoding: 'utf8' })
      for (const name of CSV_FILES) {
        try {
          renameSync(join(dir, name + tmpSuffix), join(dir, name))
        } catch (e) {
          throw new AppError(
            ErrorCode.CSV_WRITE_FAILED,
            `${name} を書き込めませんでした。Excel などでファイルを開いている場合は閉じてから再度出力してください（${(e as Error).message}）`
          )
        }
        written.push(join(dir, name))
      }
    } finally {
      for (const name of CSV_FILES) rmSync(join(dir, name + tmpSuffix), { force: true })
    }
    return { directory: dir, files: written }
  }

  private lapRecords(event: RaceEvent, teams: Map<number, Team>, anomalyFlag: (b: string | null) => string): string {
    const byTeam = groupBy(this.repos.lapRecords.listByEvent(event.id), (r) => r.teamId)
    const rows: CsvValue[][] = []
    for (const [teamId, recs] of byTeam) {
      const team = teams.get(teamId)
      for (const d of deriveLaps(recs, event.actualStartAt)) {
        rows.push([
          event.id,
          teamId,
          team?.name,
          team?.bibNumber,
          flag(team?.deletedAt != null),
          d.lapNumber,
          jst(d.record.passedAt),
          jst(d.record.passedWallAt),
          d.lapTimeMs,
          d.lapTimeMs === null ? null : formatDuration(d.lapTimeMs),
          d.record.id,
          d.record.bootSessionId,
          anomalyFlag(d.record.bootSessionId)
        ])
      }
    }
    return toCsv(CSV_HEADERS['lap_records.csv'], rows)
  }

  private vehicleData(event: RaceEvent): string {
    // 有効なラップに紐づく有効な車両データのみ（削除済みラップのものは出さない、D-025）
    const laps = deriveLaps(this.repos.lapRecords.listByEvent(event.id), event.actualStartAt)
    const rows: CsvValue[][] = []
    for (const d of laps) {
      const v = this.repos.vehicleData.findByLapRecord(d.record.id)
      if (!v) continue
      rows.push([
        event.id,
        d.lapNumber,
        jst(d.record.passedAt),
        v.speed,
        v.voltage,
        v.current,
        v.integratedValue,
        d.record.id,
        v.id,
        jst(v.updatedAt)
      ])
    }
    return toCsv(CSV_HEADERS['vehicle_data.csv'], rows)
  }

  private competitorRecords(event: RaceEvent, teams: Map<number, Team>, anomalyFlag: (b: string | null) => string): string {
    const byTeam = groupBy(this.repos.competitorPasses.listByEvent(event.id), (r) => r.teamId)
    const rows: CsvValue[][] = []
    for (const teamId of [...byTeam.keys()].sort((a, b) => a - b)) {
      const team = teams.get(teamId)
      // 他チームの初回ラップタイムは基準時刻がないため算出しない（D-005, D-020）
      for (const d of deriveLaps(byTeam.get(teamId)!, null)) {
        rows.push([
          event.id,
          teamId,
          team?.name,
          team?.bibNumber,
          flag(team?.deletedAt != null),
          d.lapNumber,
          jst(d.record.passedAt),
          jst(d.record.passedWallAt),
          d.lapTimeMs,
          d.lapTimeMs === null ? null : formatDuration(d.lapTimeMs),
          d.record.id,
          d.record.bootSessionId,
          anomalyFlag(d.record.bootSessionId)
        ])
      }
    }
    return toCsv(CSV_HEADERS['competitor_records.csv'], rows)
  }

  private memos(event: RaceEvent): string {
    const rows = this.repos.memos
      .listByEvent(event.id)
      .map((m): CsvValue[] => [event.id, m.id, jst(m.notedAt), m.body, jst(m.updatedAt)])
    return toCsv(CSV_HEADERS['memos.csv'], rows)
  }

  /**
   * 大会の全操作履歴 + 大会に属さない操作者管理の履歴（D-042）。
   * 操作者管理の履歴は全大会共通のため、どの大会の CSV にも同じ行が含まれる。
   */
  private history(event: RaceEvent, anomalyFlag: (b: string | null) => string): string {
    const entries: OperationHistoryEntry[] = this.repos.history
      .listAll()
      .filter((h) => h.eventId === event.id || h.eventId === null)
    const rows = entries.map((h): CsvValue[] => [
      h.id,
      h.eventId === null ? 'OPERATOR_MANAGEMENT' : 'EVENT',
      h.eventId,
      jst(h.operatedAt),
      h.operatorId,
      h.operatorNameSnapshot ?? '未設定',
      h.action,
      h.targetTable,
      h.targetId,
      h.beforeJson,
      h.afterJson,
      h.undoOfHistoryId,
      h.operationGroup,
      h.note,
      h.bootSessionId,
      anomalyFlag(h.bootSessionId)
    ])
    return toCsv(CSV_HEADERS['operation_history.csv'], rows)
  }
}

/**
 * 大会フォルダ名 `<大会ID>_<大会名>`（D-041）。
 * Windows で使えない文字（\ / : * ? " < > | と制御文字）は `_` に置き換え、末尾の空白・ピリオドは除く。
 * 大会 ID を先頭に付けるため、大会名が同じ・変更された場合でも別大会と混ざらない。
 */
export function eventFolderName(event: Pick<RaceEvent, 'id' | 'name'>): string {
  const safe = event.name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 80)
  return safe === '' ? String(event.id) : `${event.id}_${safe}`
}

function groupBy<T, K>(items: readonly T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>()
  for (const it of items) {
    const k = key(it)
    const list = m.get(k)
    if (list) list.push(it)
    else m.set(k, [it])
  }
  return m
}
