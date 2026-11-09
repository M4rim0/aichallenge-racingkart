import { useCallback, useEffect, useState } from 'react'
import type { VehicleDataFields, VehicleDataRow } from '@shared/types/entities'
import type { Result } from '@shared/errors'
import { formatJst } from '@shared/time/jst'

/** 検証用：車両データ入力（段階7）。正式 UI ではない。入力値はそのまま送る（変換しない）。 */
const FIELDS: [keyof VehicleDataFields, string][] = [
  ['speed', '速度 km/h'],
  ['voltage', '電圧 V'],
  ['current', '電流 A'],
  ['integratedValue', '積算値（単位未確定）']
]

export function VehiclePanel({ eventId }: { eventId: number | null }): React.JSX.Element {
  const [rows, setRows] = useState<VehicleDataRow[]>([])
  const [drafts, setDrafts] = useState<Record<number, Partial<VehicleDataFields>>>({})
  const [message, setMessage] = useState('')

  const reload = useCallback(async () => {
    if (eventId === null) return setRows([])
    const r = await window.wgc.vehicleData.list(eventId)
    if (r.ok) setRows(r.value)
  }, [eventId])

  useEffect(() => {
    void reload()
    const h = setInterval(() => void reload(), 1500) // ラップ登録・UNDO の反映（検証用の簡易更新）
    return () => clearInterval(h)
  }, [reload])

  const report = async <T,>(r: Result<T>, ok: string): Promise<void> => {
    setMessage(r.ok ? ok : `エラー: ${JSON.stringify(r.error)}`)
    await reload()
  }

  if (eventId === null) return <section><h2>車両データ（段階7）</h2><p>大会を選択してください。</p></section>

  async function save(row: VehicleDataRow): Promise<void> {
    const raw = drafts[row.lapRecordId] ?? {}
    const draft = row.vehicleData === null ? raw : Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== ''))
    if (row.vehicleData === null) {
      await report(await window.wgc.vehicleData.create(row.lapRecordId, draft), `${row.lapNumber}周目に登録しました`)
    } else {
      await report(await window.wgc.vehicleData.update(row.vehicleData.id, draft), `${row.lapNumber}周目を修正しました`)
    }
    setDrafts((d) => ({ ...d, [row.lapRecordId]: {} }))
  }

  return (
    <section>
      <h2>車両データ（段階7）</h2>
      <p id="vehicle-message">{message}</p>
      <table id="vehicle">
        <thead>
          <tr>
            <th>周回</th><th>通過日時</th>
            {FIELDS.map(([, label]) => <th key={label}>{label}</th>)}
            <th>入力（変更する項目のみ）</th><th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.lapRecordId} data-lap={row.lapNumber}>
              <td>{row.lapNumber}</td>
              <td>{formatJst(row.passedAt)}</td>
              {FIELDS.map(([k]) => (
                <td key={k}>{row.vehicleData === null ? '—' : (row.vehicleData[k] ?? '（未入力）')}</td>
              ))}
              <td>
                {FIELDS.map(([k, label]) => (
                  <input
                    key={k}
                    name={k}
                    size={8}
                    placeholder={label}
                    value={drafts[row.lapRecordId]?.[k] ?? ''}
                    onChange={(e) => setDrafts((d) => ({ ...d, [row.lapRecordId]: { ...d[row.lapRecordId], [k]: e.target.value } }))}
                  />
                ))}{' '}
                <button className="save" onClick={() => void save(row)}>{row.vehicleData === null ? '登録' : '修正'}</button>
              </td>
              <td>
                {row.vehicleData !== null && (
                  <button className="del" onClick={async () => void report(await window.wgc.vehicleData.delete(row.vehicleData!.id), '車両データを削除しました')}>削除</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>※ 修正時は入力した項目のみ変更します。項目を未入力に戻す操作は正式 UI で決定します（検証用画面では空欄の入力は「変更なし」と区別できないため）。</p>
    </section>
  )
}
