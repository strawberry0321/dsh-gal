/**
 * dsh-gal — host half.
 *
 * Serves the widget's browser half, its art/audio assets, the DeepSeek balance
 * and spend feed, and the per-turn token/cost ledger that the dialogue box shows
 * once a turn finishes. Everything the client needs is exposed as plain JSON over
 * a small set of routes under `/dsh-gal`; the client script is injected
 * into the web app's index document with `webServer.tapIndex`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createPackRegistry } from './packs.js'
import { createUsageService } from './usage.js'
import { normalizePricing, costOf, tokensOf, DEFAULT_PRICING } from './pricing.js'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

/** Base path for every route this plugin owns. */
const ROUTE = '/dsh-gal'

// Config and ledger prefer the writable DSH home; the profile-scoped copies are
// legacy fallbacks so an older install keeps working.
const CONFIG_FILE_CANDIDATES = [
  path.join(DSH_HOME, '.dsh-gal.json'),
  path.join(DSH_HOME, 'profiles', 'desktop', '.dsh-gal.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dsh-gal.json'),
]
const USAGE_FILE_CANDIDATES = [
  path.join(DSH_HOME, '.dsh-gal-usage.json'),
  path.join(DSH_HOME, 'profiles', 'desktop', '.dsh-gal-usage.json'),
]

/** Where character packs live. The first root wins on an id collision. */
const USER_ROOT = path.join(DSH_HOME, 'dsh-gal')
const USER_PACK_ROOT = path.join(USER_ROOT, 'packs')
const PACKAGE_PACK_ROOT = path.join(PACKAGE_ROOT, 'assets', 'packs')

/**
 * Fixed UI art (dialogue plate, settings icon, click sound). A copy under the
 * user root overrides the shipped one, so the look can be changed without
 * touching the package — and without losing the change on the next update.
 */
const UI_NAME_CANDIDATES = {
  'dialog.png': [path.join(USER_ROOT, 'ui', 'dialog.png'), path.join(PACKAGE_ROOT, 'assets', 'ui', 'dialog.png')],
  'settings.png': [path.join(USER_ROOT, 'ui', 'settings.png'), path.join(PACKAGE_ROOT, 'assets', 'ui', 'settings.png')],
  'click.wav': [path.join(USER_ROOT, 'ui', 'click.wav'), path.join(PACKAGE_ROOT, 'assets', 'ui', 'click.wav')],
  'dialog.json': [path.join(USER_ROOT, 'ui', 'dialog.json'), path.join(PACKAGE_ROOT, 'assets', 'ui', 'dialog.json')],
}

/** Dropped into `packs/` the first time that folder is created. */
const USER_PACK_README = `# 立绘包 / 语音包放这里

一个包就是一个文件夹，**目录名就是包名**：

    mygal/
    ├── sprites/    立绘：png jpg webp gif avif bmp
    ├── voices/     语音：wav mp3 ogg oga m4a aac flac
    ├── script.csv  可选：语音 → 台词对照表
    └── pack.json   可选：显示名 / 默认立绘 / 手动裁切

放好后**刷新页面**，设定面板的「立绘包 / 语音包」下拉里就会多出它。
用户目录优先：同名包会整体覆盖插件自带的同名包（不是合并）。

换掉包里的同名文件（比如把立绘换成镜像版）也是**刷新页面**即可：素材 URL 带文件版本号，
不会读到浏览器里缓存的那张旧图。

完整体现在 docs/customize.md；对话框底图、设定图标、点击音效放同级目录的 ui/ 下。
`

/**
 * Create the user drop-folders.
 *
 * The plugin only ever *reads* from the user root, so a fresh install used to
 * leave no trace of where user packs belong — the folders now exist from the
 * first run, and `packs/` carries a short README the first time it is created.
 * Existing folders are never touched.
 */
function ensureUserDirs(log) {
  try {
    if (!fs.existsSync(USER_PACK_ROOT)) {
      fs.mkdirSync(USER_PACK_ROOT, { recursive: true })
      fs.writeFileSync(path.join(USER_PACK_ROOT, 'README.md'), USER_PACK_README, 'utf8')
    }
    fs.mkdirSync(path.join(USER_ROOT, 'ui'), { recursive: true })
  } catch (err) {
    log(`could not create ${USER_ROOT}: ${String((err && err.message) || err)}`)
  }
}

/**
 * Geometry of the dialogue plate. The shipped 1280x720 artwork is empty white
 * except for a small logo in the bottom-right corner (x 865..1242, y 606..682),
 * so the top is cropped away: the box becomes a short wide strip, and the
 * vertical budget that frees up goes into a wider plate — which is what keeps
 * the logo crisp instead of shrinking to a blur.
 *
 * `assets/ui/dialog.json` replaces this wholesale — it is re-read on every
 * request, so anyone swapping the artwork can describe their own plate without
 * touching code *and* without restarting DSH.
 */
const DEFAULT_DIALOG_GEOMETRY = {
  image: { width: 1280, height: 720 },
  crop: { x: 0, y: 0.42, w: 1, h: 0.58 },
  inset: { left: 0.05, right: 0.05, top: 0.07, bottom: 0.04 },
  // Space reserved along the bottom for 余额/花费, and how much of the width it
  // may use before it would run into the logo.
  footer: { heightRatio: 0.42, maxWidthRatio: 0.66 },
  radius: 10,
  // How much of the inner box the figure sheets may use before reaching the
  // logo: its top edge sits 72.8% down the artwork. A plate without a logo
  // (see assets/ui/dialog-blank.json) raises this to 1.
  logoShare: 0.72,
}

/** Plates the settings panel can install from the package itself. */
const BUNDLED_PLATES = {
  blank: {
    png: path.join(PACKAGE_ROOT, 'assets', 'ui', 'dialog-blank.png'),
    json: path.join(PACKAGE_ROOT, 'assets', 'ui', 'dialog-blank.json'),
  },
}

/** A replacement plate is a picture, not a data dump: 8 MB is generous. */
const MAX_PLATE_BYTES = 8 * 1024 * 1024

/** Scale levels are 1..10; the old percentage form was 0.2..2.0. */
const SCALE_LEVEL_MIN = 1
const SCALE_LEVEL_MAX = 10
const CONFIG_VERSION = 3

/**
 * How much of the base width one dialogue-box level is worth.
 *
 * v1.3 re-based this unit: the box had been driven by the same /10 factor as the
 * art, which made the default far too large. At 0.04 per level, level 5 — the
 * default — reproduces what the old build produced at level 2, so the
 * comfortable size now sits in the middle of the range. `migrateConfig()`
 * rescales stored values by the matching x2.5 factor.
 */
const DIALOG_LEVEL_UNIT = 0.04
const DIALOG_LEVEL_REBASE = 1 / 10 / DIALOG_LEVEL_UNIT // = 2.5, old level -> new level

const PACKAGE_PRICING_FILE = path.join(PACKAGE_ROOT, 'assets', 'pricing.json')
const USER_PRICING_FILE = path.join(USER_ROOT, 'pricing.json')

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.json': 'application/json; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
}

/**
 * Default widget state.
 *
 * `scale` and `dialogScale` are **levels 1..10** (default 5), not percentages:
 * a percentage slider let the art be pushed past the point where the settings
 * panel was still reachable, which left no way back. A bounded level cannot.
 */
const DEFAULT_CONFIG = {
  version: CONFIG_VERSION,
  spritePack: '',
  voicePack: '',
  spriteFile: '', // last shown art; empty = the pack's defaultSprite
  scale: 5, // 立绘缩放：1-10 档
  volume: 0.5, // 音量
  lang: 'ja', // 语音语言: 'ja' | 'zh' (日语 / 中文)
  autoPlay: false, // 自动播放语音
  autoPlayMinutes: 1, // 自动播放间隔（分钟）
  dialogScale: 5, // 对话框缩放：1-10 档（档位 5 = 基准宽度的 20%）
  dialogEnabled: true, // 对话框开关
  dialogSide: 'above', // 对话框位置: 'above' | 'below'
  dialogOpacity: 0, // 对话框不透明度：百分比，0 = 原图完全不透明，越大越透明
  dialogHoldSeconds: 3, // 台词显示完后，对话框停留几秒再自动消失
  spriteRevertOnHide: true, // 对话框消失后，立绘回到立绘包的默认立绘
  spriteVisible: true,
  pos: { hx: 'right', hd: 24, vy: 'bottom', vd: 24 },
  extraPackRoots: [],
  pricingFile: '', // optional: absolute path to a custom pricing document
}

function clamp(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

/** Read the first readable candidate, or null. */
function readFirst(candidates) {
  for (const file of candidates) {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      // try the next candidate
    }
  }
  return null
}

/** Read the first readable binary candidate, or null. */
function readFirstBytes(candidates) {
  for (const file of candidates) {
    try {
      return fs.readFileSync(file)
    } catch {
      // try the next candidate
    }
  }
  return null
}

function writeFirst(candidates, text) {
  for (const file of candidates) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, text, 'utf8')
      return true
    } catch {
      // try the next candidate
    }
  }
  return false
}

function normalizePos(raw, base) {
  const out = { ...base }
  if (!raw || typeof raw !== 'object') return out
  if (raw.hx === 'left' || raw.hx === 'right') out.hx = raw.hx
  if (raw.vy === 'top' || raw.vy === 'bottom') out.vy = raw.vy
  out.hd = clamp(raw.hd, 0, 100000, base.hd)
  out.vd = clamp(raw.vd, 0, 100000, base.vd)
  return out
}

/** Round an incoming value to a whole 1..10 scale level. */
function scaleLevel(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.round(clamp(n, SCALE_LEVEL_MIN, SCALE_LEVEL_MAX, fallback))
}

/**
 * Repair a `dialogOpacity` written by the build that divided the slider by 100.
 *
 * The control is a 0..95 **percentage**, but that build stored a 0..0.95
 * fraction, so a chosen "44%" landed on disk as `0.44` and every reader treated
 * it as 0.44% — the box looked permanently opaque and the slider snapped to 0.
 * The UI can only ever produce whole percentages, so a non-integer between 0
 * and 1 is unambiguously a leftover fraction. Idempotent: after repair the value
 * is whole, so re-running changes nothing.
 */
function repairDialogOpacity(value, fallback) {
  if (!Number.isFinite(Number(value))) return fallback
  const n = Number(value)
  if (n > 0 && n < 1 && !Number.isInteger(n)) return Math.round(clamp(n * 100, 0, 95, fallback))
  return clamp(n, 0, 95, fallback)
}

/**
 * Bring an older config document forward.
 *
 * v1 -> v2  `scale` / `dialogScale` were 0.2..2.0 fractions, now 1..10 levels.
 * v2 -> v3  the dialogue-box level unit was re-based by x2.5, so a stored
 *           `dialogScale` has to be rescaled to keep the same on-screen size.
 */
function migrateConfig(raw) {
  if (!raw || typeof raw !== 'object') return raw
  const out = { ...raw }
  const parsed = Number(out.version)
  let version = Number.isFinite(parsed) ? parsed : 0

  if (version < 2) {
    const fractionToLevel = (value, fallback) => {
      const n = Number(value)
      if (!Number.isFinite(n)) return fallback
      // The old range topped out at 2.0 (=200%), which is exactly the runaway
      // zoom the level scale exists to prevent: anything above 1.0 clamps to 10.
      return n <= 1.05 ? scaleLevel(n * 10, fallback) : SCALE_LEVEL_MAX
    }
    out.scale = fractionToLevel(out.scale, DEFAULT_CONFIG.scale)
    out.dialogScale = fractionToLevel(out.dialogScale, 5)
    version = 2
  }

  if (version < 3) {
    const previous = Number(out.dialogScale)
    out.dialogScale = Number.isFinite(previous)
      ? scaleLevel(previous * DIALOG_LEVEL_REBASE, DEFAULT_CONFIG.dialogScale)
      : DEFAULT_CONFIG.dialogScale
    version = 3
  }

  out.version = version
  return out
}

/** Coerce an arbitrary config patch into a complete, valid config document. */
function coerceConfig(raw, base = DEFAULT_CONFIG) {
  const out = { ...base, version: CONFIG_VERSION, pos: { ...base.pos } }
  if (!raw || typeof raw !== 'object') return out
  if (typeof raw.spritePack === 'string') out.spritePack = raw.spritePack
  if (typeof raw.voicePack === 'string') out.voicePack = raw.voicePack
  if (typeof raw.spriteFile === 'string') out.spriteFile = raw.spriteFile
  if (raw.scale !== undefined) out.scale = scaleLevel(raw.scale, base.scale)
  if (raw.volume !== undefined) out.volume = clamp(raw.volume, 0, 1, base.volume)
  if (raw.lang !== undefined) out.lang = raw.lang === 'zh' ? 'zh' : 'ja'
  if (raw.autoPlay !== undefined) out.autoPlay = raw.autoPlay === true
  if (raw.autoPlayMinutes !== undefined) out.autoPlayMinutes = clamp(raw.autoPlayMinutes, 0.5, 240, base.autoPlayMinutes)
  if (raw.dialogScale !== undefined) out.dialogScale = scaleLevel(raw.dialogScale, base.dialogScale)
  if (raw.dialogEnabled !== undefined) out.dialogEnabled = raw.dialogEnabled !== false
  if (raw.dialogSide !== undefined) out.dialogSide = raw.dialogSide === 'below' ? 'below' : 'above'
  if (raw.dialogOpacity !== undefined) out.dialogOpacity = repairDialogOpacity(raw.dialogOpacity, base.dialogOpacity)
  if (raw.dialogHoldSeconds !== undefined) {
    out.dialogHoldSeconds = clamp(raw.dialogHoldSeconds, 0.5, 120, base.dialogHoldSeconds)
  }
  if (raw.spriteVisible !== undefined) out.spriteVisible = raw.spriteVisible !== false
  if (raw.spriteRevertOnHide !== undefined) out.spriteRevertOnHide = raw.spriteRevertOnHide !== false
  if (raw.pos !== undefined) out.pos = normalizePos(raw.pos, base.pos)
  if (Array.isArray(raw.extraPackRoots)) {
    out.extraPackRoots = raw.extraPackRoots.filter((p) => typeof p === 'string' && p.trim() !== '').slice(0, 16)
  }
  if (typeof raw.pricingFile === 'string') out.pricingFile = raw.pricingFile
  return out
}

function readBody(req, limit = 262144) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

/** Read a request body as bytes (uploaded artwork), or reject past `limit`. */
function readBodyBytes(req, limit = MAX_PLATE_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`图片太大（上限 ${Math.round(limit / 1024 / 1024)} MB）`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Identify an image by its magic bytes and read its pixel size.
 *
 * A replacement plate has to report its real size: the geometry written next to
 * it is what gives the box its shape, and a declared size that disagrees with
 * the file is drawn stretched. Four formats a plate realistically arrives in are
 * understood, all by header — no decoder, no dependency.
 */
function imageSize(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32) return null

  // PNG: signature, then IHDR as two big-endian uint32 at 16 and 20.
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    if (bytes.toString('latin1', 12, 16) !== 'IHDR') return null
    return { mime: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }

  // GIF87a / GIF89a: two little-endian uint16 right after the version tag.
  if (bytes.toString('latin1', 0, 3) === 'GIF') {
    return { mime: 'image/gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
  }

  // WebP: a RIFF container. VP8X holds the canvas, VP8/VP8L the frame.
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    const fourcc = bytes.toString('latin1', 12, 16)
    if (fourcc === 'VP8X') {
      return { mime: 'image/webp', width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) }
    }
    if (fourcc === 'VP8 ') {
      return { mime: 'image/webp', width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
    }
    if (fourcc === 'VP8L') {
      const bits = bytes.readUInt32LE(21)
      return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    return null
  }

  // JPEG: walk the marker chain to the SOFn segment carrying the size.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) {
        at++
        continue
      }
      const marker = bytes[at + 1]
      // Standalone markers carry no length field.
      if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += 2
        continue
      }
      const length = bytes.readUInt16BE(at + 2)
      if (length < 2) return null
      const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isStartOfFrame) {
        return { mime: 'image/jpeg', width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) }
      }
      at += 2 + length
    }
    return null
  }
  return null
}

/**
 * Coerce a `dialog.json` document into a complete geometry, or fall back.
 *
 * Split out of `apply()` so the parse is reachable from the verification script:
 * the file is re-read whenever it changes, which is what lets the settings panel
 * replace the plate without a DSH restart.
 */
function parseDialogGeometry(raw, warn = () => {}) {
  if (!raw) return DEFAULT_DIALOG_GEOMETRY
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return DEFAULT_DIALOG_GEOMETRY
    const base = DEFAULT_DIALOG_GEOMETRY
    const nums = (source, fallback) => {
      const out = { ...fallback }
      if (source && typeof source === 'object') {
        for (const key of Object.keys(fallback)) {
          if (Number.isFinite(Number(source[key]))) out[key] = Number(source[key])
        }
      }
      return out
    }
    const crop = nums(parsed.crop, base.crop)
    crop.w = clamp(crop.w, 0.05, 1 - clamp(crop.x, 0, 1), base.crop.w)
    crop.h = clamp(crop.h, 0.05, 1 - clamp(crop.y, 0, 1), base.crop.h)
    crop.x = clamp(crop.x, 0, 1)
    crop.y = clamp(crop.y, 0, 1)
    const image = nums(parsed.image, base.image)
    return {
      image: { width: Math.max(1, image.width), height: Math.max(1, image.height) },
      crop,
      inset: nums(parsed.inset, base.inset),
      footer: nums(parsed.footer, base.footer),
      radius: Number.isFinite(Number(parsed.radius)) ? Math.max(0, Number(parsed.radius)) : base.radius,
      // Below 0.2 the figures would have no room at all; above 1 they would spill
      // out of the plate.
      logoShare: clamp(parsed.logoShare, 0.2, 1, base.logoShare),
    }
  } catch (err) {
    warn(`dialog.json parse failed, using defaults: ${String(err && err.message)}`)
    return DEFAULT_DIALOG_GEOMETRY
  }
}

function sendBytes(res, bytes, mime, { cacheSeconds = 604800 } = {}) {
  res.writeHead(200, {
    'Content-Type': mime || 'application/octet-stream',
    'Content-Length': String(bytes.length),
    'Cache-Control': cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : 'no-store',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(bytes)
}

function sendNotFound(res, message) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(message)
}

function queryOf(req) {
  try {
    return new URL(req.url || '/', 'http://127.0.0.1').searchParams
  } catch {
    return new URLSearchParams()
  }
}

const name = 'dsh-gal'
const inject = ['webServer', 'credentials']

function apply(ctx) {
  const log = (message) => {
    try {
      console.error(`[dsh-gal] ${message}`)
    } catch {
      // logging must never break the plugin
    }
  }

  // ── dialogue plate geometry ───────────────────────────────────────────────
  ensureUserDirs(log)

  const DIALOG_JSON_FILES = UI_NAME_CANDIDATES['dialog.json']
  const DIALOG_PNG_FILES = UI_NAME_CANDIDATES['dialog.png']
  const USER_PLATE_PNG = DIALOG_PNG_FILES[0]
  const USER_PLATE_JSON = DIALOG_JSON_FILES[0]

  /**
   * The plate geometry, re-read whenever the file behind it changes.
   *
   * It used to be resolved once, in `apply()` — which meant swapping the artwork
   * silently kept the old shape until DSH was restarted. Since the settings
   * panel now replaces the plate on a button press, the lookup is keyed on the
   * winning file's mtime: a replaced plate takes effect on the spot.
   */
  let dialogCacheKey = null
  let dialogCacheValue = DEFAULT_DIALOG_GEOMETRY

  function dialogGeometry() {
    let key = 'default'
    for (const file of DIALOG_JSON_FILES) {
      try {
        const stat = fs.statSync(file)
        key = `${file}:${stat.mtimeMs}:${stat.size}`
        break
      } catch {
        // not this one
      }
    }
    if (key === dialogCacheKey) return dialogCacheValue
    let raw = null
    for (const file of DIALOG_JSON_FILES) {
      try {
        raw = fs.readFileSync(file, 'utf8')
        break
      } catch {
        // not this one
      }
    }
    dialogCacheValue = parseDialogGeometry(raw, log)
    dialogCacheKey = key
    return dialogCacheValue
  }

  /**
   * Which plate is in force: the shipped artwork, the bundled blank one, or an
   * image the user installed. The blank plate is recognised by comparing it with
   * the copy in the package, so the panel can name it honestly.
   */
  function dialogSource() {
    let user = null
    try {
      user = fs.readFileSync(USER_PLATE_PNG)
    } catch {
      return 'bundled'
    }
    try {
      const blank = fs.readFileSync(BUNDLED_PLATES.blank.png)
      if (blank.length === user.length && blank.equals(user)) return 'blank'
    } catch {
      // no bundled blank to compare against
    }
    return 'user'
  }

  /** Install a plate: the image and the geometry describing it land together. */
  function writeUserPlate(bytes, geometry) {
    fs.mkdirSync(path.dirname(USER_PLATE_PNG), { recursive: true })
    fs.writeFileSync(USER_PLATE_PNG, bytes)
    fs.writeFileSync(USER_PLATE_JSON, `${JSON.stringify(geometry, null, 2)}\n`, 'utf8')
    dialogCacheKey = null
  }

  /** Drop the user's plate so the bundled artwork comes back. */
  function removeUserPlate() {
    let removed = false
    for (const file of [USER_PLATE_PNG, USER_PLATE_JSON]) {
      try {
        fs.rmSync(file, { force: true })
        removed = true
      } catch {
        // nothing to remove
      }
    }
    dialogCacheKey = null
    return removed
  }

  // ── config ────────────────────────────────────────────────────────────────
  let configNeedsRewrite = false
  let config = (() => {
    const raw = readFirst(CONFIG_FILE_CANDIDATES)
    if (!raw) return { ...DEFAULT_CONFIG }
    try {
      const parsed = JSON.parse(raw)
      const migrated = migrateConfig(parsed)
      // Version 0 means "no version key at all": a v1-era document.
      if (Number(migrated.version) !== Number(parsed.version)) configNeedsRewrite = true
      return coerceConfig(migrated)
    } catch (err) {
      log(`config parse failed, using defaults: ${String(err && err.message)}`)
      return { ...DEFAULT_CONFIG }
    }
  })()

  function saveConfig() {
    const ok = writeFirst(CONFIG_FILE_CANDIDATES, JSON.stringify(config, null, 2))
    if (!ok) log('could not persist config: no writable candidate')
    return ok
  }

  // Write a migrated document back once, so the file stops carrying pre-migration
  // values that a downgrade would misinterpret.
  if (configNeedsRewrite) saveConfig()

  function updateConfig(patch) {
    const before = config
    config = coerceConfig({ ...config, ...patch }, config)
    if (patch && patch.pos) config.pos = normalizePos(patch.pos, before.pos)
    if (config.spritePack !== before.spritePack || config.voicePack !== before.voicePack) registry.invalidate()
    saveConfig()
    return config
  }

  // ── pricing ───────────────────────────────────────────────────────────────
  const pricing = (() => {
    // A user copy wins, then an explicit `pricingFile`, then the shipped default.
    const candidates = [USER_PRICING_FILE, PACKAGE_PRICING_FILE]
    if (typeof config.pricingFile === 'string' && config.pricingFile) candidates.unshift(config.pricingFile)
    const raw = readFirst(candidates)
    if (!raw) return normalizePricing(DEFAULT_PRICING)
    try {
      return normalizePricing(JSON.parse(raw))
    } catch (err) {
      log(`pricing parse failed, using defaults: ${String(err && err.message)}`)
      return normalizePricing(DEFAULT_PRICING)
    }
  })()

  // ── packs + usage ─────────────────────────────────────────────────────────
  const registry = createPackRegistry({
    roots: [USER_PACK_ROOT, PACKAGE_PACK_ROOT, ...config.extraPackRoots],
    log,
  })
  const usage = createUsageService({
    credentials: ctx.credentials,
    usageFiles: USAGE_FILE_CANDIDATES,
    pricing,
    log,
  })

  /** Fill in pack ids left empty so a fresh install has art and voices. */
  function ensurePackSelection() {
    let dirty = false
    if (!registry.get(config.spritePack)) {
      const pack = registry.firstWithSprites()
      if (pack) {
        config.spritePack = pack.id
        dirty = true
      }
    }
    if (!registry.get(config.voicePack)) {
      const pack = registry.firstWithVoices()
      if (pack) {
        config.voicePack = pack.id
        dirty = true
      }
    }
    if (dirty) saveConfig()
  }

  function packSummary(pack) {
    return {
      id: pack.id,
      name: pack.name,
      description: pack.description,
      source: pack.source,
      spriteCount: pack.sprites.length,
      voiceCount: pack.voices.length,
      scriptCount: pack.scriptCount,
      defaultSprite: pack.defaultSprite,
      // Which rule picked it: 'config' (pack.json) or 'auto' (first in natural
      // order), or 'none' for a voice-only pack.
      defaultSource: pack.defaultSource,
      // Cache token for the default artwork, so reverting to it after the pack
      // was replaced does not ask for a URL the browser has already got.
      defaultSpriteVersion: pack.defaultSpriteVersion,
      crop: pack.crop,
      spriteSize: pack.spriteSize,
      aspect:
        pack.spriteSize && pack.crop.h > 0
          ? (pack.crop.w * pack.spriteSize.w) / (pack.crop.h * pack.spriteSize.h)
          : 1,
    }
  }

  function listPacks() {
    const packs = registry.all()
    return {
      spritePacks: packs.filter((p) => p.sprites.length > 0).map(packSummary),
      voicePacks: packs.filter((p) => p.voices.length > 0).map(packSummary),
      all: packs.map(packSummary),
    }
  }

  // ── per-turn token / cost ledger ──────────────────────────────────────────
  // Aggregated per (session, turn) so a main session and any sub-agents running
  // in parallel cannot cross-contaminate each other's totals.
  const turnAggs = new Map()
  let lastTurn = null
  let lastTurnSeq = 0

  function finalizeTurn(sessionId) {
    const agg = turnAggs.get(sessionId)
    if (agg && (agg.tokens > 0 || agg.cost > 0)) {
      lastTurn = { turn: agg.turn, tokens: agg.tokens, amount: agg.cost, ts: Date.now() }
      lastTurnSeq += 1
    }
    turnAggs.delete(sessionId)
  }

  function handleSessionEvent(sessionId, event) {
    try {
      const type = event && event.type
      const data = event && event.data
      if (!data || typeof data !== 'object') return
      if (type === 'turn/end') {
        finalizeTurn(sessionId)
        return
      }
      if (type !== 'assistant/message') return
      const usageSample = data.usage
      if (!usageSample || typeof usageSample !== 'object') return
      const turn = Number(data.turn)
      if (!Number.isFinite(turn)) return
      let agg = turnAggs.get(sessionId)
      if (!agg || agg.turn !== turn) {
        if (agg) finalizeTurn(sessionId)
        agg = { turn, cost: 0, tokens: 0 }
        turnAggs.set(sessionId, agg)
      }
      agg.tokens += tokensOf(usageSample)
      const model = data.message && data.message.source ? data.message.source.model : ''
      agg.cost += costOf(pricing, model, usageSample)
    } catch (err) {
      log(`session event failed: ${String(err && err.message)}`)
    }
  }

  // ── routes ────────────────────────────────────────────────────────────────
  const disposers = []

  function register(routePath, handler) {
    disposers.push(ctx.webServer.register({ kind: 'exact', path: routePath, handler }))
  }

  disposers.push(
    ctx.on('session/event', (session, event) => {
      handleSessionEvent(session && session.id ? session.id : 'default', event)
    }),
  )
  disposers.push(
    ctx.on('session/disposed', (session) => {
      if (session && session.id) turnAggs.delete(session.id)
    }),
  )

  register(`${ROUTE}/client.js`, (req, res) => {
    try {
      const file = path.join(PACKAGE_ROOT, 'lib', 'client.js')
      const bytes = fs.readFileSync(file)
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': String(bytes.length),
      })
      res.end(bytes)
    } catch (err) {
      sendNotFound(res, `client script unavailable: ${String((err && err.message) || err)}`)
    }
  })

  register(`${ROUTE}/asset/ui/dialog.png`, (req, res) => {
    const bytes = readFirstBytes(DIALOG_PNG_FILES)
    if (!bytes) return sendNotFound(res, 'dialog image unavailable')
    // The plate is replaceable at runtime, so it is never cached — a stale copy
    // would survive the very button press that replaced it. The bytes are
    // sniffed because an uploaded plate may be a JPEG or a WebP.
    const info = imageSize(bytes)
    sendBytes(res, bytes, info ? info.mime : 'image/png', { cacheSeconds: 0 })
  })

  register(`${ROUTE}/asset/ui/settings.png`, (req, res) => {
    const bytes = readFirstBytes(UI_NAME_CANDIDATES['settings.png'])
    if (!bytes) return sendNotFound(res, 'settings icon unavailable')
    // Also replaceable in the user directory, so also never cached: a plain
    // refresh has to be enough to pick a new icon up.
    sendBytes(res, bytes, 'image/png', { cacheSeconds: 0 })
  })

  register(`${ROUTE}/asset/ui/click.wav`, (req, res) => {
    const bytes = readFirstBytes(UI_NAME_CANDIDATES['click.wav'])
    if (!bytes) return sendNotFound(res, 'click sound unavailable')
    sendBytes(res, bytes, 'audio/wav', { cacheSeconds: 0 })
  })

  register(`${ROUTE}/asset/ui/dialog.json`, (req, res) => {
    sendJson(res, { ok: true, ...dialogGeometry() })
  })

  /**
   * Replace / restore the dialogue plate.
   *
   *   GET                      report the geometry in force
   *   PUT   (raw image body)   install that image as the plate
   *   PUT   ?preset=blank      install the bundled plain plate
   *   PUT   ?preset=default    restore the bundled artwork
   *   DELETE                   restore the bundled artwork
   *
   * Every install writes `ui/dialog.png` **and** `ui/dialog.json` together: the
   * geometry supplies the box's shape and the insets the text is laid out in, so
   * an image without matching geometry is drawn stretched. Layout parameters the
   * user already has (insets, footer, radius, logo share) are carried over — only
   * the size and crop change with the picture.
   */
  register(`${ROUTE}/api/dialog-image`, async (req, res) => {
    try {
      const method = (req.method || 'GET').toUpperCase()
      const preset = (queryOf(req).get('preset') || '').toLowerCase()
      const reply = (source) => sendJson(res, { ok: true, dialog: dialogGeometry(), source, plateSource: dialogSource() })

      if (method === 'GET' || method === 'HEAD') return reply(dialogSource())
      if (method === 'DELETE' || preset === 'default') {
        removeUserPlate()
        return reply('bundled')
      }
      if (preset === 'blank') {
        let bytes = null
        try {
          bytes = fs.readFileSync(BUNDLED_PLATES.blank.png)
        } catch {
          bytes = null
        }
        let geometry = null
        try {
          geometry = JSON.parse(fs.readFileSync(BUNDLED_PLATES.blank.json, 'utf8'))
        } catch {
          geometry = null
        }
        if (!bytes || !geometry) return sendJson(res, { ok: false, error: '插件自带的空白底图缺失' }, 500)
        writeUserPlate(bytes, geometry)
        return reply('blank')
      }

      const bytes = await readBodyBytes(req)
      const info = imageSize(bytes)
      if (!info) return sendJson(res, { ok: false, error: '只认 PNG / JPEG / WebP / GIF 图片' }, 400)
      const current = dialogGeometry()
      writeUserPlate(bytes, {
        image: { width: info.width, height: info.height },
        // A replacement plate is taken as-is: the whole picture is the box.
        crop: { x: 0, y: 0, w: 1, h: 1 },
        inset: { ...current.inset },
        footer: { ...current.footer },
        radius: current.radius,
        logoShare: current.logoShare,
      })
      return reply('user')
    } catch (err) {
      sendJson(res, { ok: false, error: String((err && err.message) || err) }, 400)
    }
  })

  register(`${ROUTE}/asset/sprite`, (req, res) => {
    try {
      const params = queryOf(req)
      const found = registry.resolveAsset(params.get('pack') || '', 'sprite', params.get('file') || '')
      if (!found) return sendNotFound(res, 'sprite not found')
      const mime = MIME[path.extname(found.abs).toLowerCase()] || 'application/octet-stream'
      // Only a versioned request may be cached (see `versionOf`): a name-only URL
      // would pin the artwork for a week, and replacing a pack keeps every name.
      sendBytes(res, fs.readFileSync(found.abs), mime, { cacheSeconds: params.get('v') ? 604800 : 0 })
    } catch (err) {
      sendNotFound(res, `sprite failed: ${String((err && err.message) || err)}`)
    }
  })

  register(`${ROUTE}/asset/voice`, (req, res) => {
    try {
      const params = queryOf(req)
      const found = registry.resolveAsset(params.get('pack') || '', 'voice', params.get('file') || '')
      if (!found) return sendNotFound(res, 'voice not found')
      const mime = MIME[path.extname(found.abs).toLowerCase()] || 'application/octet-stream'
      sendBytes(res, fs.readFileSync(found.abs), mime, { cacheSeconds: params.get('v') ? 604800 : 0 })
    } catch (err) {
      sendNotFound(res, `voice failed: ${String((err && err.message) || err)}`)
    }
  })

  register(`${ROUTE}/api/packs`, (req, res) => {
    try {
      ensurePackSelection()
      sendJson(res, { ok: true, ...listPacks(), config })
    } catch (err) {
      sendJson(res, { ok: false, error: String((err && err.message) || err) }, 500)
    }
  })

  register(`${ROUTE}/api/config`, async (req, res) => {
    try {
      if (req.method === 'PUT' || req.method === 'POST' || req.method === 'PATCH') {
        const body = await readBody(req)
        const patch = body ? JSON.parse(body) : {}
        const next = updateConfig(patch)
        sendJson(res, { ok: true, config: next })
        return
      }
      sendJson(res, { ok: true, config })
    } catch (err) {
      sendJson(res, { ok: false, error: String((err && err.message) || err) }, 400)
    }
  })

  register(`${ROUTE}/api/state`, async (req, res) => {
    try {
      const [balance, today] = await Promise.all([usage.getBalance(), usage.getToday()])
      sendJson(res, { ok: true, balance, today, ledger: usage.ledgerSnapshot() })
    } catch (err) {
      sendJson(res, { ok: false, error: String((err && err.message) || err) }, 500)
    }
  })

  register(`${ROUTE}/api/turn`, (req, res) => {
    const payload = lastTurn
      ? { ok: true, seq: lastTurnSeq, turn: lastTurn.turn, tokens: lastTurn.tokens, amount: lastTurn.amount, ts: lastTurn.ts }
      : { ok: true, seq: 0, turn: null, tokens: null, amount: null, ts: null }
    sendJson(res, payload)
  })

  register(`${ROUTE}/api/bootstrap`, async (req, res) => {
    try {
      ensurePackSelection()
      const [balance, today] = await Promise.all([usage.getBalance(), usage.getToday()])
      sendJson(res, {
        ok: true,
        config,
        packs: listPacks(),
        dialog: dialogGeometry(),
        dialogSource: dialogSource(),
        balance,
        today,
        turn: lastTurn ? { seq: lastTurnSeq, ...lastTurn } : { seq: 0 },
        pricing: { updatedAt: pricing.updatedAt, currency: pricing.currency, unit: pricing.unit },
      })
    } catch (err) {
      sendJson(res, { ok: false, error: String((err && err.message) || err) }, 500)
    }
  })

  /**
   * One call = one interaction: a random line (with transcript) plus a random
   * piece of art that is not the one already on screen.
   */
  register(`${ROUTE}/api/next`, (req, res) => {
    try {
      ensurePackSelection()
      const params = queryOf(req)
      const spritePack = registry.resolve(params.get('spritePack') || config.spritePack, 'sprites')
      const voicePack = registry.resolve(params.get('voicePack') || config.voicePack, 'voices')
      const sprite = registry.pickSprite(spritePack, params.get('currentSprite') || '')
      const voice = registry.pickVoice(voicePack, params.get('currentClip') || '')
      const spriteUrl = sprite
        ? `${ROUTE}/asset/sprite?pack=${encodeURIComponent(spritePack.id)}&file=${encodeURIComponent(sprite.file)}&v=${encodeURIComponent(sprite.version)}`
        : null
      const voiceUrl = voice
        ? `${ROUTE}/asset/voice?pack=${encodeURIComponent(voicePack.id)}&file=${encodeURIComponent(voice.file)}&v=${encodeURIComponent(voice.version)}`
        : null
      sendJson(res, {
        ok: true,
        spritePack: spritePack ? spritePack.id : null,
        voicePack: voicePack ? voicePack.id : null,
        sprite: sprite ? { file: sprite.file, url: spriteUrl, size: sprite.size, crop: sprite.crop } : null,
        voice: voice ? { clip: voice.clip, file: voice.file, url: voiceUrl, ja: voice.ja, zh: voice.zh } : null,
      })
    } catch (err) {
      sendJson(res, { ok: false, error: String((err && err.message) || err) }, 500)
    }
  })

  disposers.push(
    ctx.webServer.tapIndex((html) => {
      if (html.indexOf(`${ROUTE}/client.js`) !== -1) return html
      const tag = `<script defer src="${ROUTE}/client.js"></script>`
      if (html.indexOf('</body>') !== -1) return html.replace('</body>', `${tag}</body>`)
      return html + tag
    }),
  )

  log(`ready — ${registry.all().length} pack(s), route ${ROUTE}, config ${CONFIG_FILE_CANDIDATES[0]}`)

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // disposal must not throw during teardown
      }
    }
  })
}

export {
  name,
  inject,
  apply,
  ROUTE,
  DEFAULT_CONFIG,
  DEFAULT_DIALOG_GEOMETRY,
  parseDialogGeometry,
  imageSize,
  SCALE_LEVEL_MIN,
  SCALE_LEVEL_MAX,
  DIALOG_LEVEL_UNIT,
}
