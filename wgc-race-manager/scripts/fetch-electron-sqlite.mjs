// better-sqlite3 の Electron 用ビルド済みバイナリを native/ へダウンロードする（npm install / npm ci の postinstall で実行）。
//
// better-sqlite3 12 は Node・Electron の ABI ごとに別のバイナリを使う。
// - node_modules/better-sqlite3/build/Release/：システムの Node 用（自動テスト用。better-sqlite3 自身の install で入る）
// - native/electron-v<ABI>-<platform>-<arch>/：Electron 用（アプリ用。このスクリプトで入れる）
// 両者が上書きし合わないよう、Electron 用は別フォルダに置き、アプリは nativeBinding で明示的に読み込む。
// C++ のビルドツールは不要（配布元のビルド済みバイナリをダウンロードする）。
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const force = process.argv.includes('--force')

const electronVersion = require('electron/package.json').version
const sqlitePkgDir = dirname(require.resolve('better-sqlite3/package.json'))
const abi = require('node-abi').getAbi(electronVersion, 'electron')
const platform = process.platform
const arch = process.env.npm_config_arch || process.arch
const outDir = join(root, 'native', `electron-v${abi}-${platform}-${arch}`)
const outFile = join(outDir, 'better_sqlite3.node')

if (existsSync(outFile) && !force) {
  console.log(`[wgc] Electron ${electronVersion} 用 SQLite バイナリは導入済み: ${outFile}`)
  process.exit(0)
}

console.log(`[wgc] Electron ${electronVersion}（ABI ${abi}, ${platform}-${arch}）用の better-sqlite3 をダウンロードします`)
// prebuild-install は「カレントディレクトリのパッケージ」の build/Release に展開するため、
// node_modules の Node 用バイナリを上書きしないよう、一時フォルダで実行する
const work = mkdtempSync(join(tmpdir(), 'wgc-electron-sqlite-'))
try {
  cpSync(join(sqlitePkgDir, 'package.json'), join(work, 'package.json'))
  const r = spawnSync(
    process.execPath,
    [require.resolve('prebuild-install/bin.js'), '--runtime', 'electron', '--target', electronVersion, '--arch', arch, '--platform', platform, '--verbose'],
    { cwd: work, stdio: 'inherit', env: process.env }
  )
  const downloaded = join(work, 'build', 'Release', 'better_sqlite3.node')
  if (r.status !== 0 || !existsSync(downloaded)) {
    console.error('[wgc] Electron 用 SQLite バイナリのダウンロードに失敗しました。ネット接続を確認して `npm run setup:native` を実行してください。')
    process.exit(1)
  }
  mkdirSync(outDir, { recursive: true })
  copyFileSync(downloaded, outFile)
  console.log(`[wgc] 導入しました: ${outFile}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
