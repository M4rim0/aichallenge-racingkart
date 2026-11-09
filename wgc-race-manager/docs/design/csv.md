# CSV 出力仕様（段階9）

> 状態：**実装済み**。関連決定：D-005, D-008, D-013, D-020, D-025, D-032, D-039〜D-043
> **列名は集計スクリプトとの互換性のため安易に変更しない（D-043）。** 列を追加する場合は末尾に追加する。

## 出力方法（D-041）

- 毎回、保存先フォルダをダイアログで選択する。
- 選択したフォルダの下に `<大会ID>_<大会名>` フォルダを自動作成し、その中に 5 ファイルを書き出す。
  - 大会名に Windows で使えない文字（`\ / : * ? " < > |` と制御文字）があれば `_` に置き換え、末尾の空白・ピリオドは除く（80 文字まで）。
  - 先頭に大会 ID が付くため、別大会の CSV と混ざらない。大会名を変更した後に出力すると新しい名前のフォルダになる。
- 同じ大会を同じ保存先に再出力すると、既存の 5 ファイルを最新データで上書きする。
  - 各ファイルは一時ファイルに書き込んでから置き換えるため、書き込み途中の壊れたファイルは残らない。
  - Excel などでファイルを開いていると置き換えに失敗することがある。その場合はエラーを表示する（閉じてから再出力）。

## 共通仕様（仕様 §13）

| 項目 | 内容 |
|---|---|
| 文字コード | UTF-8（BOM 付き。Excel で日本語が文字化けしない） |
| 区切り | カンマ |
| 行の改行 | CRLF |
| ヘッダー | あり（1 行目） |
| 引用 | 値にカンマ・改行・`"` を含む場合は `"` で囲み、`"` は `""` にする（RFC 4180）。メモ本文などの改行は入力されたまま（値の中の改行）保持する |
| 日時 | 日本時間 `YYYY-MM-DD HH:mm:ss.SSS`（ミリ秒まで）。PC のタイムゾーン設定に依存しない |
| 空欄 | 未入力。`0` とは区別する |
| 真偽値 | `1` / `0` |
| 削除済みの記録 | 通常の記録 CSV には出さない。操作履歴 CSV には削除内容を残す |
| 削除済みのチーム | 記録は出力する。`team_deleted = 1`（D-008） |

### 日時の列（D-039）

- `*_master_jst`：**マスタークロック日時**。大会記録の基準。周回番号・ラップタイムはこの値から算出している。
- `*_pc_jst`：記録した瞬間の **PC 実日時**（参考値）。通常はマスタークロックとほぼ同じで、起動中に PC の時刻が変更された場合などにずれる。手入力で追加した過去記録には存在しないため空欄。

## lap_records.csv（自チームのラップ記録）

有効なラップのみ。周回順。

| 列名 | 意味 |
|---|---|
| event_id | 大会 ID |
| team_id | チーム ID |
| team_name | チーム名 |
| bib_number | ゼッケン番号 |
| team_deleted | チームが削除済みなら 1 |
| lap_number | 周回番号（通過日時順に算出、D-005） |
| passed_at_master_jst | 通過日時（マスタークロック、基準） |
| passed_at_pc_jst | 通過時点の PC 実日時（手入力の過去記録は空欄） |
| lap_time_ms | ラップタイム（ミリ秒の整数。集計・計算用、D-040）。1 周目は実際の開始時刻が基準。一時停止中の時間を含む |
| lap_time | ラップタイム（`H:mm:ss.SSS`。人による確認用） |
| record_id | 記録 ID |
| boot_session_id | 記録したアプリ起動セッションの ID |
| clock_anomaly_session | その起動セッションで PC の時刻異常を検出していれば 1（D-013）。不明なら空欄 |

## vehicle_data.csv（車両データ）

有効なラップに紐づく有効な車両データのみ（削除済みラップの車両データは出さない、D-025）。周回順。

| 列名 | 意味 |
|---|---|
| event_id | 大会 ID |
| lap_number | 周回番号 |
| passed_at_master_jst | そのラップの通過日時（マスタークロック） |
| speed_kmh | 速度（km/h）。入力文字列のまま |
| voltage_v | 電圧（V）。入力文字列のまま |
| current_a | 電流（A）。入力文字列のまま |
| integrated_value | 積算値。**意味・単位は未確定**。入力文字列のまま |
| lap_record_id | 紐づくラップ記録の ID |
| vehicle_data_id | 車両データ ID |
| updated_at_master_jst | 最終更新日時（マスタークロック） |

## competitor_records.csv（他チーム通過記録）

自チームを除く。有効な通過のみ。チーム ID 順 → 周回順。

| 列名 | 意味 |
|---|---|
| event_id | 大会 ID |
| team_id | チーム ID |
| team_name | チーム名 |
| bib_number | ゼッケン番号 |
| team_deleted | チームが削除済みなら 1 |
| lap_number | 周回番号（通過回数。初回通過 = 1 周目、D-020） |
| passed_at_master_jst | 通過日時（マスタークロック、基準） |
| passed_at_pc_jst | 通過時点の PC 実日時（手入力の過去記録は空欄） |
| lap_time_ms | ラップタイム（ミリ秒）。**1 周目は基準時刻がないため空欄** |
| lap_time | ラップタイム（`H:mm:ss.SSS`）。1 周目は空欄 |
| record_id | 記録 ID |
| boot_session_id | 記録したアプリ起動セッションの ID |
| clock_anomaly_session | その起動セッションで PC の時刻異常を検出していれば 1 |

## memos.csv（メモ）

有効なメモのみ。日時順。

| 列名 | 意味 |
|---|---|
| event_id | 大会 ID |
| memo_id | メモ ID |
| noted_at_master_jst | メモの日時（作成時のマスタークロック。変更不可、D-036） |
| body | 本文（入力のまま。改行・カンマ・引用符を含む） |
| updated_at_master_jst | 最終更新日時（本文を修正した日時） |

## operation_history.csv（操作履歴）

履歴 ID 順。**その大会の全操作** と **大会に属さない操作者管理の操作**（D-042）を含む。

> **注意（重複）**：操作者は全大会共通のため、操作者管理の履歴（`scope = OPERATOR_MANAGEMENT`）は
> **どの大会の CSV にも同じ行が含まれる**。複数大会の CSV を結合して集計する場合は `history_id` で重複を除くこと。

| 列名 | 意味 |
|---|---|
| history_id | 履歴 ID（全大会で一意） |
| scope | `EVENT`：大会内の操作 / `OPERATOR_MANAGEMENT`：操作者の登録・編集・削除（大会に属さない） |
| event_id | 大会 ID。操作者管理の操作は **空欄** |
| operated_at_master_jst | 操作日時（マスタークロック） |
| operator_id | 操作者 ID。未選択なら空欄 |
| operator_name | 操作当時の操作者名（スナップショット）。未選択なら `未設定`（D-032） |
| action | `CREATE`（追加）/ `UPDATE`（編集・復元）/ `DELETE`（削除）/ `UNDO`（取り消し） |
| target_table | 対象データ（`events`, `teams`, `lap_records`, `competitor_passes`, `vehicle_data`, `memos`, `operators`, `race_clock_transitions`） |
| target_id | 対象データの ID |
| before_json | 変更前の値（JSON）。追加では空欄 |
| after_json | 変更後の値（JSON）。削除では論理削除後の値 |
| undo_of_history_id | UNDO の場合、取り消した操作の history_id |
| operation_group | 1 回の操作で記録された行に共通の ID（UNDO の単位） |
| note | 補足（例：`LAP REGISTER`, `START`, `restore`, `correct actual start: ...`） |
| boot_session_id | 操作したアプリ起動セッションの ID |
| clock_anomaly_session | その起動セッションで PC の時刻異常を検出していれば 1 |

## 実装しないもの（§20 未確定）

- 予測結果の CSV
- 最終結果の独立 CSV
