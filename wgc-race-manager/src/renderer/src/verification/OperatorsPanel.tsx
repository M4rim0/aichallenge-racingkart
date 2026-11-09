import { useCallback, useEffect, useState } from 'react'
import type { Operator } from '@shared/types/entities'
import type { Result } from '@shared/errors'

/** 検証用：操作者の登録・切り替え（段階8）。正式 UI ではない。 */
export function OperatorsPanel(): React.JSX.Element {
  const [ops, setOps] = useState<Operator[]>([])
  const [current, setCurrent] = useState<Operator | null>(null)
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [renames, setRenames] = useState<Record<number, string>>({})

  const reload = useCallback(async () => {
    const [l, c] = await Promise.all([window.wgc.operators.list(), window.wgc.operators.current()])
    if (l.ok) setOps(l.value)
    if (c.ok) setCurrent(c.value)
  }, [])
  useEffect(() => {
    void reload()
  }, [reload])

  const report = async <T,>(r: Result<T>, ok: string): Promise<void> => {
    setMessage(r.ok ? ok : `エラー: ${JSON.stringify(r.error)}`)
    await reload()
  }

  return (
    <section>
      <h2>操作者（段階8）</h2>
      <p id="op-message">{message}</p>
      <p>
        現在の操作者：<strong id="op-current">{current ? current.name : '未設定'}</strong>{' '}
        <select
          id="op-select"
          value={current?.id ?? ''}
          onChange={async (e) => void report(await window.wgc.operators.select(e.target.value === '' ? null : Number(e.target.value)), '操作者を切り替えました')}
        >
          <option value="">未設定</option>
          {ops.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </p>
      <p>
        <input id="op-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="操作者名" />{' '}
        <button id="op-add" onClick={async () => { await report(await window.wgc.operators.create(name), '操作者を登録しました'); setName('') }}>登録</button>
      </p>
      <ul id="op-list">
        {ops.map((o) => (
          <li key={o.id}>
            {o.name}{' '}
            <input className="op-rename" value={renames[o.id] ?? ''} placeholder="新しい名前" onChange={(e) => setRenames({ ...renames, [o.id]: e.target.value })} />{' '}
            <button onClick={async () => { await report(await window.wgc.operators.rename(o.id, renames[o.id] ?? ''), '名前を修正しました'); setRenames({ ...renames, [o.id]: '' }) }}>名前修正</button>{' '}
            <button onClick={async () => void report(await window.wgc.operators.delete(o.id), '操作者を削除しました')}>削除</button>
          </li>
        ))}
      </ul>
    </section>
  )
}
