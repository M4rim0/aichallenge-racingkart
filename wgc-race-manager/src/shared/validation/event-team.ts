import { isPlainObject, Validator, type FieldErrors } from './common'

/** 大会情報のうち、ユーザーが直接入力・編集できる項目（状態・実際の開始/終了時刻は時計操作でのみ変わる） */
export interface EventEditableFields {
  name: string
  heldOn: string | null
  courseName: string | null
  lapDistanceM: number | null
  scheduledStartAt: number | null
  scheduledEndAt: number | null
}

export type EventCreateInput = Pick<EventEditableFields, 'name'> & Partial<Omit<EventEditableFields, 'name'>>
export type EventUpdateInput = Partial<EventEditableFields>

export const EVENT_EDITABLE_KEYS = [
  'name',
  'heldOn',
  'courseName',
  'lapDistanceM',
  'scheduledStartAt',
  'scheduledEndAt'
] as const

export interface TeamEditableFields {
  name: string
  bibNumber: string | null
  color: string | null
  isOwnTeam: boolean
}

export type TeamCreateInput = Pick<TeamEditableFields, 'name'> & Partial<Omit<TeamEditableFields, 'name'>>
export type TeamUpdateInput = Partial<TeamEditableFields>

export const TEAM_EDITABLE_KEYS = ['name', 'bibNumber', 'color', 'isOwnTeam'] as const

function validateEventFields(v: Validator, input: Record<string, unknown>, requireName: boolean): void {
  v.onlyKeys(input, EVENT_EDITABLE_KEYS)
  if (requireName || 'name' in input) v.requiredText('name', input['name'])
  v.optionalDate('heldOn', input['heldOn'])
  v.optionalText('courseName', input['courseName'])
  v.optionalPositiveNumber('lapDistanceM', input['lapDistanceM'])
  v.optionalEpochMs('scheduledStartAt', input['scheduledStartAt'])
  v.optionalEpochMs('scheduledEndAt', input['scheduledEndAt'])
}

/** 予定開始・終了の前後関係（両方が入力されている場合のみ） */
export function validateScheduleOrder(start: number | null, end: number | null): FieldErrors {
  if (start !== null && end !== null && end <= start) {
    return { scheduledEndAt: '終了予定時刻は開始予定時刻より後にしてください' }
  }
  return {}
}

export function validateEventCreate(input: unknown): FieldErrors {
  if (!isPlainObject(input)) return { _: '入力が不正です' }
  const v = new Validator()
  validateEventFields(v, input, true)
  if (v.ok) {
    Object.assign(
      v.errors,
      validateScheduleOrder(
        (input['scheduledStartAt'] as number | null | undefined) ?? null,
        (input['scheduledEndAt'] as number | null | undefined) ?? null
      )
    )
  }
  return v.errors
}

export function validateEventUpdate(input: unknown): FieldErrors {
  if (!isPlainObject(input)) return { _: '入力が不正です' }
  const v = new Validator()
  validateEventFields(v, input, false)
  return v.errors
}

function validateTeamFields(v: Validator, input: Record<string, unknown>, requireName: boolean): void {
  v.onlyKeys(input, TEAM_EDITABLE_KEYS)
  if (requireName || 'name' in input) v.requiredText('name', input['name'])
  v.optionalText('bibNumber', input['bibNumber'])
  v.optionalText('color', input['color'])
  v.optionalBoolean('isOwnTeam', input['isOwnTeam'])
}

export function validateTeamCreate(input: unknown): FieldErrors {
  if (!isPlainObject(input)) return { _: '入力が不正です' }
  const v = new Validator()
  validateTeamFields(v, input, true)
  return v.errors
}

export function validateTeamUpdate(input: unknown): FieldErrors {
  if (!isPlainObject(input)) return { _: '入力が不正です' }
  const v = new Validator()
  validateTeamFields(v, input, false)
  return v.errors
}
