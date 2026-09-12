/**
 * Real-browser probe: the art must change even when image requests never land.
 *
 * Reported symptom: on a fresh conversation the voice played but the sprite did
 * not move, and a pack switch in the settings panel changed nothing until the
 * next message. Both waited on an `<img>` load — the lowest-priority request on
 * a busy page, and the same class of request that starved the audio before it.
 *
 * This loads the real `lib/client.js` into headless Edge and makes every direct
 * image source *never arrive* (the only source an `<img>` can still get is a
 * `blob:` URL, i.e. the byte cache's fetch path). Then it drives the widget for
 * real: a pointer click on the art, and a pack switch in the settings panel.
 *
 *   node scripts/sprite-starve-probe.mjs
 *
 * Exit code 0 = the art appeared, changed on click, and changed on pack switch —
 * with the starving shim provably in the way of every direct image load.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]

function findBrowser() {
  for (const candidate of BROWSERS) if (fs.existsSync(candidate)) return candidate
  return null
}

// ── tiny PNG encoder (same technique as make-blank-plate.mjs) ────────────────
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** A flat-colour RGBA PNG — which frame is on screen is read back by colour. */
function png(width, height, [r, g, b]) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1)
    for (let x = 0; x < width; x++) {
      const at = row + 1 + x * 4
      raw[at] = r
      raw[at + 1] = g
      raw[at + 2] = b
      raw[at + 3] = 255
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const dataUrl = (body) => `data:image/png;base64,${body.toString('base64')}`

// Three distinguishable frames: the shipped pack's two, and the other pack's one.
const ART = {
  'a1.png': { rgb: [220, 60, 70], url: dataUrl(png(60, 40, [220, 60, 70])) },
  'a2.png': { rgb: [60, 120, 210], url: dataUrl(png(60, 40, [60, 120, 210])) },
  'b1.png': { rgb: [70, 190, 110], url: dataUrl(png(60, 40, [70, 190, 110])) },
}
const PLATE_URL = dataUrl(png(64, 36, [250, 250, 252]))
const ICON_URL = dataUrl(png(8, 8, [40, 40, 48]))

const PACK_A = {
  id: 'neri',
  name: 'neri',
  source: 'package',
  spriteCount: 2,
  voiceCount: 1,
  scriptCount: 1,
  defaultSprite: 'a1.png',
  crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
  spriteSize: { w: 60, h: 40 },
  aspect: (0.8 * 60) / (0.8 * 40),
}
const PACK_B = {
  id: 'alt',
  name: 'alt',
  source: 'user',
  spriteCount: 1,
  voiceCount: 1,
  scriptCount: 1,
  defaultSprite: 'b1.png',
  crop: { x: 0, y: 0, w: 1, h: 1 },
  spriteSize: { w: 60, h: 40 },
  aspect: 60 / 40,
}
const GEOMETRY = {
  image: { width: 64, height: 36 },
  crop: { x: 0, y: 0, w: 1, h: 1 },
  inset: { left: 0.06, right: 0.06, top: 0.08, bottom: 0.04 },
  radius: 10,
  logoShare: 0.72,
  footer: { maxWidthRatio: 0.66 },
}

function buildPage(clientSource) {
  const config = {
    version: 3,
    spritePack: 'neri',
    voicePack: 'neri',
    spriteFile: '',
    scale: 5,
    volume: 0,
    lang: 'ja',
    autoPlay: false,
    autoPlayMinutes: 1,
    dialogScale: 1,
    dialogEnabled: true,
    dialogSide: 'above',
    dialogHoldSeconds: 600,
    spriteRevertOnHide: false,
    spriteVisible: true,
    dialogOpacity: 0,
    pos: { hx: 'right', hd: 24, vy: 'bottom', vd: 24 },
  }
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>sprite-probe</title></head>
<body>
<pre id="result">pending</pre>
<script>
(function () {
  // ── the starvation shim ───────────────────────────────────────────────────
  // On the real page an <img> request for the artwork is the lowest-priority
  // request there is: measured stalls of ten seconds, all released at once when
  // the conversation is used. Here a direct image source never lands at all, so
  // the only source that can still paint the art is a blob from the byte cache.
  window.__starved = [];
  var descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable: true,
    get: function () { return descriptor.get.call(this); },
    set: function (value) {
      var text = String(value);
      if (text.indexOf('blob:') !== 0) {
        window.__starved.push(text.slice(0, 60));
        return;
      }
      descriptor.set.call(this, text);
    },
  });
  window.__errors = [];
  window.addEventListener('error', function (event) {
    window.__errors.push(String((event && event.message) || event));
  });
  window.addEventListener('unhandledrejection', function (event) {
    window.__errors.push('unhandledrejection: ' + String((event && event.reason) || ''));
  });

  // ── the host stub ─────────────────────────────────────────────────────────
  // Same shape as the real routes; the asset paths are left to the real fetch, which
  // is the path under test.
  var serverConfig = ${JSON.stringify(config)};
  var PACK_A = ${JSON.stringify(PACK_A)};
  var PACK_B = ${JSON.stringify(PACK_B)};
  var GEOMETRY = ${JSON.stringify(GEOMETRY)};
  var ART = ${JSON.stringify(
    Object.fromEntries(Object.entries(ART).map(([name, art]) => [name, art.url])),
  )};
  var roll = 0;
  var realFetch = window.fetch.bind(window);
  // The plate and the gear icon are asked for by their real paths; the bytes come
  // from data URLs, because a file:// page may not fetch a file:// URL at all.
  function respondWith(url) {
    return Promise.resolve({
      ok: true, status: 200,
      blob: function () { return realFetch(url).then(function (r) { return r.blob(); }); },
    });
  }
  window.fetch = function (input, init) {
    var url = String(input && input.url ? input.url : input);
    var route = url.split('?')[0];
    if (url.indexOf('data:') === 0 || url.indexOf('blob:') === 0) return realFetch(input, init);
    if (url.indexOf('/asset/ui/settings.png') !== -1) return respondWith(window.__ui.icon);
    if (url.indexOf('/asset/ui/dialog.png') !== -1) return respondWith(window.__ui.plate);
    if (url.indexOf('/asset/') !== -1) return realFetch(input, init);
    var body = { ok: true };
    if (route.indexOf('/api/bootstrap') !== -1) {
      body = {
        ok: true, config: serverConfig,
        packs: { spritePacks: [PACK_A, PACK_B], voicePacks: [PACK_A], all: [PACK_A, PACK_B] },
        dialog: GEOMETRY,
        balance: { ok: true, totalBalance: 12.39, currency: 'CNY' },
        today: { amount: 0.59, source: 'ledger' },
        turn: { seq: 0 }, pricing: {},
      };
    } else if (route.indexOf('/api/next') !== -1) {
      var pack = serverConfig.spritePack === 'alt' ? PACK_B : PACK_A;
      var names = Object.keys(ART).filter(function (n) { return n.indexOf(pack.id === 'alt' ? 'b' : 'a') === 0; });
      var file = names[roll++ % names.length];
      body = {
        ok: true, spritePack: pack.id, voicePack: PACK_A.id,
        sprite: { file: file, url: ART[file], size: pack.spriteSize, crop: pack.crop },
        voice: { clip: 'clip001', file: 'clip001.wav', url: '', ja: 'こんにちは', zh: '你好' },
      };
    } else if (route.indexOf('/api/config') !== -1) {
      if (init && init.body) {
        try {
          var patch = JSON.parse(init.body);
          for (var k in patch) serverConfig[k] = patch[k];
        } catch (e) {}
      }
      body = { ok: true, config: serverConfig };
    } else if (route.indexOf('/api/packs') !== -1) {
      body = { ok: true, spritePacks: [PACK_A, PACK_B], voicePacks: [PACK_A], all: [PACK_A, PACK_B], config: serverConfig };
    } else if (route.indexOf('/api/state') !== -1) {
      body = { ok: true, balance: { ok: true, totalBalance: 12.39, currency: 'CNY' },
               today: { amount: 0.59, source: 'ledger' }, ledger: {} };
    } else if (route.indexOf('/api/turn') !== -1) {
      body = { ok: true, seq: 0, turn: null, tokens: null, amount: null, ts: null };
    }
    return Promise.resolve({
      ok: true, status: 200,
      json: function () { return Promise.resolve(body); },
      blob: function () { return Promise.resolve(new Blob([JSON.stringify(body)])); },
    });
  };
  // The two UI images have to come through the byte cache like everything else.
  window.__ui = { plate: ${JSON.stringify(PLATE_URL)}, icon: ${JSON.stringify(ICON_URL)} };
})();
</script>
<script>
${clientSource}
</script>
<script>
(function () {
  function tick(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function img() { return document.querySelector('.dsg-sprite-img'); }

  /** What is actually on screen, read back through a canvas thumbnail. */
  async function fingerprint() {
    var el = img();
    if (!el || !el.complete || !el.naturalWidth) return null;
    var canvas = document.createElement('canvas');
    canvas.width = 12;
    canvas.height = 8;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(el, 0, 0, 12, 8);
    var data = ctx.getImageData(0, 0, 12, 8).data;
    var hash = 0;
    for (var i = 0; i < data.length; i++) hash = (hash * 31 + data[i]) >>> 0;
    return { hash: hash, rgb: [data[0], data[1], data[2]] };
  }

  async function sample() {
    var el = img();
    return {
      src: el ? String(el.getAttribute('src')).slice(0, 24) : null,
      style: el ? (el.style.width + ' / ' + el.style.left) : null,
      art: await fingerprint(),
    };
  }

  async function waitForArt(timeout) {
    var deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      var art = await fingerprint();
      if (art) return art;
      await tick(60);
    }
    return null;
  }

  async function waitForChange(before, timeout) {
    var deadline = Date.now() + timeout;
    var last = null;
    while (Date.now() < deadline) {
      last = await fingerprint();
      if (last && (!before || last.hash !== before.hash)) return last;
      await tick(60);
    }
    return last;
  }

  function clickSprite() {
    var box = document.querySelector('.dsg-sprite');
    var at = box.getBoundingClientRect();
    var opts = {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
      button: 0, buttons: 1,
      clientX: Math.round(at.left + at.width / 2),
      clientY: Math.round(at.top + at.height / 2),
    };
    box.dispatchEvent(new PointerEvent('pointerdown', opts));
    box.dispatchEvent(new PointerEvent('pointerup', opts));
  }

  function switchPack(id) {
    var select = document.querySelector('[data-act="sprite-pack"]');
    select.value = id;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  window.__run = async function () {
    var out = { steps: [] };
    for (var i = 0; i < 100 && !img(); i++) await tick(50);

    await waitForArt(8000);
    var boot = await sample();
    out.steps.push({ name: 'boot', at: boot });

    // The two UI images go through the same cache; they must survive as well.
    await tick(200);
    out.ui = {
      plate: String((document.querySelector('.dsg-dialog-img') || {}).src || '').slice(0, 5),
      icon: String((document.querySelector('.dsg-gear img') || {}).src || '').slice(0, 5),
    };

    // 1. A click on the art: the widget's own path to a new frame.
    clickSprite();
    var afterClick = await waitForChange(boot.art, 8000);
    var click = await sample();
    click.art = afterClick;
    out.steps.push({ name: 'click', at: click });

    // 2. The settings panel's pack switch, on a page with no conversation at all.
    switchPack('alt');
    var afterSwitch = await waitForChange(afterClick, 8000);
    var swap = await sample();
    swap.art = afterSwitch;
    out.steps.push({ name: 'pack-switch', at: swap });
    out.savedSpritePack = null;
    try {
      var res = await window.fetch('/dsh-gal/api/packs', { cache: 'no-store' });
      out.savedSpritePack = (await res.json()).config.spritePack;
    } catch (e) {}
    out.starved = window.__starved.slice();
    out.errors = window.__errors.slice();
    return out;
  };
})();
</script>
<script>
(async function () {
  var result;
  try {
    result = await window.__run();
  } catch (err) {
    result = { fatal: String((err && err.stack) || err), errors: window.__errors, starved: window.__starved };
  }
  document.getElementById('result').textContent = 'PROBE:' + JSON.stringify(result);
})();
</script>
</body></html>
`
}

const browser = findBrowser()
if (!browser) {
  console.log('sprite-starve-probe: no Edge/Chrome found — skipping')
  process.exit(0)
}

const clientPath = process.env.DSG_PROBE_CLIENT || path.join(ROOT, 'lib/client.js')
const client = fs.readFileSync(clientPath, 'utf8')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsg-sprite-'))
const page = path.join(tmp, 'probe.html')
fs.writeFileSync(page, buildPage(client), 'utf8')

const run = spawnSync(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-extensions',
    '--window-size=1600,1000',
    '--virtual-time-budget=60000',
    '--dump-dom',
    `file:///${page.replace(/\\/g, '/')}`,
  ],
  { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 },
)
fs.rmSync(tmp, { recursive: true, force: true })

if (run.error) {
  console.error(`sprite-starve-probe: could not run the browser (${run.error.message})`)
  process.exit(1)
}

const dom = String(run.stdout || '')
const match = /<pre id="result">([\s\S]*?)<\/pre>/.exec(dom)
if (!match) {
  console.error('sprite-starve-probe: the page never finished')
  console.error(dom.slice(-1200))
  process.exit(1)
}
const decoded = match[1]
  .replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&')

if (!decoded.startsWith('PROBE:')) {
  console.error(`sprite-starve-probe: no result (${decoded.slice(0, 200)})`)
  process.exit(1)
}

let result
try {
  result = JSON.parse(decoded.slice('PROBE:'.length))
} catch (err) {
  console.error(`sprite-starve-probe: unreadable result (${err.message})`)
  console.error(decoded.slice(0, 1200))
  process.exit(1)
}

const problems = []
if (result.fatal) problems.push(`页面抛错：${result.fatal.split('\n')[0]}`)
const step = (name) => (result.steps || []).find((s) => s.name === name)
const boot = step('boot')
const click = step('click')
const swap = step('pack-switch')
const rgb = (s) => (s && s.at && s.at.art ? s.at.art.rgb.join(',') : '空')
const HEARD = { '220,60,70': 'a1', '60,120,210': 'a2', '70,190,110': 'b1' }
const name = (s) => HEARD[rgb(s)] || rgb(s)

if (!boot || !boot.at.art) problems.push('启动后立绘没有画出来')
else if (!/^blob:/.test(String(boot.at.src))) problems.push(`启动后的立绘不是字节缓存给的（${boot.at.src}）`)
else if (name(boot) !== 'a1') problems.push(`启动后画的不是包内默认立绘（${name(boot)}）`)

if (!click || !click.at.art) problems.push('点击后立绘没有画出来')
else if (name(click) === name(boot)) problems.push(`点击没有换图（还是 ${name(boot)}）`)

if (!swap || !swap.at.art) problems.push('换立绘包后立绘没有画出来')
else if (name(swap) === name(click)) problems.push(`设定里换包没有换图（还是 ${name(click)}）`)
else if (name(swap) !== 'b1') problems.push(`换包后画的不是新包的立绘（${name(swap)}）`)

if (result.savedSpritePack !== 'alt') problems.push(`换包没有存进配置（spritePack=${result.savedSpritePack}）`)
// The shim has to have actually been in the way, or this proves nothing.
if (!Array.isArray(result.starved) || result.starved.length === 0) {
  problems.push('探针没能饿死图片请求，这次结果不算数')
}
if (result.ui && (result.ui.plate !== 'blob:' || result.ui.icon !== 'blob:')) {
  problems.push(`底图或设定图标没走字节缓存（plate=${result.ui.plate} icon=${result.ui.icon}）`)
}
if (Array.isArray(result.errors) && result.errors.length) problems.push(`页面报错：${result.errors[0]}`)

console.log('dsh-gal · 立绘饿死图片请求探针')
console.log(`browser : ${browser}`)
if (result.steps) {
  for (const s of result.steps) {
    console.log(`${s.name.padEnd(12)} src=${String(s.at.src).padEnd(26)} 画面=${name(s).padEnd(4)} 尺寸/裁切=${s.at.style}`)
  }
}
console.log(`直接图片请求被饿死：${(result.starved || []).length} 次`)
console.log('')

if (problems.length) {
  for (const p of problems) console.log(`✗ ${p}`)
  process.exitCode = 1
} else {
  console.log('✓ 图片请求全部饿死时，启动、点击换图、设定换包都能立刻生效')
}
