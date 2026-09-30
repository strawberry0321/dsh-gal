/**
 * Is the client half actually running in the Desktop app?
 *
 * The only automatable signal: the client polls `/api/state` every 60 s, which
 * makes the host refresh the balance and rewrite the usage ledger. If that file's
 * mtime never moves while the app sits idle, `/dsh-gal/client.js` is not being
 * loaded — the widget is not "hidden", it was never created. That is exactly the
 * 2.3.2 bug (only `tapIndex` injection, which the official Desktop never runs).
 *
 *   node scripts/desktop-liveness-check.mjs [seconds]
 *
 * Exit code 0 = the ledger moved, so the script is alive. 1 = it did not.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const waitSeconds = Math.max(10, Number(process.argv[2]) || 90)
const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const candidates = [
  path.join(home, '.dsh-gal-usage.json'),
  path.join(home, 'dsh-gal', '.dsh-gal-usage.json'),
]
const file = candidates.find((c) => fs.existsSync(c))
if (!file) {
  console.log(`✗ 找不到用量文件：${candidates.join(' 或 ')}`)
  console.log('  没有这个文件说明挂件从未跑过（余额/记账还没写过）。')
  process.exit(1)
}

const stampOf = () => {
  const stat = fs.statSync(file)
  return { at: stat.mtimeMs, size: stat.size }
}

const before = stampOf()
console.log(`用量文件: ${file}`)
console.log(`起始: mtime=${new Date(before.at).toLocaleString()} size=${before.size}`)
console.log(`静默观察 ${waitSeconds} 秒（期间不要发消息）…`)

const started = Date.now()
let after = before
while (Date.now() - started < waitSeconds * 1000) {
  await new Promise((r) => setTimeout(r, 2000))
  after = stampOf()
  if (after.at !== before.at) break
}

console.log(`结束: mtime=${new Date(after.at).toLocaleString()} size=${after.size}`)
try {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  const keys = Object.keys(data).slice(0, 8).join(', ')
  console.log(`内容键: ${keys}`)
} catch {
  // a ledger that is being rewritten right now is not worth failing over
}

console.log('')
if (after.at !== before.at) {
  console.log('✓ 客户端脚本在跑（宿主按它的轮询刷新了余额并重写账本）')
} else {
  console.log('✗ 账本没动 → 客户端脚本没有被加载 / 没有在轮询')
  console.log('  · 装完插件必须**完全退出 DSH Desktop 再启动**（注入表在应用启动时冻结）')
  console.log('  · 确认插件装在应用实际使用的 profile：dsh --profile desktop --dump-config | Select-String dsh-gal')
  process.exitCode = 1
}
