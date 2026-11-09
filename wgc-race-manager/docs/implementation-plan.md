# 実装計画・ディレクトリ構成案（v0.1 対応）

> 基準文書：[spec-v0.1.md](./spec-v0.1.md)
> 状態：計画は承認済み（確定事項は [decisions.md](./decisions.md)）。段階1〜8 完了。
> 段階1で確定したバージョンは [dev-setup.md](./dev-setup.md) を参照。

---

## 1. 技術構成案

| 区分 | 採用候補 | 2026-11-09 時点の最新安定版 | 備考 |
|---|---|---|---|
| ランタイム | Electron | 45.2.x | 46 は alpha のため不採用 |
| UI | React | 19.x | |
| 言語 | TypeScript | 6.0.3（確定） | 7.0（ネイティブ版）は周辺ツール対応を考慮し見送り |
| 状態管理 | Zustand | 5.x | Renderer 側の表示状態のみ。正のデータは常に DB |
| DB | SQLite + better-sqlite3 | 13.0.3（確定） | Node-API 版のため Node/Electron で同一バイナリ。再ビルド不要 |
| ビルド | electron-vite（Vite） | 6.x / 8.x | main / preload / renderer を一括ビルド |
| テスト | Vitest | 5.x | Service・Repository・計算エンジンの自動テスト |
| 配布 | electron-builder | 26.x | Windows 向け NSIS またはポータブル（段階1で決定事項として確認） |

- バージョンは段階1で `package.json` に**完全固定**（`^` を使わない）し、`package-lock.json` をコミットする。
- オンライン通信は一切行わない（自動更新・テレメトリ・CDN 読み込みなし。CSP で外部接続を禁止）。

## 2. アーキテクチャ

```
┌──────────── Renderer (React + Zustand) ────────────┐
│  画面表示・入力のみ。DB/Node API へのアクセス不可    │
│  window.wgc.*（preload が公開する型付き API）を呼ぶ │
└───────────────▲───────────────────┬────────────────┘
                │ IPC (invoke / 通知) │
┌───────────────┴─ Preload (contextBridge) ──────────┐
│  公開チャネルのホワイトリスト。contextIsolation=ON,  │
│  sandbox=ON, nodeIntegration=OFF                     │
└───────────────▲───────────────────┬────────────────┘
┌───────────────┴─ Main Process ─────▼────────────────┐
│ ipc/        : 入力検証（zod 等）→ Service 呼び出し    │
│ services/   : レース処理・時計・戦略計算・CSV・電源    │
│ repositories: SQL を書く唯一の層                     │
│ db/         : 接続・マイグレーション・トランザクション │
└──────────────────────────┬──────────────────────────┘
                           ▼
                SQLite（WAL, synchronous=FULL）
```

- **shared/**：IPC の型定義・ドメイン型・純粋関数（戦略計算・ラップ再計算・CSV 整形）。
  純粋関数は Electron 非依存にし、Vitest で直接テストする。
- **書き込み系の全操作**は Service 内で `db.transaction()` を使い、「データ変更 + operation_history 挿入」を 1 トランザクションで実行（仕様 §14）。
- 順位・ラップタイム・周回番号・予測値は**保存せず**、元データ（通過日時）から毎回再計算する（仕様 §14）。
  ※ lap_records の「周回番号」「ラップタイム」は仕様 §5.2 で保存項目に挙がっているため、後述の論点 A-6 で扱いを確認する。

## 3. ディレクトリ構成案

本リポジトリ（aichallenge-racingkart）は自動運転AIチャレンジ用であり本アプリと無関係のため、
**`wgc-race-manager/` サブディレクトリに完全に独立したプロジェクトとして配置**する（論点 A-1 参照）。

```
wgc-race-manager/
├─ docs/
│  ├─ spec-v0.1.md              # 基準文書（原文）
│  ├─ implementation-plan.md    # 本書
│  └─ decisions.md              # 確定事項ログ（ユーザー回答を記録）
├─ package.json / package-lock.json
├─ electron.vite.config.ts
├─ electron-builder.yml
├─ tsconfig*.json
├─ vitest.config.ts
├─ src/
│  ├─ shared/                   # Main/Renderer 共通（Node/DOM 非依存）
│  │  ├─ types/                 # ドメイン型（Event, Team, LapRecord ...）
│  │  ├─ ipc-contract.ts        # IPC チャネル名・引数・戻り値の型
│  │  ├─ time/                  # JST 整形（ミリ秒）、期間計算
│  │  └─ strategy/              # 戦略計算（純粋関数）
│  │     ├─ pace.ts             #   3/5/10周平均・ペース変化
│  │     ├─ ranking.ts          #   順位・周回差（規則差し替え可能な Strategy）
│  │     ├─ position.ts         #   Q = L + Δt/P
│  │     ├─ projection.ts       #   最終周回数予測（R_drive）
│  │     ├─ attack-defense.ts   #   P_req 計算（不成立判定込み）
│  │     └─ warnings.ts         #   警告判定（しきい値は未確定 → 段階11）
│  ├─ main/
│  │  ├─ index.ts               # アプリ起動・単一インスタンスロック
│  │  ├─ window.ts
│  │  ├─ db/
│  │  │  ├─ connection.ts       # PRAGMA 設定（WAL, FULL, foreign_keys）
│  │  │  ├─ migrations/         # 001_init.sql ...（番号付き・前進のみ）
│  │  │  └─ migrate.ts
│  │  ├─ repositories/          # テーブル単位の Repository
│  │  │  ├─ event-repository.ts
│  │  │  ├─ team-repository.ts
│  │  │  ├─ lap-record-repository.ts
│  │  │  ├─ vehicle-data-repository.ts
│  │  │  ├─ competitor-pass-repository.ts
│  │  │  ├─ operator-repository.ts
│  │  │  ├─ memo-repository.ts
│  │  │  ├─ operation-history-repository.ts
│  │  │  ├─ race-clock-transition-repository.ts
│  │  │  └─ mandatory-stoppage-repository.ts
│  │  ├─ services/
│  │  │  ├─ clock-service.ts    # マスタークロック・レース時計・復元
│  │  │  ├─ event-service.ts
│  │  │  ├─ team-service.ts
│  │  │  ├─ lap-service.ts
│  │  │  ├─ competitor-service.ts
│  │  │  ├─ vehicle-data-service.ts
│  │  │  ├─ operator-service.ts
│  │  │  ├─ memo-service.ts
│  │  │  ├─ history-service.ts  # 操作履歴の記録・取り消し(undo)
│  │  │  ├─ strategy-service.ts # DB → shared/strategy 呼び出し
│  │  │  ├─ csv-service.ts
│  │  │  └─ power-service.ts    # powerSaveBlocker
│  │  └─ ipc/                   # ハンドラ登録（検証 → Service）
│  ├─ preload/
│  │  └─ index.ts               # contextBridge.exposeInMainWorld('wgc', ...)
│  └─ renderer/
│     ├─ index.html
│     └─ src/
│        ├─ api/                # window.wgc の薄いラッパ
│        ├─ stores/             # Zustand
│        └─ ...                 # 画面構成は UI 仕様確定後（§17）
└─ tests/
   ├─ unit/                     # shared/ の純粋関数
   ├─ repository/               # 一時 SQLite ファイルで実 DB テスト
   ├─ service/                  # トランザクション・履歴・再計算
   └─ fixtures/                 # レースデータのサンプル
```

**UI について**：段階1〜12 では、動作確認用に**最小限の検証用画面（無装飾・機能確認のみ）**を置くことを提案する。
正式な画面構成・配色・操作性はユーザー決定後に段階14で実装する（論点 B-1）。

## 4. データベース設計案（概要）

共通方針：
- 主キーは `INTEGER PRIMARY KEY`。日時は **UTC の epoch ミリ秒（INTEGER）** で保存し、表示・CSV で JST に変換。
- 全記録テーブルに `created_at`, `updated_at`, `deleted_at`（論理削除、NULL=有効）。
- 外部キー有効化。`PRAGMA journal_mode=WAL; synchronous=FULL;`（電源断対策）。

| テーブル | 主なカラム |
|---|---|
| events | id, name, held_on, course_name, lap_distance_m, scheduled_start_at, scheduled_end_at, actual_start_at, actual_end_at, status(PREPARING/RUNNING/PAUSED/FINISHED) |
| teams | id, event_id, name, bib_number, color, is_own_team, deleted_at — 部分一意インデックス `UNIQUE(event_id) WHERE is_own_team=1 AND deleted_at IS NULL` |
| lap_records | id, event_id, team_id, passed_at, passed_wall_at（※）, boot_session_id, deleted_at — 周回番号・ラップタイムは保存せず算出（D-005） |
| vehicle_data | id, lap_record_id（有効行で UNIQUE）, speed, voltage, current, integrated_value — 4 項目とも **入力文字列のまま TEXT**、空欄は NULL（D-006） |
| competitor_passes | id, event_id, team_id, passed_at, passed_wall_at（※）, boot_session_id, deleted_at |
| operators | id, name, deleted_at |
| memos | id, event_id, body, noted_at, deleted_at |
| operation_history | id, event_id, operator_id, operator_name_snapshot, operated_at, action(CREATE/UPDATE/DELETE/UNDO), target_table, target_id, before_json, after_json, undo_of_history_id, note — 追記専用 |
| race_clock_transitions | id, event_id, kind(START/PAUSE/RESUME/END), at, wall_at, mono_ms, boot_session_id — 追記専用 |
| mandatory_stoppages | id, event_id, starts_at, ends_at, deleted_at |

※ `passed_at` と `passed_wall_at` の 2 本立ては論点 A-3 の結論次第（列は段階2で用意済み）。

段階2で追加した DB レベルの保護：
- 全テーブルで物理削除（DELETE）をトリガーで拒否
- operation_history / race_clock_transitions は UPDATE も拒否（追記専用）
- 通過記録・ラップ記録の team_id が別大会のチームを指す場合は拒否
- 操作履歴はトランザクション外から記録できない（`runAudited` で変更と同時に記録）
- チーム削除と順位計算の分離は [design/team-deletion.md](./design/team-deletion.md)（提案中）

## 5. 時計設計案

- **アンカー方式**：起動時に `(wall0 = Date.now(), mono0 = performance.now())` を取得し、
  以後の「マスタークロック日時」は `wall0 + (performance.now() - mono0)` で算出。OS 時刻変更の影響を受けない。
- **レース経過時間**：`race_clock_transitions` を時系列に畳み込み、RUNNING 区間の合計で算出。
  同一起動中の区間は単調時計差で、起動をまたぐ区間は保存済み実日時の差で算出（仕様 §4.4「再起動後は保存済みの日時情報を基準に復元」）。
- 起動時に OS 時刻が最後に保存された日時より過去になっている場合は**異常として検出し通知**（自動補正はしない）。異常は `app_sessions.clock_anomaly` に記録し、各記録の `boot_session_id` で識別できる（D-013、migration 002）。
- 実際の開始時刻の修正（D-012）は `events.actual_start_at` を更新し、START の遷移記録は書き換えない。経過時間の計算では修正後の値を使う。
- 強制停止時間の拡張点：`RemainingStoppageCalculator`（`src/shared/time/race-clock.ts`）。段階10で S_remaining を実装する（D-014）。
- 1 起動ごとに `boot_session_id` を発行し、どの起動中の記録かを追跡可能にする。

## 6. 開発段階と各段階の完了条件

| # | 段階 | 主な成果物 | 完了条件（テスト） |
|---|---|---|---|
| 1 | 初期化・技術構成確定 | electron-vite 雛形、TS/ESLint/Vitest、better-sqlite3 の Electron 向けビルド確認、CSP・セキュリティ設定 | `npm run build`/`npm test` 成功、空ウィンドウ起動、Windows ビルド手順書 |
| 2 | SQLite・Repository 層 | マイグレーション、10 テーブル、Repository、トランザクション + 履歴ヘルパ | 一時 DB での CRUD・論理削除・ロールバックテスト |
| 3 | 大会・チーム管理 | Event/Team Service + IPC | 自チーム一意制約、記録ありチームの削除挙動テスト |
| 4 | マスタークロック・レース時計 | ClockService、状態遷移、復元 | START/PAUSE/RESUME/END、再起動復元、OS 時刻変更シミュレーション（時計を注入してテスト） |
| 5 | 自チームラップ記録 | LapService（登録・追加・修正・削除・取り消し） | ラップタイム・周回番号の再計算テスト |
| 6 | 他チーム通過記録 | CompetitorService | チーム間非混在、修正後の順位再計算テスト |
| 7 | 車両データ | VehicleDataService | ラップ紐づけ、NULL≠0、修正テスト |
| 8 | 操作者・メモ・操作履歴 | Operator/Memo/HistoryService | 名前スナップショット、before/after、UNDO 履歴テスト |
| 9 | CSV 出力 | CsvService（BOM, CRLF, JST ミリ秒, RFC4180 エスケープ） | 改行・カンマ・日本語を含むゴールデンファイルテスト、削除済み除外 |
| 10 | 戦略計算エンジン | shared/strategy/* + StrategyService | 平均・データ不足・周回差/時間差分離・停止時間反映・P_req 不成立判定・異常値（0, 負, NaN） |
| 11 | 警告判定 | warnings.ts | **しきい値・通知方式の確定後に着手**（§20） |
| 12 | 異常終了・電源断復旧 | 単一インスタンス、起動時整合性チェック、powerSaveBlocker | プロセス強制終了テスト、WAL 復旧確認、PAUSED 維持 |
| 13 | 統合テスト | シナリオテスト（模擬レース 1 本を通しで） | 全テスト成功 |
| 14 | UI 調整・最終検証 | ユーザー決定の UI 実装 | Windows 実機での手動テスト（§18 チェックリスト） |

各段階終了時に「実装済み / 未実装 / 保留」を明記して報告する。

## 7. 開発環境上の制約（事前共有）

- 本作業環境は **Linux のクラウドコンテナ**であり、Windows 実機での GUI 動作・スリープ抑止・インストーラ動作は確認できない。
  - 自動テスト（ロジック・DB・CSV）は Linux 上で実行可能。
  - Windows 固有の確認（電源管理、Excel での CSV 表示、インストーラ）は**手動テスト手順書を用意し、ユーザー側で実施**していただく必要がある。
- better-sqlite3 13 は Node-API 版のため、Node（テスト）と Electron（実行）で同じバイナリが使える（段階1で確認済み）。

---

## 8. 仕様上の論点（変更せず、確認を求めるもの）

### A. 矛盾・技術的問題の可能性があるもの

**A-1. 配置リポジトリ**
- 問題：指定ブランチのリポジトリは自動運転AIチャレンジ用で、本アプリと無関係。
- 影響：CI（.github）や pre-commit が本アプリにも作用する可能性、履歴の混在。
- 案：(a) `wgc-race-manager/` サブディレクトリに独立配置（**本計画の前提**） / (b) 専用リポジトリを新設して移す。

**A-2. PAUSE 中の「残り時間」**
- 問題：§4.2 は PAUSE で経過時間を止めるが、§4.3 は残り時間を「予定終了時刻 − 現在日時」とするため、PAUSE 中も残り時間は減り続ける。
- 影響：PAUSE を「レース中断（終了時刻延長あり）」と捉えるか「計測の一時停止（終了時刻不変）」と捉えるかで、R_clock・予測値が変わる。
- 案：(a) 仕様どおり残り時間は減り続け、終了時刻を延ばす場合はユーザーが予定終了時刻を手動変更 / (b) PAUSE 時間分だけ終了時刻を自動延長。**(a) を推奨**（仕様の字義どおり）。

**A-3. 単調時計と記録日時の関係**
- 問題：§4.4「単調増加時計を使用」かつ「記録には実日時も保存」。レース中に OS 時刻が変更された場合、単調時計ベースの日時と OS 実日時が乖離する。どちらを「通過日時」とするかが未定義。
- 影響：ラップタイム計算・CSV の日時。
- 案：`passed_at`（アンカー＋単調時計で算出、計算に使用）と `passed_wall_at`（OS 実日時、参考保存）の 2 列を保存。CSV には両方出すか `passed_at` のみかを確認したい。

**A-4. 自チームの扱い（ラップ記録と通過記録の二重化）**
- 問題：§5（自チームラップ）と §7（全チーム通過、「参加チームすべて」）が独立しているため、自チームが両方に記録されうる。順位計算でどちらを使うか未定義。
- 影響：二重入力の手間、両者の不一致時に順位がぶれる。
- 案：(a) 順位・戦略計算では自チームは lap_records を正とし、competitor_passes の自チーム入力は不可にする / (b) 両方許可し、計算には lap_records のみ使用。**(a) を推奨**。

**A-5. 自チームラップの PAUSE 中の扱い**
- 問題：§5.1 の START/PAUSE/RESUME/END はレース時計（§4.2）と同一操作か不明。また PAUSE を挟んだラップのラップタイムに一時停止時間を含めるか不明。
- 案：同一操作とし、ラップタイムは「通過日時の差」（§5.2 の字義どおり、PAUSE 時間を含む）。PAUSE 時間を除外した値が必要なら別途。

**A-6. 周回番号・ラップタイムの保存**
- 問題：§5.2 は保存項目に周回番号・ラップタイムを含むが、§14 は「原則として元データから再計算」。保存すると修正時の再計算で不整合リスク。
- 案：DB には通過日時のみ保存し、周回番号・ラップタイムは常に算出（読み出し時・CSV 出力時に付与）。これで §5.3 の再計算要件は自動的に満たされる。**推奨**。

**A-7. 強制停止時間とペース計算**
- 問題：強制停止を跨いだラップは極端に長くなり、3/5/10 周平均・走行位置推定（Δt）が歪む。仕様は R_drive からの除外のみ規定。
- 案：(a) 停止区間と重なるラップは、重なった時間を差し引いてペース計算に使う / (b) 停止を跨いだラップは平均から除外 / (c) 何もしない（仕様どおり）。同様に Δt からも停止時間を差し引くか確認したい。

**A-8. 最終周回数予測の「実際の通過タイミング」**
- 問題：§8.5 の意図として「終了時刻後にゴールラインを越えた周回をカウントするか（チェッカー後の完走周回の扱い）」が大会規則依存。
- 案：大会規則が判明するまで、「終了時刻までに完了した通過のみカウント」と「終了時刻をまたぐ周回もカウント」の 2 方式を規則 Strategy として実装し、選択はユーザー確認後。どちらを既定にするか確認したい。

**A-9. 積算値の保存形式**
- 問題：「入力値をそのまま保存」「単位・意味を推測しない」。数値型で保存すると先頭ゼロ・表記揺れ・単位付き入力が失われる。
- 案：速度・電圧・電流は数値（REAL, NULL 可）、積算値は**入力文字列のまま TEXT** で保存。速度等も文字列で保持すべきか確認したい。

**A-10. 攻撃・防衛計算の G（周回差）**
- 問題：G に整数の周回差を使うか、走行位置推定 Q の差（小数）を使うかで結果が変わる。また「追いつく」=同周回か、追い抜く（+α）か。
- 案：G = Q 差（推定）を用い、結果を「推定値」と明示。分母 ≤ 0（防衛）では「相手ペースでは追いつけない（必要ペースなし）」と表示、R_drive ≤ 0 や Pt 不明では「算出不可」とする。

**A-11. 直前操作の取り消し（UNDO）の範囲**
- 問題：「直前操作」が全体共通の 1 件か、操作者ごと/画面ごとか、多段 UNDO・REDO の要否が未定義。
- 案：イベント単位で、操作履歴を遡る**多段 UNDO（REDO なし）**。UNDO 自体も履歴に記録（§11）。

**A-12. 電源管理の範囲**
- 問題：§16「画面消灯についても考慮」。Electron の `powerSaveBlocker` は `prevent-app-suspension`（スリープ抑止のみ）と `prevent-display-sleep`（画面消灯も抑止）の二択。
- 案：レース中（RUNNING/PAUSED）は `prevent-display-sleep` を推奨。ノートPCのフタ閉じ・電源ボタン動作は OS 設定依存のためアプリでは制御不可（手順書で案内）。

**A-13. 削除済みチームの記録**
- 問題：チームを論理削除した場合、そのチームの通過記録を順位計算・CSV に含めるか。
- 案：削除前に影響件数を表示して確認（§3.2）、削除後は順位計算・通常 CSV から除外、操作履歴には残す。

### B. UI 判断として保留するもの（§17）

- B-1. 段階1〜12 の検証用最小画面を置いてよいか（正式 UI ではない旨を明記）。
- B-2. 画面構成・配色・ボタン配置・キーボードショートカット・通過操作の入力方式（チームごとのボタン/ゼッケン番号入力 等）。
- B-3. CSV 出力先フォルダの選び方（保存ダイアログ / 固定フォルダ）。
- B-4. 削除・UNDO 時の確認ダイアログの有無。
- B-5. データ不足・推定値・算出不可の表示方法。

### C. §20 未確定事項（着手時に確認）

| 未確定事項 | 影響する段階 |
|---|---|
| 積算値の意味・単位 | 7（保存は文字列のまま進められる） |
| 同周回順位判定ルール | 10（差し替え可能構造で先行実装可） |
| 他チームの初回通過時刻の基準 | 6・10（初回ラップタイムの算出可否） |
| 強制停止時間の登録・変更条件 | 4・10 |
| 警告の通知方式・しきい値 | 11（確定まで着手不可） |
| 車両データ・メモの修正履歴の詳細 | 8 |
| 予測結果の別 CSV 出力 | 9 |
| 最終結果の独立 CSV | 9・12 |
