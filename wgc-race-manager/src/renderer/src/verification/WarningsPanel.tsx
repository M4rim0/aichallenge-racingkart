import { useCallback, useEffect, useState } from 'react'
import type { WarningList } from '@shared/warnings/types'
import { SEVERITY_LABEL, WARNING_TYPE_LABEL } from '@shared/warnings/detect'
import { formatJst } from '@shared/time/jst'

/**
 * 検証用：警告一覧（段階11）。正式 UI ではない。
 * 画面上の一覧のみ（音・ポップアップなし、D-061）。表示の強調方法・更新間隔は UI 設計時に決める（W-10）。
 */
export function WarningsPanel({ eventId }: { eventId: number | null }): React.JSX.Element {
  const [list, setList] = useState<WarningList | null>(null)
  const [message, setMessage] = useState('')

  const reload = useCallback(async () => {
    if (eventId === null) return setList(null)
    const r = await window.wgc.warnings.evaluate(eventId)
    if (r.ok) setList(r.value)
  }, [eventId])
  useEffect(() => {
    void reload()
    const h = setInterval(() => void reload(), 1000)
    return () => clearInterval(h)
  }, [reload])

  if (eventId === null) return <section><h2>警告（段階11）</h2><p>大会を選択してください。</p></section>

  return (
    <section>
      <h2>警告（段階11）</h2>
      <p id="warnings-message">{message}</p>
      <p>表示中 {list?.visible.length ?? 0} 件 / 確認済みで非表示 <span id="warnings-acked">{list?.acknowledgedCount ?? 0}</span> 件</p>
      <table id="warnings">
        <thead>
          <tr><th>重要度</th><th>状態</th><th>種別</th><th>内容</th><th>発生</th><th>調整</th><th></th></tr>
        </thead>
        <tbody>
          {list?.visible.map((w) => (
            <tr key={w.occurrenceId} data-key={w.key}>
              <td>{SEVERITY_LABEL[w.severity]}</td>
              <td>{w.phase === 'NEW' ? (w.escalatedAt !== null ? '重要度上昇' : '新規') : '継続中'}</td>
              <td>{WARNING_TYPE_LABEL[w.type]}{w.kind ? `（${w.kind}）` : ''}</td>
              <td>{w.message}</td>
              <td>{formatJst(w.raisedAt)}</td>
              <td>{w.adjustments.join(' / ')}</td>
              <td>
                <button
                  className="ack"
                  onClick={async () => {
                    const r = await window.wgc.warnings.acknowledge(eventId, w.occurrenceId)
                    setMessage(r.ok ? '確認済みにしました' : `エラー: ${JSON.stringify(r.error)}`)
                    await reload()
                  }}
                >
                  確認済み
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {list && list.suppressed.length > 0 && (
        <details>
          <summary>不確実性により抑制した判定（{list.suppressed.length}）</summary>
          <ul>{list.suppressed.map((s, i) => <li key={i}>{WARNING_TYPE_LABEL[s.type]} / チーム {s.teamId} / {s.reason}：{s.detail}</li>)}</ul>
        </details>
      )}
    </section>
  )
}
