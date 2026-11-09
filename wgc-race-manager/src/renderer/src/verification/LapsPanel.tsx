import { useCallback, useEffect, useState } from 'react'
import type { LapView } from '@shared/types/entities'
import type { Result } from '@shared/errors'
import { formatDuration, formatJst, parseJst } from '@shared/time/jst'

/** 検証用：自チームラップ記録・UNDO（段階5）。正式 UI ではない。 */
export function LapsPanel({ eventId }: { eventId: number | null }): React.JSX.Element {
  const [laps, setLaps] = useState<LapView[]>([])
  const [message, setMessage] = useState('')
  const [pastInput, setPastInput] = useState('')
  const [edit, setEdit] = useState<Record<number, string>>({})

  const reload = useCallback(async () => {
    if (eventId === null) return setLaps([])
    const r = await window.wgc.laps.list(eventId)
    if (r.ok) setLaps(r.value)
  }, [eventId])

  useEffect(() => {
    void reload()
  }, [reload])

  const report = async <T,>(r: Result<T>, ok: string): Promise<void> => {
    setMessage(r.ok ? ok : `エラー: ${JSON.stringify(r.error)}`)
    await reload()
  }

  if (eventId === null) return <section><h2>自チームラップ（段階5）</h2><p>大会を選択してください。</p></section>

  async function addPast(): Promise<void> {
    const ms = parseJst(pastInput)
    if (ms === null) return setMessage('日時の形式が不正です（YYYY-MM-DD HH:mm:ss.SSS、日本時間）')
    await report(await window.wgc.laps.addPast(eventId!, ms), '過去記録を追加しました')
  }

  async function update(recordId: number): Promise<void> {
    const ms = parseJst(edit[recordId] ?? '')
    if (ms === null) return setMessage('日時の形式が不正です')
    await report(await window.wgc.laps.update(recordId, ms), '通過日時を修正しました')
  }

  async function undo(): Promise<void> {
    const p = await window.wgc.undo.peek(eventId!)
    if (!p.ok) return setMessage(`エラー: ${JSON.stringify(p.error)}`)
    if (!p.value) return setMessage('取り消せる操作がありません')
    if (!window.confirm(`次の操作を取り消しますか？\n${p.value.description}\n（${formatJst(p.value.operatedAt)} ${p.value.operatorName ?? '操作者未設定'}）`)) return
    await report(await window.wgc.undo.run(eventId!, p.value.operationGroup), `取り消しました: ${p.value.description}`)
  }

  return (
    <section>
      <h2>自チームラップ（段階5）</h2>
      <p id="laps-message">{message}</p>
      <button id="lap-register" onClick={async () => void report(await window.wgc.laps.register(eventId), 'ラップを登録しました')}>
        LAP REGISTER
      </button>{' '}
      <button id="undo" onClick={() => void undo()}>直前操作の取り消し（UNDO）</button>
      <p>
        <label>過去記録の追加（JST） <input id="past-input" value={pastInput} onChange={(e) => setPastInput(e.target.value)} placeholder="2026-10-01 09:10:00.000" /></label>{' '}
        <button id="past-add" onClick={() => void addPast()}>追加</button>
      </p>
      <table id="laps">
        <thead>
          <tr><th>周回</th><th>通過日時（JST）</th><th>ラップタイム</th><th>PC実日時</th><th>修正</th><th>削除</th></tr>
        </thead>
        <tbody>
          {laps.map((l) => (
            <tr key={l.recordId}>
              <td>{l.lapNumber}</td>
              <td>{formatJst(l.passedAt)}</td>
              <td>{l.lapTimeMs === null ? '' : formatDuration(l.lapTimeMs)}</td>
              <td>{l.passedWallAt === null ? '（手入力）' : formatJst(l.passedWallAt)}</td>
              <td>
                <input value={edit[l.recordId] ?? ''} onChange={(e) => setEdit({ ...edit, [l.recordId]: e.target.value })} placeholder={formatJst(l.passedAt)} />{' '}
                <button onClick={() => void update(l.recordId)}>修正</button>
              </td>
              <td>
                <button onClick={async () => void report(await window.wgc.laps.delete(l.recordId), '削除しました')}>削除</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
