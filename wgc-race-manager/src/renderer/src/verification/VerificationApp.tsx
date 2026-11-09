import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/ipc-contract'

/**
 * 検証用画面（決定 D-004）。
 * 機能・データ・時計の動作確認のための最低限の画面であり、正式 UI の仕様ではない。
 * レイアウト・配色・操作性は意図的に何も決めていない（ブラウザ既定の表示のまま）。
 */
export function VerificationApp(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.wgc.app
      .getInfo()
      .then(setInfo)
      .catch((e: unknown) => setError(String(e)))
  }, [])

  return (
    <main>
      <h1>検証用画面（正式UIではありません）</h1>
      <h2>起動・DB確認</h2>
      {error && <p>エラー: {error}</p>}
      {info ? (
        <table>
          <tbody>
            {Object.entries(info).map(([k, v]) => (
              <tr key={k}>
                <th>{k}</th>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        !error && <p>読み込み中…</p>
      )}
    </main>
  )
}
