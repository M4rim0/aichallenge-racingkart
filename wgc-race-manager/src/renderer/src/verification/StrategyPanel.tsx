import { useCallback, useEffect, useState } from 'react'
import type { MandatoryStoppage } from '@shared/types/entities'
import type { StrategyReport, TeamStrategy } from '@shared/strategy/engine'
import type { ScenarioId } from '@shared/strategy/pace'
import type { Result } from '@shared/errors'
import { formatDuration, formatJst, parseJst } from '@shared/time/jst'

/**
 * 検証用：強制停止時間・戦略計算（段階10）。正式 UI ではない。
 * 計算結果の数値を確認するための素の表であり、表示方法・項目の取捨選択は UI 設計時に決める（D-054）。
 */
const SC: ScenarioId[] = ['avg3', 'avg5', 'avg10']
const dur = (ms: number | null | undefined): string => (ms === null || ms === undefined ? '—' : formatDuration(Math.round(ms)))
const num = (x: number | null | undefined, d = 3): string => (x === null || x === undefined ? '—' : x.toFixed(d))

export function StrategyPanel({ eventId }: { eventId: number | null }): React.JSX.Element {
  const [report, setReport] = useState<StrategyReport | null>(null)
  const [stoppages, setStoppages] = useState<MandatoryStoppage[]>([])
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [edits, setEdits] = useState<Record<number, string>>({})
  const [message, setMessage] = useState('')

  const reload = useCallback(async () => {
    if (eventId === null) return
    const [r, s] = await Promise.all([window.wgc.strategy.get(eventId), window.wgc.stoppages.list(eventId)])
    if (r.ok) setReport(r.value)
    if (s.ok) setStoppages(s.value)
  }, [eventId])
  useEffect(() => {
    void reload()
    const h = setInterval(() => void reload(), 1000)
    return () => clearInterval(h)
  }, [reload])

  const report_ = async <T,>(r: Result<T>, ok: string): Promise<void> => {
    setMessage(r.ok ? ok : `エラー: ${JSON.stringify(r.error)}`)
    await reload()
  }

  if (eventId === null) return <section><h2>強制停止・戦略計算（段階10）</h2><p>大会を選択してください。</p></section>
  const name = (id: number): string => report?.teams.find((t) => t.teamId === id)?.name ?? String(id)

  return (
    <section>
      <h2>強制停止・戦略計算（段階10）</h2>
      <p id="strategy-message">{message}</p>

      <h3>強制停止時間</h3>
      <p>
        開始（JST） <input id="stop-start" value={start} onChange={(e) => setStart(e.target.value)} placeholder="2026-10-01 12:00:00.000" />{' '}
        終了（JST、空欄 = 未定） <input id="stop-end" value={end} onChange={(e) => setEnd(e.target.value)} />{' '}
        <button
          id="stop-add"
          onClick={async () => {
            const s = parseJst(start)
            const e = end.trim() === '' ? null : parseJst(end)
            if (s === null || (end.trim() !== '' && e === null)) return setMessage('日時の形式が不正です')
            await report_(await window.wgc.stoppages.create(eventId, s, e), '強制停止時間を登録しました')
          }}
        >
          登録
        </button>
      </p>
      <table id="stoppages">
        <thead><tr><th>開始</th><th>終了</th><th>終了日時の入力・修正</th><th></th></tr></thead>
        <tbody>
          {stoppages.map((s) => (
            <tr key={s.id}>
              <td>{formatJst(s.startsAt)}</td>
              <td>{s.endsAt === null ? '未定' : formatJst(s.endsAt)}</td>
              <td>
                <input className="stop-end-edit" value={edits[s.id] ?? ''} onChange={(e) => setEdits({ ...edits, [s.id]: e.target.value })} placeholder="空欄 = 未定" />{' '}
                <button onClick={async () => {
                  const v = edits[s.id] ?? ''
                  const e = v.trim() === '' ? null : parseJst(v)
                  if (v.trim() !== '' && e === null) return setMessage('日時の形式が不正です')
                  await report_(await window.wgc.stoppages.update(s.id, s.startsAt, e), '修正しました')
                }}>修正</button>
              </td>
              <td><button onClick={async () => void report_(await window.wgc.stoppages.delete(s.id), '削除しました')}>削除</button></td>
            </tr>
          ))}
        </tbody>
      </table>

      {report && (
        <>
          <h3>計算の前提（{report.rankingRule.provisional ? '暫定順位' : '順位'}：{report.rankingRule.label}）</h3>
          <table id="strategy-clock">
            <tbody>
              <tr><th>計算時刻</th><td>{formatJst(report.clock.evaluatedAt)}</td></tr>
              <tr><th>残り時間 R_clock</th><td id="r-clock">{dur(report.clock.remainingClockMs)}</td></tr>
              <tr><th>今後の強制停止 S_remaining</th><td id="s-remaining">{dur(report.clock.remainingStoppageMs)}</td></tr>
              <tr><th>残り走行可能時間 R_drive</th><td id="r-drive">{dur(report.clock.remainingDriveMs)}</td></tr>
              <tr><th>これまでの強制停止</th><td>{dur(report.clock.elapsedStoppageMs)}</td></tr>
              <tr><th>不確実性</th><td id="strategy-uncertainties">{report.uncertainties.join(', ') || 'なし'}</td></tr>
            </tbody>
          </table>

          <h3>ペース・位置（推定）</h3>
          <table id="strategy-pace">
            <thead>
              <tr><th>暫定順位</th><th>チーム</th><th>周回</th><th>3周平均</th><th>5周平均</th><th>10周平均</th><th>除外</th><th>変化(3−10)</th><th>推定位置Q(5周)</th><th>前との差</th><th>後との差</th></tr>
            </thead>
            <tbody>
              {report.teams.map((t) => (
                <tr key={t.teamId}>
                  <td>{t.current.rank}</td>
                  <td>{t.name}{t.isOwnTeam ? '（自）' : ''}{t.teamDeleted ? '（削除済み）' : ''}</td>
                  <td>{t.current.laps}</td>
                  {SC.map((s) => (
                    <td key={s}>{t.pace.averages[s].avgMs === null ? `データ不足(${t.pace.averages[s].used}/${t.pace.averages[s].required})` : `${dur(t.pace.averages[s].avgMs)} (${t.pace.averages[s].used})`}</td>
                  ))}
                  <td>{t.pace.excluded.map((e) => `${e.lapNumber}周:${e.reason}`).join(' ') || '—'}</td>
                  <td>{t.pace.change ? `${(t.pace.change.diffMs / 1000).toFixed(1)}秒 / ${t.pace.change.percent.toFixed(1)}% ${t.pace.change.direction}` : '—'}</td>
                  <td>{num(t.scenarios.avg5.position?.q)}{t.scenarios.avg5.position?.overdue ? '（遅れ）' : ''}</td>
                  <td>{gap(t.ahead)}</td>
                  <td>{gap(t.behind)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>予測（3シナリオ・推定値）</h3>
          <table id="strategy-prediction">
            <thead>
              <tr><th>チーム</th>{SC.map((s) => <th key={s}>{s}：最終周回 / 順位（変動）</th>)}<th>抜ける可能性</th><th>抜かれる可能性</th></tr>
            </thead>
            <tbody>
              {report.teams.map((t) => (
                <tr key={t.teamId} data-team={t.name}>
                  <td>{t.name}</td>
                  {SC.map((s) => {
                    const r = t.scenarios[s]
                    return <td key={s}>{r.predictedFinalLaps ?? '—'} / {r.predicted ? `${r.predictedRank}位（${r.rankChange >= 0 ? '+' : ''}${r.rankChange}）` : '予測不可'}</td>
                  })}
                  <td className="may-overtake">{t.mayOvertake.map((o) => `${name(o.teamId)}[${o.scenarios.join(',')}]`).join(' ') || '—'}</td>
                  <td className="may-be-overtaken">{t.mayBeOvertakenBy.map((o) => `${name(o.teamId)}[${o.scenarios.join(',')}]`).join(' ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>攻撃・防衛（5周平均シナリオ・推定値）</h3>
          <table id="strategy-attack">
            <thead><tr><th>チーム</th><th>攻撃対象</th><th>位置差G</th><th>追いつくペース</th><th>余裕</th><th>防衛対象</th><th>リードG</th><th>並ばれる境界ペース</th><th>余裕</th><th>不確実性</th></tr></thead>
            <tbody>
              {report.teams.map((t) => <AttackRow key={t.teamId} t={t} name={name} />)}
            </tbody>
          </table>
        </>
      )}
    </section>
  )
}

function gap(n: TeamStrategy['ahead']): string {
  if (!n) return '—'
  const parts = [`${n.lapGap}周`]
  if (n.measuredTimeGapMs !== null) parts.push(`実測 ${dur(n.measuredTimeGapMs)}`)
  else if (n.estimatedTimeGapMs !== null) parts.push(`推定 ${dur(n.estimatedTimeGapMs)}`)
  return parts.join(' / ')
}

function AttackRow({ t, name }: { t: TeamStrategy; name: (id: number) => string }): React.JSX.Element {
  const s = t.scenarios.avg5
  const a = s.attack
  const d = s.defense
  return (
    <tr data-team={t.name}>
      <td>{t.name}</td>
      <td>{a ? name(a.targetTeamId) : '—'}</td>
      <td>{num(a?.gapLaps)}</td>
      <td>{a ? (a.status === 'OK' ? dur(a.catchUpPaceMs) : a.status) : '—'}</td>
      <td>{a?.paceMarginMs != null ? dur(a.paceMarginMs) : '—'}</td>
      <td>{d ? name(d.threatTeamId) : '—'}</td>
      <td>{num(d?.leadLaps)}</td>
      <td>{d ? (d.status === 'OK' ? dur(d.limitPaceMs) : d.status) : '—'}</td>
      <td>{d?.paceMarginMs != null ? dur(d.paceMarginMs) : '—'}</td>
      <td>{s.uncertainties.join(', ') || '—'}</td>
    </tr>
  )
}
