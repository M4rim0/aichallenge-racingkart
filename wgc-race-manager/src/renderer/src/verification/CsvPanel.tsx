import { useState } from 'react'

/** 検証用：CSV 出力（段階9）。正式 UI ではない。 */
export function CsvPanel({ eventId }: { eventId: number | null }): React.JSX.Element {
  const [message, setMessage] = useState('')
  if (eventId === null) return <section><h2>CSV 出力（段階9）</h2><p>大会を選択してください。</p></section>
  return (
    <section>
      <h2>CSV 出力（段階9）</h2>
      <button
        id="csv-export"
        onClick={async () => {
          const r = await window.wgc.csv.export(eventId)
          if (!r.ok) return setMessage(`エラー: ${JSON.stringify(r.error)}`)
          setMessage(r.value.cancelled ? 'キャンセルしました' : `出力しました: ${r.value.directory}（${r.value.files.length} ファイル）`)
        }}
      >
        CSV を出力
      </button>
      <p id="csv-message">{message}</p>
    </section>
  )
}
