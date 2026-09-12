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
 * Cache token for one asset file: modification time and byte length.
 *
 * Replacing a pack's artwork keeps every file name, so a URL a browser already
 * holds would still be the address of the *old* bytes — and since those URLs are
 * cached for a week, the old picture is what keeps being drawn. (That is exactly
 * how a mirrored pack carried on rendering un-mirrored after a restart: right
 * bytes on disk, stale copy in the browser.) The stamp rides in the query string,
 * so a replaced file gets a URL nobody has cached, while untouched files stay
 * cacheable.
 */
function versionOf(abs) {
  const stat = safeStat(abs)
  if (!stat) return '0-0'
  return `${Math.round(stat.mtimeMs)}-${stat.size}`
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

/**
 * Folder names a pack may use for its artwork and its audio.
 *
 * The scanner began with `sprites/` and `voices/`, but a pack assembled in
 * Chinese or Japanese naturally comes out as `立绘/` + `语音/` (or `立ち絵/` +
 * `ボイス/`), and being told to rename folders before the plugin will even look
 * at them is a needless papercut. The English names stay first, so nothing about
 * an existing pack changes.
 */
const SPRITE_DIR_NAMES = ['sprites', 'sprite', '立绘', '立ち絵']
const VOICE_DIR_NAMES = ['voices', 'voice', '语音', 'ボイス']

/** The first existing sub-directory with one of `names`, or null. */
function subdirOf(dir, names) {
  for (const name of names) {
    const candidate = path.join(dir, name)
    const stat = safeStat(candidate)
    if (stat && stat.isDirectory()) return candidate
  }
  return null
}

/**
 * Two ways to draw a voice line.
 *
 *   random   uniform every time, only the previous two picks are held back. Equal
 *            probability, but the draws cluster: over a 40-click session one line
 *            lands 3-5 times while hundreds are never heard.
 *   shuffle  a bag of the whole pool, drawn without replacement and refilled the
 *            moment it runs out. Every line is heard once before any line is heard
 *            twice, so the counts stay within one of each other for as long as the
 *            session lasts. This is the default; `random` is kept for anyone who
 *            wants the old behaviour back.
 */
export const VOICE_ORDERS = ['shuffle', 'random']

/** How many slots one round may be cut into, so a wild weight cannot blow up. */
const MAX_ROUND_SLOTS = 20000

/**
 * Turn a set of weights into whole slots, keeping the ratios exact.
 *
 * Scaling by `1 / smallest positive weight` is what makes a fractional weight
 * mean something: without it `0.25` rounds to 1 slot and "a quarter as often"
 * silently becomes "just as often".
 */
export function voiceSlots(weights) {
  const positive = weights.filter((w) => w > 0)
  if (positive.length === 0) return weights.map(() => 1)
  const scale = 1 / Math.min(...positive)
  let slots = weights.map((w) => (w > 0 ? Math.max(1, Math.round(w * scale)) : 0))
  const total = slots.reduce((a, b) => a + b, 0)
  if (total > MAX_ROUND_SLOTS) {
    const shrink = MAX_ROUND_SLOTS / total
    slots = slots.map((n) => (n > 0 ? Math.max(1, Math.floor(n * shrink)) : 0))
    // Rounding up to one slot each can push the sum back over the cap, so the
    // remainder is taken off the biggest entries — never below one, because every
    // line still has to be reachable.
    let over = slots.reduce((a, b) => a + b, 0) - MAX_ROUND_SLOTS
    while (over > 0) {
      let biggest = -1
      for (let i = 0; i < slots.length; i++) if (slots[i] > 1 && (biggest < 0 || slots[i] > slots[biggest])) biggest = i
      if (biggest < 0) break
      slots[biggest]--
      over--
    }
  }
  return slots
}

/**
 * Plan one round of the shuffle bag: every file exactly as many times as its
 * weight says, in an order that never places the same file twice in a row.
 *
 * Equal weights take the plain shuffle fast path — with one slot each there can
 * be no adjacency by construction, so the expensive spread is not needed. When
 * weights differ, the round is built greedily from the files with the most slots
 * left, picking at random among ties: that spreads a heavily weighted file as
 * thinly as arithmetic allows and still reshuffles the order every round.
 *
 * `previous` is the file that ended the last round; the new one will not open
 * with it, because a repeat across the seam is heard exactly like a repeat.
 */
export function planVoiceRound(files, weightOf, { random = Math.random, previous = null } = {}) {
  const count = files.length
  if (count === 0) return []
  if (count === 1) return [files[0]]

  const weights = files.map((file) => weightOf(file))
  const slots = voiceSlots(weights)
  const total = slots.reduce((a, b) => a + b, 0)
  const order = []

  if (total === count) {
    for (const file of files) order.push(file)
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      const swap = order[i]
      order[i] = order[j]
      order[j] = swap
    }
    if (previous && order[0] === previous) {
      const j = 1 + Math.floor(random() * (order.length - 1))
      const swap = order[0]
      order[0] = order[j]
      order[j] = swap
    }
    return order
  }

  const left = slots.slice()
  let last = previous
  for (let placed = 0; placed < total; placed++) {
    let best = -1
    for (let i = 0; i < count; i++) {
      if (left[i] <= 0) continue
      if (files[i] === last && count > 1 && left.some((n, k) => n > 0 && k !== i)) continue
      if (left[i] > best) best = left[i]
    }
    if (best < 0) break
    let ties = 0
    for (let i = 0; i < count; i++) {
      if (left[i] !== best) continue
      if (files[i] === last && count > 1 && left.some((n, k) => n > 0 && k !== i)) continue
      ties++
    }
    let pick = Math.floor(random() * ties)
    let chosen = -1
    for (let i = 0; i < count; i++) {
      if (left[i] !== best) continue
      if (files[i] === last && count > 1 && left.some((n, k) => n > 0 && k !== i)) continue
      if (pick-- === 0) {
        chosen = i
        break
      }
    }
    if (chosen < 0) break
    order.push(files[chosen])
    left[chosen]--
    last = files[chosen]
  }
  return order
}

export function createPackRegistry({ roots = [], log = () => {} } = {}) {
  let cache = null
  let cacheAt = 0
  const cropCache = new Map() // abs path -> { at, size, crop }
  const lastPick = new Map() // packId -> last chosen file, for `random` order
  const bags = new Map() // packId -> { key, order, at }, the shuffle bag

  function packRoots() {
    return roots.filter(Boolean)
  }

  /**
   * Read a pack's optional `weights.json`.
   *
   *   { "mas0033": 3, "……。": 0.2 }
   *
   * Keys may be a voice file name (with or without its extension) or a line of
   * dialogue, matched exactly — nothing is normalised, so 「……。」 and 「……」 stay
   * two different keys. Values are multiples of "normal": 0 never plays the line,
   * 0.25 plays it a quarter as often, 5 five times as often. Only the lines worth
   * tuning need to be listed; everything else stays at 1.
   *
   * A missing or unreadable file leaves the pack unweighted, and an unusable value
   * is ignored rather than allowed to silence a line — a typo in a hand-written
   * JSON file must never break the widget.
   */
  function readWeights(dir) {
    const file = path.join(dir, 'weights.json')
    const stat = safeStat(file)
    if (!stat || !stat.isFile()) return null
    const stamp = `${Math.round(stat.mtimeMs)}-${stat.size}`
    let parsed = null
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (err) {
      log(`weights.json ignored (${String((err && err.message) || err)})`)
      return { table: new Map(), stamp, keys: 0 }
    }
    const table = new Map()
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (!key || key.startsWith('_') || key.startsWith('$')) continue // comments
        const weight = Number(value)
        if (!Number.isFinite(weight) || weight < 0) continue
        table.set(key.trim(), weight)
        const id = clipIdOf(key)
        if (id !== key.trim()) table.set(id, weight)
      }
    }
    return { table, stamp, keys: table.size }
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
    // The transcript lives either beside `pack.json` or inside the voice folder,
    // whichever it is called.
    const search = [dir, ...VOICE_DIR_NAMES.map((name) => path.join(dir, name))]
    for (const sub of search) {
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
    const spriteDir = subdirOf(dir, SPRITE_DIR_NAMES)
    const voiceDir = subdirOf(dir, VOICE_DIR_NAMES)
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
    let defaultVersion = null
    if (defaultSprite) {
      const abs = path.join(spriteDir || dir, defaultSprite)
      crop = cropOf(abs, explicitCrop)
      sourceSize = pngSizeOfFile(abs)
      defaultVersion = versionOf(abs)
    }

    const weights = readWeights(dir)
    const weightOf = (file) => {
      if (!weights || weights.table.size === 0) return 1
      const id = clipIdOf(file)
      if (weights.table.has(id)) return weights.table.get(id)
      const line = script ? script.lines[id] : null
      if (line) {
        // Both languages are offered as keys, matched exactly and independently:
        // no punctuation folding, no near-match merging.
        if (line.ja && weights.table.has(line.ja)) return weights.table.get(line.ja)
        if (line.zh && weights.table.has(line.zh)) return weights.table.get(line.zh)
      }
      return 1
    }
    const weighted = weights && weights.table.size > 0 ? voices.filter((f) => weightOf(f) !== 1).length : 0

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
      defaultSpriteVersion: defaultVersion,
      crop,
      spriteSize: sourceSize,
      scriptFile: script ? script.file : null,
      scriptCount: script ? script.count : 0,
      lines: script ? script.lines : {},
      voiceWeights: weights,
      weightOf,
      weightedVoiceCount: weighted,
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
    const abs = path.join(dir, file)
    return { file, size: pngSizeOfFile(abs), crop: pack.crop, version: versionOf(abs) }
  }

  /**
   * Pick a voice line, preferring clips that have transcript text so the dialogue
   * box is never blank.
   *
   * `order` selects how it is drawn:
   *
   *   'shuffle'  the bag. The whole pool is planned into a round, drawn without
   *              replacement, and replanned the moment it runs out — so a line
   *              cannot come back until every other line has had its turn, and the
   *              refill happens on its own (no restart, no reset button). A round
   *              ends mid-click for nobody: the next draw simply starts a new one,
   *              which will not open with the line that just closed the last.
   *   'random'   the original behaviour: uniform every time, holding back only the
   *              line on screen and the one before it.
   *
   * The bag is keyed by pack *and* by the pool it was planned from, so replacing
   * the pack's files, editing `weights.json` or flipping the setting all discard a
   * stale round instead of drawing from it.
   */
  function pickVoice(pack, currentClip, { order = 'shuffle' } = {}) {
    if (!pack || pack.voices.length === 0) return null
    const translated = pack.scriptCount > 0 ? pack.voices.filter((f) => pack.lines[clipIdOf(f)]) : []
    const base = translated.length > 0 ? translated : pack.voices
    const mode = order === 'random' ? 'random' : 'shuffle'

    let file = null
    if (mode === 'shuffle') {
      // The round is tied to the pool it was planned from and to the weights file
      // behind it: change either and a stale round is dropped rather than drawn
      // from. The file *list* is not part of the key — a rescan hands back a fresh
      // array every couple of seconds, which would otherwise reset the bag forever.
      const key = `${base.length}:${pack.voiceWeights ? pack.voiceWeights.stamp : 'none'}`
      let bag = bags.get(pack.id)
      if (!bag || bag.key !== key || bag.at >= bag.order.length) {
        bag = {
          key,
          previous: bag ? bag.previous : null,
          order: planVoiceRound(base, pack.weightOf, { previous: bag ? bag.previous : null }),
          at: 0,
        }
        bags.set(pack.id, bag)
      }
      file = bag.order[bag.at++]
      // A pack can be re-scanned under a running bag; a name that is gone is
      // simply skipped rather than served as a 404.
      if (!base.includes(file)) {
        bags.delete(pack.id)
        return pickVoice(pack, currentClip, { order: mode })
      }
      bag.previous = file
    } else {
      const avoid = new Set([currentClip, lastPick.get(`voice:${pack.id}`)].filter(Boolean))
      const pool = base.filter((f) => !avoid.has(clipIdOf(f)))
      const list = pool.length > 0 ? pool : base
      file = list[Math.floor(Math.random() * list.length)]
      lastPick.set(`voice:${pack.id}`, clipIdOf(file))
    }

    const clip = clipIdOf(file)
    const line = pack.lines[clip] || null
    const version = versionOf(path.join(pack.voiceDir || pack.dir, file))
    return { file, clip, ja: line ? line.ja : '', zh: line ? line.zh : '', version }
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
