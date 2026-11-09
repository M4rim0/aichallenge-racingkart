import { useCallback, useEffect, useState } from 'react'
import type { Result } from '@shared/errors'
import type { RaceEvent, Team } from '@shared/types/entities'

/** 検証用：大会・チーム管理の動作確認（段階3）。正式 UI ではない。 */

/** datetime-local の値（PC のローカル時刻）→ epoch ms。検証用の簡易変換。 */
function toMs(v: string): number | null {
  return v === '' ? null : new Date(v).getTime()
}
function fmt(ms: number | null): string {
  return ms === null ? '' : new Date(ms).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
}

export function EventsTeamsPanel({
  selected,
  setSelected
}: {
  selected: number | null
  setSelected: (id: number | null) => void
}): React.JSX.Element {
  const [events, setEvents] = useState<RaceEvent[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [message, setMessage] = useState<string>('')

  const show = <T,>(r: Result<T>, ok: string): r is { ok: true; value: T } => {
    setMessage(r.ok ? ok : `エラー: ${JSON.stringify(r.error)}`)
    return r.ok
  }

  const reloadEvents = useCallback(async () => {
    const r = await window.wgc.events.list()
    if (r.ok) setEvents(r.value)
  }, [])
  const reloadTeams = useCallback(async (eventId: number | null) => {
    if (eventId === null) return setTeams([])
    const r = await window.wgc.teams.list(eventId, true)
    if (r.ok) setTeams(r.value)
  }, [])

  useEffect(() => {
    void reloadEvents()
    // 状態（status）の表示を時計操作に追従させる（検証用の簡易更新）
    const h = setInterval(() => void reloadEvents(), 1000)
    return () => clearInterval(h)
  }, [reloadEvents])
  useEffect(() => {
    void reloadTeams(selected)
  }, [selected, reloadTeams])

  async function createEvent(form: HTMLFormElement): Promise<void> {
    const f = new FormData(form)
    const lap = String(f.get('lapDistanceM') ?? '')
    const r = await window.wgc.events.create({
      name: String(f.get('name') ?? ''),
      heldOn: String(f.get('heldOn') ?? '') || null,
      courseName: String(f.get('courseName') ?? '') || null,
      lapDistanceM: lap === '' ? null : Number(lap),
      scheduledStartAt: toMs(String(f.get('start') ?? '')),
      scheduledEndAt: toMs(String(f.get('end') ?? ''))
    })
    if (show(r, `大会を作成しました (id=${r.ok ? r.value.id : ''})`)) {
      form.reset()
      await reloadEvents()
      setSelected(r.value.id)
    }
  }

  async function createTeam(form: HTMLFormElement): Promise<void> {
    if (selected === null) return
    const f = new FormData(form)
    const r = await window.wgc.teams.create(selected, {
      name: String(f.get('name') ?? ''),
      bibNumber: String(f.get('bibNumber') ?? '') || null,
      color: String(f.get('color') ?? '') || null,
      isOwnTeam: f.get('isOwnTeam') === 'on'
    })
    if (show(r, 'チームを追加しました')) {
      form.reset()
      await reloadTeams(selected)
    }
  }

  async function deleteTeam(team: Team): Promise<void> {
    const impact = await window.wgc.teams.deletionImpact(team.id)
    if (!show(impact, '')) return
    const i = impact.value
    const ok = window.confirm(
      `「${team.name}」を削除しますか？（記録は保持されます）\n` +
        `ラップ記録 ${i.lapRecords} 件 / 通過記録 ${i.competitorPasses} 件 / 車両データ ${i.vehicleData} 件`
    )
    if (!ok) return
    show(await window.wgc.teams.delete(team.id, i), 'チームを削除しました（論理削除）')
    await reloadTeams(selected)
  }

  async function restoreTeam(team: Team): Promise<void> {
    show(await window.wgc.teams.restore(team.id), 'チームを復元しました')
    await reloadTeams(selected)
  }

  async function toggleOwn(team: Team): Promise<void> {
    show(await window.wgc.teams.update(team.id, { isOwnTeam: !team.isOwnTeam }), '自チーム判定を変更しました')
    await reloadTeams(selected)
  }

  return (
    <section>
      <h2>大会・チーム管理（段階3）</h2>
      <p id="message">{message}</p>

      <h3>大会の作成</h3>
      <form
        id="event-form"
        onSubmit={(e) => {
          e.preventDefault()
          void createEvent(e.currentTarget)
        }}
      >
        <label>大会名 <input name="name" /></label>{' '}
        <label>開催日 <input name="heldOn" type="date" /></label>{' '}
        <label>コース名 <input name="courseName" /></label>{' '}
        <label>1周の距離(m) <input name="lapDistanceM" /></label>{' '}
        <label>開始予定 <input name="start" type="datetime-local" step="1" /></label>{' '}
        <label>終了予定 <input name="end" type="datetime-local" step="1" /></label>{' '}
        <button type="submit">作成</button>
      </form>

      <h3>大会一覧</h3>
      <table id="events">
        <thead>
          <tr>
            <th></th><th>id</th><th>大会名</th><th>開催日</th><th>コース</th><th>距離(m)</th>
            <th>開始予定</th><th>終了予定</th><th>状態</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td>
                <input type="radio" name="sel" checked={selected === e.id} onChange={() => setSelected(e.id)} />
              </td>
              <td>{e.id}</td><td>{e.name}</td><td>{e.heldOn}</td><td>{e.courseName}</td><td>{e.lapDistanceM}</td>
              <td>{fmt(e.scheduledStartAt)}</td><td>{fmt(e.scheduledEndAt)}</td><td>{e.status}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {selected !== null && (
        <>
          <h3>チーム（大会 id={selected}）</h3>
          <form
            id="team-form"
            onSubmit={(e) => {
              e.preventDefault()
              void createTeam(e.currentTarget)
            }}
          >
            <label>チーム名 <input name="name" /></label>{' '}
            <label>ゼッケン <input name="bibNumber" /></label>{' '}
            <label>識別色 <input name="color" /></label>{' '}
            <label><input name="isOwnTeam" type="checkbox" /> 自チーム</label>{' '}
            <button type="submit">追加</button>
          </form>
          <table id="teams">
            <thead>
              <tr><th>id</th><th>チーム名</th><th>ゼッケン</th><th>識別色</th><th>自チーム</th><th>削除済み</th><th>操作</th></tr>
            </thead>
            <tbody>
              {teams.map((t) => (
                <tr key={t.id}>
                  <td>{t.id}</td><td>{t.name}</td><td>{t.bibNumber}</td><td>{t.color}</td>
                  <td>{t.isOwnTeam ? '○' : ''}</td><td>{t.deletedAt !== null ? '削除済み' : ''}</td>
                  <td>
                    {t.deletedAt === null ? (
                      <>
                        <button onClick={() => void toggleOwn(t)}>自チーム切替</button>{' '}
                        <button onClick={() => void deleteTeam(t)}>削除</button>
                      </>
                    ) : (
                      <button onClick={() => void restoreTeam(t)}>復元</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  )
}
