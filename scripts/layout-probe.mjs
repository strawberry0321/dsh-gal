/**
 * Real-browser layout probe.
 *
 * The dialogue box's auto-fit depends on actual text metrics, which cannot be
 * modelled reliably by hand — estimating CJK advance widths in Node repeatedly
 * disagreed with what shipped. This loads the *real* `lib/client.js` into
 * headless Edge, drives the real settings steppers, and measures the live DOM.
 *
 *   node scripts/layout-probe.mjs
 *
 * Exit code 0 = every dialogue level renders its text fully inside the box.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseScriptIndex } from '../lib/csv.js'

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

/** The longest line in the shipped pack — the worst case the fit has to survive. */
function worstCaseLine() {
  const text = fs.readFileSync(path.join(ROOT, 'assets/packs/neri/script.csv'), 'utf8')
  const parsed = parseScriptIndex(text)
  let best = { clip: '', ja: '', zh: '' }
  for (const [clip, line] of Object.entries(parsed.lines)) {
    if ([...line.ja].length > [...best.ja].length) best = { clip, ja: line.ja, zh: line.zh }
  }
  return best
}

/** The shortest real line in the shipped pack — the auto-fit's worst case at the top. */
function shortestLine() {
  const text = fs.readFileSync(path.join(ROOT, 'assets/packs/neri/script.csv'), 'utf8')
  const parsed = parseScriptIndex(text)
  let best = { clip: '', ja: '', zh: '' }
  for (const [clip, line] of Object.entries(parsed.lines)) {
    if (!best.clip || [...line.ja].length < [...best.ja].length) best = { clip, ja: line.ja, zh: line.zh }
  }
  return best
}

function buildPage(clientSource, longest, shortest, geometry) {
  const bootstrapConfig = {
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
    // Pinned open for the whole run so the countdown cannot hide the box midway.
    dialogHoldSeconds: 600,
    spriteRevertOnHide: true,
    spriteVisible: true,
    dialogOpacity: 0,
    pos: { hx: 'right', hd: 24, vy: 'bottom', vd: 24 },
  }
  const pack = {
    id: 'neri',
    name: 'neri',
    source: 'package',
    spriteCount: 18,
    voiceCount: 405,
    scriptCount: 389,
    defaultSprite: 'large_neri_01face.png',
    crop: { x: 0.164, y: 0.168, w: 0.679, h: 0.832 },
    spriteSize: { w: 1500, h: 1200 },
    aspect: (0.679 * 1500) / (0.832 * 1200),
  }
  // A 1x1 transparent PNG keeps the probe free of file:// image loading.
  const pixel =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>probe</title></head>
<body>
<pre id="result">pending</pre>
<script>
(function () {
  var serverConfig = ${JSON.stringify(bootstrapConfig)};
  var PACK = ${JSON.stringify(pack)};
  var LONG = ${JSON.stringify(longest)};
  var SHORT = ${JSON.stringify(shortest)};
  var PIXEL = ${JSON.stringify(pixel)};
  // What the box is showing right now — the "did the whole line render" check has
  // to follow the phase, not a single hard-coded string.
  window.__probeExpect = LONG.ja;
  // The driver script runs in its own scope, so the short line has to cross over
  // through the window rather than through a closure.
  window.__probeShortJa = SHORT.ja;
  var turnPolls = 0;
  window.__probeTurnSeq = false;

  window.fetch = function (input, init) {
    var url = String(input && input.url ? input.url : input);
    var route = url.split('?')[0];
    var body = { ok: true };
    if (route.indexOf('/api/bootstrap') !== -1) {
      body = { ok: true, config: serverConfig, packs: { spritePacks: [PACK], voicePacks: [PACK], all: [PACK] },
               dialog: ${JSON.stringify(geometry)}, balance: { ok: true, totalBalance: 12.39, currency: 'CNY' },
               today: { amount: 0.59, source: 'ledger' }, turn: { seq: 0 }, pricing: {} };
    } else if (route.indexOf('/api/next') !== -1) {
      // The fourth phase asks for a two-character line: the auto-fit used to chase
      // "the tallest size the box allows", which ballooned this one.
      var line = window.__probeShort ? SHORT : LONG;
      body = { ok: true, spritePack: 'neri', voicePack: 'neri',
               sprite: { file: 'large_neri_01face.png', url: PIXEL, size: { w: 1500, h: 1200 }, crop: PACK.crop },
               voice: { clip: line.clip, file: line.clip + '.wav', url: '', ja: line.ja, zh: line.zh } };
    } else if (route.indexOf('/api/state') !== -1) {
      body = { ok: true, balance: { ok: true, totalBalance: 12.39, currency: 'CNY' },
               today: { amount: 0.59, source: 'ledger' }, ledger: {} };
    } else if (route.indexOf('/api/turn') !== -1) {
      // A faithful cold start: the host's counter stays at 0 until a turn settles,
      // and the one turn this page ever sees is the FIRST one after that restart.
      // Reporting 1 and then 2 (as this probe used to) hides the bug where the
      // first turn is mistaken for a baseline and no receipt is ever printed.
      turnPolls++;
      body = window.__probeTurnSeq
        ? { ok: true, seq: 1, turn: 3, tokens: 12483, amount: 0.0384, ts: Date.now() }
        : { ok: true, seq: 0, turn: null, tokens: null, amount: null, ts: null };
    } else if (route.indexOf('/api/config') !== -1) {
      if (init && init.body) {
        try {
          var patch = JSON.parse(init.body);
          for (var k in patch) serverConfig[k] = patch[k];
        } catch (e) {}
      }
      body = { ok: true, config: serverConfig };
    } else if (route.indexOf('/api/packs') !== -1) {
      body = { ok: true, spritePacks: [PACK], voicePacks: [PACK], all: [PACK], config: serverConfig };
    }
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
  };
})();
</script>
<script>
${clientSource}
</script>
<script>
(function () {
  function tick(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function q(sel) { return document.querySelector(sel); }

  function measure(level) {
    var dialog = q('.dsg-dialog');
    var body = q('.dsg-dialog-body');
    var line = q('.dsg-line');
    var inner = q('.dsg-line-inner');
    var foot = q('.dsg-foot');
    if (!dialog || !line || !inner || !foot) return { level: level, error: 'missing nodes' };
    var dialogRect = dialog.getBoundingClientRect();
    var common = {
      level: level,
      dialogW: Math.round(dialogRect.width),
      dialogH: Math.round(dialogRect.height),
      lineHidden: line.classList.contains('dsg-line-off'),
    };

    // Receipt / balance sheets: the figures are the content, so they are what has
    // to fit — and they must stay above the logo band.
    if (foot.classList.contains('dsg-foot-full')) {
      var footRect = foot.getBoundingClientRect();
      var contentH = 0;
      for (var i = 0; i < foot.children.length; i++) {
        var child = foot.children[i];
        if (child.classList.contains('dsg-cost-off') || child.classList.contains('dsg-wallet-off')) continue;
        contentH += child.getBoundingClientRect().height;
      }
      var costShown = !!q('.dsg-cost:not(.dsg-cost-off)');
      // Horizontal centring of the figures in the plate. The strip used to be
      // capped at 66% of the inner width and, being a flex item under
      // align-items:stretch, sat at the *left* edge of the body: the figures were
      // centred inside a narrow left-hand band, i.e. visibly off-centre in the
      // box. Measuring the strip itself would never show that — its children are
      // the ink, so they are what gets measured here.
      var inkLeft = Infinity, inkRight = -Infinity, inkLine = null;
      for (var c = 0; c < foot.children.length; c++) {
        var lineEl = foot.children[c];
        if (lineEl.classList.contains('dsg-cost-off') || lineEl.classList.contains('dsg-wallet-off')) continue;
        inkLine = lineEl;
        for (var g = 0; g < lineEl.children.length; g++) {
          var inkRect = lineEl.children[g].getBoundingClientRect();
          if (inkRect.width <= 0) continue;
          inkLeft = Math.min(inkLeft, inkRect.left);
          inkRight = Math.max(inkRight, inkRect.right);
        }
      }
      common.inkWidthPx = inkLeft < Infinity ? Math.round((inkRight - inkLeft) * 10) / 10 : 0;
      common.inkCenterOffsetPx = inkLeft < Infinity
        ? Math.round(((inkLeft + inkRight) / 2 - (dialogRect.left + dialogRect.right) / 2) * 10) / 10
        : null;
      // "Centred" on an empty measurement would be meaningless, so the ink has to
      // actually exist before its position counts.
      common.centred = common.inkWidthPx > 0 && Math.abs(common.inkCenterOffsetPx || 0) <= 3;
      // The figures are plain black, like the voice line.
      common.inkColor = inkLine ? getComputedStyle(inkLine).color : '';
      common.inkBlack = common.inkColor === 'rgb(36, 36, 36)';
      common.inkText = inkLine ? (inkLine.textContent || '').replace(/\s+/g, ' ').trim() : '';
      // How far down the plate the content reaches. The logo's top edge is at
      // plate y 72.8%, so anything past that collides with it.
      var bottomFraction = (footRect.top - dialogRect.top + footRect.height) / dialogRect.height;
      common.sheet = 'figures';
      common.sheetName = costShown ? 'cost' : 'wallet';
      common.lineBoxH = 0;
      common.textH = Math.round(contentH * 10) / 10;
      common.footH = Math.round(footRect.height * 10) / 10;
      common.contentBottomFraction = Math.round(bottomFraction * 1000) / 1000;
      common.fontPx = Math.round(parseFloat(getComputedStyle(foot).fontSize) * 100) / 100;
      common.chars = 0;
      common.fullyRendered = true;
      common.fits = contentH <= footRect.height + 0.5;
      common.overflowsBy = Math.round(Math.max(0, contentH - footRect.height) * 10) / 10;
      common.clippedCue = false;
      common.footClipped = foot.scrollHeight > foot.clientHeight + 1;
      common.clearsLogo = bottomFraction <= 0.74;
      // The whole point of this sheet: the voice line must be gone.
      common.lineGone = common.lineHidden;
      return common;
    }

    var innerRect = inner.getBoundingClientRect();
    var lineRect = line.getBoundingClientRect();
    var footRect2 = foot.getBoundingClientRect();
    var text = inner.textContent || '';
    common.sheet = 'line';
    common.sheetName = 'line';
    common.lineBoxH = Math.round(lineRect.height * 10) / 10;
    common.textH = Math.round(innerRect.height * 10) / 10;
    common.footH = Math.round(footRect2.height * 10) / 10;
    common.fontPx = Math.round(parseFloat(getComputedStyle(inner).fontSize) * 100) / 100;
    common.chars = text.length;
    common.fullyRendered = text === window.__probeExpect;
    common.fillShare = common.lineBoxH > 0 ? Math.round((common.textH / common.lineBoxH) * 1000) / 1000 : null;
    common.fits = innerRect.height <= lineRect.height + 0.5;
    common.overflowsBy = Math.round(Math.max(0, innerRect.height - lineRect.height) * 10) / 10;
    common.clippedCue = line.classList.contains('dsg-line-clipped');
    common.footClipped = foot.scrollHeight > foot.clientHeight + 1;
    common.clearsLogo = true;
    common.lineGone = false;
    return common;
  }

  window.addEventListener('load', function () {
    setTimeout(async function () {
      var out = { viewport: [window.innerWidth, window.innerHeight], phases: {}, expect: {}, error: null };
      try {
        var gear = q('.dsg-gear');
        // Opening the panel pins the dialogue box so it cannot hide mid-run.
        gear.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await tick(80);
        var dec = q('[data-act="dialog-scale-dec"]');
        var inc = q('[data-act="dialog-scale-inc"]');
        var val = q('[data-val="dialog-scale"]');

        // Which sheet each phase is supposed to be showing. Without this the probe
        // could not tell "the receipt appeared" from "nothing appeared and the boot
        // line is still up" — both measure as a box with text in it.
        async function sweep(label, expectSheet) {
          while (Number(val.textContent) > 1) { dec.click(); await tick(40); }
          var rows = [];
          for (var level = 1; level <= 10; level++) {
            await tick(80);
            var first = measure(level);
            // A re-layout re-runs the auto-fit. If the numbers change, the box
            // was left in a stale state by the previous step.
            window.dispatchEvent(new Event('resize'));
            await tick(80);
            var second = measure(level);
            first.afterRefit = { fontPx: second.fontPx, textH: second.textH, lineBoxH: second.lineBoxH, fits: second.fits };
            rows.push(first);
            if (level < 10) { inc.click(); }
          }
          out.phases[label] = rows;
          out.expect[label] = expectSheet;
        }

        // Phase A: a voice line owns the box — the strip is removed entirely, so
        // this is the roomiest the text ever gets.
        await sweep('line · 语音台词（无底栏）', 'line')

        // Phase B: after a turn, the box carries the 消耗/花费 receipt.
        window.__probeTurnSeq = true
        await tick(4000)
        await sweep('cost · 对话结束收据', 'cost')

        // Phase C: clicking the box swaps it to 余额/今日已用.
        q('.dsg-dialog').dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await tick(300)
        await sweep('wallet · 余额与今日已用', 'wallet')

        // Phase D: the shortest line in the pack, via a real click on the art. This
        // is the case that used to blow up to the box-filling cap: the shorter the
        // line, the bigger it got, and a large plate made a one-character line shout.
        window.__probeShort = true
        window.__probeExpect = window.__probeShortJa
        var sprite = q('.dsg-sprite')
        for (var phase of ['pointerdown', 'pointerup']) {
          sprite.dispatchEvent(new PointerEvent(phase, { bubbles: true, pointerId: 7, button: 0, clientX: 40, clientY: 40 }))
        }
        await tick(600)
        await sweep('line-short · 极短台词', 'line')
      } catch (err) {
        out.error = String((err && err.message) || err);
      }
      document.getElementById('result').textContent = JSON.stringify(out);
    }, 6000);
  });
})();
</script>
</body></html>`
}

const browser = findBrowser()
if (!browser) {
  console.log('layout-probe: no Edge/Chrome found — skipping (set one in BROWSERS to enable)')
  process.exit(0)
}

const clientSource = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8')
assert.ok(!clientSource.includes('</script'), 'client.js must not contain a literal </script')
const geometry = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/ui/dialog.json'), 'utf8'))
const longest = worstCaseLine()
const shortest = shortestLine()
// Read the cap out of the client so the probe cannot drift from it...
const declaredMax = Number((/const MAX_LINE_FONT = ([\d.]+)/.exec(clientSource) || [])[1])
assert.ok(Number.isFinite(declaredMax), 'MAX_LINE_FONT not found in lib/client.js')
// ...but judge against an absolute ceiling of its own, or raising the cap in the
// client would silently raise the bar here too. 34px is already generous for a
// caption on a 400px plate; the old behaviour was 44.
const ABSOLUTE_MAX_LINE_FONT = 34

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsg-probe-'))
const page = path.join(tmp, 'probe.html')
fs.writeFileSync(page, buildPage(clientSource, longest, shortest, geometry), 'utf8')

console.log('dsh-gal · real-browser layout probe')
console.log(`browser : ${browser}`)
console.log(`worst case: ${longest.clip} (${[...longest.ja].length} chars, ${(longest.ja.match(/\n/g) || []).length} hard breaks)`)
console.log(`shortest  : ${shortest.clip} ("${shortest.ja}", ${[...shortest.ja].length} chars) — cap ${declaredMax}px, limit ${ABSOLUTE_MAX_LINE_FONT}px`)
console.log('')

const run = spawnSync(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-extensions',
    '--window-size=1920,1080',
    '--virtual-time-budget=30000',
    '--dump-dom',
    `file:///${page.replace(/\\/g, '/')}`,
  ],
  { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 },
)

fs.rmSync(tmp, { recursive: true, force: true })

if (run.error) {
  console.log(`layout-probe: could not run the browser (${run.error.message}) — skipping`)
  process.exit(0)
}

const match = /<pre id="result">([\s\S]*?)<\/pre>/.exec(run.stdout || '')
if (!match) {
  console.error('layout-probe: no result captured')
  console.error((run.stderr || '').split('\n').slice(-12).join('\n'))
  process.exit(1)
}

const decoded = match[1]
  .replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&')

if (decoded === 'pending') {
  console.error('layout-probe: page did not finish before the virtual-time budget expired')
  process.exit(1)
}

const result = JSON.parse(decoded)
if (result.error) {
  console.error(`layout-probe: ${result.error}`)
  process.exit(1)
}

console.log(`viewport: ${result.viewport[0]}x${result.viewport[1]}`)

// Levels 1-2 are thumbnail-sized (70-83px wide). Neither a 64-character line nor
// two figures can fit there at any legible size, so those are allowed to
// truncate — but the line sheet must *say* it is truncated rather than silently
// look like an overlap.
const READABLE_FROM = 3
let failures = 0
for (const [phase, rows] of Object.entries(result.phases)) {
  const expect = result.expect ? result.expect[phase] : null
  console.log('')
  console.log(`── ${phase} ${'─'.repeat(Math.max(0, 60 - phase.length))}`)
  console.log('lvl  dialogW  dialogH  内容高  容器高  font    填充比  画面占比  居中偏移  文字颜色  完整显示')
  for (const row of rows) {
    const figures = row.sheet === 'figures'
    // A caption is never allowed to be oversized, whatever the box would permit.
    const fontOk = figures || row.fontPx <= ABSOLUTE_MAX_LINE_FONT
    // The phase must actually be showing the sheet it claims to be measuring: a
    // receipt that never arrived would otherwise pass as "a box with text in it".
    const sheetOk = !expect || row.sheetName === expect
    // The token count is written in K/M, never as a comma-separated run of digits.
    const unitOk = row.sheetName !== 'cost' || (/\d(\.\d+)?[KM] token/.test(row.inkText || '') && !/\d,\d{3}/.test(row.inkText || ''))
    // For the figure sheets the content must fit the band, stay clear of the logo
    // AND sit on the plate's centre line; for the line sheet the text must fit.
    const complete = figures
      ? row.fits && row.clearsLogo && !row.footClipped && row.lineGone && row.centred && row.inkBlack && sheetOk && unitOk
      : row.fits && row.fullyRendered && !row.footClipped && fontOk && sheetOk
    const expectedTruncated = row.level < READABLE_FROM
    let verdict
    if (complete) {
      verdict = 'YES'
      if (row.clippedCue) {
        verdict = 'YES(?) 明明放得下却显示了截断提示'
        failures++
      }
    } else if (expectedTruncated && !figures && row.clippedCue && row.fullyRendered && fontOk && sheetOk) {
      verdict = `截断(小档位预期) 溢出 ${row.overflowsBy}px`
    } else if (expectedTruncated && figures && row.lineGone && row.clearsLogo && row.centred && row.inkBlack && sheetOk && unitOk) {
      // The figures are clipped inside their own band, not covered by anything.
      verdict = `截断(小档位预期) 内容 ${row.textH}px > 区域 ${row.footH}px`
    } else {
      const why = []
      if (!sheetOk) why.push(`显示的是 ${row.sheetName}，不是 ${expect}`)
      if (!unitOk) why.push(`token 没写成 K/M：${row.inkText}`)
      if (!fontOk) why.push(`字号 ${row.fontPx}px 超过上限 ${ABSOLUTE_MAX_LINE_FONT}px（又想填满对话框）`)
      if (!row.fits) why.push(`溢出 ${row.overflowsBy}px`)
      if (figures && !row.clearsLogo) why.push(`压到 logo（到 ${row.contentBottomFraction}）`)
      if (figures && !row.centred) why.push(`没有居中（偏 ${row.inkCenterOffsetPx}px）`)
      if (figures && !row.inkBlack) why.push(`颜色不是黑色（${row.inkColor}）`)
      if (figures && !row.lineGone) why.push('语音内容没有隐藏')
      if (row.footClipped) why.push('内容被裁')
      if (!figures && !row.fullyRendered) why.push(`只渲染 ${row.chars} 字`)
      // Only worth complaining about a missing cue when something really is cut off.
      if (!figures && !row.fullyRendered && !row.clippedCue) why.push('没有截断提示')
      verdict = `NO (${why.join('，')})`
      failures++
    }
    console.log(
      String(row.level).padEnd(4),
      String(row.dialogW).padEnd(8),
      String(row.dialogH).padEnd(8),
      String(row.textH).padEnd(7),
      String(figures ? row.footH : row.lineBoxH).padEnd(8),
      String(row.fontPx).padEnd(7),
      String(figures ? '-' : row.fillShare).padEnd(7),
      String(figures ? row.contentBottomFraction : '-').padEnd(9),
      String(figures ? `${row.inkCenterOffsetPx}px` : '-').padEnd(9),
      String(figures ? row.inkColor.replace(/^rgb\(|\)$/g, '') : '-').padEnd(9),
      verdict,
    )
  }
}

console.log('')
const summary = Object.entries(result.phases).map(([phase, rows]) => {
  const firstOk = rows.find((r) => r.fits && r.fullyRendered && !r.footClipped)
  return `${phase.split(' ')[0]}: ${firstOk ? `≥${firstOk.level} 档完整显示` : '无档位完整显示'}`
})
if (failures > 0) {
  console.log(`${failures} 处不符合预期`)
  process.exitCode = 1
} else {
  console.log(summary.join('   |   '))
  console.log('比允许下限更小的档位按预期截断，并显示淡出提示')
}
