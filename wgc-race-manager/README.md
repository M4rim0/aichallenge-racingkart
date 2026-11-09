# WGCレース管理・戦略支援システム

玉川大学 TSCP 向け、ソーラーカーレース（WGC 等）のレース管理・戦略支援アプリ（Windows / オフライン）。

- 基準文書: [docs/spec-v0.1.md](docs/spec-v0.1.md)
- 実装計画: [docs/implementation-plan.md](docs/implementation-plan.md)
- 確定事項: [docs/decisions.md](docs/decisions.md)
- 開発環境: [docs/dev-setup.md](docs/dev-setup.md)（Electron 33.4.11 / better-sqlite3 12.11.1、D-073。**Windows の S モードでは起動不可**）
- 設計: [docs/design/](docs/design/)（CSV の列仕様は [csv.md](docs/design/csv.md)、戦略計算は [strategy.md](docs/design/strategy.md)、警告は [warnings.md](docs/design/warnings.md)、復旧・電源管理は [recovery-power.md](docs/design/recovery-power.md)）

## 進捗

| 段階 | 内容 | 状態 |
|---|---|---|
| 1 | プロジェクト初期化・技術構成確定 | 完了 |
| 2 | SQLite・Repository 層 | 完了 |
| 3 | 大会・チーム管理 | 完了 |
| 4 | マスタークロック・レース時計 | 完了（強制停止時間は段階10、D-014） |
| 5 | 自チームラップ記録・UNDO | 完了 |
| 6 | 他チーム通過記録・暫定順位 | 完了 |
| 7 | 車両データ入力 | 完了 |
| 8 | 操作者・メモ・操作履歴 | 完了 |
| 9 | CSV 出力 | 完了（予測結果・最終結果 CSV は未確定のため未実装） |
| 10 | 戦略計算エンジン・強制停止時間 | 完了（警告は段階11） |
| 11 | 警告判定 | 完了（W-1〜W-11 は D-069 で正式化） |
| 12 | 異常終了・電源断復旧・電源管理・復旧確認待ち | 実装済み（Linux で検証。**Windows 実機テストは未実施**） |
| 13 | 統合テスト | 未着手 |
| 14 | UI 調整・最終検証 | 未着手 |

現在の画面は検証用画面のみです（正式 UI ではありません。決定 D-004）。
