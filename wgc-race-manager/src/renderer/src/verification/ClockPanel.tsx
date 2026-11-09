import { useEffect, useState } from 'react'
import type { ClockStatus, LifecycleStatus } from '@shared/ipc-contract'
import type { RaceClockSnapshot } from '@shared/time/race-clock'
import { formatDuration, formatJst, parseJst } from '@shared/time/jst'

/**
 * 検証用：マスタークロック・レース時計（段階4）。正式 UI ではない。
 * 表示値は Main から定期取得したもの（表示更新方式は正式 UI で決定する）。
 */
export function ClockPanel({ eventId }: { eventId: number | null }): React.JSX.Element {
  const [status, setStatus] = useState<ClockStatus | null>(null)
  const [race, setRace] = useState<RaceClockSnapshot | null>(null)
  const [life, setLife] = useState<LifecycleStatus | null>(null)
  const [message, setMessage] = useState('')
  const [correction, setCorrection] = useState('')

  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      const s = await window.wgc.clock.getStatus()
      if (alive && s.ok) setStatus(s.value)
      const l = await window.wgc.lifecycle.getStatus()
      if (alive && l.ok) setLife(l.value)
      if (eventId !== null) {
        const r = await window.wgc.race.getState(eventId)
        if (alive && r.ok) setRace(r.value)
      } else if (alive) setRace(null)
    }
    void tick()
    const h = setInterval(() => void tick(), 200)
    return () => {
      alive = false
      clearInterval(h)
    }
  }, [eventId])

  async function op(kind: 'start' | 'pause' | 'resume' | 'end'): Promise<void> {
    if (eventId === null) return
    const r = await window.wgc.race[kind](eventId)
    setMessage(r.ok ? `${kind.toUpperCase()} を実行しました` : `エラー: ${JSON.stringify(r.error)}`)
  }

  async function correct(): Promise<void> {
    if (eventId === null) return
    const ms = parseJst(correction)
    if (ms === null) return setMessage('日時の形式が不正です（YYYY-MM-DD HH:mm:ss.SSS、日本時間）')
    const r = await window.wgc.race.correctStart(eventId, ms)
    setMessage(r.ok ? '実際の開始時刻を修正しました' : `エラー: ${JSON.stringify(r.error)}`)
  }

  return (
    <section>
      <h2>時計（段階4）</h2>
      {status?.session?.clockAnomaly && (
        <p id="clock-anomaly">
          <strong>警告：PCの時刻異常を検出しました。</strong> {status.session.anomalyDetail}
        </p>
      )}
      <table id="clock">
        <tbody>
          <tr><th>マスタークロック（JST）</th><td id="master-now">{status ? formatJst(status.masterNow) : ''}</td></tr>
          <tr><th>PC実日時（JST）</th><td>{status ? formatJst(status.wallNow) : ''}</td></tr>
          <tr><th>PC実日時 − マスタークロック</th><td>{status ? `${status.wallDriftMs} ms` : ''}</td></tr>
          <tr><th>起動セッション</th><td>{status?.bootSessionId}</td></tr>
          <tr><th>電源の抑制（段階12）</th><td id="power-state">{life ? (life.power.active ? `抑制中（大会 ${life.power.eventIds.join(', ')}）` : '解除') : ''}</td></tr>
          <tr><th>前回の終了</th><td id="previous-shutdown">{life ? (life.previousShutdown === null ? '判定対象なし' : life.previousShutdown.clean ? '正常終了' : `異常終了（前回起動 ${formatJst(life.previousShutdown.startedWallAt)}）`) : ''}</td></tr>
          <tr>
            <th>復旧確認待ち</th>
            <td id="recovery-pending">
              {life ? (life.pendingRecoveries.length === 0 ? 'なし' : life.pendingRecoveries.map((h) => `${h.eventName}（大会 ${h.eventId}、${h.eventStatus}）`).join(' / ')) : ''}
              {eventId !== null && life?.pendingRecoveries.some((h) => h.eventId === eventId) && (
                <>
                  {' '}
                  <button
                    id="recovery-confirm"
                    onClick={async () => {
                      const h = life.pendingRecoveries.find((x) => x.eventId === eventId)!
                      const r = await window.wgc.recovery.confirm(eventId, h.holdId)
                      setMessage(r.ok ? '復旧を確認しました（時計は実際の経過時間で進み続けています）' : `エラー: ${JSON.stringify(r.error)}`)
                    }}
                  >
                    選択中の大会の復旧を確認
                  </button>
                </>
              )}
            </td>
          </tr>
          <tr><th>復帰時の時刻ずれ</th><td id="resume-anomalies">{life ? (life.resumeAnomalies.length === 0 ? 'なし' : life.resumeAnomalies.map((a) => `${formatJst(a.wallAt)}：${a.detail ?? ''}`).join(' / ')) : ''}</td></tr>
        </tbody>
      </table>
      {eventId === null ? (
        <p>大会を選択してください。</p>
      ) : (
        <>
          <p id="race-message">{message}</p>
          <button onClick={() => void op('start')}>START</button>{' '}
          <button onClick={() => void op('pause')}>PAUSE</button>{' '}
          <button onClick={() => void op('resume')}>RESUME</button>{' '}
          <button onClick={() => void op('end')}>END</button>
          <table id="race">
            <tbody>
              <tr><th>状態</th><td id="race-status">{race?.status}</td></tr>
              <tr><th>実際の開始時刻</th><td>{race?.actualStartAt != null ? formatJst(race.actualStartAt) : ''}</td></tr>
              <tr><th>実際の終了時刻</th><td>{race?.actualEndAt != null ? formatJst(race.actualEndAt) : ''}</td></tr>
              <tr><th>レース経過時間</th><td id="race-elapsed">{race?.elapsedMs != null ? formatDuration(race.elapsedMs) : ''}</td></tr>
              <tr><th>残り時間</th><td id="race-remaining">{race?.remainingClockMs != null ? formatDuration(race.remainingClockMs) : ''}</td></tr>
              <tr><th>時系列の異常</th><td>{race?.anomalies.map((a) => a.message).join(' / ')}</td></tr>
            </tbody>
          </table>
          <p>
            <label>
              実際の開始時刻の修正（JST）{' '}
              <input id="correct-input" value={correction} onChange={(e) => setCorrection(e.target.value)} placeholder="2026-10-01 09:00:00.000" />
            </label>{' '}
            <button id="correct-btn" onClick={() => void correct()}>修正</button>
          </p>
        </>
      )}
    </section>
  )
}
