import { app, ipcMain } from 'electron'
import { IpcChannel, type AppInfo, type ClockStatus, type TeamDeletionImpact } from '@shared/ipc-contract'
import { AppError, ErrorCode } from '@shared/errors'
import type { EventCreateInput, EventUpdateInput, TeamCreateInput, TeamUpdateInput } from '@shared/validation/event-team'
import { probeSqliteVersion } from '../db/sqlite-probe'
import { getAppDatabase } from '../db/app-database'
import type { AppContext } from '../app-context'
import { asId, asObject, handle } from './handle'

export function registerIpcHandlers(ctx: AppContext): void {
  ipcMain.handle(IpcChannel.appGetInfo, (): AppInfo => {
    const { status } = getAppDatabase()
    return {
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      sqlite: probeSqliteVersion(),
      platform: process.platform,
      userDataPath: app.getPath('userData'),
      dbPath: status.path,
      dbSchemaVersion: status.schemaVersion,
      dbIntegrity: status.integrity.join('; ')
    }
  })

  handle(IpcChannel.eventsList, () => ctx.events.list())
  handle(IpcChannel.eventsGet, (id: unknown) => ctx.events.get(asId(id)))
  handle(IpcChannel.eventsCreate, (input: unknown) => ctx.events.create(asObject<EventCreateInput>(input)))
  handle(IpcChannel.eventsUpdate, (id: unknown, patch: unknown) =>
    ctx.events.update(asId(id), asObject<EventUpdateInput>(patch))
  )

  handle(IpcChannel.teamsList, (eventId: unknown, includeDeleted: unknown) =>
    ctx.teams.list(asId(eventId, 'eventId'), { includeDeleted: includeDeleted === true })
  )
  handle(IpcChannel.teamsCreate, (eventId: unknown, input: unknown) =>
    ctx.teams.create(asId(eventId, 'eventId'), asObject<TeamCreateInput>(input))
  )
  handle(IpcChannel.teamsUpdate, (id: unknown, patch: unknown) =>
    ctx.teams.update(asId(id), asObject<TeamUpdateInput>(patch))
  )
  handle(IpcChannel.teamsDeletionImpact, (id: unknown) => ctx.teams.getDeletionImpact(asId(id)))
  handle(IpcChannel.teamsDelete, (id: unknown, impact: unknown) =>
    ctx.teams.delete(asId(id), asImpact(impact))
  )
  handle(IpcChannel.teamsRestore, (id: unknown) => ctx.teams.restore(asId(id)))

  handle(IpcChannel.clockGetStatus, (): ClockStatus => ({
    masterNow: ctx.clock.now(),
    wallNow: ctx.clock.wallNow(),
    wallDriftMs: ctx.clock.wallDriftMs(),
    bootSessionId: ctx.clock.bootSessionId,
    session: ctx.session
  }))
  handle(IpcChannel.raceGetState, (eventId: unknown) => ctx.raceClock.getState(asId(eventId, 'eventId')))
  handle(IpcChannel.raceStart, (eventId: unknown) => ctx.raceClock.start(asId(eventId, 'eventId')))
  handle(IpcChannel.racePause, (eventId: unknown) => ctx.raceClock.pause(asId(eventId, 'eventId')))
  handle(IpcChannel.raceResume, (eventId: unknown) => ctx.raceClock.resume(asId(eventId, 'eventId')))
  handle(IpcChannel.raceEnd, (eventId: unknown) => ctx.raceClock.end(asId(eventId, 'eventId')))
  handle(IpcChannel.raceCorrectStart, (eventId: unknown, at: unknown) =>
    ctx.raceClock.correctActualStart(asId(eventId, 'eventId'), at as number)
  )

  handle(IpcChannel.lapsList, (eventId: unknown) => ctx.laps.list(asId(eventId, 'eventId')))
  handle(IpcChannel.lapsRegister, (eventId: unknown) => ctx.laps.register(asId(eventId, 'eventId')))
  handle(IpcChannel.lapsAddPast, (eventId: unknown, at: unknown) => ctx.laps.addPast(asId(eventId, 'eventId'), at as number))
  handle(IpcChannel.lapsUpdate, (recordId: unknown, at: unknown) => ctx.laps.updatePassedAt(asId(recordId, 'recordId'), at as number))
  handle(IpcChannel.lapsDelete, (recordId: unknown) => {
    ctx.laps.delete(asId(recordId, 'recordId'))
    return null
  })
  handle(IpcChannel.undoPeek, (eventId: unknown) => ctx.undo.peek(asId(eventId, 'eventId')))
  handle(IpcChannel.undoRun, (eventId: unknown, group: unknown) => {
    if (typeof group !== 'string' || group === '') {
      throw new AppError(ErrorCode.VALIDATION, '取り消し対象が指定されていません')
    }
    return ctx.undo.undo(asId(eventId, 'eventId'), group)
  })

  handle(IpcChannel.competitorsListByEvent, (eventId: unknown) => ctx.competitors.listByEvent(asId(eventId, 'eventId')))
  handle(IpcChannel.competitorsRegister, (teamId: unknown) => ctx.competitors.register(asId(teamId, 'teamId')))
  handle(IpcChannel.competitorsAddPast, (teamId: unknown, at: unknown) => ctx.competitors.addPast(asId(teamId, 'teamId'), at as number))
  handle(IpcChannel.competitorsUpdate, (recordId: unknown, at: unknown) =>
    ctx.competitors.updatePassedAt(asId(recordId, 'recordId'), at as number)
  )
  handle(IpcChannel.competitorsDelete, (recordId: unknown) => {
    ctx.competitors.delete(asId(recordId, 'recordId'))
    return null
  })
  handle(IpcChannel.standingsGet, (eventId: unknown) => ctx.standings.get(asId(eventId, 'eventId')))

  handle(IpcChannel.vehicleList, (eventId: unknown) => ctx.vehicleData.listByEvent(asId(eventId, 'eventId')))
  handle(IpcChannel.vehicleCreate, (lapRecordId: unknown, fields: unknown) =>
    ctx.vehicleData.create(asId(lapRecordId, 'lapRecordId'), asObject(fields, 'fields'))
  )
  handle(IpcChannel.vehicleUpdate, (id: unknown, fields: unknown) => ctx.vehicleData.update(asId(id), asObject(fields, 'fields')))
  handle(IpcChannel.vehicleDelete, (id: unknown) => {
    ctx.vehicleData.delete(asId(id))
    return null
  })

  handle(IpcChannel.operatorsList, (includeDeleted: unknown) => ctx.operators.list({ includeDeleted: includeDeleted === true }))
  handle(IpcChannel.operatorsCreate, (name: unknown) => ctx.operators.create(name))
  handle(IpcChannel.operatorsRename, (id: unknown, name: unknown) => ctx.operators.rename(asId(id), name))
  handle(IpcChannel.operatorsDelete, (id: unknown) => {
    ctx.operators.delete(asId(id))
    return null
  })
  handle(IpcChannel.operatorsSelect, (id: unknown) => ctx.operators.select(id === null ? null : asId(id)))
  handle(IpcChannel.operatorsCurrent, () => ctx.operators.current())

  handle(IpcChannel.memosList, (eventId: unknown) => ctx.memos.list(asId(eventId, 'eventId')))
  handle(IpcChannel.memosCreate, (eventId: unknown, body: unknown) => ctx.memos.create(asId(eventId, 'eventId'), body))
  handle(IpcChannel.memosUpdate, (id: unknown, body: unknown) => ctx.memos.updateBody(asId(id), body))
  handle(IpcChannel.memosDelete, (id: unknown) => {
    ctx.memos.delete(asId(id))
    return null
  })
}

function asImpact(v: unknown): TeamDeletionImpact {
  const o = asObject<Record<string, unknown>>(v, 'confirmedImpact')
  const n = (k: string): number => {
    const x = o[k]
    if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < 0) {
      throw new AppError(ErrorCode.VALIDATION, '確認件数が不正です', { confirmedImpact: '確認件数が不正です' })
    }
    return x
  }
  return { lapRecords: n('lapRecords'), competitorPasses: n('competitorPasses'), vehicleData: n('vehicleData') }
}
