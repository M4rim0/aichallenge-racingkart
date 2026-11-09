import { useCallback, useEffect, useState } from 'react'
import type { LapView, Team } from '@shared/types/entities'
import type { Standings } from '@shared/ipc-contract'
import type { Result } from '@shared/errors'
import { formatDuration, formatJst, parseJst } from '@shared/time/jst'

/** 検証用：他チーム通過記録・暫定順位（段階6）。正式 UI ではない。 */
export function CompetitorsPanel({ eventId }: { eventId: number | null }): React.JSX.Element {
  const [teams, setTeams] = useState<Team[]>([])
  const [passes, setPasses] = useState<Record<number, LapView[]>>({})
  const [standings, setStandings] = useState<Standings | null>(null)
  const [message, setMessage] = useState('')
  const [pastTeam, setPastTeam] = useState<number | ''>('')
  const [pastInput, setPastInput] = useState('')

  const reload = useCallback(async () => {
    if (eventId === null) return
    const [t, p, s] = await Promise.all([
      window.wgc.teams.list(eventId, true),
      window.wgc.competitors.listByEvent(eventId),
      window.wgc.standings.get(eventId)
    ])
    if (t.ok) setTeams(t.value.filter((x) => !x.isOwnTeam))
    if (p.ok) setPasses(p.value)
    if (s.ok) setStandings(s.value)
  }, [eventId])

  useEffect(() => {
    void reload()
    const h = setInterval(() => void reload(), 1000) // 自チームラップ・UNDO を順位に反映（検証用の簡易更新）
    return () => clearInterval(h)
  }, [reload])

  const report = async <T,>(r: Result<T>, ok: string): Promise<void> => {
    setMessage(r.ok ? ok : `エラー: ${JSON.stringify(r.error)}`)
    await reload()
  }

  if (eventId === null) return <section><h2>他チーム通過・暫定順位（段階6）</h2><p>大会を選択してください。</p></section>

  return (
    <section>
      <h2>他チーム通過・暫定順位（段階6）</h2>
      <p id="comp-message">{message}</p>
      <p>
        通過登録：{' '}
        {teams
          .filter((t) => t.deletedAt === null)
          .map((t) => (
            <button key={t.id} data-team={t.id} onClick={async () => void report(await window.wgc.competitors.register(t.id), `${t.name} の通過を登録しました`)}>
              {t.bibNumber ? `[${t.bibNumber}] ` : ''}{t.name}
            </button>
          ))}
      </p>
      <p>
        過去記録の追加：{' '}
        <select id="past-team" value={pastTeam} onChange={(e) => setPastTeam(e.target.value === '' ? '' : Number(e.target.value))}>
          <option value="">チーム</option>
          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}{t.deletedAt !== null ? '（削除済み）' : ''}</option>)}
        </select>{' '}
        <input id="comp-past-input" value={pastInput} onChange={(e) => setPastInput(e.target.value)} placeholder="2026-10-01 09:10:00.000" />{' '}
        <button
          id="comp-past-add"
          onClick={async () => {
            const ms = parseJst(pastInput)
            if (pastTeam === '' || ms === null) return setMessage('チームと日時（JST）を指定してください')
            await report(await window.wgc.competitors.addPast(pastTeam, ms), '過去記録を追加しました')
          }}
        >
          追加
        </button>
      </p>

      <h3 id="standings-title">{standings?.provisional ? '暫定順位' : '順位'}（{standings?.ruleLabel}）</h3>
      <table id="standings">
        <thead>
          <tr><th>暫定順位</th><th>チーム</th><th>周回数</th><th>最終通過</th><th>トップとの周回差</th><th>前との周回差</th><th>前との時間差（同周回のみ）</th></tr>
        </thead>
        <tbody>
          {standings?.rows.map((r) => (
            <tr key={r.teamId}>
              <td>{r.rank}{r.tied ? '（同順位）' : ''}</td>
              <td>{r.bibNumber ? `[${r.bibNumber}] ` : ''}{r.teamName}{r.isOwnTeam ? '（自チーム）' : ''}{r.teamDeleted ? '（削除済み）' : ''}</td>
              <td>{r.laps}</td>
              <td>{r.lastPassAt === null ? '' : formatJst(r.lastPassAt)}</td>
              <td>{r.lapsBehindLeader}</td>
              <td>{r.lapsBehindAhead ?? ''}</td>
              <td>{r.timeBehindAheadMs === null ? '' : formatDuration(r.timeBehindAheadMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>チーム別通過記録</h3>
      {teams.map((t) => (
        <details key={t.id}>
          <summary>{t.name}{t.deletedAt !== null ? '（削除済み）' : ''}：{passes[t.id]?.length ?? 0} 周</summary>
          <table>
            <thead><tr><th>周回</th><th>通過日時</th><th>ラップタイム</th><th></th></tr></thead>
            <tbody>
              {(passes[t.id] ?? []).map((p) => (
                <tr key={p.recordId}>
                  <td>{p.lapNumber}</td>
                  <td>{formatJst(p.passedAt)}</td>
                  <td>{p.lapTimeMs === null ? '（基準なし）' : formatDuration(p.lapTimeMs)}</td>
                  <td><button onClick={async () => void report(await window.wgc.competitors.delete(p.recordId), '削除しました')}>削除</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ))}
    </section>
  )
}
