import { app, ipcMain } from 'electron'
import { IpcChannel, type AppInfo, type TeamDeletionImpact } from '@shared/ipc-contract'
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
