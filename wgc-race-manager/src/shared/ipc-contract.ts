/**
 * Renderer ⇔ Main の IPC 契約。
 * Renderer に公開する操作はここで型定義したものに限る（仕様 §2.1）。
 * データ操作系はすべて Result<T> を返し、例外は投げない。
 */
import type { Result } from './errors'
import type { AppSession, LapView, RaceEvent, Team } from './types/entities'
import type { RaceClockSnapshot } from './time/race-clock'
import type {
  EventCreateInput,
  EventUpdateInput,
  TeamCreateInput,
  TeamUpdateInput
} from './validation/event-team'

export const IpcChannel = {
  appGetInfo: 'app:get-info',
  eventsList: 'events:list',
  eventsGet: 'events:get',
  eventsCreate: 'events:create',
  eventsUpdate: 'events:update',
  teamsList: 'teams:list',
  teamsCreate: 'teams:create',
  teamsUpdate: 'teams:update',
  teamsDeletionImpact: 'teams:deletion-impact',
  teamsDelete: 'teams:delete',
  teamsRestore: 'teams:restore',
  clockGetStatus: 'clock:get-status',
  raceGetState: 'race:get-state',
  raceStart: 'race:start',
  racePause: 'race:pause',
  raceResume: 'race:resume',
  raceEnd: 'race:end',
  raceCorrectStart: 'race:correct-start',
  lapsList: 'laps:list',
  lapsRegister: 'laps:register',
  lapsAddPast: 'laps:add-past',
  lapsUpdate: 'laps:update',
  lapsDelete: 'laps:delete',
  undoPeek: 'undo:peek',
  undoRun: 'undo:run',
  competitorsListByEvent: 'competitors:list-by-event',
  competitorsRegister: 'competitors:register',
  competitorsAddPast: 'competitors:add-past',
  competitorsUpdate: 'competitors:update',
  competitorsDelete: 'competitors:delete',
  standingsGet: 'standings:get'
} as const

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel]

export interface AppInfo {
  appVersion: string
  electron: string
  chrome: string
  node: string
  sqlite: string
  platform: string
  userDataPath: string
  dbPath: string
  dbSchemaVersion: number
  /** PRAGMA quick_check の結果（正常時は ok） */
  dbIntegrity: string
}

export interface TeamDeletionImpact {
  lapRecords: number
  competitorPasses: number
  vehicleData: number
}

export interface ClockStatus {
  /** マスタークロックの現在日時（UTC ms） */
  masterNow: number
  /** PC の実日時（UTC ms） */
  wallNow: number
  /** PC 実日時 − マスタークロック（起動中の OS 時刻変更で 0 から離れる。参考情報） */
  wallDriftMs: number
  bootSessionId: string
  /** この起動セッション（PC 時刻異常の有無、D-013） */
  session: AppSession | null
}

export interface UndoCandidate {
  operationGroup: string
  description: string
  operatedAt: number
  operatorName: string | null
  historyIds: number[]
}

export interface StandingRow {
  rank: number
  tied: boolean
  teamId: number
  teamName: string
  bibNumber: string | null
  isOwnTeam: boolean
  teamDeleted: boolean
  laps: number
  lastPassAt: number | null
  lapsBehindLeader: number
  lapsBehindAhead: number | null
  timeBehindAheadMs: number | null
}

export interface Standings {
  ruleId: string
  ruleLabel: string
  /** true の場合、画面で「暫定順位」と明示する（D-023） */
  provisional: boolean
  rows: StandingRow[]
}

/** preload が window.wgc として公開する API */
export interface WgcApi {
  app: {
    getInfo(): Promise<AppInfo>
  }
  events: {
    list(): Promise<Result<RaceEvent[]>>
    get(id: number): Promise<Result<RaceEvent>>
    create(input: EventCreateInput): Promise<Result<RaceEvent>>
    update(id: number, patch: EventUpdateInput): Promise<Result<RaceEvent>>
  }
  teams: {
    list(eventId: number, includeDeleted?: boolean): Promise<Result<Team[]>>
    create(eventId: number, input: TeamCreateInput): Promise<Result<Team>>
    update(id: number, patch: TeamUpdateInput): Promise<Result<Team>>
    deletionImpact(id: number): Promise<Result<TeamDeletionImpact>>
    delete(id: number, confirmedImpact: TeamDeletionImpact): Promise<Result<Team>>
    restore(id: number): Promise<Result<Team>>
  }
  clock: {
    getStatus(): Promise<Result<ClockStatus>>
  }
  race: {
    getState(eventId: number): Promise<Result<RaceClockSnapshot>>
    start(eventId: number): Promise<Result<RaceClockSnapshot>>
    pause(eventId: number): Promise<Result<RaceClockSnapshot>>
    resume(eventId: number): Promise<Result<RaceClockSnapshot>>
    end(eventId: number): Promise<Result<RaceClockSnapshot>>
    correctStart(eventId: number, actualStartAt: number): Promise<Result<RaceClockSnapshot>>
  }
  laps: {
    list(eventId: number): Promise<Result<LapView[]>>
    register(eventId: number): Promise<Result<LapView>>
    addPast(eventId: number, passedAt: number): Promise<Result<LapView>>
    update(recordId: number, passedAt: number): Promise<Result<LapView>>
    delete(recordId: number): Promise<Result<null>>
  }
  undo: {
    peek(eventId: number): Promise<Result<UndoCandidate | null>>
    run(eventId: number, operationGroup: string): Promise<Result<UndoCandidate>>
  }
  competitors: {
    /** チーム ID → 通過一覧 */
    listByEvent(eventId: number): Promise<Result<Record<number, LapView[]>>>
    register(teamId: number): Promise<Result<LapView>>
    addPast(teamId: number, passedAt: number): Promise<Result<LapView>>
    update(recordId: number, passedAt: number): Promise<Result<LapView>>
    delete(recordId: number): Promise<Result<null>>
  }
  standings: {
    get(eventId: number): Promise<Result<Standings>>
  }
}
