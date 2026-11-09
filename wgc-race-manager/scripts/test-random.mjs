// 段階13 追加のランダム操作テスト：複数シード × 数千操作（通常の npm test より長時間）。
// 使い方: npm run test:random
//   変更する場合は環境変数で指定（例: WGC_RANDOM_SEEDS=1,2 WGC_RANDOM_OPS=5000 npm run test:random）
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const env = {
  ...process.env,
  WGC_RANDOM_SEEDS: process.env.WGC_RANDOM_SEEDS ?? '20261110,1,42,777,31415',
  WGC_RANDOM_OPS: process.env.WGC_RANDOM_OPS ?? '5000'
}
console.log(`シード: ${env.WGC_RANDOM_SEEDS} / 各 ${env.WGC_RANDOM_OPS} 操作`)
const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
const res = spawnSync(process.execPath, [vitest, 'run', 'tests/integration/random-ops.test.ts', '--silent=false'], { env, stdio: 'inherit' })
process.exit(res.status ?? 1)
