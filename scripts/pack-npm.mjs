/**
 * Build the publishable npm tarball.
 *
 * The repo ships a 125MB demo voice pack, which is fine for GitHub but far too
 * heavy for the npm registry — and nobody wants a 124MB dependency. So the
 * published package keeps everything that makes the widget work out of the box
 * (all 18 sprites, the UI artwork, the transcript) plus a handful of sample
 * voices, and the full voice pack is a separate download for users who want it.
 *
 *   node scripts/pack-npm.mjs [outputDir]
 *
 * The dev suites (scripts/) stay in the repo: their assertions are written
 * against the full sample pack and would fail inside a trimmed distribution.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.resolve(process.argv[2] || path.join(ROOT, 'dist'))
const SAMPLE_VOICES = 12

const PACK = path.join('assets', 'packs', 'neri')
const copies = [
  'lib',
  'docs',
  path.join('assets', 'ui'),
  path.join('assets', 'pricing.json'),
  path.join('assets', 'packs', 'README.md'),
  path.join(PACK, 'pack.json'),
  path.join(PACK, 'script.csv'),
  path.join(PACK, 'sprites'),
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
  'package.json',
]

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gal-npm-'))
const pkgDir = path.join(stage, 'package')

for (const rel of copies) {
  const from = path.join(ROOT, rel)
  if (!fs.existsSync(from)) throw new Error(`missing in repo: ${rel}`)
  fs.cpSync(from, path.join(pkgDir, rel), { recursive: true })
}

// A few real clips, with their transcript rows intact, so a fresh install has
// voices as well as art.
const allVoices = fs.readdirSync(path.join(ROOT, PACK, 'voices')).sort((a, b) =>
  a.localeCompare(b, undefined, { numeric: true }),
)
const sample = allVoices.slice(0, SAMPLE_VOICES)
fs.mkdirSync(path.join(pkgDir, PACK, 'voices'), { recursive: true })
for (const file of sample) {
  fs.copyFileSync(path.join(ROOT, PACK, 'voices', file), path.join(pkgDir, PACK, 'voices', file))
}

// Say so in the pack itself: the settings panel shows this description.
const packJson = JSON.parse(fs.readFileSync(path.join(pkgDir, PACK, 'pack.json'), 'utf8'))
packJson.description = `示例立绘包：18 张立绘 + ${sample.length} 条示例语音 + 台词对照表。完整语音包（${allVoices.length} 条）见 GitHub Releases 上的完整发行包。`
fs.writeFileSync(path.join(pkgDir, PACK, 'pack.json'), `${JSON.stringify(packJson, null, 2)}\n`, 'utf8')

// The published manifest: no dev scripts (they ship with the repo, not here).
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
delete pkg.scripts
pkg.files = ['lib', 'assets/ui', 'assets/packs', 'assets/pricing.json', 'cordis.patch.yml', 'docs', 'README.md', 'LICENSE']
fs.writeFileSync(path.join(pkgDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

// Invariants of the distribution: art complete, voices deliberately trimmed.
const count = (rel) => fs.readdirSync(path.join(pkgDir, rel)).length
const sprites = count(path.join(PACK, 'sprites'))
const voices = count(path.join(PACK, 'voices'))
if (sprites !== 18) throw new Error(`expected 18 sprites, got ${sprites}`)
if (voices !== SAMPLE_VOICES) throw new Error(`expected ${SAMPLE_VOICES} voices, got ${voices}`)
// Named, not counted: the blank plate preset is only reachable when its artwork
// ships, and a count would not have noticed it going missing.
const UI_REQUIRED = ['dialog.png', 'dialog.json', 'dialog-blank.png', 'dialog-blank.json', 'settings.png', 'click.wav']
const ui = fs.readdirSync(path.join(pkgDir, 'assets', 'ui'))
const uiMissing = UI_REQUIRED.filter((name) => !ui.includes(name))
if (uiMissing.length) throw new Error(`missing ui assets: ${uiMissing.join(', ')}`)

fs.mkdirSync(OUT_DIR, { recursive: true })
const out = execFileSync('npm', ['pack', '--pack-destination', OUT_DIR, '--loglevel=error'], {
  cwd: pkgDir,
  encoding: 'utf8',
  shell: process.platform === 'win32',
})
  .trim()
  .split('\n')
  .pop()

const tarball = path.join(OUT_DIR, out)
const stat = fs.statSync(tarball)
fs.rmSync(stage, { recursive: true, force: true })

console.log(`  sprites ${sprites} · voices ${voices}/${allVoices.length}（示例）· ui ${ui.join(',')}`)
console.log(`  ${out}  ${(stat.size / 1024 / 1024).toFixed(1)} MiB`)
console.log(`\n这是 npm 用的精简包；GitHub Release 用的是仓库根目录的 \`npm pack\` 全量包。`)
