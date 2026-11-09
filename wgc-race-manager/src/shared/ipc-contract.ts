/**
 * Renderer ⇔ Main の IPC 契約。
 * Renderer に公開する操作はここで型定義したものに限る（仕様 §2.1）。
 * データ操作系はすべて Result<T> を返し、例外は投げない。
 */
import type { Result } from './errors'
import type { RaceEvent, Team } from './types/entities'
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
  teamsRestore: 'teams:restore'
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
}
