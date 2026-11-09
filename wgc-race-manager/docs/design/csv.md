# 設計提案：CSV 出力（段階9）

> 状態：**提案（ユーザー承認待ち）**。関連：仕様 §13、D-005, D-008, D-013, D-015, D-032

## 共通仕様（仕様 §13 のとおり）

- UTF-8 BOM 付き / カンマ区切り / CRLF / ヘッダーあり / 日本時間 / ミリ秒まで
- 値にカンマ・改行・`"` を含む場合は `"` で囲み、`"` は `""` に置換（RFC 4180）。メモ内の改行は CRLF のまま保持
- 空欄は未入力（空文字列）。0 と区別する
- 日時形式：`YYYY-MM-DD HH:mm:ss.SSS`（日本時間）
- 削除済みの記録は通常の記録 CSV に出さない。操作履歴 CSV には削除内容を残す
- 同じ大会の再出力は同じフォルダに最新データで上書き

## 列案

### lap_records.csv（自チーム、有効なラップのみ、周回順）

| 列 | 内容 |
|---|---|
| lap_number | 周回番号（算出） |
| passed_at | 通過日時（マスタークロック） |
| passed_at_pc | 通過時点の PC 実日時（手入力の過去記録は空欄） |
| lap_time_ms | ラップタイム（ミリ秒、整数） |
| lap_time | ラップタイム（`H:mm:ss.SSS`） |
| team_name / bib_number | 自チーム名・ゼッケン |
| team_deleted | チームが削除済みなら `1`（D-008） |
| record_id | 記録 ID |
| boot_session_id | 記録した起動セッション |
| clock_anomaly_session | その起動セッションで PC 時刻異常を検出していれば `1`（D-013） |

### vehicle_data.csv（有効な車両データのみ。削除済みラップのものは出さない、D-025）

lap_number, passed_at, speed, voltage, current, integrated_value, lap_record_id, vehicle_data_id, updated_at
（4 項目は入力文字列のまま。未入力は空欄）

### competitor_records.csv（他チーム、有効な通過のみ。チーム→周回順）

team_name, bib_number, team_deleted, lap_number, passed_at, passed_at_pc, lap_time_ms, lap_time（初回は空欄、D-020）, record_id, boot_session_id, clock_anomaly_session

### memos.csv（有効なメモのみ、日時順）

noted_at, body, memo_id, updated_at

### operation_history.csv（大会の全履歴、ID 順）

history_id, operated_at, operator_id, operator_name（未選択は `未設定`、D-032）, action（CREATE / UPDATE / DELETE / UNDO）, target_table, target_id, before（JSON）, after（JSON）, undo_of_history_id, operation_group, note, boot_session_id

## 確認したいこと

1. 日時（A-3）：上記のとおり、マスタークロック（`passed_at`）と PC 実日時（`passed_at_pc`）を両方出力してよいか
2. ラップタイムの形式：ミリ秒の整数と `H:mm:ss.SSS` の両方を出力してよいか
3. 出力先：保存先フォルダの選び方（ダイアログで毎回選ぶ / 既定フォルダ）は UI 判断（B-3）。
   上書きのため、選んだフォルダの下に大会ごとのサブフォルダ（例：`<大会ID>_<大会名>`）を作る方式でよいか
4. 操作履歴 CSV に、大会に属さない操作者の登録・編集・削除（event_id なし）を含めるか
5. 列名を英語（上記）にするか日本語にするか
