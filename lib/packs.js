/**
 * Character-pack discovery.
 *
 * A *pack root* is a directory whose immediate sub-directories are packs:

 *   <root>/neri/sprites/*.png    立绘 (character art)
 *   <root>/neri/voices/*.wav     语音 (voice lines)
 *   <root>/neri/script.csv       clip -> 台词 (optional transcript)
 *   <root>/neri/pack.json        display name / default sprite / crop (optional)
 *
 * Two roots are always searched: a user root under `$DSH_HOME` (survives plugin
 * updates and is where new packs belong) and the one shipped inside the package.
 * Extra roots can be appended from the widget config.
 *
 * 立绘包 and 语音包 are listed independently, so a pack may contribute only art,
 * only voices, or both.
 */
import fs from 'node:fs'
import path from 'node:path'
import { parseScriptIndex, clipIdOf } from './csv.js'
import { pngVisibleCrop } from './png-alpha.js'

export const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif|bmp)$/i
export const AUDIO_EXT = /\.(wav|mp3|ogg|oga|m4a|aac|flac)$/i

/** Read only the IHDR so we can learn an image's intrinsic size cheaply. */
export function pngSize(buf) {
  if (!buf || buf.length < 24) return null
  if (buf.readUInt32BE(0) !== 0x89504e47) return null
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

/**
 * Same as `pngSize`, but reads 24 bytes instead of the whole file. `/api/next`
 * runs on every click, and a sprite is ~800KB — slurping it just to learn its
 * dimensions would be pure waste.
 */
export function pngSizeOfFile(abs) {
  let fd = null
  try {
    fd = fs.openSync(abs, 'r')
    const header = Buffer.alloc(24)
    const read = fs.readSync(fd, header, 0, 24, 0)
    if (read < 24) return null
    return pngSize(header)
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // nothing useful to do while closing
      }
    }
  }
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function safeStat(target) {
  try {
    return fs.statSync(target)
  } catch {
    return null
  }
}

/** Clamp an arbitrary crop descriptor into 0..1 with a usable minimum. */
function normalizeCrop(raw, fallback = { x: 0, y: 0, w: 1, h: 1 }) {
  if (!raw || typeof raw !== 'object') return { ...fallback }
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
  const x = Math.min(Math.max(num(raw.x, fallback.x), 0), 1)
  const y = Math.min(Math.max(num(raw.y, fallback.y), 0), 1)
  const w = Math.min(Math.max(num(raw.w, fallback.w), 0.02), 1 - x)
  const h = Math.min(Math.max(num(raw.h, fallback.h), 0.02), 1 - y)
  return { x, y, w, h }
}

/**
 * Natural ordering, so `2.png` precedes `10.png`.
 *
 * A plain lexicographic sort puts `10` before `2`, which makes the automatic
 * default look like it was chosen at random on any pack with more than nine
 * numbered files.
 */
function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

/**
 * Decide which sprite is the pack's default:
 *
 *   1. `defaultSprite` in `pack.json`
 *   2. otherwise the first sprite in natural order — a pack always has *a*
 *      default, so "revert to the default pose when the box hides" always has
 *      somewhere to land, even for a folder of art with no metadata at all
 *
 * `source` says which rule won, and is surfaced in the settings panel so the
 * choice is never a mystery.
 */
function resolveDefaultSprite(sprites, metaDefault) {
  if (sprites.length === 0) return { file: null, source: 'none' }
  if (typeof metaDefault === 'string' && sprites.includes(metaDefault)) {
    return { file: metaDefault, source: 'config' }
  }
  return { file: sprites[0], source: 'auto' }
}

export function createPackRegistry({ roots = [], log = () => {} } = {}) {
  let cache = null
  let cacheAt = 0
  const cropCache = new Map() // abs path -> { at, size, crop }
  const lastPick = new Map() // packId -> last chosen file

  function packRoots() {
    return roots.filter(Boolean)
  }

  function readPackJson(dir) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'))
      return raw && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }

  /** Load and memoise `clip -> {ja, zh}` for one pack directory. */
  function loadScript(dir) {
    const candidates = []
    for (const sub of [dir, path.join(dir, 'voices')]) {
      for (const entry of safeReaddir(sub)) {
        if (entry.isFile() && /\.csv$/i.test(entry.name)) candidates.push(path.join(sub, entry.name))
      }
    }
    if (candidates.length === 0) return null
    // Prefer a file literally named script*.csv, then the shortest name.
    candidates.sort((a, b) => {
      const an = /^script/i.test(path.basename(a)) ? 0 : 1
      const bn = /^script/i.test(path.basename(b)) ? 0 : 1
      return an - bn || path.basename(a).length - path.basename(b).length
    })
    for (const file of candidates) {
      try {
        const stat = safeStat(file)
        const parsed = parseScriptIndex(fs.readFileSync(file, 'utf8'))
        if (parsed.count > 0) return { ...parsed, file: path.basename(file), mtimeMs: stat ? stat.mtimeMs : 0 }
      } catch (err) {
        log(`script parse failed: ${file}: ${String(err && err.message)}`)
      }
    }
    return null
  }

  /** Visible-box crop for one image, memoised on mtime. */
  function cropOf(abs, fallbackCrop) {
    if (fallbackCrop) return fallbackCrop
    const stat = safeStat(abs)
    if (!stat) return { x: 0, y: 0, w: 1, h: 1 }
    const hit = cropCache.get(abs)
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit.crop
    let crop = { x: 0, y: 0, w: 1, h: 1 }
    try {
      const detected = pngVisibleCrop(fs.readFileSync(abs))
      if (detected) crop = normalizeCrop(detected)
    } catch {
      // Non-PNG or unreadable: fall back to the full canvas.
    }
    cropCache.set(abs, { mtimeMs: stat.mtimeMs, crop })
    return crop
  }

  function scanPack(dir, id, source) {
    const meta = readPackJson(dir)
    const spriteDir = safeStat(path.join(dir, 'sprites'))?.isDirectory() ? path.join(dir, 'sprites') : null
    const voiceDir = safeStat(path.join(dir, 'voices'))?.isDirectory() ? path.join(dir, 'voices') : null
    // A pack may also drop art/audio straight into its own folder.
    const loose = safeReaddir(dir).filter((e) => e.isFile()).map((e) => e.name)
    const sprites = [
      ...(spriteDir ? safeReaddir(spriteDir).filter((e) => e.isFile() && IMAGE_EXT.test(e.name)).map((e) => e.name) : []),
      ...loose.filter((n) => IMAGE_EXT.test(n)),
    ].sort(naturalCompare)
    const voices = [
      ...(voiceDir ? safeReaddir(voiceDir).filter((e) => e.isFile() && AUDIO_EXT.test(e.name)).map((e) => e.name) : []),
      ...loose.filter((n) => AUDIO_EXT.test(n)),
    ].sort(naturalCompare)
    if (sprites.length === 0 && voices.length === 0) return null

    const script = loadScript(dir)
    const explicitCrop = meta.crop ? normalizeCrop(meta.crop) : null
    const resolved = resolveDefaultSprite(sprites, meta.defaultSprite)
    const defaultSprite = resolved.file

    let crop = explicitCrop || { x: 0, y: 0, w: 1, h: 1 }
    let sourceSize = null
    if (defaultSprite) {
      const abs = path.join(spriteDir || dir, defaultSprite)
      crop = cropOf(abs, explicitCrop)
      sourceSize = pngSizeOfFile(abs)
    }

    return {
      id,
      source,
      dir,
      name: typeof meta.displayName === 'string' && meta.displayName ? meta.displayName : id,
      description: typeof meta.description === 'string' ? meta.description : '',
      spriteDir,
      voiceDir,
      sprites,
      voices,
      defaultSprite,
      defaultSource: resolved.source,
      crop,
      spriteSize: sourceSize,
      scriptFile: script ? script.file : null,
      scriptCount: script ? script.count : 0,
      lines: script ? script.lines : {},
    }
  }

  function scan() {
    const packs = new Map()
    const rootList = packRoots()
    rootList.forEach((root, index) => {
      const source = index === 0 ? 'user' : 'package'
      for (const entry of safeReaddir(root)) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue
        if (packs.has(entry.name)) continue // earlier roots win
        const pack = scanPack(path.join(root, entry.name), entry.name, source)
        if (pack) packs.set(entry.name, pack)
      }
    })
    return [...packs.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  function all() {
    const now = Date.now()
    if (cache && now - cacheAt < 2000) return cache
    try {
      cache = scan()
    } catch (err) {
      log(`pack scan failed: ${String(err && err.message)}`)
      cache = cache || []
    }
    cacheAt = now
    return cache
  }

  function invalidate() {
    cache = null
    cacheAt = 0
  }

  function get(id) {
    const packs = all()
    if (packs.length === 0) return null
    const wanted = String(id || '')
    return packs.find((p) => p.id === wanted) || null
  }

  function firstWithSprites() {
    return all().find((p) => p.sprites.length > 0) || null
  }

  function firstWithVoices() {
    return all().find((p) => p.voices.length > 0) || null
  }

  /** Resolve a pack for a given role, falling back to any pack that can serve it. */
  function resolve(id, role) {
    const pack = get(id)
    if (pack && (role === 'voices' ? pack.voices.length > 0 : pack.sprites.length > 0)) return pack
    return role === 'voices' ? firstWithVoices() : firstWithSprites()
  }

  /**
   * Pick a sprite that is not the one currently on screen, so every interaction
   * visibly changes the art. Falls back to "anything but the previous pick".
   */
  function pickSprite(pack, current) {
    if (!pack || pack.sprites.length === 0) return null
    const avoid = new Set([current, lastPick.get(`sprite:${pack.id}`)].filter(Boolean))
    const pool = pack.sprites.filter((f) => !avoid.has(f))
    const list = pool.length > 0 ? pool : pack.sprites
    const file = list[Math.floor(Math.random() * list.length)]
    lastPick.set(`sprite:${pack.id}`, file)
    const dir = pack.spriteDir || pack.dir
    return { file, size: pngSizeOfFile(path.join(dir, file)), crop: pack.crop }
  }

  /**
   * Pick a random voice line, preferring clips that have transcript text so the
   * dialogue box is never blank.
   */
  function pickVoice(pack, currentClip) {
    if (!pack || pack.voices.length === 0) return null
    const translated = pack.scriptCount > 0 ? pack.voices.filter((f) => pack.lines[clipIdOf(f)]) : []
    const base = translated.length > 0 ? translated : pack.voices
    const avoid = new Set([currentClip, lastPick.get(`voice:${pack.id}`)].filter(Boolean))
    const pool = base.filter((f) => !avoid.has(clipIdOf(f)))
    const list = pool.length > 0 ? pool : base
    const file = list[Math.floor(Math.random() * list.length)]
    const clip = clipIdOf(file)
    lastPick.set(`voice:${pack.id}`, clip)
    const line = pack.lines[clip] || null
    return { file, clip, ja: line ? line.ja : '', zh: line ? line.zh : '' }
  }

  /**
   * Validate a requested asset against the scanned inventory. Only names that
   * the scanner actually saw are served, which makes path traversal impossible.
   */
  function resolveAsset(packId, kind, file) {
    const pack = get(packId)
    if (!pack) return null
    const isSprite = kind === 'sprite'
    const list = isSprite ? pack.sprites : pack.voices
    if (!list.includes(file)) return null
    const dir = isSprite ? pack.spriteDir || pack.dir : pack.voiceDir || pack.dir
    const abs = path.join(dir, file)
    // Belt and braces: the joined path must still live inside the pack.
    const rel = path.relative(pack.dir, abs)
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null
    return { abs, pack, isSprite }
  }

  return {
    all,
    get,
    resolve,
    resolveAsset,
    pickSprite,
    pickVoice,
    firstWithSprites,
    firstWithVoices,
    invalidate,
    roots: packRoots,
  }
}
