# WGCレース管理・戦略支援システム

玉川大学 TSCP 向け、ソーラーカーレース（WGC 等）のレース管理・戦略支援アプリ（Windows / オフライン）。

- 基準文書: [docs/spec-v0.1.md](docs/spec-v0.1.md)
- 実装計画: [docs/implementation-plan.md](docs/implementation-plan.md)
- 確定事項: [docs/decisions.md](docs/decisions.md)
- 開発環境: [docs/dev-setup.md](docs/dev-setup.md)
- 設計提案: [docs/design/](docs/design/)

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
| 8 | 操作者・メモ・操作履歴 | 未着手 |
| 9〜14 | | 未着手 |

現在の画面は検証用画面のみです（正式 UI ではありません。決定 D-004）。
