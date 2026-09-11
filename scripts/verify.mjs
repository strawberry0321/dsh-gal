/**
 * End-to-end verification for dsh-gal.
 *
 * Boots the real host plugin against a fake Cordis context, then drives every
 * HTTP route with fake request/response objects — no DSH process and no network
 * required. Run with:
 *
 *   node scripts/verify.mjs
 *
 * Exit code 0 = every check passed.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

// The host plugin resolves its config/ledger under DSH_HOME, read at module load.
// Point it at a scratch directory so verification never touches the real install.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsg-verify-'))
process.env.DSH_HOME = TMP_HOME

let passed = 0
let failed = 0
const failures = []

function check(label, fn) {
  try {
    const result = fn()
    if (result && typeof result.then === 'function') {
      return result.then(
        () => {
          passed++
          console.log(`  \u2713 ${label}`)
        },
        (err) => {
          failed++
          failures.push(`${label}: ${err.message}`)
          console.log(`  \u2717 ${label}\n      ${err.message}`)
        },
      )
    }
    passed++
    console.log(`  \u2713 ${label}`)
  } catch (err) {
    failed++
    failures.push(`${label}: ${err.message}`)
    console.log(`  \u2717 ${label}\n      ${err.message}`)
  }
  return Promise.resolve()
}

function section(title) {
  console.log(`\n${title}`)
}

// ── fake Cordis context ─────────────────────────────────────────────────────
function createHarness() {
  const routes = new Map()
  const indexTaps = []
  const listeners = new Map()
  const effects = []
  const ctx = {
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
      tapIndex(fn) {
        indexTaps.push(fn)
        return () => {}
      },
    },
    // No credentials: the balance route must degrade instead of throwing.
    credentials: { async resolve() { return null } },
    on(event, fn) {
      listeners.set(event, fn)
      return () => listeners.delete(event)
    },
    // Cordis runs the effect body immediately and keeps whatever it returns as
    // the disposer, so the harness must do the same.
    effect(fn) {
      effects.push(fn())
    },
  }
  return { ctx, routes, indexTaps, listeners, effects }
}

function callRoute(handler, routePath, { method = 'GET', query = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`http://127.0.0.1${routePath}`)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    const req = new Readable({ read() {} })
    req.method = method
    req.url = `${url.pathname}${url.search}`
    req.headers = {}
    const timer = setTimeout(() => reject(new Error(`route timeout: ${routePath}`)), 5000)
    const res = {
      statusCode: 0,
      headers: {},
      writeHead(code, headers) {
        this.statusCode = code
        this.headers = headers || {}
      },
      end(data) {
        clearTimeout(timer)
        const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ''))
        resolve({ status: this.statusCode, headers: this.headers, body: payload })
      },
    }
    Promise.resolve(handler(req, res)).catch((err) => {
      clearTimeout(timer)
      reject(err)
    })
    if (body !== undefined) req.push(Buffer.from(body))
    req.push(null)
  })
}

function jsonOf(response) {
  return JSON.parse(response.body.toString('utf8'))
}

// ── main ────────────────────────────────────────────────────────────────────
console.log('dsh-gal verification\n=================================')

section('1. Module syntax')
// client.js is the one file never imported by Node (it only ever runs in the
// browser), so compile it here. Everything else is proven by the real ESM
// import performed in section 5.
await check('lib/client.js compiles as a classic browser script', () => {
  const source = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8')
  assert.ok(source.length > 10000, `only ${source.length} bytes`)
  // eslint-disable-next-line no-new-func
  new Function(source)
})
await check('lib/client.js is served byte-for-byte by the host', () => {
  const source = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8')
  assert.ok(!source.includes('</script'), 'a literal </script would break the index injection')
})
await check('no shipped text file carries a UTF-8 BOM', () => {
  // A BOM makes DSH's plugin installer throw `Unexpected token '\uFEFF'` while
  // reading the bundle's package.json, and the failure only surfaces much later
  // as a silently missing `dsh.profile.bundles` row. Cheap to check here.
  const offenders = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === '.git') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(json|js|mjs|md|ya?ml|csv)$/i.test(entry.name)) continue
      const head = Buffer.alloc(3)
      const fd = fs.openSync(full, 'r')
      try {
        fs.readSync(fd, head, 0, 3, 0)
      } finally {
        fs.closeSync(fd)
      }
      if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) offenders.push(path.relative(ROOT, full))
    }
  }
  walk(ROOT)
  assert.deepEqual(offenders, [], `UTF-8 BOM found in: ${offenders.join(', ')}`)
})

section('2. PNG alpha cropping')
{
  const { pngVisibleCrop, readPngAlphaBox } = await import('../lib/png-alpha.js')
  const sprite = path.join(ROOT, 'assets/packs/neri/sprites/large_neri_01face.png')
  await check('detects the visible box of a 1500x1200 sprite', () => {
    const info = readPngAlphaBox(fs.readFileSync(sprite))
    assert.ok(info, 'no info returned')
    assert.equal(info.width, 1500)
    assert.equal(info.height, 1200)
    assert.ok(info.box, 'no visible box found')
    // Reference values measured independently with GDI+.
    assert.ok(Math.abs(info.box.x - 246) <= 3, `x=${info.box.x}`)
    assert.ok(Math.abs(info.box.y - 202) <= 3, `y=${info.box.y}`)
    assert.ok(Math.abs(info.box.w - 1019) <= 4, `w=${info.box.w}`)
    assert.ok(Math.abs(info.box.h - 997) <= 4, `h=${info.box.h}`)
  })
  await check('normalises the crop to 0..1', () => {
    const crop = pngVisibleCrop(fs.readFileSync(sprite))
    assert.ok(crop.x > 0.15 && crop.x < 0.18, `x=${crop.x}`)
    assert.ok(crop.w > 0.66 && crop.w < 0.7, `w=${crop.w}`)
    assert.ok(crop.x + crop.w <= 1 && crop.y + crop.h <= 1)
  })
  await check('survives a non-PNG buffer', () => {
    assert.equal(readPngAlphaBox(Buffer.from('not a png at all')), null)
  })
  await check('dialog plate is opaque, so it is not cropped', () => {
    const crop = pngVisibleCrop(fs.readFileSync(path.join(ROOT, 'assets/ui/dialog.png')))
    assert.ok(crop.w > 0.99 && crop.h > 0.99, `w=${crop.w} h=${crop.h}`)
  })
}

section('3. Script index CSV')
{
  const { parseScriptIndex, clipIdOf } = await import('../lib/csv.js')
  const text = fs.readFileSync(path.join(ROOT, 'assets/packs/neri/script.csv'), 'utf8')
  const parsed = parseScriptIndex(text)
  await check('parses the shipped transcript', () => {
    assert.ok(parsed.count > 380, `only ${parsed.count} lines`)
    assert.equal(parsed.columns.ja, 3)
    assert.equal(parsed.columns.zh, 4)
  })
  await check('joins a voice file name to its line', () => {
    assert.equal(clipIdOf('ner0042.wav'), 'ner0042')
    const line = parsed.lines['ner0002']
    assert.ok(line, 'ner0002 missing')
    assert.match(line.ja, /お兄ちゃん/)
    assert.match(line.zh, /哥哥/)
  })
  await check('keeps quoted multi-line fields intact', () => {
    const line = parsed.lines['ner0010']
    assert.ok(line, 'ner0010 missing')
    assert.ok(line.ja.includes('\n'), 'newline inside the quoted field was lost')
  })
  await check('tolerates a headerless two-column file', () => {
    const small = parseScriptIndex('v001,こんにちは,你好\nv002,おやすみ,晚安\n')
    assert.equal(small.count, 2)
    assert.equal(small.lines.v002.zh, '晚安')
  })
  await check('drops inline sound cues instead of printing them', () => {
    // The sample transcripts carry cues like `<dash=2>` in the middle of a
    // sentence; without this the dialogue box shows the tag to the reader.
    const cue = parseScriptIndex(
      'clip,japanese,chinese\nv001,えいっ<dash=2>、ねいっ。,嘿<dash=2>，嘿<dash=20>。\nv002,なんで２本ともイッた<dash=6>！,干掉了<dash=12>！\n',
    )
    assert.equal(cue.lines.v001.ja, 'えいっ、ねいっ。', 'ja cue not stripped')
    assert.equal(cue.lines.v001.zh, '嘿，嘿。', 'zh cue not stripped')
    assert.equal(cue.lines.v002.ja, 'なんで２本ともイッた！')
    assert.equal(cue.lines.v002.zh, '干掉了！')
    // Nothing else may be touched: real punctuation and lone angle brackets stay.
    const safe = parseScriptIndex('clip,japanese,chinese\nv003,1 < 2 です,数值 <3 也要保留\nv004,ふつう,普通\n')
    assert.equal(safe.lines.v003.ja, '1 < 2 です')
    assert.equal(safe.lines.v003.zh, '数值 <3 也要保留')
    // And the shipped data itself must be clean now.
    const shipped = parseScriptIndex(fs.readFileSync(path.join(ROOT, 'assets/packs/neri/script.csv'), 'utf8'))
    const cueLeft = Object.values(shipped.lines).filter((l) => /<[a-z]/i.test(l.ja) || /<[a-z]/i.test(l.zh))
    assert.equal(cueLeft.length, 0, `${cueLeft.length} shipped lines still contain a tag`)
  })
}

section('4. Pricing')
{
  const { priceFor, isPeakTime, costOf, tokensOf, normalizePricing } = await import('../lib/pricing.js')
  const pricing = normalizePricing(JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/pricing.json'), 'utf8')))
  await check('matches a dated model name to the flash tier', () => {
    const price = priceFor(pricing, 'deepseek-v4-flash-0731')
    assert.deepEqual(price.miss, [1.5, 3.0])
  })
  await check('gives pro its own tier', () => {
    assert.deepEqual(priceFor(pricing, 'deepseek-v4-pro-0813').miss, [4.5, 9.0])
  })
  await check('Beijing 10:00 on a Wednesday is peak', () => {
    // 2026-09-09 is a Wednesday. 10:00 Beijing = 02:00 UTC.
    assert.equal(isPeakTime(pricing, Date.UTC(2026, 8, 9, 2, 0, 0) / 1000), true)
  })
  await check('Beijing 20:00 on a Wednesday is off-peak', () => {
    assert.equal(isPeakTime(pricing, Date.UTC(2026, 8, 9, 12, 0, 0) / 1000), false)
  })
  await check('a Saturday midday is off-peak (weekend valley)', () => {
    // 2026-09-12 is a Saturday. 10:00 Beijing = 02:00 UTC.
    assert.equal(isPeakTime(pricing, Date.UTC(2026, 8, 12, 2, 0, 0) / 1000), false)
  })
  await check('prices a usage sample', () => {
    const usage = { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 1_000_000, reasoningTokens: 0 }
    const off = costOf(pricing, 'deepseek-v4-flash', usage, Date.UTC(2026, 8, 9, 12, 0, 0) / 1000)
    assert.equal(Number(off.toFixed(6)), 6) // 1.5 + 4.5
    const peak = costOf(pricing, 'deepseek-v4-flash', usage, Date.UTC(2026, 8, 9, 2, 0, 0) / 1000)
    assert.equal(Number(peak.toFixed(6)), 12) // 3 + 9
  })
  await check('counts every token bucket', () => {
    assert.equal(tokensOf({ inputTokens: 10, cacheReadTokens: 20, outputTokens: 30, reasoningTokens: 40 }), 100)
  })
}

section('5. Host plugin boot')
const harness = createHarness()
const mod = await import('../lib/index.js')
await check('exports a Cordis plugin', () => {
  assert.equal(typeof mod.apply, 'function')
  assert.equal(mod.name, 'dsh-gal')
  assert.deepEqual(mod.inject, ['webServer', 'credentials'])
})
await check('apply() registers its routes and index injection', () => {
  mod.apply(harness.ctx)
  assert.ok(harness.routes.size >= 10, `only ${harness.routes.size} routes`)
  assert.equal(harness.indexTaps.length, 1)
  assert.equal(harness.listeners.size, 2)
  assert.equal(harness.effects.length, 1)
})
await check('creates the user drop-folders on first run', () => {
  // The plugin only reads from the user root, so a fresh install used to leave
  // no trace of where user packs belong.
  const root = path.join(TMP_HOME, 'dsh-gal')
  assert.ok(fs.existsSync(path.join(root, 'packs')), 'packs/ was not created')
  assert.ok(fs.existsSync(path.join(root, 'packs', 'README.md')), 'the how-to README is missing')
  assert.ok(fs.existsSync(path.join(root, 'ui')), 'ui/ was not created')
  const readme = fs.readFileSync(path.join(root, 'packs', 'README.md'), 'utf8')
  assert.match(readme, /sprites\//)
  assert.match(readme, /voices\//)
  // An existing folder must never be rewritten.
  fs.writeFileSync(path.join(root, 'packs', 'README.md'), 'mine', 'utf8')
  mod.apply(createHarness().ctx)
  assert.equal(fs.readFileSync(path.join(root, 'packs', 'README.md'), 'utf8'), 'mine', 'it overwrote the user README')
})
await check('injects the client script into the index document', () => {
  const html = harness.indexTaps[0]('<html><body><div id="app"></div></body></html>')
  assert.ok(html.includes('<script defer src="/dsh-gal/client.js"></script>'))
  assert.ok(html.indexOf('/dsh-gal/client.js') < html.indexOf('</body>'))
  // Idempotent: a second pass must not add a duplicate tag.
  assert.equal(harness.indexTaps[0](html), html)
})

const route = (p) => {
  const handler = harness.routes.get(p)
  assert.ok(handler, `route ${p} not registered`)
  return handler
}

section('6. Asset routes')
await check('client.js is served as JavaScript', async () => {
  const res = await callRoute(route('/dsh-gal/client.js'), '/dsh-gal/client.js')
  assert.equal(res.status, 200)
  assert.match(res.headers['Content-Type'], /javascript/)
  assert.ok(res.body.length > 10000, `only ${res.body.length} bytes`)
  assert.ok(res.body.toString('utf8').includes('__dshGalWidget'))
})
await check('UI assets are served with the right mime types', async () => {
  const dialog = await callRoute(route('/dsh-gal/asset/ui/dialog.png'), '/dsh-gal/asset/ui/dialog.png')
  assert.equal(dialog.status, 200)
  assert.equal(dialog.headers['Content-Type'], 'image/png')
  assert.equal(dialog.body.readUInt32BE(0), 0x89504e47)

  const click = await callRoute(route('/dsh-gal/asset/ui/click.wav'), '/dsh-gal/asset/ui/click.wav')
  assert.equal(click.headers['Content-Type'], 'audio/wav')
  assert.equal(click.body.toString('ascii', 0, 4), 'RIFF')

  const gear = await callRoute(route('/dsh-gal/asset/ui/settings.png'), '/dsh-gal/asset/ui/settings.png')
  assert.equal(gear.status, 200)
})
await check('a user copy under $DSH_HOME overrides the shipped UI asset', async () => {
  const dir = path.join(TMP_HOME, 'dsh-gal', 'ui')
  fs.mkdirSync(dir, { recursive: true })
  const custom = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('CUSTOM-PLATE')])
  fs.writeFileSync(path.join(dir, 'dialog.png'), custom)
  const overridden = await callRoute(route('/dsh-gal/asset/ui/dialog.png'), '/dsh-gal/asset/ui/dialog.png')
  assert.equal(overridden.status, 200)
  assert.equal(overridden.body.length, custom.length, 'the user copy was not picked up')
  fs.rmSync(path.join(TMP_HOME, 'dsh-gal'), { recursive: true, force: true })
  const shipped = await callRoute(route('/dsh-gal/asset/ui/dialog.png'), '/dsh-gal/asset/ui/dialog.png')
  assert.ok(shipped.body.length > 10000, 'falling back to the shipped plate failed')
})
await check('a sprite is served by pack + file name', async () => {
  const res = await callRoute(route('/dsh-gal/asset/sprite'), '/dsh-gal/asset/sprite', {
    query: { pack: 'neri', file: 'large_neri_07face.png' },
  })
  assert.equal(res.status, 200)
  assert.equal(res.headers['Content-Type'], 'image/png')
  assert.ok(res.body.length > 100000)
})
await check('a voice line is served by pack + file name', async () => {
  const res = await callRoute(route('/dsh-gal/asset/voice'), '/dsh-gal/asset/voice', {
    query: { pack: 'neri', file: 'ner0042.wav' },
  })
  assert.equal(res.status, 200)
  assert.equal(res.headers['Content-Type'], 'audio/wav')
  assert.equal(res.body.toString('ascii', 0, 4), 'RIFF')
})
await check('rejects unknown files and path traversal', async () => {
  for (const query of [
    { pack: 'neri', file: 'nope.png' },
    { pack: 'neri', file: '../../../package.json' },
    { pack: 'neri', file: '..%2F..%2Fpackage.json' },
    { pack: 'missing-pack', file: 'large_neri_01face.png' },
    { pack: 'neri', file: '' },
  ]) {
    const res = await callRoute(route('/dsh-gal/asset/sprite'), '/dsh-gal/asset/sprite', { query })
    assert.equal(res.status, 404, `expected 404 for ${JSON.stringify(query)}, got ${res.status}`)
  }
})

section('7. Pack discovery')
let packsResponse = null
await check('/api/packs lists the shipped pack for both roles', async () => {
  const res = await callRoute(route('/dsh-gal/api/packs'), '/dsh-gal/api/packs')
  const data = jsonOf(res)
  packsResponse = data
  assert.equal(data.ok, true)
  const spritePack = data.spritePacks.find((p) => p.id === 'neri')
  const voicePack = data.voicePacks.find((p) => p.id === 'neri')
  assert.ok(spritePack, 'no sprite pack')
  assert.ok(voicePack, 'no voice pack')
  assert.equal(spritePack.spriteCount, 18)
  assert.equal(voicePack.voiceCount, 405)
  assert.ok(voicePack.scriptCount > 380, `scriptCount=${voicePack.scriptCount}`)
  assert.equal(spritePack.defaultSprite, 'large_neri_01face.png')
  assert.ok(spritePack.crop.w > 0.6 && spritePack.crop.w < 0.75, `crop=${JSON.stringify(spritePack.crop)}`)
})
await check('auto-selects a pack for each role on a fresh install', () => {
  // The first /api/packs call runs ensurePackSelection(), so a brand new config
  // must come back with both roles already pointing at the shipped pack.
  assert.equal(packsResponse.config.spritePack, 'neri')
  assert.equal(packsResponse.config.voicePack, 'neri')
})

section('7b. Default sprite resolution')
{
  const { createPackRegistry } = await import('../lib/packs.js')
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsg-packs-'))
  // A real 1x1 PNG so the alpha scan has something valid to chew on.
  const PIXEL = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  )
  const makePack = (name, files, meta) => {
    const dir = path.join(sandbox, name, 'sprites')
    fs.mkdirSync(dir, { recursive: true })
    for (const file of files) fs.writeFileSync(path.join(dir, file), PIXEL)
    if (meta) fs.writeFileSync(path.join(sandbox, name, 'pack.json'), JSON.stringify(meta), 'utf8')
    return path.join(sandbox, name)
  }
  const inspect = (name) => {
    const registry = createPackRegistry({ roots: [sandbox] })
    const pack = registry.all().find((p) => p.id === name)
    assert.ok(pack, `pack ${name} was not scanned`)
    return pack
  }

  await check('a file merely called Default carries no special meaning', () => {
    // The naming convention was dropped: pack.json is the way to declare a
    // default, so `Default.png` is just another sprite.
    makePack('plaindefault', ['01.png', '02.png', 'Default.png'])
    const pack = inspect('plaindefault')
    assert.notEqual(pack.defaultSprite, 'Default.png', 'the filename convention is back')
    assert.equal(pack.defaultSprite, '01.png')
    assert.equal(pack.defaultSource, 'auto')
    assert.ok(pack.sprites.includes('Default.png'), 'it must still be a usable sprite')
  })
  await check('the Default-name rule is gone from the code', () => {
    const source = fs.readFileSync(path.join(ROOT, 'lib/packs.js'), 'utf8')
    assert.ok(!/DEFAULT_NAME_RE/.test(source), 'the name-matching regex is still there')
    assert.ok(!/'name'/.test(source), 'the name source is still reported')
  })
  await check('pack.json is used when it names an existing sprite', () => {
    makePack('configured', ['01.png', '02.png'], { defaultSprite: '02.png' })
    const pack = inspect('configured')
    assert.equal(pack.defaultSprite, '02.png')
    assert.equal(pack.defaultSource, 'config')
  })
  await check('a pack with no declared default still gets one', () => {
    // This is what guarantees "revert to the default pose" always has a target,
    // even for a pack of user-supplied art with no metadata at all.
    makePack('bare', ['alpha.png', 'beta.png'])
    const pack = inspect('bare')
    assert.ok(pack.defaultSprite, 'a default must always be resolved')
    assert.equal(pack.defaultSource, 'auto')
    assert.ok(pack.sprites.includes(pack.defaultSprite))
  })
  await check('the automatic pick is the first in natural order', () => {
    // Lexicographic order puts 10 before 2, which makes the auto pick look random
    // on any pack with ten or more numbered files.
    makePack('numbered', ['10.png', '9.png', '2.png', '1.png'])
    const pack = inspect('numbered')
    assert.deepEqual(pack.sprites, ['1.png', '2.png', '9.png', '10.png'])
    assert.equal(pack.defaultSprite, '1.png')
    assert.equal(pack.defaultSource, 'auto')
  })
  await check('a stale defaultSprite in pack.json still falls back', () => {
    makePack('stale', ['only.png'], { defaultSprite: 'deleted.png' })
    const pack = inspect('stale')
    assert.equal(pack.defaultSprite, 'only.png')
    assert.equal(pack.defaultSource, 'auto')
  })
  await check('a voice-only pack has no default sprite', () => {
    const dir = path.join(sandbox, 'voiceonly', 'voices')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'a.wav'), Buffer.from('RIFF'))
    const pack = inspect('voiceonly')
    assert.equal(pack.defaultSprite, null)
    assert.equal(pack.defaultSource, 'none')
  })
  await check('the summary exposes which rule won', async () => {
    const listed = jsonOf(await callRoute(route('/dsh-gal/api/packs'), '/dsh-gal/api/packs'))
    const neri = listed.spritePacks.find((p) => p.id === 'neri')
    assert.equal(neri.defaultSprite, 'large_neri_01face.png')
    assert.equal(neri.defaultSource, 'config', 'the shipped pack declares it in pack.json')
  })
  await check('the settings panel reports the default and its reason', () => {
    const css = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8')
    assert.match(css, /function defaultSpriteNote\(pack\)/)
    assert.match(css, /pack\.defaultSource === 'config' \? 'pack\.json 指定' : '自动选定'/)
    assert.match(css, /defaultSpriteNote\(spritePack\)/, 'the note must be shown next to the pack picker')
  })
  fs.rmSync(sandbox, { recursive: true, force: true })
}

section('8. Interaction feed')
await check('/api/next returns a fresh sprite and a transcribed line', async () => {
  const seenClip = new Set()
  const seenSprite = new Set()
  for (let i = 0; i < 12; i++) {
    const res = await callRoute(route('/dsh-gal/api/next'), '/dsh-gal/api/next', {
      query: { spritePack: 'neri', voicePack: 'neri' },
    })
    const data = jsonOf(res)
    assert.equal(data.ok, true)
    assert.ok(data.sprite, 'no sprite chosen')
    assert.ok(data.voice, 'no voice chosen')
    assert.ok(data.voice.url.startsWith('/dsh-gal/asset/voice?'), data.voice.url)
    assert.ok(data.sprite.url.startsWith('/dsh-gal/asset/sprite?'), data.sprite.url)
    // Every interaction must carry transcript text, or the box would be blank.
    assert.ok(data.voice.ja && data.voice.ja.length > 0, `empty ja for ${data.voice.clip}`)
    assert.ok(data.voice.zh && data.voice.zh.length > 0, `empty zh for ${data.voice.clip}`)
    assert.ok(data.sprite.size && data.sprite.size.w === 1500 && data.sprite.size.h === 1200)
    seenClip.add(data.voice.clip)
    seenSprite.add(data.sprite.file)
  }
  assert.ok(seenClip.size >= 6, `voices are not random enough: ${seenClip.size} distinct in 12`)
  assert.ok(seenSprite.size >= 6, `sprites are not random enough: ${seenSprite.size} distinct in 12`)
})
await check('does not immediately repeat the art or the line', async () => {
  let previous = null
  for (let i = 0; i < 20; i++) {
    const res = await callRoute(route('/dsh-gal/api/next'), '/dsh-gal/api/next', {
      query: { spritePack: 'neri', voicePack: 'neri' },
    })
    const data = jsonOf(res)
    const key = `${data.sprite.file}|${data.voice.clip}`
    assert.notEqual(key, previous, 'immediate repeat')
    previous = key
  }
})

section('8b. Voice pack with no transcript table')
await check('a voice-only pack still plays, it just has no line to print', async () => {
  // Reproduces a user drop-in pack: audio and nothing else, no script.csv. The
  // click must still swap the art and still play the voice — what changes is only
  // that there is no text, so the box shows 余额 / 今日已用 rather than staying
  // blank. The host's half of that contract is: a voice URL, empty ja/zh.
  const voiceDir = path.join(TMP_HOME, 'dsh-gal', 'packs', 'notranscript', 'voices')
  fs.mkdirSync(voiceDir, { recursive: true })
  for (const name of ['clip0001.wav', 'clip0002.wav']) {
    fs.writeFileSync(path.join(voiceDir, name), Buffer.from('RIFF____WAVEfmt '), 'binary')
  }

  // A config write is what invalidates the pack cache, so this doubles as proof
  // that a freshly dropped-in pack becomes selectable without a restart.
  const config = route('/dsh-gal/api/config')
  const put = (patch) => callRoute(config, '/dsh-gal/api/config', { method: 'PUT', body: JSON.stringify(patch) })
  await put({ voicePack: 'notranscript' })

  const listed = jsonOf(await callRoute(route('/dsh-gal/api/packs'), '/dsh-gal/api/packs'))
  const pack = listed.voicePacks.find((p) => p.id === 'notranscript')
  assert.ok(pack, 'a voice-only pack was not discovered at all')
  assert.equal(pack.voiceCount, 2)
  assert.equal(pack.scriptCount, 0, 'this pack must have no transcript whatsoever')

  const data = jsonOf(
    await callRoute(route('/dsh-gal/api/next'), '/dsh-gal/api/next', {
      query: { spritePack: 'neri', voicePack: 'notranscript' },
    }),
  )
  assert.ok(data.sprite, 'the art must still swap on the same click')
  assert.ok(data.voice, 'the voice must still be picked')
  assert.equal(data.voice.ja, '', 'ja must be empty: there is no table to read')
  assert.equal(data.voice.zh, '', 'zh must be empty: there is no table to read')

  // "Playback is unaffected": the file the client was just handed must serve.
  const served = await callRoute(route('/dsh-gal/asset/voice'), '/dsh-gal/asset/voice', {
    query: { pack: 'notranscript', file: `${data.voice.clip}.wav` },
  })
  assert.equal(served.status, 200, 'the voice picked for a textless pack must still be playable')

  // Hand the shared config back to the pack the rest of the suite expects.
  await put({ voicePack: 'neri' })
})

section('9. Balance + spend')
await check('/api/state degrades cleanly without a key', async () => {
  const res = await callRoute(route('/dsh-gal/api/state'), '/dsh-gal/api/state')
  const data = jsonOf(res)
  assert.equal(data.ok, true)
  assert.equal(data.balance.ok, false)
  assert.equal(data.balance.code, 'NO_KEY')
  assert.ok(Number.isFinite(data.today.amount), 'today.amount must be a number')
})
await check('the ledger only books a real decrease', async () => {
  const { createUsageService } = await import('../lib/usage.js')
  const file = path.join(process.env.TEMP || '/tmp', `dsg-ledger-${process.pid}.json`)
  fs.rmSync(file, { force: true })
  const service = createUsageService({ credentials: null, usageFiles: [file] })
  service.recordLedger(20, 'CNY') // first sample: baseline only
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).todayUsage, 0)
  service.recordLedger(19.5, 'CNY') // spent 0.5
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).todayUsage, 0.5)
  service.recordLedger(25, 'CNY') // top-up: never negative spend
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).todayUsage, 0.5)
  service.recordLedger(24, 'USD') // currency switch: re-base, do not book the jump
  const ledger = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(ledger.todayUsage, 0.5)
  assert.equal(ledger.lastCurrency, 'USD')
  fs.rmSync(file, { force: true })
})

section('10. Config round-trip')
await check('writes and re-reads a config patch', async () => {
  const handler = route('/dsh-gal/api/config')
  const put = await callRoute(handler, '/dsh-gal/api/config', {
    method: 'PUT',
    body: JSON.stringify({ scale: 8, volume: 0.25, lang: 'zh', dialogSide: 'below', dialogOpacity: 40 }),
  })
  const saved = jsonOf(put)
  assert.equal(saved.ok, true)
  assert.equal(saved.config.scale, 8)
  assert.equal(saved.config.volume, 0.25)
  assert.equal(saved.config.lang, 'zh')
  assert.equal(saved.config.dialogSide, 'below')
  assert.equal(saved.config.dialogOpacity, 40)

  const get = jsonOf(await callRoute(handler, '/dsh-gal/api/config'))
  assert.equal(get.config.scale, 8)
  assert.equal(get.config.dialogSide, 'below')
})
await check('scale is a bounded 1..10 level, never a runaway percentage', async () => {
  const handler = route('/dsh-gal/api/config')
  const put = async (patch) =>
    jsonOf(await callRoute(handler, '/dsh-gal/api/config', { method: 'PUT', body: JSON.stringify(patch) })).config
  // The whole point of the level scale: nothing can push the art — or the
  // settings panel anchored to it — somewhere it cannot be recovered from.
  assert.equal((await put({ scale: 999 })).scale, 10)
  assert.equal((await put({ scale: -4 })).scale, 1)
  assert.equal((await put({ scale: 0 })).scale, 1)
  assert.equal((await put({ scale: 3.4 })).scale, 3)
  assert.equal((await put({ scale: 3.6 })).scale, 4)
  assert.equal((await put({ dialogScale: 12 })).dialogScale, 10)
  assert.equal((await put({ dialogScale: 1 })).dialogScale, 1)
})
await check('clamps nonsense values instead of storing them', async () => {
  const handler = route('/dsh-gal/api/config')
  const put = async (patch) =>
    jsonOf(await callRoute(handler, '/dsh-gal/api/config', { method: 'PUT', body: JSON.stringify(patch) })).config
  assert.equal((await put({ dialogScale: 4 })).dialogScale, 4)
  const saved = await put({ volume: -5, dialogScale: 'huge', lang: 'klingon', dialogSide: 'sideways' })
  assert.equal(saved.volume, 0, 'a negative volume clamps to silence')
  assert.equal(saved.dialogScale, 4, 'an unusable number leaves the setting untouched')
  assert.equal(saved.lang, 'ja', 'anything that is not zh falls back to Japanese')
  assert.equal(saved.dialogSide, 'above')
})
await check('a v1 config file migrates percentages to levels', async () => {
  const file = path.join(TMP_HOME, '.dsh-gal.json')
  const snapshot = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  // v1 shipped 0.2..2.0 fractions; v2 ships 1..10 levels.
  fs.writeFileSync(file, JSON.stringify({ version: 1, scale: 0.7, dialogScale: 2, volume: 0.33 }), 'utf8')
  const harness2 = createHarness()
  const mod2 = await import(`../lib/index.js?migrate=${Date.now()}`)
  mod2.apply(harness2.ctx)
  const migrated = jsonOf(
    await callRoute(harness2.routes.get('/dsh-gal/api/config'), '/dsh-gal/api/config'),
  ).config
  assert.equal(migrated.version, 3, 'migration must land on the current version')
  assert.equal(migrated.scale, 7, '0.7 should become level 7')
  assert.equal(migrated.dialogScale, 10, 'the old 200% ceiling clamps to the new maximum')
  assert.equal(migrated.volume, 0.33, 'unrelated keys must survive migration')
  harness2.effects[0]()
  if (snapshot !== null) fs.writeFileSync(file, snapshot, 'utf8')
})
await check('a v2 config has its dialogue scale re-based by x2.5', async () => {
  const file = path.join(TMP_HOME, '.dsh-gal.json')
  const snapshot = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  // v3 changed the dialogue-box level unit, so an old level must be rescaled to
  // keep the same on-screen size: the comfortable old 2 is the new 5.
  fs.writeFileSync(file, JSON.stringify({ version: 2, scale: 6, dialogScale: 2, lang: 'zh' }), 'utf8')
  const harness3 = createHarness()
  const mod3 = await import(`../lib/index.js?rebase=${Date.now()}`)
  mod3.apply(harness3.ctx)
  const migrated = jsonOf(
    await callRoute(harness3.routes.get('/dsh-gal/api/config'), '/dsh-gal/api/config'),
  ).config
  assert.equal(migrated.version, 3)
  assert.equal(migrated.dialogScale, 5, 'old level 2 must become the new level 5')
  assert.equal(migrated.scale, 6, 'the art scale is untouched by this migration')
  assert.equal(migrated.lang, 'zh')
  harness3.effects[0]()
  if (snapshot !== null) fs.writeFileSync(file, snapshot, 'utf8')
})
await check('a migrated document is written back to disk once', async () => {
  const file = path.join(TMP_HOME, '.dsh-gal.json')
  const snapshot = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  fs.writeFileSync(file, JSON.stringify({ version: 2, dialogScale: 2 }), 'utf8')
  const harness4 = createHarness()
  const mod4 = await import(`../lib/index.js?persist=${Date.now()}`)
  mod4.apply(harness4.ctx)
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(onDisk.version, 3, 'the migrated document should be persisted')
  assert.equal(onDisk.dialogScale, 5)
  harness4.effects[0]()
  if (snapshot !== null) fs.writeFileSync(file, snapshot, 'utf8')
})
await check('persists the drag anchor', async () => {
  const handler = route('/dsh-gal/api/config')
  const saved = jsonOf(
    await callRoute(handler, '/dsh-gal/api/config', {
      method: 'PUT',
      body: JSON.stringify({ pos: { hx: 'left', hd: 120, vy: 'bottom', vd: 44 } }),
    }),
  )
  assert.deepEqual(saved.config.pos, { hx: 'left', hd: 120, vy: 'bottom', vd: 44 })
})
await check('config-only keys survive a rewrite', async () => {
  const handler = route('/dsh-gal/api/config')
  // `pricingFile` and `extraPackRoots` have no UI: they must not be dropped when
  // the widget PUTs an unrelated slider change.
  jsonOf(await callRoute(handler, '/dsh-gal/api/config', {
    method: 'PUT',
    body: JSON.stringify({ pricingFile: 'C:/tmp/prices.json', extraPackRoots: ['C:/tmp/packs'] }),
  }))
  const after = jsonOf(await callRoute(handler, '/dsh-gal/api/config', {
    method: 'PUT',
    body: JSON.stringify({ volume: 0.7 }),
  }))
  assert.equal(after.config.pricingFile, 'C:/tmp/prices.json')
  assert.deepEqual(after.config.extraPackRoots, ['C:/tmp/packs'])
  assert.equal(after.config.volume, 0.7)
})
await check('rejects a malformed body with 400', async () => {
  const res = await callRoute(route('/dsh-gal/api/config'), '/dsh-gal/api/config', {
    method: 'PUT',
    body: '{not json',
  })
  assert.equal(res.status, 400)
})

section('11. Per-turn cost')
await check('boots with an empty turn payload', async () => {
  const data = jsonOf(await callRoute(route('/dsh-gal/api/turn'), '/dsh-gal/api/turn'))
  assert.equal(data.ok, true)
  assert.equal(data.seq, 0)
  assert.equal(data.tokens, null)
})
await check('aggregates usage and settles on turn/end', async () => {
  const emit = harness.listeners.get('session/event')
  assert.ok(emit, 'no session/event listener')
  const session = { id: 'session-test' }
  const message = { source: { model: 'deepseek-v4-flash' } }
  emit(session, { type: 'assistant/message', data: { turn: 3, usage: { inputTokens: 1000, cacheReadTokens: 5000, outputTokens: 2000, reasoningTokens: 500 }, message } })
  emit(session, { type: 'assistant/message', data: { turn: 3, usage: { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 0, reasoningTokens: 0 }, message } })
  emit(session, { type: 'turn/end', data: {} })
  const data = jsonOf(await callRoute(route('/dsh-gal/api/turn'), '/dsh-gal/api/turn'))
  assert.equal(data.seq, 1)
  assert.equal(data.turn, 3)
  assert.equal(data.tokens, 1000 + 5000 + 2000 + 500 + 1000)
  assert.ok(data.amount > 0, `amount=${data.amount}`)
})
await check('keeps concurrent sessions in separate buckets', async () => {
  const emit = harness.listeners.get('session/event')
  const message = { source: { model: 'deepseek-v4-flash' } }
  emit({ id: 'session-a' }, { type: 'assistant/message', data: { turn: 1, usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 0, reasoningTokens: 0 }, message } })
  emit({ id: 'session-b' }, { type: 'assistant/message', data: { turn: 1, usage: { inputTokens: 9999, cacheReadTokens: 0, outputTokens: 0, reasoningTokens: 0 }, message } })
  emit({ id: 'session-a' }, { type: 'turn/end', data: {} })
  const afterA = jsonOf(await callRoute(route('/dsh-gal/api/turn'), '/dsh-gal/api/turn'))
  assert.equal(afterA.tokens, 10, 'session B leaked into session A\u2019s total')
  emit({ id: 'session-b' }, { type: 'turn/end', data: {} })
  const afterB = jsonOf(await callRoute(route('/dsh-gal/api/turn'), '/dsh-gal/api/turn'))
  assert.equal(afterB.tokens, 9999)
  assert.equal(afterB.seq, 3)
})
await check('a turn with no usage does not raise a false alarm', async () => {
  const emit = harness.listeners.get('session/event')
  const before = jsonOf(await callRoute(route('/dsh-gal/api/turn'), '/dsh-gal/api/turn')).seq
  emit({ id: 'session-empty' }, { type: 'turn/end', data: {} })
  const after = jsonOf(await callRoute(route('/dsh-gal/api/turn'), '/dsh-gal/api/turn')).seq
  assert.equal(after, before)
})
await check('a turn end reports the cost without starting a new interaction', () => {
  // Explicit product decision: the receipt is not another roll. No voice, no art
  // change, no fresh random line — only 消耗 / 花费 appear.
  const css = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8')
  const poll = css.slice(css.indexOf('async function pollTurn'), css.indexOf('async function refreshState'))
  assert.match(poll, /setTurnCost\(data\.tokens, data\.amount\)/, 'the cost must still be recorded')
  assert.match(poll, /showDialog\(\)/, 'the box must appear')
  assert.ok(!/roll\(/.test(poll), 'turn end must not roll a new line, voice or sprite')
  assert.match(poll, /cancelAutoHide\(\)/, 'the linger countdown must be re-armed for the receipt')
})

section('12. Dialogue plate crop')
{
  // Measured from the shipped artwork: the 1280x720 plate is pure white except
  // for a logo at x 865..1242, y 606..682. Cropping the empty top is what keeps
  // that logo large enough to read once the plate is scaled down.
  const LOGO = { left: 865 / 1280, right: 1242 / 1280, top: 606 / 720, bottom: 682 / 720 }
  let geo = null
  await check('/asset/ui/dialog.json describes the plate', async () => {
    const res = await callRoute(route('/dsh-gal/asset/ui/dialog.json'), '/dsh-gal/asset/ui/dialog.json')
    geo = jsonOf(res)
    assert.equal(geo.ok, true)
    assert.equal(geo.image.width, 1280)
    assert.equal(geo.image.height, 720)
  })
  await check('the crop cuts the empty top and reaches the bottom edge', () => {
    assert.ok(geo.crop.y > 0.25, `crop.y=${geo.crop.y}: the blank top should actually be removed`)
    assert.ok(geo.crop.y + geo.crop.h >= 0.999, `crop ends at ${geo.crop.y + geo.crop.h}, not the bottom edge`)
    assert.equal(geo.crop.x, 0)
    assert.equal(geo.crop.w, 1)
  })
  await check('the crop keeps the whole logo', () => {
    assert.ok(geo.crop.y <= LOGO.top, `crop starts at ${geo.crop.y}, below the logo top ${LOGO.top}`)
    assert.ok(geo.crop.y + geo.crop.h >= LOGO.bottom, 'crop ends above the logo bottom')
  })
  await check('the cropped plate is much wider than the raw 16:9', () => {
    const aspect = (geo.crop.w * geo.image.width) / (geo.crop.h * geo.image.height)
    assert.ok(aspect > 2.5, `aspect=${aspect.toFixed(2)} — cropping should yield a wide strip`)
    assert.ok(aspect < 4, `aspect=${aspect.toFixed(2)} — too extreme to hold two lines of text`)
  })
  await check('the footer is kept clear of the logo', () => {
    const inner = 1 - geo.inset.left - geo.inset.right
    const footerRight = geo.inset.left + geo.footer.maxWidthRatio * inner
    assert.ok(footerRight < LOGO.left, `footer reaches ${footerRight.toFixed(3)}, overlapping the logo at ${LOGO.left.toFixed(3)}`)
    assert.ok(geo.footer.heightRatio >= 0.25, 'the footer must be reserved a usable share of the height')
  })
  await check('the host and client fallbacks match assets/ui/dialog.json', async () => {
    const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/ui/dialog.json'), 'utf8'))
    const hostDefault = (await import('../lib/index.js')).DEFAULT_DIALOG_GEOMETRY
    for (const key of ['image', 'crop', 'inset', 'footer']) {
      assert.deepEqual(hostDefault[key], shipped[key], `host DEFAULT_DIALOG_GEOMETRY.${key} drifted`)
    }
    assert.equal(hostDefault.radius, shipped.radius)
    // The browser half cannot import anything, so its fallback is a literal that
    // has to be kept in step by hand — hence this check.
    const clientSource = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8')
    const match = clientSource.match(/const DEFAULT_DIALOG_GEO = (\{[\s\S]*?\n  \})/)
    assert.ok(match, 'DEFAULT_DIALOG_GEO not found in lib/client.js')
    // eslint-disable-next-line no-new-func
    const clientDefault = new Function(`return ${match[1]}`)()
    for (const key of ['image', 'crop', 'inset', 'footer']) {
      assert.deepEqual(clientDefault[key], shipped[key], `client DEFAULT_DIALOG_GEO.${key} drifted`)
    }
  })
  await check('bootstrap hands the geometry to the browser', async () => {
    const data = jsonOf(await callRoute(route('/dsh-gal/api/bootstrap'), '/dsh-gal/api/bootstrap'))
    assert.deepEqual(data.dialog.crop, geo.crop)
  })
}

section('13. Hidden UI must not swallow clicks')
{
  // Regression guard. Both the settings panel and the gear button are laid out
  // (and measured) while invisible, so a stray `pointer-events:auto` turns them
  // into invisible shields over the art: the art stops responding and the gear
  // can never be reached. This actually shipped once — hence the test.
  const css = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8')
  const rule = (selector) => {
    const start = css.indexOf(`${selector}{`)
    assert.ok(start >= 0, `rule ${selector} not found`)
    return css.slice(start, css.indexOf('}', start))
  }
  await check('the closed settings panel accepts no pointer events', () => {
    assert.match(rule('.dsg-panel'), /pointer-events:none/, 'closed panel is hit-testable')
    assert.match(rule('.dsg-panel.dsg-panel-open'), /pointer-events:auto/, 'open panel must be interactive')
  })
  await check('the hidden gear button accepts no pointer events', () => {
    assert.match(rule('.dsg-gear'), /pointer-events:none/, 'hidden gear is hit-testable')
    assert.match(rule('.dsg-root.dsg-hover .dsg-gear,.dsg-gear.dsg-gear-open'), /pointer-events:auto/)
  })
  await check('the gear outranks the panel so it can always close it', () => {
    const gearZ = Number(/z-index:(\d+)/.exec(rule('.dsg-gear'))?.[1])
    const panelZ = Number(/z-index:(\d+)/.exec(rule('.dsg-panel'))?.[1])
    assert.ok(gearZ > panelZ, `gear z-index ${gearZ} must exceed panel z-index ${panelZ}`)
  })
  await check('the art stays clickable across its whole box', () => {
    assert.match(rule('.dsg-sprite'), /pointer-events:auto/)
    // The image is click-through: hit testing must land on the box, which is
    // exactly the visible (cropped) area.
    assert.match(rule('.dsg-sprite-img'), /pointer-events:none/)
    assert.match(rule('.dsg-dialog'), /pointer-events:none/)
  })
}

section('14. Dialogue box auto-hide')
{
  const css = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8')
  await check('the box hides itself once the line has finished', () => {
    assert.match(css, /function scheduleAutoHide\(\)/, 'no auto-hide scheduler')
    assert.match(css, /state\.dialogShown = false/, 'the countdown must actually hide the box')
    assert.match(css, /scheduleAutoHide\(\)/, 'nothing ever schedules the hide')
  })
  await check('a new line resets any countdown left from the previous one', () => {
    assert.match(css, /function cancelAutoHide\(\)/)
    assert.match(css, /cancelAutoHide\(\)\n\s*\}/, 'resetLineGate must cancel the pending hide')
  })
  await check('auto-hide does not re-flow the art', () => {
    // Placement must reserve the box whenever the *setting* allows it, or the
    // art would jump up and down every few seconds.
    assert.match(css, /const dialogOn = c\.dialogEnabled !== false\n/, 'placement must ignore the transient show flag')
    assert.match(css, /const visible = m\.dialogOn && state\.dialogShown === true/)
  })
  await check('the box stays open while the settings panel is in use', () => {
    // Otherwise it vanishes mid-adjustment and the size/opacity sliders give no
    // visible feedback at all.
    assert.match(css, /if \(state\.panelOpen\) return/, 'auto-hide must pause while the panel is open')
    assert.match(css, /cancelAutoHide\(\)\s*\n\s*state\.dialogShown = true/, 'opening the panel must pin the box')
  })
  await check('hiding the box settles the art back to the pack default', () => {
    // A random frame left up after the line disappears reads as a glitch.
    assert.match(css, /function hideDialog\(\)/)
    const hide = css.slice(css.indexOf('function hideDialog()'), css.indexOf('async function roll'))
    assert.match(hide, /state\.dialogShown = false/, 'hideDialog must hide the box')
    assert.match(hide, /revertToDefaultSprite\(\)/, 'hideDialog must restore the default art')
    assert.match(hide, /applyLayout\(\)/, 'hideDialog must re-flow')
    assert.match(
      css,
      /hideTimer = setTimeout\(\(\) => \{\s*\n\s*hideTimer = null\s*\n\s*hideDialog\(\)/,
      'the timer must route through hideDialog',
    )
  })
  await check('the default art is the pack defaultSprite, and is opt-out', () => {
    const revert = css.slice(css.indexOf('function revertToDefaultSprite'), css.indexOf('async function roll'))
    assert.match(revert, /if \(cfg\(\)\.spriteRevertOnHide === false\) return/, 'the behaviour must be switchable off')
    assert.match(revert, /pack && pack\.defaultSprite/, 'it must use the pack defaultSprite, not a hardcoded name')
    assert.match(revert, /persist: false/, 'reverting must not rewrite the config on every hide')
    assert.match(revert, /pack\.crop \|\| \{ x: 0, y: 0, w: 1, h: 1 \}/, 'it must reuse the pack crop')
    // The random roll and the revert share one swap helper, so the
    // preload-then-commit behaviour cannot drift apart.
    assert.match(css, /function setSprite\(\{ file, url, crop, aspect, persist = true \}\)/)
    assert.match(css, /setSprite\(\{ file: data\.sprite\.file, url: data\.sprite\.url, crop, aspect \}\)/)
  })
  await check('the revert flag round-trips through the host', async () => {
    const handler = route('/dsh-gal/api/config')
    const put = async (patch) =>
      jsonOf(await callRoute(handler, '/dsh-gal/api/config', { method: 'PUT', body: JSON.stringify(patch) })).config
    assert.equal((await put({ spriteRevertOnHide: false })).spriteRevertOnHide, false)
    assert.equal((await put({ volume: 0.4 })).spriteRevertOnHide, false, 'an unrelated patch must not reset it')
    assert.equal((await put({ spriteRevertOnHide: true })).spriteRevertOnHide, true)
  })
  await check('the countdown waits for the voice, not just the text', () => {
    // Regression guard: hiding when the *text* finished cut long lines off
    // mid-sentence, because a spoken line outlasts the typewriter animation.
    assert.match(css, /let typingFinished = false/, 'no typing gate')
    assert.match(css, /let voiceFinished = true/, 'no voice gate')
    assert.match(css, /function noteTypingFinished\(\)/, 'no typing-complete signal')
    assert.match(css, /function noteVoiceFinished\(\)/, 'no voice-complete signal')
    assert.match(css, /function resetLineGate\(\)/, 'the gate must be reset per line')
    // Both signals must be required before the box may hide.
    assert.match(css, /if \(!holdLatched && voiceFinished\) scheduleAutoHide\(\)/, 'typing must wait for the voice')
    assert.match(css, /if \(!holdLatched && typingFinished\) scheduleAutoHide\(\)/, 'the voice must wait for the text')
    // The audio element has to report back, with a safety net for streams that
    // never fire `ended`.
    assert.match(css, /addEventListener\('ended', noteVoiceFinished/)
    assert.match(css, /addEventListener\('error', noteVoiceFinished/)
    assert.match(css, /voiceFallbackTimer = setTimeout\(noteVoiceFinished/)
    // And the typewriter must hand over to the gate rather than hiding directly.
    assert.match(css, /noteTypingFinished\(\)\n\s+return/, 'typing completion must not hide by itself')
    assert.ok(!/scheduleAutoHide\(\) \/\/ the line is complete/.test(css), 'the old text-only path is back')
  })
  await check('rendering a new line resets the gates and owns the sheet', () => {
    const render = css.slice(css.indexOf('function renderLine('), css.indexOf('function renderWallet('))
    assert.match(render, /resetLineGate\(\)/, 'the gates must reset per line')
    assert.match(render, /state\.sheet = 'line'/, 'a voice line must take over the sheet')
    assert.match(render, /applySheet\(\)/, 'the sheet change must be applied')
  })
  await check('the hold duration is configurable and clamped', async () => {
    const handler = route('/dsh-gal/api/config')
    const put = async (patch) =>
      jsonOf(await callRoute(handler, '/dsh-gal/api/config', { method: 'PUT', body: JSON.stringify(patch) })).config
    assert.equal((await put({ dialogHoldSeconds: 10 })).dialogHoldSeconds, 10)
    assert.equal((await put({ dialogHoldSeconds: 9999 })).dialogHoldSeconds, 120)
    assert.equal((await put({ dialogHoldSeconds: 0 })).dialogHoldSeconds, 0.5)
    assert.equal((await put({ dialogHoldSeconds: 3 })).dialogHoldSeconds, 3)
  })
}

section('15. Settings controls: units, centring, defaults')
{
  const css = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8')
  const rule = (selector) => {
    const start = css.indexOf(`${selector}{`)
    assert.ok(start >= 0, `rule ${selector} not found`)
    return css.slice(start, css.indexOf('}', start))
  }
  await check('dialogue opacity is a percentage at every site', () => {
    // The shipped bug: the slider divided by 100 (storing 0.4 for "40%") while
    // the formatter and the renderer both read it back as a percentage, so every
    // value rounded to 0 and the control looked broken.
    assert.match(css, /bindPercent\(ui\.dialogOpacity, 'dialogOpacity'/, 'opacity must use the percent binder')
    assert.ok(!/bindRange\(ui\.dialogOpacity/.test(css), 'the fraction binder would store 0.4 for a 40% slider')
    const binder = css.slice(css.indexOf('function bindPercent'), css.indexOf('function bindLevel'))
    assert.match(binder, /clamp\(Math\.round\(num\(input\.value, 0\)\), 0, 95\)/, 'the binder must store the raw percent')
    assert.ok(!/\/ 100/.test(binder), 'the percent binder must not divide')
    // Read sites must agree too.
    assert.match(css, /ui\.dialogOpacity\.value = String\(Math\.round\(num\(c\.dialogOpacity, 0\)\)\)/)
    assert.match(css, /1 - num\(c\.dialogOpacity, 0\) \/ 100/)
  })
  await check('volume keeps its 0..1 fraction unit', () => {
    const binder = css.slice(css.indexOf('function bindRange'), css.indexOf('function bindPercent'))
    assert.match(binder, /num\(input\.value, 50\) \/ 100/, 'volume is a 0..1 fraction')
    assert.match(css, /bindRange\(ui\.volume, 'volume'/)
  })
  await check('an opacity value survives the host round-trip', async () => {
    const handler = route('/dsh-gal/api/config')
    const put = async (patch) =>
      jsonOf(await callRoute(handler, '/dsh-gal/api/config', { method: 'PUT', body: JSON.stringify(patch) })).config
    for (const percent of [0, 1, 40, 95]) {
      const stored = (await put({ dialogOpacity: percent })).dialogOpacity
      assert.equal(stored, percent, `${percent}% did not survive the round-trip`)
    }
    assert.equal((await put({ dialogOpacity: 500 })).dialogOpacity, 95, 'opacity clamps at 95')
    assert.equal((await put({ dialogOpacity: 0 })).dialogOpacity, 0)
  })
  await check('a fraction left by the broken build is repaired, not honoured', async () => {
    const handler = route('/dsh-gal/api/config')
    const put = async (patch) =>
      jsonOf(await callRoute(handler, '/dsh-gal/api/config', { method: 'PUT', body: JSON.stringify(patch) })).config
    // 0.44 was "44%" as stored by the buggy slider; it must come back as 44.
    assert.equal((await put({ dialogOpacity: 0.44 })).dialogOpacity, 44)
    assert.equal((await put({ dialogOpacity: 0.95 })).dialogOpacity, 95)
    assert.equal((await put({ dialogOpacity: 0.01 })).dialogOpacity, 1)
    // Whole numbers are already percentages and must pass through untouched.
    assert.equal((await put({ dialogOpacity: 44 })).dialogOpacity, 44)
    assert.equal((await put({ dialogOpacity: 0 })).dialogOpacity, 0)
    assert.equal((await put({ dialogOpacity: 1 })).dialogOpacity, 1)
  })
  await check('dialogue box scale defaults to level 5', async () => {
    const mod = await import('../lib/index.js')
    assert.equal(mod.DEFAULT_CONFIG.dialogScale, 5)
    assert.match(css, /dialogScale: 5, dialogEnabled: true/, 'the browser fallback must match')
  })
  await check('the dialogue level unit is re-based so level 5 == the old level 2', async () => {
    const mod = await import('../lib/index.js')
    // Old unit was 1/10 per level, so old level 2 was 0.2 of the base width.
    // The new unit must reproduce that at level 5.
    assert.equal(mod.DIALOG_LEVEL_UNIT, 0.04)
    assert.equal(5 * mod.DIALOG_LEVEL_UNIT, 0.2)
    const clientUnit = Number(/const DIALOG_LEVEL_UNIT = ([\d.]+)/.exec(css)?.[1])
    assert.equal(clientUnit, mod.DIALOG_LEVEL_UNIT, 'host and browser must share the same unit')
    assert.match(css, /const dialogFactor = \(level\) => clamp\(num\(level, 5\), SCALE_MIN, SCALE_MAX\) \* DIALOG_LEVEL_UNIT/)
    // The art keeps its own /10 unit.
    assert.match(css, /const levelFactor = \(level\) => clamp\(num\(level, 5\), SCALE_MIN, SCALE_MAX\) \/ 10/)
    assert.ok(!/dlgW = clamp\([^\n]*levelFactor/.test(css), 'the box must not fall back to the art unit')
  })
  await check('every dialogue level produces a distinct width', async () => {
    const mod = await import('../lib/index.js')
    const base = 1040
    const widths = []
    for (let level = 1; level <= 10; level++) {
      widths.push(Math.max(70, Math.min(base * level * mod.DIALOG_LEVEL_UNIT, 1920 * 0.96)))
    }
    for (let i = 1; i < widths.length; i++) {
      assert.ok(widths[i] > widths[i - 1], `level ${i + 1} is not larger than level ${i}: ${widths.join(', ')}`)
    }
    assert.equal(widths[4], 208, 'level 5 should be the 208px the old level 2 produced')
  })
  await check('the two level controls are steppers, not sliders', () => {
    // A 10-stop slider was fiddly to land on; arrows are unambiguous.
    for (const key of ['scale', 'dialog-scale']) {
      assert.ok(css.includes(`data-act="${key}-dec"`), `${key} needs a decrement button`)
      assert.ok(css.includes(`data-act="${key}-inc"`), `${key} needs an increment button`)
    }
    assert.ok(!/type="range" data-act="scale"/.test(css), 'the art slider is back')
    assert.ok(!/type="range" data-act="dialog-scale"/.test(css), 'the box slider is back')
    assert.match(css, /function bindStepper\(/)
    assert.match(css, /bindStepper\(ui\.scaleDec, ui\.scaleInc, ui\.scaleVal, 'scale'\)/)
    assert.match(css, /bindStepper\(ui\.dialogScaleDec, ui\.dialogScaleInc, ui\.dialogScaleVal, 'dialogScale'\)/)
    // The ends disable themselves so the 1..10 range is visible.
    assert.match(css, /decEl2\.disabled = value <= SCALE_MIN/)
    assert.match(css, /incEl2\.disabled = value >= SCALE_MAX/)
    // Volume and opacity keep their sliders.
    assert.match(css, /type="range" data-act="volume"/)
    assert.match(css, /type="range" data-act="dialog-opacity"/)
  })
  await check('the footer figures are unbreakable units', () => {
    // Without this a narrow box wrapped "余额" onto its own line, away from the
    // amount it labels.
    assert.match(rule('.dsg-cost,.dsg-wallet'), /flex-wrap:wrap/, 'rows must still wrap between figures')
    assert.match(rule('.dsg-cost>*,.dsg-wallet>*'), /white-space:nowrap/, 'a figure must not split')
    assert.match(css, /class="dsg-kv"><span class="dsg-k">余额<\/span>/, 'label and amount must share one unit')
    assert.match(css, /class="dsg-kv"><span class="dsg-k">今日已用<\/span>/, 'today must share one unit')
  })
  await check('the strip auto-fits and never grows taller than its cap', () => {
    // It is sized to its content, capped by the reserved ratio. A fixed share of
    // a short plate is smaller than two rows of text, and because the strip is
    // bottom-aligned, the overflow rode up over the dialogue line.
    assert.match(css, /function fitFooter\(dlgW, cap, full\)/, 'the strip needs a fit pass with a cap')
    assert.match(css, /foot\.style\.height = 'auto'/, 'the strip must be content-sized, not ratio-pinned')
    assert.match(css, /const height = full \? budget : Math\.min\(used, budget\)/, 'the height must be capped')
    assert.match(css, /foot\.style\.overflow = 'hidden'/, 'an over-tall strip must clip rather than ride up')
    assert.match(css, /const footerH = fitFooter\(m\.dlgW, figuresFull \? box\.innerH : box\.footerCap, figuresFull\)/)
    assert.ok(
      !/foot\.style\.height = `\$\{Math\.round\(innerH \* footerRatio\)\}px`/.test(css),
      'the ratio-pinned height is back',
    )
  })
  await check('a short line is capped instead of filling the plate', () => {
    // "As large as the box allows" is the wrong goal for a caption: a one-character
    // line grew to 44px on a large plate, which reads as a shout. The cap only ever
    // binds on short lines — a long one is limited by the box long before it.
    const cap = Number((/const MAX_LINE_FONT = ([\d.]+)/.exec(css) || [])[1])
    assert.ok(Number.isFinite(cap), 'MAX_LINE_FONT is gone')
    assert.ok(cap <= 34, `MAX_LINE_FONT ${cap}px is back in fill-the-box territory`)
    assert.ok(cap > 12, `MAX_LINE_FONT ${cap}px would make a short line timid`)
    assert.match(css, /const hi = clamp\(avail \* 0\.86, 8, MAX_LINE_FONT\)/, 'the fit must respect the cap')
    assert.ok(!/clamp\(avail \* 0\.86, 8, 44\)/.test(css), 'the old 44px ceiling is back')
    // The floor must stay low: a long line still has to fit a short plate.
    assert.match(css, /const MIN_LINE_FONT = 5/)
    assert.match(css, /Math\.max\(MIN_LINE_FONT, Math\.floor\(size \* 10\) \/ 10\)/, 'the floor must still be honoured')
  })
  await check('the figure sheets take over the whole plate', () => {
    // Clicking the box must show ONLY 余额/今日已用 — so the voice line is hidden
    // outright and the figures stop being a strip and become the content.
    assert.match(css, /const figures = sheet === 'cost' \|\| sheet === 'wallet'/)
    assert.match(css, /lineBox\.classList\.toggle\('dsg-line-off', figures\)/, 'the voice line must be hidden')
    assert.match(css, /foot\.classList\.toggle\('dsg-foot-off', !figures\)/)
    assert.match(css, /foot\.classList\.toggle\('dsg-foot-full', figures\)/)
    assert.match(css, /\.dsg-line\.dsg-line-off\{display:none\}/, 'the line must really be removed')
    // The class rule alone is NOT enough: applyLayout() writes an inline max-width,
    // which outranks it. That is exactly how the figures ended up centred inside a
    // left-hugging 66% strip while this assertion passed.
    assert.match(css, /\.dsg-foot\.dsg-foot-full\{[^}]*max-width:none/, 'the figures must not stay in the narrow strip')
    assert.match(css, /foot\.style\.maxWidth = figuresFull\s*\?\s*'none'/, 'the inline cap must be lifted too')
    assert.ok(
      !/^\s*foot\.style\.maxWidth = `\$\{Math\.round\(innerW/m.test(css),
      'an unconditional inline cap is back: it outranks the class rule',
    )
  })
  await check('the receipt is black, centred and holds for 5s', () => {
    // Both figures read as plain black, like the voice line. The old pink/lilac
    // pair only stayed legible on the white plate thanks to a dark text-shadow,
    // which smudged the glyphs; weight carries the emphasis instead.
    assert.ok(!/D2778D|E6C9F0/.test(css), 'the old status colours are back')
    assert.match(css, /\.dsg-cost,\.dsg-wallet\{color:#242424\}/, 'the figures must be black')
    assert.match(css, /\.dsg-cost b\{font-weight:700\}/, 'the amount keeps its weight, not its colour')
    assert.ok(!/\.dsg-cost\{[^}]*text-shadow/.test(css), 'black text needs no shadow')

    // The receipt appears unasked, so it lingers longer than a voice line does.
    assert.match(css, /const COST_HOLD_SECONDS = 5/, 'the receipt must hold for 5s')
    assert.match(
      css,
      /return computeHoldSeconds\(state\.sheet, cfg\(\)\.dialogHoldSeconds, COST_HOLD_SECONDS\)/,
      'the countdown must ask for the right duration',
    )
    const hold = css.slice(css.indexOf('function holdSeconds()'), css.indexOf('function scheduleAutoHide'))
    assert.ok(!/setTimeout/.test(hold), 'the duration decision belongs in the pure, testable block')
    assert.match(css, /const hold = holdSeconds\(\)/, 'scheduleAutoHide must use it')
  })
  await check('the figure sheets stay clear of the logo', () => {
    // The logo's top edge is 72.8% down the artwork; the inner box starts at 7%
    // and spans 89%, so (72.8-7)/89 = 0.739 is the last safe share.
    const share = Number(/const LOGO_SAFE_SHARE = ([\d.]+)/.exec(css)?.[1])
    assert.ok(Number.isFinite(share), 'LOGO_SAFE_SHARE not found')
    assert.ok(share <= 0.739, `share ${share} would put the figures on the logo`)
    assert.match(css, /Math\.round\(cap \* LOGO_SAFE_SHARE\)/, 'the band must be derived from the safe share')
    // The band must be measured against the true inner height, not a padded one —
    // inflating it pushed the band down over the logo on the smallest plates.
    assert.match(css, /const innerH = Math\.max\(1, m\.dlgH/, 'innerH must not be inflated to a floor')
    assert.ok(!/Math\.max\(24, m\.dlgH/.test(css), 'the padded inner height is back')
  })
  await check('the strip fit is measured fractionally too', () => {
    const fit = css.slice(css.indexOf('function fitFooter'), css.indexOf('function refitLine'))
    assert.match(fit, /const measure = \(\) => foot\.getBoundingClientRect\(\)\.height/)
    assert.ok(!/foot\.offsetHeight/.test(fit), 'integer measurement lets up to 1.5px overflow through')
    assert.match(fit, /measure\(\) > budget \+ 0\.5/, 'tolerance must be sub-pixel')
  })
  await check('the line may shrink far enough to fit a short plate', () => {
    // Regression guard for the reported bug: at level 4 and below a long line
    // could not fit at all because the font was floored at 12px, so it overflowed
    // and `overflow:hidden` cut it off exactly at the footer's top edge — the
    // balance figures looked like they were covering the text.
    const floor = Number(/const MIN_LINE_FONT = ([\d.]+)/.exec(css)?.[1])
    assert.ok(Number.isFinite(floor), 'MIN_LINE_FONT not found')
    assert.ok(floor <= 6, `the line floor is ${floor}px — a long line in a short plate would be clipped`)
    const fitLine = css.slice(css.indexOf('function fitLine'), css.indexOf('let typingTimer'))
    assert.match(fitLine, /let low = MIN_LINE_FONT/, 'the search must reach the floor')
    assert.ok(!/Math\.min\(12, hi\)/.test(fitLine), 'the old 12px floor is back')
  })
  await check('the chosen font is never rounded up past a wrap boundary', () => {
    // The real cause of the level-4 miss: the search won at 6.19px, `toFixed(1)`
    // rounded that to 6.2px, the extra 0.01px pushed a character onto a new line,
    // and the box overflowed by 4px. Round down, then verify.
    const commit = css.slice(css.indexOf('function commitLineFont'), css.indexOf('function fitLine'))
    assert.match(commit, /Math\.floor\(size \* 10\) \/ 10/, 'the size must be rounded down')
    assert.ok(!/toFixed\(1\)\}`/.test(commit), 'toFixed rounds up and reintroduces the bug')
    assert.match(
      commit,
      /while \(chosen > MIN_LINE_FONT && lineTextHeight\(\) > avail \+ 0\.5/,
      'must walk back until it truly fits',
    )
    // Both fitLine exit paths must go through the verified commit.
    assert.ok(!/lineInner\.style\.fontSize = `\$\{hi\.toFixed/.test(css), 'the hi path must also be verified')
  })
  await check('the fit is measured with sub-pixel precision', () => {
    // `clientHeight`/`scrollHeight` are integers and their 1px of slack let a
    // level-9 box overflow by 1.3px while still reporting "fits".
    assert.match(css, /const lineAvail = \(\) => lineBox\.getBoundingClientRect\(\)\.height/)
    assert.match(css, /const lineTextHeight = \(\) => lineInner\.getBoundingClientRect\(\)\.height/)
    const fit = css.slice(css.indexOf('function fitLine'), css.indexOf('let typingTimer'))
    assert.ok(!/lineInner\.scrollHeight/.test(fit), 'the integer measurement is back in the search')
    assert.ok(!/lineBox\.clientHeight/.test(fit), 'the integer container measurement is back')
  })
  await check('a line that cannot fit at all is marked as truncated', () => {
    // Levels 1-3 are too small for the longest line. Fading the cut edge makes
    // that read as "there is more" rather than as an overlap.
    assert.match(css, /dsg-line-clipped/, 'no truncation cue class')
    assert.match(css, /lineBox\.classList\.toggle\('dsg-line-clipped'/, 'the cue must follow the measurement')
    assert.match(css, /\.dsg-line-clipped\{[^}]*mask-image/, 'the cue must be visible')
  })
  await check('the line is re-fit when the strip changes height', () => {
    // The receipt and the balance are different sheets, and switching between
    // them (or to the bare voice line) changes how much room the text has.
    assert.match(css, /function syncFooter\(\)/)
    assert.match(css, /const used = fitFooter\(box\.m\.dlgW, full \? box\.innerH : box\.footerCap, full\)/)
    assert.match(css, /x\$\{Math\.round\(footerH\)\}/, 'the fit key must include the footer height')
    const sheet = css.slice(css.indexOf('function applySheet()'), css.indexOf('function shorten'))
    assert.match(sheet, /syncFooter\(\)/, 'every sheet change must resync the strip')
    // All three sheets must be reachable and mutually exclusive.
    assert.match(sheet, /costLine\.classList\.toggle\('dsg-cost-off', sheet !== 'cost'\)/)
    assert.match(sheet, /walletLine\.classList\.toggle\('dsg-wallet-off', sheet !== 'wallet'\)/)
    assert.match(sheet, /foot\.classList\.toggle\('dsg-foot-off', !figures\)/)
  })
  await check('the strip is removed entirely for a voice line', () => {
    // That is what buys back the vertical room levels 3-4 were short of.
    const fit = css.slice(css.indexOf('function fitFooter'), css.indexOf('function syncFooter'))
    assert.match(fit, /classList\.contains\('dsg-foot-off'\)/, 'a hidden strip must report zero height')
    assert.match(fit, /foot\.style\.height = '0px'/)
    assert.match(css, /\.dsg-foot\.dsg-foot-off\{display:none\}/, 'the strip must actually be removed')
  })
  await check('clicking the box swaps to the balance and resets the countdown', () => {
    const walletSheet = css.slice(css.indexOf('function renderWalletSheet'), css.indexOf('function setTurnCost'))
    assert.match(walletSheet, /state\.sheet = 'wallet'/, 'clicking must select the balance sheet')
    assert.match(walletSheet, /state\.dialogShown = true/, 'the box must be on screen')
    // "3 seconds from this click" — not "3 seconds after the voice ends".
    assert.match(walletSheet, /holdLatched = true/, 'the gate must stop managing the countdown')
    assert.match(walletSheet, /scheduleAutoHide\(\)/, 'the countdown must restart from now')
    // The box is only clickable while visible, so it can never shield the art.
    assert.match(css, /\.dsg-root\.dsg-dialog-on \.dsg-dialog\{[^}]*pointer-events:auto/, 'the box must be clickable')
    assert.match(css, /\.dsg-dialog\{[^}]*pointer-events:none/, 'a hidden box must stay click-through')
    assert.match(css, /dialog\.addEventListener\('click'/, 'the click handler must be wired')
  })
  await check('a voice with no transcript shows the balance instead of a placeholder', () => {
    // The pack may ship no script.csv at all. There is nothing to print, so the
    // box falls back to 余额 / 今日已用 — the click is still a voice interaction.
    const pick = css.slice(css.indexOf('function renderVoiceSheet('), css.indexOf('function showNotice('))
    assert.match(pick, /if \(currentLine\(\)\)/, 'a transcribed voice must still get its line')
    assert.match(pick, /renderLine\(\)/, 'the transcribed path must render the line')
    assert.match(pick, /showVoiceWalletSheet\(\{ waitForVoice \}\)/, 'a textless voice must fall back to the figures')
    // Boot renders the widget before the first roll; without this guard the box
    // would flash a "no transcript" sheet for a moment on every page load.
    assert.match(pick, /if \(!state\.voice\) return/, 'boot must not flash a sheet before the first roll')

    const render = css.slice(css.indexOf('function renderLine('), css.indexOf('function renderVoiceSheet('))
    assert.ok(!/finalText/.test(render), 'the old placeholder fallback is back')
    assert.ok(!/未找到立绘包/.test(render), 'the missing-pack notice belongs to the click path now')
    assert.match(css, /showNotice\('未找到立绘包/, 'the missing-pack notice must still be reachable')
    // And there is no longer any honest way to print the placeholder.
    assert.ok(!/showLine\('（此语音没有对应台词）'\)/.test(css), 'the placeholder must be gone')
  })
  await check('with a voice pending, the figures wait for it before counting down', () => {
    const figures = css.slice(css.indexOf('function showVoiceWalletSheet('), css.indexOf('function setTurnCost'))
    assert.match(figures, /resetLineGate\(\)/, 'a stale countdown must not survive into the new sheet')
    assert.match(figures, /typingFinished = true/, 'a figure sheet has nothing to type')
    assert.match(figures, /if \(!waitForVoice\) scheduleAutoHide\(\)/, 'a pending voice must own the countdown')
    // The click path must hand the gate over to the audio rather than arming the
    // countdown itself, or a long clip would be cut off.
    const roll = css.slice(css.indexOf('async function roll('), css.indexOf('function onSpriteClick('))
    assert.match(roll, /const willPlay = playAudio && Boolean\(data\.voice\.url\)/, 'only real audio may hold the box')
    assert.match(roll, /renderVoiceSheet\(\{ waitForVoice: willPlay \}\)/, 'the click must pass the pending sound on')
    assert.match(roll, /if \(willPlay\) playVoice\(data\.voice\.url\)/, 'the voice must play either way')
    assert.match(css, /addEventListener\('ended', noteVoiceFinished/, 'the countdown must start when the audio ends')
  })
  await check('switching the sheet is silent, but the gear still clicks', () => {
    const handler = css.slice(css.indexOf("dialog.addEventListener('click'"), css.indexOf('function togglePanel'))
    assert.ok(!/playClick\(/.test(handler), 'the box must not play the button sound')
    assert.match(handler, /showWalletSheet\(\)/, 'it must still swap the sheet')
    // The settings button is a real button and keeps its sound.
    const gear = css.slice(css.indexOf("gear.addEventListener('click'"), css.indexOf("dialog.addEventListener('click'"))
    assert.match(gear, /playClick\(\)/, 'the gear must keep its click sound')
  })
  await check('a latched countdown ignores late typing/voice callbacks', () => {
    // Otherwise a voice that happens to still be playing would silently extend
    // the 3 seconds the user just asked for.
    assert.match(css, /let holdLatched = false/)
    assert.match(css, /if \(!holdLatched && voiceFinished\) scheduleAutoHide\(\)/)
    assert.match(css, /if \(!holdLatched && typingFinished\) scheduleAutoHide\(\)/)
    assert.match(css, /function resetLineGate\(\)[\s\S]*?holdLatched = false/, 'a new line must unlatch')
  })
  await check('re-fitting never truncates an animation in flight', () => {
    assert.match(css, /if \(typingTimer\) return/, 'refitLine must leave a running animation alone')
    assert.match(css, /fitLine\(\)\n\s+\/\/ The text is done/, 'the animation must settle the size itself')
  })
  await check('dialogue content is centred', () => {
    assert.match(rule('.dsg-line'), /text-align:center/, 'the line must be centred')
    assert.match(rule('.dsg-cost,.dsg-wallet'), /justify-content:center/, 'the footer rows must be centred')
  })
}

section('16. Dialogue box placement')
{
  // The placement maths is fenced by @pure-start/@pure-end in lib/client.js so it
  // can be lifted out of the browser IIFE and driven directly here.
  const clientSource = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8')
  const block = clientSource.match(/\/\* @pure-start \*\/([\s\S]*?)\/\* @pure-end \*\//)
  await check('the pure placement block is present and extractable', () => {
    assert.ok(block, '@pure-start/@pure-end markers not found in lib/client.js')
    assert.ok(block[1].includes('function computePlacement'))
    assert.ok(block[1].includes('function computeHoldSeconds'))
    assert.ok(block[1].includes('function readTurnPoll'))
    assert.ok(block[1].includes('function formatTokenCount'))
    assert.ok(!block[1].includes('document.'), 'placement maths must not touch the DOM')
  })
  // eslint-disable-next-line no-new-func
  const computePlacement = new Function(`${block[1]}\nreturn computePlacement`)()
  // eslint-disable-next-line no-new-func
  const computeHoldSeconds = new Function(`${block[1]}\nreturn computeHoldSeconds`)()
  // eslint-disable-next-line no-new-func
  const readTurnPoll = new Function(`${block[1]}\nreturn readTurnPoll`)()
  // eslint-disable-next-line no-new-func
  const formatTokenCount = new Function(`${block[1]}\nreturn formatTokenCount`)()
  await check('token counts are shown in K and M', () => {
    // A receipt is read at a glance: "128,453" has to be parsed digit by digit.
    assert.equal(formatTokenCount(128453), '128.5K')
    assert.equal(formatTokenCount(12483), '12.5K')
    assert.equal(formatTokenCount(1500), '1.5K')
    assert.equal(formatTokenCount(1234567), '1.23M')
    assert.equal(formatTokenCount(1500000), '1.5M')
    // Short counts stay exact: the unit never hides precision that still fits.
    assert.equal(formatTokenCount(845), '845')
    assert.equal(formatTokenCount(999), '999')
    assert.equal(formatTokenCount(0), '0')
    // Trailing zeros are trimmed, not padded.
    assert.equal(formatTokenCount(2000), '2K')
    assert.equal(formatTokenCount(2000000), '2M')
    // Never round up *across* a unit boundary: "1000.0K" and "1000" are the traps.
    assert.equal(formatTokenCount(999950), '1M')
    assert.equal(formatTokenCount(999999), '1M')
    assert.equal(formatTokenCount(999600), '999.6K')
    // Rubbish in, placeholder out — never "NaN token".
    for (const bad of [null, undefined, 'x', NaN]) assert.equal(formatTokenCount(bad), '--', `tokens=${bad}`)
    // The receipt must actually use it, and the old comma formatting must be gone.
    const render = clientSource.slice(clientSource.indexOf('function renderCost()'), clientSource.indexOf('function applySheet'))
    assert.match(render, /formatTokenCount\(state\.cost\.tokens\)/, 'the receipt must use the K/M formatter')
    assert.ok(!/toLocaleString/.test(clientSource), 'the comma-separated formatter is back')
  })
  await check('the FIRST turn after a restart still produces a receipt', () => {
    // The bug this guards: the counter stays 0 until a turn settles, so "it was 0
    // before" was mistaken for "this reading is only a baseline" — and the very
    // first conversation after every DSH restart printed no receipt at all.
    const first = readTurnPoll(0, true, 1, 128453, 0.2841)
    assert.equal(first.show, true, 'the first turn after a restart must be shown')
    assert.equal(first.seq, 1)
    assert.equal(first.aligned, true)

    // A page that boots before the counters move must align on the reading, not
    // spend the first real turn on it.
    const cold = readTurnPoll(0, false, 0, null, null)
    assert.deepEqual(cold, { aligned: true, seq: 0, show: false }, 'the first reading is a baseline')
    assert.equal(readTurnPoll(cold.seq, cold.aligned, 1, 500, 0.01).show, true, 'and the next one is real')
  })
  await check('no stale receipt when a page reloads, and no repeats', () => {
    // Bootstrap reports the counter as of now, so a turn that settled *before* this
    // page loaded must not print again on every refresh...
    assert.equal(readTurnPoll(7, true, 7, 999, 9).show, false, 'the same seq is not a new turn')
    // ...but the next one must.
    assert.equal(readTurnPoll(7, true, 8, 999, 9).show, true)
    // Without a bootstrap reading, the first poll is the baseline (it may well be a
    // turn that settled minutes ago).
    assert.equal(readTurnPoll(0, false, 7, 999, 9).show, false, 'an unknown first reading is a baseline')
  })
  await check('a turn with nothing to report shows nothing', () => {
    assert.equal(readTurnPoll(3, true, 4, 0, 0).show, false, 'zero tokens and zero cost is not a receipt')
    assert.equal(readTurnPoll(3, true, 4, 0, 0.0004).show, true, 'a cost is enough on its own')
    assert.equal(readTurnPoll(3, true, 4, 120, 0).show, true, 'tokens alone are enough too')
    // Garbage must neither advance the counter nor print anything.
    for (const bad of [null, undefined, 'x', NaN]) {
      assert.deepEqual(readTurnPoll(3, true, bad, 5, 5), { aligned: true, seq: 3, show: false }, `seq=${bad}`)
    }
  })
  await check('the receipt holds for 5s, everything else follows the config', () => {
    // The receipt appears unasked, so it gets a duration of its own rather than the
    // 3s a voice line (which the user asked for by clicking) gets.
    assert.equal(computeHoldSeconds('cost', 3, 5), 5)
    assert.equal(computeHoldSeconds('cost', 600, 5), 5, 'the receipt must not inherit a pinned hold')
    assert.equal(computeHoldSeconds('cost', undefined, undefined), 5, 'the receipt falls back to 5')
    assert.equal(computeHoldSeconds('line', 3, 5), 3)
    assert.equal(computeHoldSeconds('wallet', 10, 5), 10, 'the balance table follows the config')
    assert.equal(computeHoldSeconds('line', undefined, 5), 3, 'a missing config falls back to 3')
    assert.equal(computeHoldSeconds('line', 9999, 5), 120, 'the configured hold is clamped')
    assert.equal(computeHoldSeconds('line', 0, 5), 0.5)
  })
  const base = { vw: 1920, vh: 1080, contentW: 316, contentH: 310, dlgW: 380, dlgH: 214, gap: 10 }
  const place = (over) => computePlacement({ ...base, hx: 'right', hd: 24, vy: 'bottom', vd: 24, side: 'above', dialogOn: true, ...over })
  const onScreen = (r) => {
    assert.ok(r.sy + r.dy >= -0.001, `plate top ${r.sy + r.dy} is above the viewport`)
    assert.ok(r.sy + r.dy + base.dlgH <= base.vh + 0.001, `plate bottom ${r.sy + r.dy + base.dlgH} is below the viewport`)
    assert.ok(r.sx + r.dx >= -0.001, `plate left ${r.sx + r.dx} is off screen`)
    assert.ok(r.sx + r.dx + base.dlgW <= base.vw + 0.001, `plate right ${r.sx + r.dx + base.dlgW} is off screen`)
  }

  await check('default (bottom-right, 上方): plate sits above the art, nothing moves', () => {
    const r = place({})
    assert.equal(r.sy, 1080 - 24 - 310)
    assert.equal(r.dy, -214 - 10)
    assert.ok(r.dy + base.dlgH <= 0, 'plate should be fully above the art')
    onScreen(r)
  })
  await check('an art box with room on both sides centres the plate on it', () => {
    // Anchored 600px from the left on a 1920 viewport: no clamping needed.
    const r = place({ hx: 'left', hd: 600 })
    assert.equal(r.sx, 600)
    assert.equal(r.dx, (base.contentW - base.dlgW) / 2)
    assert.equal(r.sx + r.dx + base.dlgW / 2, r.sx + base.contentW / 2, 'plate centre should match art centre')
    onScreen(r)
  })
  await check('下方 + art pinned to the bottom: plate shares the bottom edge', () => {
    const r = place({ side: 'below', vy: 'bottom', vd: 0 })
    assert.equal(r.sy, 1080 - 310)
    assert.equal(r.dy, 310 - 214, 'plate bottom should coincide with the art bottom')
    assert.equal(r.sy + r.dy + base.dlgH, 1080)
    onScreen(r)
  })
  await check('下方 + partial gap: art is nudged up so the plate fits', () => {
    const r = place({ side: 'below', vy: 'bottom', vd: 30 })
    const before = 1080 - 30 - 310
    assert.ok(r.sy < before, `art was not nudged up (${r.sy} vs ${before})`)
    assert.equal(r.dy, 310 + 10)
    assert.equal(r.sy + r.dy + base.dlgH, 1080, 'plate should end exactly at the bottom edge')
    onScreen(r)
  })
  await check('下方 + plenty of room: plate is simply placed underneath', () => {
    const r = place({ side: 'below', vy: 'top', vd: 100 })
    assert.equal(r.sy, 100, 'art should not move when there is room')
    assert.equal(r.dy, 310 + 10)
    onScreen(r)
  })
  await check('上方 + art pinned to the top: plate flips underneath', () => {
    const r = place({ side: 'above', vy: 'top', vd: 0 })
    assert.equal(r.sy, 0, 'art should stay at the top')
    assert.equal(r.dy, 310 + 10, 'plate should be below the art')
    onScreen(r)
  })
  await check('上方 + partial gap: art is nudged down so the plate fits', () => {
    const r = place({ side: 'above', vy: 'top', vd: 40 })
    assert.ok(r.sy > 40, 'art was not nudged down')
    assert.equal(r.dy, -214 - 10)
    assert.equal(r.sy + r.dy, 0, 'plate should start exactly at the top edge')
    onScreen(r)
  })
  await check('plate is pulled inside the viewport near the right edge', () => {
    const r = place({})
    assert.equal(r.sx + r.dx + base.dlgW, base.vw, 'plate should be flush with the right edge')
    onScreen(r)
  })
  await check('art anchored to the left keeps the plate on screen too', () => {
    const r = place({ hx: 'left', hd: 0 })
    assert.equal(r.sx, 0)
    assert.equal(r.sx + r.dx, 0)
    onScreen(r)
  })
  await check('a dialog switched off never moves the art', () => {
    const off = place({ dialogOn: false, side: 'above', vy: 'top', vd: 0 })
    assert.equal(off.sy, 0)
    assert.equal(off.dx, (base.contentW - base.dlgW) / 2)
  })
  await check('a plate taller than the viewport still cannot escape', () => {
    const r = computePlacement({
      ...base, dlgW: 1800, dlgH: 1012, hx: 'right', hd: 24, vy: 'bottom', vd: 24, side: 'above', dialogOn: true,
    })
    assert.ok(r.sy + r.dy >= -0.001)
    assert.ok(Number.isFinite(r.sx) && Number.isFinite(r.sy))
  })

  // The settings panel holds the only control that can shrink the art again, so
  // it must never be pushed somewhere unreachable — that is exactly how the old
  // percentage slider trapped users at a runaway size.
  // eslint-disable-next-line no-new-func
  const computePanelPlacement = new Function(`${block[1]}\nreturn computePanelPlacement`)()
  const panelIn = (over) => ({
    vw: 1920, vh: 1080, contentW: 316, contentH: 310, panelW: 272, panelH: 460, sx: 1580, sy: 746, ...over,
  })
  const panelOnScreen = (r, input) => {
    assert.ok(input.sx + r.px >= -0.001, `panel left ${input.sx + r.px} is off screen`)
    assert.ok(input.sx + r.px + input.panelW <= input.vw + 0.001, 'panel is off the right edge')
    assert.ok(input.sy + r.py >= -0.001, `panel top ${input.sy + r.py} is above the viewport`)
    assert.ok(
      input.sy + r.py + input.panelH <= input.vh + 0.001,
      `panel bottom ${input.sy + r.py + input.panelH} is below the viewport`,
    )
  }
  await check('the settings panel opens above the art by default', () => {
    const input = panelIn({})
    const r = computePanelPlacement(input)
    assert.equal(r.py, -460 - 8)
    panelOnScreen(r, input)
  })
  await check('the panel is never pushed off screen by a maximum-size art', () => {
    // Level 10 art sits on the bottom edge with no room above it.
    const input = panelIn({ contentW: 620, contentH: 620, sx: 1300, sy: 1080 - 24 - 620 })
    const r = computePanelPlacement(input)
    panelOnScreen(r, input)
  })
  await check('the panel stays reachable at every art size and anchor', () => {
    for (const contentH of [62, 200, 400, 620]) {
      for (const contentW of [64, 316, 620]) {
        for (const corner of ['left-top', 'left-bottom', 'right-top', 'right-bottom']) {
          const input = panelIn({
            contentH,
            contentW,
            sx: corner.endsWith('left') ? 0 : 1920 - contentW,
            sy: corner.startsWith('right') || corner.includes('bottom') ? 1080 - contentH : 0,
          })
          panelOnScreen(computePanelPlacement(input), input)
        }
      }
    }
  })
  await check('a panel wider than the viewport is pinned to the left edge', () => {
    const input = panelIn({ panelW: 2400, panelH: 400 })
    const r = computePanelPlacement(input)
    assert.ok(input.sx + r.px <= 6.001, 'oversized panel should start at the left margin')
    assert.ok(input.sy + r.py >= -0.001)
  })
}

section('17. Teardown')
await check('the effect disposer removes every route', () => {
  const dispose = harness.effects[0]
  assert.equal(typeof dispose, 'function', 'effect body did not return a disposer')
  dispose()
  assert.equal(harness.routes.size, 0, `${harness.routes.size} routes survived teardown`)
})

// ── summary ─────────────────────────────────────────────────────────────────
console.log(`\n=================================`)
console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const line of failures) console.log(`  - ${line}`)
  process.exitCode = 1
}
