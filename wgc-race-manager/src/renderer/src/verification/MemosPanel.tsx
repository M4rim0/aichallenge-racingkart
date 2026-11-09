import { useCallback, useEffect, useState } from 'react'
import type { Memo } from '@shared/types/entities'
import type { Result } from '@shared/errors'
import { formatJst } from '@shared/time/jst'

/** 検証用：メモ（段階8）。正式 UI ではない。自由記述のみ（定型ボタンなし）。 */
export function MemosPanel({ eventId }: { eventId: number | null }): React.JSX.Element {
  const [memos, setMemos] = useState<Memo[]>([])
  const [body, setBody] = useState('')
  const [message, setMessage] = useState('')
  const [edits, setEdits] = useState<Record<number, string>>({})

  const reload = useCallback(async () => {
    if (eventId === null) return setMemos([])
    const r = await window.wgc.memos.list(eventId)
    if (r.ok) setMemos(r.value)
  }, [eventId])
  useEffect(() => {
    void reload()
    const h = setInterval(() => void reload(), 1500) // UNDO の反映（検証用の簡易更新）
    return () => clearInterval(h)
  }, [reload])

  const report = async <T,>(r: Result<T>, ok: string): Promise<void> => {
    setMessage(r.ok ? ok : `エラー: ${JSON.stringify(r.error)}`)
    await reload()
  }

  if (eventId === null) return <section><h2>メモ（段階8）</h2><p>大会を選択してください。</p></section>

  return (
    <section>
      <h2>メモ（段階8）</h2>
      <p id="memo-message">{message}</p>
      <textarea id="memo-body" rows={3} cols={60} value={body} onChange={(e) => setBody(e.target.value)} />{' '}
      <button id="memo-add" onClick={async () => { const r = await window.wgc.memos.create(eventId, body); await report(r, 'メモを記録しました'); if (r.ok) setBody('') }}>記録</button>
      <table id="memos">
        <thead><tr><th>日時（JST）</th><th>本文</th><th></th></tr></thead>
        <tbody>
          {memos.map((m) => (
            <tr key={m.id}>
              <td>{formatJst(m.notedAt)}</td>
              <td style={{ whiteSpace: 'pre-wrap' }}>{m.body}</td>
              <td>
                {/* Electron では window.prompt が使えないため入力欄で修正する */}
                <input className="memo-edit" value={edits[m.id] ?? ''} placeholder="修正後の本文" onChange={(e) => setEdits({ ...edits, [m.id]: e.target.value })} />{' '}
                <button onClick={async () => { await report(await window.wgc.memos.update(m.id, edits[m.id] ?? ''), '本文を修正しました'); setEdits({ ...edits, [m.id]: '' }) }}>本文修正</button>{' '}
                <button onClick={async () => void report(await window.wgc.memos.delete(m.id), 'メモを削除しました')}>削除</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
