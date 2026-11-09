import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel, type WgcApi } from '@shared/ipc-contract'

// Renderer には型定義済みの操作のみを公開する。ipcRenderer そのものは公開しない。
const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

const api: WgcApi = {
  app: {
    getInfo: () => invoke(IpcChannel.appGetInfo)
  },
  events: {
    list: () => invoke(IpcChannel.eventsList),
    get: (id) => invoke(IpcChannel.eventsGet, id),
    create: (input) => invoke(IpcChannel.eventsCreate, input),
    update: (id, patch) => invoke(IpcChannel.eventsUpdate, id, patch)
  },
  teams: {
    list: (eventId, includeDeleted) => invoke(IpcChannel.teamsList, eventId, includeDeleted === true),
    create: (eventId, input) => invoke(IpcChannel.teamsCreate, eventId, input),
    update: (id, patch) => invoke(IpcChannel.teamsUpdate, id, patch),
    deletionImpact: (id) => invoke(IpcChannel.teamsDeletionImpact, id),
    delete: (id, impact) => invoke(IpcChannel.teamsDelete, id, impact),
    restore: (id) => invoke(IpcChannel.teamsRestore, id)
  },
  clock: {
    getStatus: () => invoke(IpcChannel.clockGetStatus)
  },
  race: {
    getState: (eventId) => invoke(IpcChannel.raceGetState, eventId),
    start: (eventId) => invoke(IpcChannel.raceStart, eventId),
    pause: (eventId) => invoke(IpcChannel.racePause, eventId),
    resume: (eventId) => invoke(IpcChannel.raceResume, eventId),
    end: (eventId) => invoke(IpcChannel.raceEnd, eventId),
    correctStart: (eventId, at) => invoke(IpcChannel.raceCorrectStart, eventId, at)
  },
  laps: {
    list: (eventId) => invoke(IpcChannel.lapsList, eventId),
    register: (eventId) => invoke(IpcChannel.lapsRegister, eventId),
    addPast: (eventId, at) => invoke(IpcChannel.lapsAddPast, eventId, at),
    update: (recordId, at) => invoke(IpcChannel.lapsUpdate, recordId, at),
    delete: (recordId) => invoke(IpcChannel.lapsDelete, recordId)
  },
  undo: {
    peek: (eventId) => invoke(IpcChannel.undoPeek, eventId),
    run: (eventId, group) => invoke(IpcChannel.undoRun, eventId, group)
  },
  competitors: {
    listByEvent: (eventId) => invoke(IpcChannel.competitorsListByEvent, eventId),
    register: (teamId) => invoke(IpcChannel.competitorsRegister, teamId),
    addPast: (teamId, at) => invoke(IpcChannel.competitorsAddPast, teamId, at),
    update: (recordId, at) => invoke(IpcChannel.competitorsUpdate, recordId, at),
    delete: (recordId) => invoke(IpcChannel.competitorsDelete, recordId)
  },
  standings: {
    get: (eventId) => invoke(IpcChannel.standingsGet, eventId)
  },
  vehicleData: {
    list: (eventId) => invoke(IpcChannel.vehicleList, eventId),
    create: (lapRecordId, fields) => invoke(IpcChannel.vehicleCreate, lapRecordId, fields),
    update: (id, fields) => invoke(IpcChannel.vehicleUpdate, id, fields),
    delete: (id) => invoke(IpcChannel.vehicleDelete, id)
  },
  operators: {
    list: (includeDeleted) => invoke(IpcChannel.operatorsList, includeDeleted === true),
    create: (name) => invoke(IpcChannel.operatorsCreate, name),
    rename: (id, name) => invoke(IpcChannel.operatorsRename, id, name),
    delete: (id) => invoke(IpcChannel.operatorsDelete, id),
    select: (id) => invoke(IpcChannel.operatorsSelect, id),
    current: () => invoke(IpcChannel.operatorsCurrent)
  },
  memos: {
    list: (eventId) => invoke(IpcChannel.memosList, eventId),
    create: (eventId, body) => invoke(IpcChannel.memosCreate, eventId, body),
    update: (id, body) => invoke(IpcChannel.memosUpdate, id, body),
    delete: (id) => invoke(IpcChannel.memosDelete, id)
  },
  csv: {
    export: (eventId) => invoke(IpcChannel.csvExport, eventId)
  },
  stoppages: {
    list: (eventId) => invoke(IpcChannel.stoppagesList, eventId),
    create: (eventId, s, e) => invoke(IpcChannel.stoppagesCreate, eventId, s, e),
    update: (id, s, e) => invoke(IpcChannel.stoppagesUpdate, id, s, e),
    delete: (id) => invoke(IpcChannel.stoppagesDelete, id)
  },
  strategy: {
    get: (eventId) => invoke(IpcChannel.strategyGet, eventId)
  },
  warnings: {
    evaluate: (eventId) => invoke(IpcChannel.warningsEvaluate, eventId),
    acknowledge: (eventId, occurrenceId) => invoke(IpcChannel.warningsAcknowledge, eventId, occurrenceId)
  }
}

contextBridge.exposeInMainWorld('wgc', api)
