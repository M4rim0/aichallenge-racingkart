# 開発環境セットアップ（Windows）

## 必要なもの

- Windows 10 / 11（x64）
- Node.js **22.12 以上**（LTS 推奨）

C++ ビルドツール（Visual Studio Build Tools / Python）は**不要**です。
better-sqlite3 13 は Node-API 対応の Windows x64 用ビルド済みバイナリを同梱しており、Node と Electron の両方で同じバイナリが動作します。

## 初回セットアップ

```powershell
cd wgc-race-manager
npm ci
```

`npm ci` は `package-lock.json` に固定されたバージョンをそのまま入れます（インターネット接続はこの時だけ必要です。アプリ本体はオフラインで動作します）。

## コマンド

| コマンド | 内容 |
|---|---|
| `npm run dev` | 開発モードで起動（ホットリロードあり） |
| `npm run build` | `out/` にビルド |
| `npm start` | ビルド済みのアプリを起動 |
| `npm test` | 自動テスト（Vitest） |
| `npm run typecheck` | 型チェック |

## 段階1の動作確認（手動）

1. `npm run build` → `npm start`
2. 「検証用画面（正式UIではありません）」と表示され、Electron / Node / SQLite のバージョンが表示されること
3. もう一度 `npm start` を実行しても 2 つ目のウィンドウが開かず、既存ウィンドウが前面に出ること（二重起動防止）

## 固定バージョン（段階1で確定）

| パッケージ | バージョン |
|---|---|
| electron | 45.2.3 |
| better-sqlite3 | 13.0.3（SQLite 3.53.4） |
| react / react-dom | 19.3.1 |
| zustand | 5.1.0 |
| typescript | 6.0.3 |
| electron-vite | 6.0.0 |
| vite | 8.3.6 |
| @vitejs/plugin-react | 6.3.0 |
| vitest | 5.1.0 |

TypeScript は 7.0（ネイティブ版）が最新ですが、周辺ツールの対応状況を考慮し安定した 6.0 系を採用しています。

## 未決定

- 配布形式（インストーラ / ポータブル exe）と electron-builder の導入は段階13〜14で確認後に行います。
