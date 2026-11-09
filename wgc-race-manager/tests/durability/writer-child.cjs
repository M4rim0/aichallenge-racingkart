// 強制終了テスト用の子プロセス（SIGKILL される前提）。
// アプリと同じ SQLite 設定（WAL + synchronous=FULL + foreign_keys）で、
// 「記録 1 件 + 操作履歴 1 件」を 1 つの IMMEDIATE トランザクションで書き続ける（runAudited と同じ形）。
const Database = require(process.argv[3])
const db = new Database(process.argv[2])
db.pragma('journal_mode = WAL')
db.pragma('synchronous = FULL')
db.pragma('foreign_keys = ON')
const eventId = Number(process.argv[4])
const teamId = Number(process.argv[5])
const insLap = db.prepare('INSERT INTO lap_records (event_id, team_id, passed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
const insHist = db.prepare(
  "INSERT INTO operation_history (event_id, operated_at, action, target_table, target_id, after_json) VALUES (?, ?, 'CREATE', 'lap_records', ?, ?)"
)
const tx = db.transaction((i) => {
  const t = 1_800_000_000_000 + i * 1000
  const id = Number(insLap.run(eventId, teamId, t, t, t).lastInsertRowid)
  insHist.run(eventId, t, id, JSON.stringify({ id, passedAt: t }))
})
let i = 0
process.send?.('ready')
for (;;) {
  tx.immediate(i++)
  if (i % 50 === 0) process.send?.(i)
}
