/**
 * Voice ↔ motion binding, checked against the packs actually installed.
 *
 * `verify.mjs` proves the pairing rules with synthetic packs; this one proves the
 * rules hold on real artwork — an animated WebP whose size comes from a header,
 * a clip that finds its own frame, and a legacy pack that pairs nothing.
 *
 *   node scripts/binding-selftest.mjs
 *
 * Exit code 0 = every installed pack behaved (or there was nothing to check).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPackRegistry, pngSizeOfFile } from '../lib/packs.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const userRoot = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-gal', 'packs')
const bundled = path.join(ROOT, 'assets', 'packs')

const registry = createPackRegistry({ roots: [bundled, userRoot] })
const packs = registry.all()
console.log(`pack roots: ${bundled}${fs.existsSync(userRoot) ? ` + ${userRoot}` : ''}`)
console.log(
  `packs: ${packs.map((p) => `${p.id}(sprites=${p.sprites.length},voices=${p.voices.length})`).join(', ') || '(none)'}`,
)

let problems = 0
const note = (bad, text) => {
  console.log(`${bad ? '✗' : '✓'} ${text}`)
  if (bad) problems++
}

// ── 1. a canvas read from a real header ──────────────────────────────────────
const webpFile = (() => {
  for (const pack of packs) {
    const file = pack.sprites.find((f) => f.toLowerCase().endsWith('.webp'))
    if (file) return path.join(pack.spriteDir || pack.dir, file)
  }
  return null
})()
if (webpFile) {
  const size = pngSizeOfFile(webpFile)
  note(!size || !(size.w > 0 && size.h > 0), `WebP header: ${path.basename(webpFile)} -> ${JSON.stringify(size)}`)
  if (size) note(size.w === size.h, `and it is not a square by accident (${size.w}x${size.h})`)
} else {
  console.log('· no WebP artwork installed — header check skipped')
}

// ── 2. real clips find their own art ─────────────────────────────────────────
let paired = 0
let unpaired = 0
const seen = new Set()
for (const pack of packs) {
  if (!pack.spriteIndex || pack.spriteIndex.size === 0) continue
  for (let i = 0; i < 24 && pack.voices.length; i++) {
    const voice = registry.pickVoice(pack, '', { order: 'shuffle' })
    if (!voice || seen.has(`${pack.id}:${voice.clip}`)) continue
    seen.add(`${pack.id}:${voice.clip}`)
    const art = registry.pairedSprite(pack, voice.clip)
    if (art) paired++
    else unpaired++
  }
}
console.log(`· sampled ${seen.size} clips across packs: paired=${paired}, unpaired=${unpaired}`)

// ── 3. a pack that pairs must hand out art that really is there ──────────────
// Not every clip has to pair — a pack legitimately ships idle/system lines that
// belong to no frame — but every hit must be a file that exists and can be read,
// or the widget would draw an empty box for that line.
const pairing = packs.filter((p) => p.spriteIndex && p.spriteIndex.size > 0)
for (const pack of pairing) {
  const hits = pack.voices.filter((v) => pack.spriteIndex.has(v.replace(/\.[^.]+$/, '')))
  if (hits.length === 0) {
    note(false, `${pack.id}: no clip names its own art → random draw, unchanged`)
    continue
  }
  const broken = []
  for (const voice of hits) {
    const clip = voice.replace(/\.[^.]+$/, '')
    const art = registry.pairedSprite(pack, clip)
    const file = art && path.join(pack.spriteDir || pack.dir, art.file)
    if (!art || !fs.existsSync(file) || !art.size || !(art.size.w > 0 && art.size.h > 0)) broken.push(clip)
  }
  note(
    broken.length > 0,
    `${pack.id}: ${hits.length}/${pack.voices.length} clips name their own art，` +
      (broken.length ? `其中 ${broken.length} 张读不出来（${broken.slice(0, 3).join(', ')}）` : '全部可读'),
  )
}

// ── 4. the pairing never invents a match ─────────────────────────────────────
for (const pack of pairing) {
  const foreign = registry.pairedSprite(pack, 'definitely_not_a_file')
  note(foreign !== null, `${pack.id}: an unknown clip pairs nothing`)
}

console.log('')
if (problems) {
  console.log(`${problems} 处不符合预期`)
  process.exitCode = 1
} else {
  console.log('OK：同名配对与 WebP 尺寸在已装的真实资源包上都成立')
}
