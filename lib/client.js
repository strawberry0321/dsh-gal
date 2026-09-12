/**
 * dsh-gal — browser half.
 *
 * Served verbatim from `/dsh-gal/client.js` and injected into the web
 * app's index document. Everything lives inside one IIFE that owns a single
 * fixed-position stage; no framework, no build step.
 *
 * Interaction model
 *   hover 立绘     -> the settings button fades in at the art's top-right corner
 *   click 立绘     -> random voice + random art + the dialogue box shows the line
 *   drag  立绘     -> moves the widget; the anchor (nearest edges) is persisted
 *   turn ends      -> the dialogue box reports 消耗 token / 花费 ￥ for that turn
 */
;(function () {
  'use strict'

  if (window.__dshGalWidget) return
  window.__dshGalWidget = true

  const ROUTE = '/dsh-gal'
  const API = `${ROUTE}/api`
  const UI = `${ROUTE}/asset/ui`
  const GAP = 10 // breathing room between art and dialogue box
  const DRAG_SLOP = 5 // px of movement below which a pointer gesture is a click
  const TURN_POLL_MS = 1000
  const STATE_POLL_MS = 60000
  // The turn receipt holds longer than a voice line: it appears on its own, and
  // two numbers that just changed are worth a second look.
  const COST_HOLD_SECONDS = 5
  const MONEY_SYMBOL = { CNY: '¥', USD: '$', EUR: '€', JPY: '¥', GBP: '£' }
  const SCALE_MIN = 1
  const SCALE_MAX = 10

  /**
   * Fallback plate geometry, replaced by `/api/bootstrap`. Kept in sync with
   * `assets/ui/dialog.json` by scripts/verify.mjs.
   */
  const DEFAULT_DIALOG_GEO = {
    image: { width: 1280, height: 720 },
    crop: { x: 0, y: 0.42, w: 1, h: 0.58 },
    inset: { left: 0.05, right: 0.05, top: 0.07, bottom: 0.04 },
    footer: { heightRatio: 0.42, maxWidthRatio: 0.66 },
    radius: 10,
    logoShare: 0.72,
  }

  // ── tiny helpers ──────────────────────────────────────────────────────────
  const clamp = (v, min, max) => Math.min(Math.max(v, min), max)
  const $ = (tag, className) => {
    const el = document.createElement(tag)
    if (className) el.className = className
    return el
  }
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback)

  function money(amount, currency) {
    const n = Number(amount)
    if (!Number.isFinite(n)) return '--'
    const symbol = MONEY_SYMBOL[String(currency || 'CNY').toUpperCase()] || `${currency || ''} `
    return `${symbol}${n.toFixed(2)}`
  }

  // ── state ─────────────────────────────────────────────────────────────────
  const state = {
    config: null,
    packs: { spritePacks: [], voicePacks: [] },
    dialog: DEFAULT_DIALOG_GEO,
    // Which plate `dialog` describes: 'bundled' (shipped artwork), 'blank' (the
    // plain plate that ships with the plugin) or 'user' (an image installed from
    // the settings panel).
    plateSource: 'bundled',
    balance: null,
    today: null,
    turnSeq: 0,
    sprite: null, // { file, url, aspect }
    voice: null, // { clip, ja, zh }
    // Whether the dialogue box is currently on screen. Separate from the
    // `dialogEnabled` setting: the box has its own show -> type -> hide cycle.
    dialogShown: false,
    // Which sheet the box is showing:
    //   'line'   a voice line (what a click on the art produces)
    //   'cost'   the turn receipt (what a finished conversation produces)
    //   'wallet' 余额 / 今日已用 — reached by clicking the box itself
    sheet: 'line',
    cost: { tokens: null, amount: null },
    panelOpen: false,
    hover: false,
  }

  const cfg = () => state.config || {}
  const packOf = (list, id) => (list || []).find((p) => p.id === id) || null

  // ── styles ────────────────────────────────────────────────────────────────
  const CSS = `
.dsg-root{position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483000;
  font-family:"Segoe UI","Microsoft YaHei",system-ui,-apple-system,sans-serif;user-select:none;-webkit-user-select:none}
.dsg-root *{box-sizing:border-box}
.dsg-stage{position:absolute;left:0;top:0;width:0;height:0;transition:transform .13s ease}
.dsg-root.dsg-dragging .dsg-stage{transition:none}

/* 立绘 */
.dsg-sprite{position:absolute;left:0;top:0;overflow:hidden;pointer-events:auto;cursor:grab;
  touch-action:none}
.dsg-root.dsg-dragging .dsg-sprite{cursor:grabbing}
/* The shadow hangs off the image itself: a filter on the clipping box would
   cast a rectangle instead of the character's silhouette. */
.dsg-sprite-img{position:absolute;display:block;pointer-events:none;-webkit-user-drag:none;
  filter:drop-shadow(0 5px 12px rgba(0,0,0,.2))}
.dsg-root.dsg-hidden .dsg-sprite{display:none}
/* No art loaded yet: keep the plate visible but stop the empty box from
   swallowing clicks. */
.dsg-root.dsg-nosprite .dsg-sprite{display:none}

/* 设定按钮（右上角，仅悬浮显示） */
/* pointer-events follows visibility: an invisible button that still accepts
   clicks would swallow presses aimed at the art underneath it. */
.dsg-gear{position:absolute;width:30px;height:30px;padding:0;border:none;background:transparent;
  cursor:pointer;pointer-events:none;opacity:0;transform:scale(.8);transition:opacity .16s ease,transform .16s ease;
  z-index:6;filter:drop-shadow(0 1px 3px rgba(0,0,0,.45))}
.dsg-root.dsg-hover .dsg-gear,.dsg-gear.dsg-gear-open{opacity:1;transform:scale(1);pointer-events:auto}
.dsg-gear img{display:block;width:100%;height:100%;-webkit-user-drag:none}
.dsg-gear:hover{transform:scale(1.12)}

/* 对话框 */
.dsg-dialog{position:absolute;transform-origin:50% 50%;pointer-events:none;opacity:0;
  transition:opacity .18s ease,transform .18s cubic-bezier(.34,1.3,.64,1)}
/* The box is only clickable while it is actually on screen — it is the control
   that swaps the sheet (voice line / receipt / balance). A hidden box must stay
   click-through, or it becomes an invisible shield over the art. */
.dsg-root.dsg-dialog-on .dsg-dialog{opacity:1;pointer-events:auto;cursor:pointer}
/* Only the bottom slice of the artwork is shown: the plate is cropped, so the
   logo keeps its size instead of shrinking along with the empty white area. */
.dsg-dialog-plate{position:absolute;left:0;top:0;width:100%;height:100%;overflow:hidden;
  box-shadow:0 6px 20px rgba(0,0,0,.2)}
.dsg-dialog-img{position:absolute;display:block;-webkit-user-drag:none}
/* Insets are written in px by applyLayout(), derived from the plate geometry. */
.dsg-dialog-body{position:absolute;display:flex;flex-direction:column}
.dsg-line{flex:1 1 auto;min-height:0;color:#111;text-align:center;overflow:hidden;
  display:flex;align-items:flex-start;word-break:break-word;white-space:pre-wrap}
.dsg-line-inner{width:100%}
/* Shown only when a line cannot fit even at the minimum size — the plate is too
   small for it. Communicates truncation instead of looking like an overlap. */
.dsg-line-clipped{-webkit-mask-image:linear-gradient(to bottom,#000 70%,transparent 100%);
  mask-image:linear-gradient(to bottom,#000 70%,transparent 100%)}
.dsg-caret{display:inline-block;width:.42em;height:.9em;margin-left:.06em;vertical-align:-.06em;
  background:#6b7fd7;opacity:.75;animation:dsg-blink .9s steps(1,end) infinite}
@keyframes dsg-blink{0%,50%{opacity:.75}50.01%,100%{opacity:0}}
.dsg-foot{flex:0 0 auto;display:flex;flex-direction:column;justify-content:flex-end;gap:.18em;
  font-weight:600;letter-spacing:.01em}
/* Each figure is an unbreakable unit and the rows wrap *between* units, so a
   narrow box can never split "余额" away from its amount onto another line. */
.dsg-cost,.dsg-wallet{display:flex;flex-wrap:wrap;justify-content:center;
  column-gap:.85em;row-gap:.02em}
.dsg-cost>*,.dsg-wallet>*{white-space:nowrap}
.dsg-kv{display:inline-flex;align-items:baseline}
/* Both figure sheets read as plain black, exactly like the voice line: they are
   read-outs, not status colours, and the old pink/lilac pair only stayed legible
   against the white plate thanks to a dark text-shadow — which smudged the
   glyphs. Weight alone carries the emphasis now. */
.dsg-cost,.dsg-wallet{color:#242424}
.dsg-cost b{font-weight:700}

.dsg-cost.dsg-cost-off{display:none}
.dsg-wallet.dsg-wallet-off{display:none}
/* In "voice line" mode the box carries nothing but the line, so the strip is
   removed entirely and the text gets the whole plate. */
.dsg-foot.dsg-foot-off{display:none}
.dsg-line.dsg-line-off{display:none}
/* Receipt / balance sheets: the strip *is* the content. It is capped to the top
   share of the plate that clears the logo in the bottom-right corner, and the
   figures are centred inside that band. */
.dsg-foot.dsg-foot-full{flex:0 0 auto;justify-content:center;max-width:none;overflow:hidden}
.dsg-wallet .dsg-k{color:#828282;font-weight:500;margin-right:.15em}

/* 设定面板（半透明白色） */
.dsg-panel{position:absolute;width:272px;padding:10px 12px 12px;border-radius:12px;
  background:rgba(255,255,255,.82);backdrop-filter:blur(9px);-webkit-backdrop-filter:blur(9px);
  border:1px solid rgba(120,120,140,.28);box-shadow:0 10px 30px rgba(0,0,0,.22);color:#2a2a33;
  font-size:12px;pointer-events:none;opacity:0;transform:translateY(6px) scale(.97);transform-origin:bottom center;
  transition:opacity .16s ease,transform .18s cubic-bezier(.34,1.3,.64,1);max-height:78vh;overflow-y:auto;z-index:5}
/* While closed the panel is invisible but still laid out (its height is measured
   for placement). It must NOT accept pointer events in that state, or it becomes
   an invisible shield over the art — which is what made the art unclickable and
   the settings button unreachable once it grew large. */
.dsg-panel.dsg-panel-open{opacity:1;transform:none;pointer-events:auto}
.dsg-head{display:flex;align-items:center;justify-content:space-between;font-weight:700;font-size:12.5px;
  color:#1f2430;padding-bottom:6px;margin-bottom:6px;border-bottom:1px solid rgba(120,120,140,.24)}
.dsg-head button{border:none;background:transparent;color:#6b7280;cursor:pointer;font-size:15px;line-height:1;padding:2px 4px}
.dsg-head button:hover{color:#111}
.dsg-row{margin:7px 0}
.dsg-row-top{display:flex;align-items:center;gap:8px}
.dsg-row-label{flex:0 0 auto;color:#3c4250;font-weight:600;min-width:74px}
.dsg-row-val{margin-left:auto;color:#5b6270;font-variant-numeric:tabular-nums}
.dsg-hint{margin-top:3px;color:#8b93a3;font-size:10.5px;line-height:1.35}
.dsg-sub{display:flex;align-items:center;gap:8px;margin:6px 0 0 12px;color:#4a5060}
.dsg-range{flex:1 1 auto;min-width:0;accent-color:#6b7fd7;height:16px}
/* Stepper: − / value / + . Used for the two 1..10 level settings, where a
   bounded click target is far easier to land on than a 10-stop slider. */
.dsg-stepper{margin-left:auto;display:inline-flex;align-items:center;gap:6px}
.dsg-step{border:1px solid rgba(120,120,140,.45);border-radius:7px;background:rgba(255,255,255,.8);
  color:#2a2a33;font-size:14px;line-height:1;width:26px;height:23px;padding:0;cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;user-select:none}
.dsg-step:hover:not(:disabled){background:rgba(107,127,215,.18);border-color:rgba(107,127,215,.65)}
.dsg-step:disabled{opacity:.35;cursor:default}
.dsg-step-val{min-width:22px;text-align:center;color:#2a2a33;font-weight:700;
  font-variant-numeric:tabular-nums}
.dsg-num{width:52px;flex:0 0 auto;border:1px solid rgba(120,120,140,.4);border-radius:6px;padding:2px 4px;
  font-size:11.5px;color:#2a2a33;background:rgba(255,255,255,.85);text-align:right}
.dsg-num:disabled{opacity:.45}
.dsg-btn{flex:1 1 auto;border:1px solid rgba(120,120,140,.42);border-radius:7px;background:rgba(255,255,255,.7);
  color:#2a2a33;font-size:11.5px;padding:4px 6px;cursor:pointer;white-space:nowrap}
.dsg-btn:hover{background:rgba(107,127,215,.14);border-color:rgba(107,127,215,.6)}
.dsg-check{width:15px;height:15px;accent-color:#6b7fd7;cursor:pointer;flex:0 0 auto}
.dsg-file{display:none}
.dsg-select{flex:1 1 auto;min-width:0;border:1px solid rgba(120,120,140,.42);border-radius:7px;
  background:rgba(255,255,255,.85);color:#2a2a33;font-size:11.5px;padding:3px 4px;cursor:pointer}
.dsg-sep{height:1px;background:rgba(120,120,140,.2);margin:9px 0}
.dsg-badge{display:inline-block;padding:1px 6px;border-radius:999px;background:rgba(107,127,215,.16);
  color:#4a5aa8;font-size:10px;margin-left:6px}
`
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  // ── dom ───────────────────────────────────────────────────────────────────
  const root = $('div', 'dsg-root')
  const stage = $('div', 'dsg-stage')
  root.appendChild(stage)

  const spriteBox = $('div', 'dsg-sprite')
  const spriteImg = $('img', 'dsg-sprite-img')
  spriteImg.alt = ''
  spriteImg.draggable = false
  const gear = $('button', 'dsg-gear')
  gear.type = 'button'
  gear.title = '设定'
  const gearImg = $('img')
  gearImg.src = `${UI}/settings.png`
  gearImg.alt = '设定'
  gearImg.draggable = false
  gear.appendChild(gearImg)
  spriteBox.appendChild(spriteImg)
  spriteBox.appendChild(gear)
  stage.appendChild(spriteBox)

  const dialog = $('div', 'dsg-dialog')
  const dialogPlate = $('div', 'dsg-dialog-plate')
  const dialogImg = $('img', 'dsg-dialog-img')
  dialogImg.src = `${UI}/dialog.png`
  dialogImg.alt = ''
  dialogImg.draggable = false
  dialogPlate.appendChild(dialogImg)
  const dialogBody = $('div', 'dsg-dialog-body')
  const lineBox = $('div', 'dsg-line')
  const lineInner = $('div', 'dsg-line-inner')
  lineBox.appendChild(lineInner)
  const foot = $('div', 'dsg-foot')
  const costLine = $('div', 'dsg-cost dsg-cost-off')
  const walletLine = $('div', 'dsg-wallet')
  foot.appendChild(costLine)
  foot.appendChild(walletLine)
  dialogBody.appendChild(lineBox)
  dialogBody.appendChild(foot)
  dialog.appendChild(dialogPlate)
  dialog.appendChild(dialogBody)
  stage.appendChild(dialog)
  const panel = $('div', 'dsg-panel')
  panel.innerHTML = [
    '<div class="dsg-head"><span>立绘挂件设定</span><button type="button" data-act="close" title="关闭">✕</button></div>',
    '<div class="dsg-row"><div class="dsg-row-top"><span class="dsg-row-label">1 立绘缩放</span>',
    '<span class="dsg-stepper">',
    '<button class="dsg-step" type="button" data-act="scale-dec" title="缩小">−</button>',
    '<span class="dsg-step-val" data-val="scale">5</span>',
    '<button class="dsg-step" type="button" data-act="scale-inc" title="放大">+</button>',
    '</span></div>',
    '<div class="dsg-hint">1 – 10 档，默认 5</div></div>',
    '<div class="dsg-row"><div class="dsg-row-top"><span class="dsg-row-label">2 音量</span>',
    '<input class="dsg-range" type="range" data-act="volume" min="0" max="100" step="1">',
    '<span class="dsg-row-val" data-val="volume">50%</span></div></div>',
    '<div class="dsg-row"><div class="dsg-row-top"><span class="dsg-row-label">3 语音语言</span>',
    '<button class="dsg-btn" type="button" data-act="lang">日文</button></div>',
    '<div class="dsg-hint">切换对话框内台词显示的语言</div></div>',
    '<div class="dsg-row"><div class="dsg-row-top"><span class="dsg-row-label">语音顺序</span>',
    '<button class="dsg-btn" type="button" data-act="voice-order">洗牌池</button></div>',
    '<div class="dsg-hint">洗牌池：一轮里每条台词各出现一次，全部放过才重洗，短时间不会重复；纯随机：每次独立随机，短期内容易重复</div></div>',
    '<div class="dsg-row"><div class="dsg-row-top"><span class="dsg-row-label">4 自动播放</span>',
    '<input class="dsg-check" type="checkbox" data-act="autoplay">',
    '<span class="dsg-row-val">语音与立绘</span></div>',
    '<div class="dsg-sub"><span>每</span>',
    '<input class="dsg-num" type="number" data-act="autoplay-min" min="0.5" max="240" step="0.5">',
    '<span>分钟自动播放</span></div></div>',
    '<div class="dsg-sep"></div>',
    '<div class="dsg-row"><div class="dsg-row-top"><span class="dsg-row-label">5 对话框缩放</span>',
    '<span class="dsg-stepper">',
    '<button class="dsg-step" type="button" data-act="dialog-scale-dec" title="缩小">−</button>',
    '<span class="dsg-step-val" data-val="dialog-scale">5</span>',
    '<button class="dsg-step" type="button" data-act="dialog-scale-inc" title="放大">+</button>',
    '</span></div>',
    '<div class="dsg-hint">1 – 10 档，默认 5</div></div>',
    '<div class="dsg-row"><div class="dsg-row-top"><span class="dsg-row-label">对话框开关</span>',
    '<input class="dsg-check" type="checkbox" data-act="dialog-enabled">',
    '<span class="dsg-row-val">显示对话框</span></div></div>',
    '<div class="dsg-row"><div class="dsg-row-top"><span class="dsg-row-label">对话框位置</span>',
    '<button class="dsg-btn" type="button" data-act="dialog-side">立绘上方</button></div></div>',
    '<div class="dsg-row"><div class="dsg-row-top"><span class="dsg-row-label">不透明度</span>',
    '<input class="dsg-range" type="range" data-act="dialog-opacity" min="0" max="95" step="1">',
    '<span class="dsg-row-val" data-val="dialog-opacity">0%</span></div>',
    '<div class="dsg-hint">0% = 对话框原图完全不透明</div></div>',
    '<div class="dsg-row"><div class="dsg-row-top"><span class="dsg-row-label">对话框底图</span>',
    '<button class="dsg-btn" type="button" data-act="plate-pick">更换图片…</button></div>',
    '<div class="dsg-sub">',
    '<button class="dsg-btn" type="button" data-act="plate-blank">空白底图</button>',
    '<button class="dsg-btn" type="button" data-act="plate-default">恢复默认</button>',
    '</div>',
    '<input class="dsg-file" type="file" data-act="plate-file" accept="image/png,image/jpeg,image/webp,image/gif">',
    '<div class="dsg-hint" data-val="plate-info"></div></div>',
    '<div class="dsg-sep"></div>',
    '<div class="dsg-row"><div class="dsg-row-top"><span class="dsg-row-label">6 立绘包</span>',
    '<select class="dsg-select" data-act="sprite-pack"></select></div>',
    '<div class="dsg-hint" data-val="sprite-pack-info"></div></div>',
    '<div class="dsg-row"><div class="dsg-row-top"><span class="dsg-row-label">7 语音包</span>',
    '<select class="dsg-select" data-act="voice-pack"></select></div>',
    '<div class="dsg-hint" data-val="voice-pack-info"></div></div>',
  ].join('')
  stage.appendChild(panel)

  const el = (act) => panel.querySelector(`[data-act="${act}"]`)
  const valEl = (name) => panel.querySelector(`[data-val="${name}"]`)
  const ui = {
    scaleDec: el('scale-dec'),
    scaleInc: el('scale-inc'),
    scaleVal: valEl('scale'),
    volume: el('volume'),
    volumeVal: valEl('volume'),
    lang: el('lang'),
    voiceOrder: el('voice-order'),
    autoPlay: el('autoplay'),
    autoPlayMin: el('autoplay-min'),
    dialogScaleDec: el('dialog-scale-dec'),
    dialogScaleInc: el('dialog-scale-inc'),
    dialogScaleVal: valEl('dialog-scale'),
    dialogEnabled: el('dialog-enabled'),
    dialogSide: el('dialog-side'),
    dialogOpacity: el('dialog-opacity'),
    dialogOpacityVal: valEl('dialog-opacity'),
    platePick: el('plate-pick'),
    plateBlank: el('plate-blank'),
    plateDefault: el('plate-default'),
    plateFile: el('plate-file'),
    plateInfo: valEl('plate-info'),
    spritePack: el('sprite-pack'),
    spritePackInfo: valEl('sprite-pack-info'),
    voicePack: el('voice-pack'),
    voicePackInfo: valEl('voice-pack-info'),
  }

  // Start hidden; the widget is revealed once the first bootstrap answers.
  root.style.visibility = 'hidden'
  const mount = () => (document.body || document.documentElement).appendChild(root)
  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount, { once: true })

  // ── audio ─────────────────────────────────────────────────────────────────
  let voiceAudio = null
  let clickAudio = null

  /**
   * How long a line may wait for its bytes before it is written off.
   *
   * A media element that never gets its data does not fail: it sits at
   * `networkState: LOADING` and its `play()` promise stays pending, so the box
   * looks fine and simply makes no sound. Waiting forever is worse than silence —
   * a clip that arrives ten seconds later plays into a box that has moved on.
   */
  const VOICE_READY_TIMEOUT_MS = 5000

  /** Bumped for every new line, so a slow load can never start a stale voice. */
  let voiceToken = 0
  let voiceStartTimer = null

  /**
   * Byte cache: asset url -> Promise<objectURL | null>.
   *
   * Media elements fetch their own `src`, and in the DSH web app those requests
   * lose the race for the page's six HTTP/1.1 connections. Measured on a real
   * session: every `/api/turn` poll answered in 1-3ms while three `<audio>`
   * elements sat `stalled` for ten seconds and then all became playable in the
   * same instant — the request queue draining when the conversation was used.
   * `fetch` never lost that race, so the bytes are fetched here and played from a
   * blob, which keeps playback off the starved media queue entirely.
   */
  const audioBytes = new Map()
  const AUDIO_BYTES_KEEP = 6

  function audioBytesFor(url) {
    const hit = audioBytes.get(url)
    if (hit) return hit
    const pending = fetch(url, { cache: 'force-cache' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.blob()
      })
      .then((blob) => URL.createObjectURL(blob))
      .catch((err) => {
        // Fall back to letting the element fetch it directly; say why, because a
        // silent failure here is exactly the bug this path exists to avoid.
        console.warn(`[dsh-gal] 语音字节读取失败，改用直连播放：${url} — ${String((err && err.message) || err)}`)
        return null
      })
    audioBytes.set(url, pending)
    if (audioBytes.size > AUDIO_BYTES_KEEP) {
      const oldest = audioBytes.keys().next().value
      if (oldest !== url) {
        const stale = audioBytes.get(oldest)
        audioBytes.delete(oldest)
        Promise.resolve(stale).then((blobUrl) => {
          if (blobUrl && blobUrl !== voiceBlobUrl && blobUrl !== clickBlobUrl) URL.revokeObjectURL(blobUrl)
        })
      }
    }
    return pending
  }

  let voiceBlobUrl = null
  let clickBlobUrl = null
  let clickWarmed = false

  /** The settings click must be instant too — it is 65KB, so warm it at boot. */
  function warmClickSound() {
    if (clickWarmed) return
    clickWarmed = true
    audioBytesFor(`${UI}/click.wav`).then((blobUrl) => {
      clickBlobUrl = blobUrl
    })
  }

  /**
   * "This line is finished" gate.
   *
   * The box must linger for `dialogHoldSeconds` after the *voice* stops — not
   * after the text stops appearing. A spoken line is routinely longer than the
   * typewriter animation, so hiding on the text alone cut the audio off
   * mid-sentence. Both signals must land before the countdown starts.
   */
  let typingFinished = false
  let voiceFinished = true
  let voiceFallbackTimer = null
  // Set when the countdown was armed by an explicit click on the box. From then
  // on the typing/voice callbacks must leave it alone — otherwise a voice that
  // happens to still be playing would silently extend the 3s the user just asked
  // for.
  let holdLatched = false

  function clearVoiceFallback() {
    if (voiceFallbackTimer) {
      clearTimeout(voiceFallbackTimer)
      voiceFallbackTimer = null
    }
    if (voiceStartTimer) {
      clearTimeout(voiceStartTimer)
      voiceStartTimer = null
    }
  }

  /** Start of a new line: nothing has finished yet. */
  function resetLineGate() {
    typingFinished = false
    voiceFinished = true // flipped to false the moment a voice actually starts
    holdLatched = false
    clearVoiceFallback()
    cancelAutoHide()
  }

  function noteTypingFinished() {
    typingFinished = true
    if (!holdLatched && voiceFinished) scheduleAutoHide()
  }

  function noteVoiceFinished() {
    clearVoiceFallback()
    voiceFinished = true
    if (!holdLatched && typingFinished) scheduleAutoHide()
  }

  function stopVoice() {
    // Supersede whatever was loading: a line that is no longer current must not
    // suddenly start playing later.
    voiceToken++
    clearVoiceFallback()
    if (!voiceAudio) return
    try {
      voiceAudio.pause()
      voiceAudio.removeAttribute('src')
      voiceAudio.load()
    } catch {
      // ignore
    }
    voiceAudio = null
  }

  /**
   * Play one line from bytes we fetched ourselves.
   *
   * `playVoice` may be called twice in a row (a click during a load, or a new line
   * arriving while the previous one was still fetching); the token makes sure only
   * the line that is still current reaches the speakers.
   */
  function startVoiceAudio(src, token) {
    if (token !== voiceToken) return
    try {
      const audio = new Audio(src)
      audio.volume = clamp(num(cfg().volume, 0.5), 0, 1)
      audio.addEventListener('ended', noteVoiceFinished, { once: true })
      audio.addEventListener('error', () => {
        console.warn('[dsh-gal] 语音解码或加载失败，本句按无声处理')
        noteVoiceFinished()
      }, { once: true })
      audio.addEventListener(
        'playing',
        () => {
          if (voiceStartTimer) {
            clearTimeout(voiceStartTimer)
            voiceStartTimer = null
          }
        },
        { once: true },
      )
      // Safety net: a truncated stream may never fire `ended`, and the box must not
      // be held open forever waiting for it.
      audio.addEventListener(
        'loadedmetadata',
        () => {
          if (voiceFallbackTimer) clearTimeout(voiceFallbackTimer)
          const seconds = Number.isFinite(audio.duration) ? audio.duration : 120
          voiceFallbackTimer = setTimeout(noteVoiceFinished, Math.min(seconds, 600) * 1000 + 2000)
        },
        { once: true },
      )
      voiceFallbackTimer = setTimeout(noteVoiceFinished, 120000)
      voiceAudio = audio
      voiceFinished = false
      const started = audio.play()
      if (started && typeof started.catch === 'function') {
        started.catch((err) => {
          console.warn(`[dsh-gal] 语音播放被拒绝（${String((err && err.name) || err)}），本句按无声处理`)
          noteVoiceFinished()
        })
      }
    } catch (err) {
      console.warn(`[dsh-gal] 无法创建音频元素：${String((err && err.message) || err)}`)
      noteVoiceFinished()
    }
  }

  function playVoice(url) {
    if (!url) return
    stopVoice() // bumps the token: anything still loading is now stale
    clearVoiceFallback()
    const token = voiceToken
    voiceStartTimer = setTimeout(() => {
      voiceStartTimer = null
      if (token !== voiceToken) return
      voiceToken++ // drop the pending line so it cannot sound off later
      console.warn('[dsh-gal] 语音迟迟没有加载出来，本句按无声处理')
      noteVoiceFinished()
    }, VOICE_READY_TIMEOUT_MS)
    audioBytesFor(url).then((blobUrl) => {
      if (token !== voiceToken) return
      if (blobUrl && voiceBlobUrl !== blobUrl) voiceBlobUrl = blobUrl
      startVoiceAudio(blobUrl || url, token)
    })
  }

  function playClick() {
    warmClickSound()
    try {
      const src = clickBlobUrl || `${UI}/click.wav`
      if (!clickAudio || clickAudio.dataset.src !== src) {
        clickAudio = new Audio(src)
        clickAudio.dataset.src = src
      }
      clickAudio.volume = clamp(num(cfg().volume, 0.5), 0, 1)
      clickAudio.currentTime = 0
      const started = clickAudio.play()
      if (started && typeof started.catch === 'function') {
        started.catch((err) => {
          console.warn(`[dsh-gal] 点击音播放被拒绝：${String((err && err.name) || err)}`)
        })
      }
    } catch {
      // A missing click sound must never break the settings button.
    }
  }

  function applyVolume() {
    const volume = clamp(num(cfg().volume, 0.5), 0, 1)
    if (voiceAudio) voiceAudio.volume = volume
    if (clickAudio) clickAudio.volume = volume
  }

  // ── server io ─────────────────────────────────────────────────────────────
  async function getJson(url) {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  }

  let saveTimer = null
  let pendingPatch = {}

  /** Coalesce rapid slider changes into one PUT. */
  function save(patch, immediate = false) {
    pendingPatch = { ...pendingPatch, ...patch }
    if (immediate) {
      const body = pendingPatch
      pendingPatch = {}
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
      return fetch(`${API}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then((r) => r.json())
        .then((d) => {
          if (d && d.config) state.config = d.config
          return d
        })
        .catch(() => null)
    }
    if (saveTimer) return Promise.resolve(null)
    saveTimer = setTimeout(() => {
      saveTimer = null
      const body = pendingPatch
      pendingPatch = {}
      fetch(`${API}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then((r) => r.json())
        .then((d) => {
          if (d && d.config) state.config = d.config
        })
        .catch(() => {})
    }, 220)
    return Promise.resolve(null)
  }

  // ── layout ────────────────────────────────────────────────────────────────
  /* @pure-start */
  /**
   * A token count in K / M.
   *
   * A receipt is read at a glance: "128,453" has to be parsed digit by digit,
   * "128.5K" is recognised in one look. Below 1K the number is already short
   * enough to read as it is, so it stays exact — the unit is never used to hide
   * precision that fits. Above that it is one decimal for K and two for M, with
   * trailing zeros trimmed ("2K" rather than "2.0K").
   *
   * The thresholds are the *rounded* ones on purpose: 999,950 must read "1M"
   * rather than "1000.0K", and 999.6 must read "1K" rather than "1000".
   */
  function formatTokenCount(tokens) {
    // A missing count is not a count of zero — `Number(null)` is 0, which would
    // print a confident "0 token" for a turn that never reported its usage.
    if (tokens === null || tokens === undefined || tokens === '') return '--'
    const n = Number(tokens)
    if (!Number.isFinite(n)) return '--'
    const abs = Math.abs(n)
    if (abs >= 999950) return `${trimZeros((n / 1e6).toFixed(2))}M`
    if (abs >= 999.5) return `${trimZeros((n / 1e3).toFixed(1))}K`
    return String(Math.round(n))
  }
  const trimZeros = (s) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s)

  /**
   * Placement maths, deliberately free of DOM access so it can be exercised
   * directly: scripts/verify.mjs lifts this block out and drives every branch.
   *
   * Returns the art's top-left corner plus the dialogue box's offset *relative
   * to the art box*:
   *
   *   side "below": if the art already sits on the bottom edge the plate shares
   *                 that edge (overlapping the art); if there is a partial gap the
   *                 art is nudged up so the plate fits completely.
   *   side "above": if the art sits on the top edge the plate flips underneath it;
   *                 if there is a partial gap the art is nudged down.
   *
   * The nudge is a layout offset only — the dragged anchor is never rewritten,
   * so hiding the dialogue box returns the art to exactly where the user left it.
   */
  function computePlacement(input) {
    const clamp = (v, min, max) => Math.min(Math.max(v, min), max)
    const { vw, vh, contentW, contentH, dlgW, dlgH, gap } = input
    const dialogOn = input.dialogOn !== false
    const side = input.side === 'below' ? 'below' : 'above'

    let sx = input.hx === 'left' ? input.hd : vw - input.hd - contentW
    let sy = input.vy === 'top' ? input.vd : vh - input.vd - contentH
    sx = clamp(sx, -contentW * 0.4, vw - contentW * 0.6)
    sy = clamp(sy, -contentH * 0.4, vh - contentH * 0.6)

    let dx = (contentW - dlgW) / 2 // centred on the art
    let dy = -dlgH - gap // above

    if (dialogOn) {
      if (side === 'below') {
        if (sy + contentH + gap + dlgH > vh) {
          const roomBelow = vh - (sy + contentH)
          if (roomBelow < gap) {
            // Pinned to the bottom edge: share it, overlapping the art.
            dy = contentH - dlgH
          } else {
            const pushed = clamp(vh - dlgH - gap - contentH, 0, vh)
            if (pushed < sy) {
              sy = pushed
              dy = contentH + gap
            } else {
              dy = contentH - dlgH
            }
          }
        } else {
          dy = contentH + gap
        }
      } else if (sy - gap - dlgH < 0) {
        if (sy < gap) {
          dy = contentH + gap // art pinned to the top: flip the plate underneath
        } else {
          sy = clamp(dlgH + gap, 0, Math.max(0, vh - contentH))
          dy = -dlgH - gap
        }
      }
      // Final guard: the plate must stay fully on screen.
      if (sx + dx < 0) dx = -sx
      if (sx + dx + dlgW > vw) dx = vw - sx - dlgW
      if (sy + dy < 0) dy = -sy
      if (sy + dy + dlgH > vh) dy = vh - sy - dlgH
    }
    return { sx, sy, dx, dy }
  }
  /**
   * Settings panel placement: above the art when there is room, below it
   * otherwise. The vertical clamp on the end is the important part — without it
   * a large art size pushes the panel off the bottom of the screen, and since
   * the panel holds the *only* control that shrinks the art again, the widget
   * would be stuck that way with no way back.
   */
  function computePanelPlacement(input) {
    const clamp = (v, min, max) => Math.min(Math.max(v, min), max)
    const { vw, vh, contentW, contentH, panelW, panelH, sx, sy } = input
    let py = -panelH - 8 // above the art
    if (sy + py < 6) py = contentH + 8 // no room above: drop below the art
    let px = contentW - panelW // flush with the art's right edge
    if (sx + px < 6) px = 6 - sx
    if (sx + px + panelW > vw - 6) px = vw - 6 - panelW - sx
    if (sy + py + panelH > vh - 6) py = vh - 6 - panelH - sy
    if (sy + py < 6) py = 6 - sy
    return { px, py }
  }
  /**
   * How long the box lingers, in seconds.
   *
   * A voice line and the balance table follow the configured hold. The turn
   * receipt does not: nobody asked for it, it arrives while the user is still
   * reading the answer, and it replaces nothing they were looking at — so it gets
   * a fixed duration of its own instead of the usual 3s.
   */
  function computeHoldSeconds(sheet, configured, costHold) {
    const clamp = (v, min, max) => Math.min(Math.max(v, min), max)
    if (sheet === 'cost') {
      const c = Number(costHold)
      return Number.isFinite(c) ? c : 5
    }
    const n = Number(configured)
    return Number.isFinite(n) ? clamp(n, 0.5, 120) : 3
  }
  /**
   * Read one `/api/turn` poll and decide whether it is a receipt to show.
   *
   * The counter is a plain "how many turns have settled since the host started"
   * number, so a page load cannot tell a turn that settled *before* it from one
   * that settles right after — and it must not print a stale receipt on every
   * refresh. Hence the alignment: the first reading (`aligned: false`) is only a
   * baseline, never a receipt. Everything that follows is a genuine new turn as
   * long as the number went up.
   *
   * Getting the baseline wrong in the other direction is just as bad, and was a
   * real bug: treating "the counter was 0 before" as "this is the baseline" threw
   * away the first turn after every DSH restart — the exact turn a user is most
   * likely to be looking at.
   */
  function readTurnPoll(prevSeq, aligned, seq, tokens, amount) {
    const s = Math.trunc(Number(seq))
    if (!Number.isFinite(s)) return { aligned, seq: prevSeq, show: false }
    if (!aligned) return { aligned: true, seq: s, show: false }
    if (s <= prevSeq) return { aligned: true, seq: prevSeq, show: false }
    const hasFigures = Number(tokens) > 0 || Number(amount) > 0
    return { aligned: true, seq: s, show: hasFigures }
  }
  /* @pure-end */

  /** Width / height of the *visible* slice of the dialogue plate. */
  function dialogAspect() {
    const geo = state.dialog || DEFAULT_DIALOG_GEO
    const crop = geo.crop || DEFAULT_DIALOG_GEO.crop
    const image = geo.image || DEFAULT_DIALOG_GEO.image
    const w = (crop.w || 1) * (image.width || 1)
    const h = (crop.h || 1) * (image.height || 1)
    return h > 0 ? w / h : 16 / 9
  }

  /** A 1..10 level as a multiplier for the art. Level 5 is the 0.5 the old percentage form meant. */
  const levelFactor = (level) => clamp(num(level, 5), SCALE_MIN, SCALE_MAX) / 10

  /**
   * The dialogue box uses its own, deliberately re-based unit.
   *
   * The first release drove it from the same /10 factor as the art, which made
   * the default box far too large. The unit is now 0.04 per level, so level 5 —
   * the default — produces exactly what the old build produced at level 2, and
   * the comfortable size sits in the middle of the range. Level 25 would be the
   * full base width. Stored configs are re-based by `migrateConfig()`.
   */
  const DIALOG_LEVEL_UNIT = 0.04
  const dialogFactor = (level) => clamp(num(level, 5), SCALE_MIN, SCALE_MAX) * DIALOG_LEVEL_UNIT

  /** Resolve every on-screen size, then ask computePlacement where things go. */
  function layout() {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const c = cfg()
    const pack = packOf(state.packs.spritePacks, c.spritePack)
    const aspect =
      state.sprite && state.sprite.aspect
        ? state.sprite.aspect
        : pack && pack.aspect
          ? pack.aspect
          : 1

    const contentH = clamp(Math.min(vh * 0.52, 620) * levelFactor(c.scale), 24, vh * 1.2)
    const contentW = clamp(contentH * aspect, 20, vw * 1.2)

    // Placement always reserves room for the box as long as the setting allows
    // it — even while the box is faded out. Re-flowing on every auto-hide would
    // make the art lurch up and down on a 3-second cycle. Switching the box off
    // entirely (the setting) is what returns the art to its dragged position.
    const dialogOn = c.dialogEnabled !== false
    // The plate is a wide strip after cropping, so the same vertical budget
    // affords a wider — and therefore sharper — box than the raw 16:9 artwork.
    const dlgW = clamp(Math.min(vw * 0.66, 1040) * dialogFactor(c.dialogScale), 70, vw * 0.96)
    const dlgH = dlgW / dialogAspect()

    const pos = c.pos || { hx: 'right', hd: 24, vy: 'bottom', vd: 24 }
    const placed = computePlacement({
      vw,
      vh,
      contentW,
      contentH,
      dlgW,
      dlgH,
      gap: GAP,
      dialogOn,
      side: c.dialogSide,
      hx: pos.hx,
      hd: num(pos.hd, 24),
      vy: pos.vy,
      vd: num(pos.vd, 24),
    })

    // Keep the settings button proportionate to the art it sits on.
    const gearSize = clamp(Math.round(contentW * 0.17), 18, 34)

    return {
      vw,
      vh,
      contentW,
      contentH,
      dlgW,
      dlgH,
      sx: placed.sx,
      sy: placed.sy,
      dx: placed.dx,
      dy: placed.dy,
      dialogOn,
      pack,
      gearSize,
    }
  }

  /**
   * The dialogue plate's inner box and the strip reserved for the footer.
   * Shared by applyLayout() and syncFooter() so the two always agree.
   */
  function dialogBox() {
    const geo = state.dialog || DEFAULT_DIALOG_GEO
    const m = layout()
    const inset = geo.inset || DEFAULT_DIALOG_GEO.inset
    // No minimum inflation here: the figure sheets derive their safe band from
    // this number, and padding it up to a floor pushed that band down over the
    // logo on the smallest plates.
    const innerH = Math.max(1, m.dlgH * (1 - num(inset.top, 0.07) - num(inset.bottom, 0.04)))
    const ratio = clamp(num((geo.footer || {}).heightRatio, 0.42), 0.15, 0.7)
    return { m, geo, innerH, footerCap: Math.max(6, Math.round(innerH * ratio)) }
  }

  function applyLayout() {
    const box = dialogBox()
    const m = box.m
    const c = cfg()
    const geo = box.geo

    stage.style.transform = `translate(${Math.round(m.sx)}px, ${Math.round(m.sy)}px)`
    spriteBox.style.width = `${m.contentW}px`
    spriteBox.style.height = `${m.contentH}px`

    // Crop away the transparent margin: the box *is* the visible area.
    const sprite = state.sprite
    const crop = (sprite && sprite.crop) || (m.pack && m.pack.crop) || { x: 0, y: 0, w: 1, h: 1 }
    const imgW = m.contentW / (crop.w || 1)
    const imgH = m.contentH / (crop.h || 1)
    spriteImg.style.width = `${imgW}px`
    spriteImg.style.height = `${imgH}px`
    spriteImg.style.left = `${-crop.x * imgW}px`
    spriteImg.style.top = `${-crop.y * imgH}px`

    gear.style.width = `${m.gearSize}px`
    gear.style.height = `${m.gearSize}px`
    gear.style.left = `${Math.max(0, m.contentW - m.gearSize)}px`
    gear.style.top = '0px'

    dialog.style.width = `${m.dlgW}px`
    dialog.style.height = `${m.dlgH}px`
    dialog.style.left = `${m.dx}px`
    dialog.style.top = `${m.dy}px`
    const visible = m.dialogOn && state.dialogShown === true
    dialog.style.opacity = visible ? String(clamp(1 - num(c.dialogOpacity, 0) / 100, 0.05, 1)) : '0'
    root.classList.toggle('dsg-dialog-on', visible)
    root.classList.toggle('dsg-hidden', c.spriteVisible === false)
    root.classList.toggle('dsg-nosprite', !state.sprite)

    // Show only the bottom slice of the artwork (see assets/ui/dialog.json).
    const plateCrop = geo.crop || DEFAULT_DIALOG_GEO.crop
    const plateImgW = m.dlgW / (plateCrop.w || 1)
    const plateImgH = m.dlgH / (plateCrop.h || 1)
    dialogImg.style.width = `${plateImgW}px`
    dialogImg.style.height = `${plateImgH}px`
    dialogImg.style.left = `${-plateCrop.x * plateImgW}px`
    dialogImg.style.top = `${-plateCrop.y * plateImgH}px`
    dialogPlate.style.borderRadius = `${Math.max(0, num(geo.radius, 10))}px`

    // Text area: the plate's inner box minus the reserved footer strip.
    const inset = geo.inset || DEFAULT_DIALOG_GEO.inset
    const insetL = m.dlgW * num(inset.left, 0.05)
    const insetR = m.dlgW * num(inset.right, 0.05)
    const insetT = m.dlgH * num(inset.top, 0.07)
    const insetB = m.dlgH * num(inset.bottom, 0.04)
    dialogBody.style.left = `${insetL}px`
    dialogBody.style.right = `${insetR}px`
    dialogBody.style.top = `${insetT}px`
    dialogBody.style.bottom = `${insetB}px`

    // The footer is deliberately the chunky part of the box and is kept clear of
    // the logo in the bottom-right corner.
    //
    // It is sized to its *content*, capped by the reserved ratio — not pinned to
    // a fixed share of the box. A fixed share is smaller than two rows of text
    // once the plate gets short (level 4 and below), and because the footer is
    // bottom-aligned with nothing clipping it, the overflow spilled upwards and
    // sat on top of the dialogue line.
    const innerW = Math.max(40, m.dlgW - insetL - insetR)
    const figuresFull = foot.classList.contains('dsg-foot-full')
    // The width cap serves exactly one layout: a voice line with the small figures
    // underneath, where they have to keep clear of the logo in the bottom-right
    // corner. A figure sheet needs no cap — it *is* the content, and the vertical
    // 72% band already clears the logo. Worse, a capped flex item under
    // `align-items:stretch` is placed at the *start* of the cross axis, so the cap
    // left the strip hugging the left edge with the figures centred inside it:
    // visually off-centre in the plate. Hence 'none', not the class rule alone —
    // this inline style would have won over `.dsg-foot-full{max-width:none}`.
    foot.style.maxWidth = figuresFull
      ? 'none'
      : `${Math.round(innerW * clamp(num((geo.footer || {}).maxWidthRatio, 0.66), 0.3, 1))}px`
    const footerH = fitFooter(m.dlgW, figuresFull ? box.innerH : box.footerCap, figuresFull)
    lastFooterH = footerH

    // Re-fit the line whenever the plate *or the reserved footer strip* changed,
    // so the text keeps filling whatever is left. Skipped otherwise: a mid-typing
    // re-fit would cut the animation short on every sprite load.
    const fitKey = `${Math.round(m.dlgW)}x${Math.round(m.dlgH)}x${Math.round(footerH)}`
    if (fitKey !== lastFitKey) {
      lastFitKey = fitKey
      refitLine()
    }

    // Settings panel: above the art when there is room, otherwise below it,
    // always clamped back into view (see computePanelPlacement).
    const panelH = panel.offsetHeight || 380
    const panelW = panel.offsetWidth || 272
    const placedPanel = computePanelPlacement({
      vw: m.vw,
      vh: m.vh,
      contentW: m.contentW,
      contentH: m.contentH,
      panelW,
      panelH,
      sx: m.sx,
      sy: m.sy,
    })
    panel.style.left = `${Math.round(placedPanel.px)}px`
    panel.style.top = `${Math.round(placedPanel.py)}px`
  }

  // ── rendering ─────────────────────────────────────────────────────────────
  function currentLine() {
    const voice = state.voice
    if (!voice) return ''
    const zh = (voice.zh || '').trim()
    const ja = (voice.ja || '').trim()
    if (cfg().lang === 'zh') return zh || ja
    return ja || zh
  }

  /**
   * Auto-fit: pick the largest font size at which the whole line still fits the
   * text area, so long lines shrink to fit and short ones grow — but only up to
   * `MAX_LINE_FONT`, never to "as big as the box allows".
   *
   * The floor is deliberately very low. An earlier version refused to go below
   * 12px, which meant a long line in a short plate could not fit at all: it
   * overflowed and `overflow:hidden` cut it off exactly at the footer's top edge,
   * so the balance figures looked like they were covering the text. Better a
   * small complete line than a truncated legible one.
   */
  const MIN_LINE_FONT = 5

  /**
   * The upper end of the scale, in px.
   *
   * Filling the plate is the wrong goal for a caption: a two-character line grew
   * to 44px on a large plate, which reads as a shout rather than a line of
   * dialogue. The cap keeps short lines merely *prominent*, and it only ever binds
   * on short ones — a long line is limited by the box long before it gets here.
   */
  const MAX_LINE_FONT = 28

  /**
   * Measure with fractional precision.
   *
   * `clientHeight`/`scrollHeight` are integers, and their 1px of slack was
   * enough to let a level-9 box overflow by 1.3px — a real, if sub-pixel, clip
   * that also slipped past the truncation cue.
   */
  const lineAvail = () => lineBox.getBoundingClientRect().height
  const lineTextHeight = () => lineInner.getBoundingClientRect().height

  /**
   * Share of the plate's inner height the receipt / balance sheets may use.
   *
   * The shipped artwork carries a logo at y 72.8%–90.9%; its inner box spans
   * 7%–96%, so (72.8-7)/89 = 0.739 is the last safe fraction, which the shipped
   * geometry rounds down to 0.72. The value travels with the plate: a self-made
   * image with nothing in the corner declares 1 and the figures get the whole
   * height. Read per call, so replacing the plate takes effect immediately.
   */
  function logoShare() {
    return clamp(num((state.dialog || {}).logoShare, DEFAULT_DIALOG_GEO.logoShare), 0.2, 1)
  }

  /**
   * Commit a font size, then make sure it really fits.
   *
   * Text height jumps in whole rows as the font crosses a wrap boundary, so the
   * winning size sits right on a cliff edge. `toFixed(1)` rounds 6.19 *up* to
   * 6.2, which is enough to push one more character onto a new line and overflow
   * — that is exactly how a level-4 box ended up 4px short. Round down, then walk
   * back in 0.1px steps until the measurement agrees.
   */
  function commitLineFont(size, avail) {
    let chosen = Math.max(MIN_LINE_FONT, Math.floor(size * 10) / 10)
    lineInner.style.fontSize = `${chosen}px`
    let guard = 0
    while (chosen > MIN_LINE_FONT && lineTextHeight() > avail + 0.5 && guard++ < 120) {
      chosen = Math.round((chosen - 0.1) * 10) / 10
      lineInner.style.fontSize = `${chosen}px`
    }
    // Still overflowing at the floor means the plate is genuinely too small for
    // this line (levels 1-2 with a very long line). Fade the cut edge so it reads
    // as "there is more below" instead of looking like the footer is sitting on
    // top of the text.
    lineBox.classList.toggle('dsg-line-clipped', lineTextHeight() > avail + 0.5)
    return chosen
  }

  function fitLine() {
    if (!lineInner.textContent) return
    const avail = lineAvail()
    if (!avail || avail < 4) return
    // `avail * 0.86` is what the *box* would allow; MAX_LINE_FONT is what the line
    // is allowed to want.
    const hi = clamp(avail * 0.86, 8, MAX_LINE_FONT)
    if (hi <= MIN_LINE_FONT) {
      commitLineFont(MIN_LINE_FONT, avail)
      return
    }
    lineInner.style.fontSize = `${hi}px`
    if (lineTextHeight() <= avail + 0.5) {
      commitLineFont(hi, avail)
      return
    }
    // Binary search the largest size that still fits, then verify after rounding.
    let low = MIN_LINE_FONT
    let high = hi
    for (let i = 0; i < 9; i++) {
      const mid = (low + high) / 2
      lineInner.style.fontSize = `${mid}px`
      if (lineTextHeight() <= avail + 0.5) low = mid
      else high = mid
    }
    commitLineFont(low, avail)
  }

  let typingTimer = null
  let hideTimer = null
  let currentFullText = ''
  let lastFitKey = ''
  let lastFooterH = -1

  function stopTyping() {
    if (typingTimer) {
      clearInterval(typingTimer)
      typingTimer = null
    }
  }

  function cancelAutoHide() {
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
  }

  /**
   * How long the box lingers before fading out. See `computeHoldSeconds` for why
   * the receipt is the odd one out.
   */
  function holdSeconds() {
    return computeHoldSeconds(state.sheet, cfg().dialogHoldSeconds, COST_HOLD_SECONDS)
  }

  /**
   * The box is not a permanent fixture: once the line has finished appearing it
   * lingers for a moment and then gets out of the way.
   */
  function scheduleAutoHide() {
    cancelAutoHide()
    // While the settings panel is open the box stays put: otherwise it would
    // vanish mid-adjustment and you could never see what the size or opacity
    // sliders were actually doing.
    if (state.panelOpen) return
    const hold = holdSeconds()
    hideTimer = setTimeout(() => {
      hideTimer = null
      hideDialog()
    }, hold * 1000)
  }

  /** Fade the box out and settle the art back to its resting pose. */
  function hideDialog() {
    state.dialogShown = false
    revertToDefaultSprite()
    applyLayout()
  }

  function showDialog() {
    if (cfg().dialogEnabled === false) return
    if (state.dialogShown === true) return
    state.dialogShown = true
    applyLayout()
  }

  /** Show the whole line at once, sized to fill the box. */
  function showLine(text) {
    stopTyping()
    currentFullText = text || ''
    lineInner.style.opacity = currentFullText ? '1' : '0.5'
    lineInner.textContent = currentFullText
    fitLine()
  }

  /** Reveal the line character by character, at the size it will end up. */
  function typeLine(text) {
    showLine(text)
    if (!currentFullText) return
    const full = currentFullText
    const delay = clamp(2200 / Math.max(1, full.length), 14, 52)
    let shown = 0
    lineInner.textContent = ''
    typingTimer = setInterval(() => {
      shown += 1
      if (shown >= full.length) {
        stopTyping()
        lineInner.textContent = full
        // Settle on the final size for whatever layout is current — the box may
        // have been resized (or the footer grown) while the animation ran.
        fitLine()
        // The text is done, but the countdown also waits for the voice to stop.
        noteTypingFinished()
        return
      }
      lineInner.innerHTML = `${escapeHtml(full.slice(0, shown))}<span class="dsg-caret"></span>`
    }, delay)
  }

  /**
   * Size the footer to the strip it was given.
   *
   * The figures have to stay legible from level 1 (a ~70px plate) to level 10,
   * so rather than one fixed proportion this picks the largest size at which the
   * wallet line and the (optional) cost line still fit inside `cap`, then reports
   * how tall the footer actually ended up.
   *
   * Height is left to the content (`height:auto`) so a short box is never given a
   * strip taller than it needs — that only starves the dialogue line.
   *
   * `full` is the receipt / balance case, where the strip fills the plate and is
   * centred by CSS. There the figures are the content, so they get a larger
   * type scale and the whole inner box as their budget.
   */
  function fitFooter(dlgW, cap, full) {
    // 'line' mode hides the strip entirely: report zero so the text gets the
    // whole plate.
    if (foot.classList.contains('dsg-foot-off')) {
      foot.style.height = '0px'
      return 0
    }
    if (!cap || cap < 6) return 0
    // The receipt / balance sheets fill the plate, but must stop above the logo:
    // its top edge sits ~73% of the way down the inner box. How much of the plate
    // that is, is part of the plate's geometry — a self-made plate with nothing
    // in the corner reports 1 and the figures get the whole height.
    const budget = full ? Math.max(6, Math.round(cap * logoShare())) : cap
    foot.style.height = 'auto'
    // Fractional, for the same reason as the line fit: `offsetHeight` is an
    // integer and its slack let the figures overflow by up to 1.5px.
    const measure = () => foot.getBoundingClientRect().height
    let hi = full ? clamp(dlgW * 0.08, 10, 34) : clamp(dlgW * 0.045, 8, 26)
    foot.style.fontSize = `${hi}px`
    if (measure() > budget + 0.5) {
      let low = 5
      let high = hi
      for (let i = 0; i < 10; i++) {
        const mid = (low + high) / 2
        foot.style.fontSize = `${mid}px`
        if (measure() <= budget + 0.5) low = mid
        else high = mid
      }
      foot.style.fontSize = `${(Math.floor(low * 10) / 10).toFixed(1)}px`
    }
    // Clamp with the box, not the font: if even the smallest readable size cannot
    // fit, the content is clipped rather than allowed to ride up over whatever is
    // beside it.
    const used = measure()
    const height = full ? budget : Math.min(used, budget)
    foot.style.height = `${height}px`
    foot.style.overflow = 'hidden'
    return height
  }

  /** Re-apply the fitted size to whatever line is current (used on resize). */
  function refitLine() {
    if (!currentFullText) return
    // Never disturb an animation in flight: the partial text would be measured as
    // if it were the whole line and the size would come out far too large. The
    // animation settles the size itself when it completes.
    if (typingTimer) return
    lineInner.textContent = currentFullText
    fitLine()
  }

  /**
   * Re-measure the footer after its content changed (the cost line appearing or
   * disappearing changes how many rows it needs, which changes how much room is
   * left for the dialogue line) and re-flow only when it actually moved.
   */
  function syncFooter() {
    const box = dialogBox()
    const full = foot.classList.contains('dsg-foot-full')
    const used = fitFooter(box.m.dlgW, full ? box.innerH : box.footerCap, full)
    if (used !== lastFooterH) applyLayout()
    else lastFooterH = used
  }

  function renderLine({ type = true } = {}) {
    const text = currentLine()
    // A new line voids any countdown left over from the previous one, and both
    // completion signals have to arrive again before the box may hide.
    resetLineGate()
    // A voice line owns the box: nothing else is on the strip.
    state.sheet = 'line'
    applySheet()
    showDialog()
    if (!text) {
      // Defensive only: renderVoiceSheet() never sends a textless voice here.
      noteTypingFinished()
      return
    }
    if (type) {
      typeLine(text) // noteTypingFinished() runs when the animation completes
    } else {
      showLine(text)
      noteTypingFinished()
    }
  }

  /**
   * Put the picked voice on screen.
   *
   * A voice that has a transcript prints its line. A voice that has none — the
   * pack ships no `script.csv` at all, or that one clip has no row — has nothing
   * to print, so the box shows 余额 / 今日已用 instead of a "（此语音没有对应台词）"
   * placeholder. Playback is unaffected either way: this only decides which of
   * the sheets goes on screen.
   *
   * `waitForVoice` leaves the countdown unarmed because a sound is about to
   * start: `noteVoiceFinished()` arms it the moment the audio ends, so a long
   * clip is never cut off mid-sentence. A silent re-render (boot, pack switch,
   * language toggle) has no audio coming, so it arms the countdown itself.
   */
  function renderVoiceSheet({ waitForVoice = false } = {}) {
    // Nothing picked yet — boot renders the widget before the first roll.
    if (!state.voice) return
    if (currentLine()) {
      renderLine()
      return
    }
    showVoiceWalletSheet({ waitForVoice })
  }

  /** A one-off message on the line sheet, for when there is nothing else to show. */
  function showNotice(text) {
    resetLineGate()
    state.sheet = 'line'
    applySheet()
    showDialog()
    showLine(text)
    noteTypingFinished()
  }

  function renderWallet() {
    const balance = state.balance
    const today = state.today
    if (!balance || balance.ok === false) {
      const reason = balance && balance.error ? balance.error : '读取中…'
      walletLine.innerHTML =
        `<span class="dsg-kv"><span class="dsg-k">余额</span>--</span>` +
        `<span class="dsg-kv"><span class="dsg-k">${escapeHtml(shorten(reason, 24))}</span></span>`
      return
    }
    const balanceText = money(balance.totalBalance, balance.currency)
    const todayText = today && Number.isFinite(Number(today.amount)) ? money(today.amount, balance.currency) : '--'
    const stale = balance.stale ? '（缓存）' : ''
    walletLine.innerHTML =
      `<span class="dsg-kv"><span class="dsg-k">余额</span>${escapeHtml(balanceText)}${stale}</span>` +
      `<span class="dsg-kv"><span class="dsg-k">今日已用</span>${escapeHtml(todayText)}</span>`
  }

  function renderCost() {
    costLine.innerHTML =
      `<span>消耗 ${escapeHtml(formatTokenCount(state.cost.tokens))} token</span>` +
      `<b>花费 ${escapeHtml(money(state.cost.amount, (state.balance && state.balance.currency) || 'CNY'))}</b>`
  }

  /**
   * Show exactly one sheet at a time.
   *
   *  - 'line'   the voice line only. The strip is removed so the text owns the
   *             whole plate (which also buys back the vertical space levels 3-4
   *             were short of).
   *  - 'cost'   the turn receipt.
   *  - 'wallet' 余额 / 今日已用, reached by clicking the box.
   *
   * For the two figure sheets the strip stops being a strip: the text area is
   * hidden outright and the figures are centred in the whole plate, so the voice
   * line is genuinely gone rather than merely pushed aside.
   */
  function applySheet() {
    const sheet = state.sheet
    const figures = sheet === 'cost' || sheet === 'wallet'
    costLine.classList.toggle('dsg-cost-off', sheet !== 'cost')
    walletLine.classList.toggle('dsg-wallet-off', sheet !== 'wallet')
    lineBox.classList.toggle('dsg-line-off', figures)
    foot.classList.toggle('dsg-foot-off', !figures)
    foot.classList.toggle('dsg-foot-full', figures)
    syncFooter()
  }

  function shorten(text, max) {
    const s = String(text || '')
    return s.length > max ? `${s.slice(0, max)}…` : s
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
  }

  /**
   * Say which sprite is the pack's default, and why.
   *
   * Without this the choice is invisible: a pack whose art is all user-supplied
   * silently adopts one file, and a user who set `defaultSprite` in pack.json has
   * no way to confirm it took effect.
   */
  function defaultSpriteNote(pack) {
    if (!pack || !pack.defaultSprite) return ''
    const why = pack.defaultSource === 'config' ? 'pack.json 指定' : '自动选定'
    return ` · 默认立绘 ${pack.defaultSprite}（${why}）`
  }

  /** Clamp anything (including a stale percentage) into a 1..10 level. */
  function levelOf(value) {
    const n = Number(value)
    if (!Number.isFinite(n)) return 5
    return clamp(Math.round(n), SCALE_MIN, SCALE_MAX)
  }

  // ── dialogue plate replacement ────────────────────────────────────────────
  const PLATE_LABEL = { bundled: '插件内置底图', blank: '自带的空白底图', user: '自定义图片' }

  function notePlate(text) {
    ui.plateInfo.textContent = text
  }

  /**
   * Install a plate, then re-flow — no page reload, no DSH restart.
   *
   * The host writes the image and a geometry describing it as one step and
   * answers with that geometry, so the box takes its new shape at once. The image
   * is re-requested with a cache-busting query string because the URL is the same
   * one the old picture was served from.
   */
  async function applyPlate({ preset = '', file = null } = {}) {
    notePlate(file ? '正在应用图片…' : preset === 'blank' ? '正在换成空白底图…' : '正在恢复默认底图…')
    try {
      const res = file
        ? await fetch(`${API}/dialog-image`, {
            method: 'PUT',
            headers: { 'Content-Type': file.type || 'application/octet-stream' },
            body: file,
          })
        : await fetch(`${API}/dialog-image${preset ? `?preset=${encodeURIComponent(preset)}` : ''}`, { method: 'PUT' })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data || data.ok !== true) throw new Error((data && data.error) || `HTTP ${res.status}`)
      if (data.dialog) state.dialog = data.dialog
      if (data.plateSource || data.source) state.plateSource = data.plateSource || data.source
      dialogImg.src = `${UI}/dialog.png?t=${Date.now()}`
      renderForm()
      applyLayout()
    } catch (err) {
      notePlate(`换图失败：${String((err && err.message) || err)}`)
    }
  }

  function renderForm() {
    const c = cfg()
    const scaleLevel = levelOf(c.scale)
    ui.scaleVal.textContent = String(scaleLevel)
    ui.scaleDec.disabled = scaleLevel <= SCALE_MIN
    ui.scaleInc.disabled = scaleLevel >= SCALE_MAX
    ui.volume.value = String(Math.round(num(c.volume, 0.5) * 100))
    ui.volumeVal.textContent = `${Math.round(num(c.volume, 0.5) * 100)}%`
    ui.lang.textContent = c.lang === 'zh' ? '中文' : '日文'
    ui.voiceOrder.textContent = c.voiceOrder === 'random' ? '纯随机' : '洗牌池'
    ui.autoPlay.checked = c.autoPlay === true
    ui.autoPlayMin.value = String(num(c.autoPlayMinutes, 1))
    ui.autoPlayMin.disabled = c.autoPlay !== true
    const dialogLevel = levelOf(c.dialogScale)
    ui.dialogScaleVal.textContent = String(dialogLevel)
    ui.dialogScaleDec.disabled = dialogLevel <= SCALE_MIN
    ui.dialogScaleInc.disabled = dialogLevel >= SCALE_MAX
    ui.dialogEnabled.checked = c.dialogEnabled !== false
    ui.dialogSide.textContent = c.dialogSide === 'below' ? '立绘下方' : '立绘上方'
    ui.dialogOpacity.value = String(Math.round(num(c.dialogOpacity, 0)))
    ui.dialogOpacityVal.textContent = `${Math.round(num(c.dialogOpacity, 0))}%`

    const plate = state.dialog || DEFAULT_DIALOG_GEO
    const plateImage = plate.image || DEFAULT_DIALOG_GEO.image
    notePlate(`${plateImage.width || '?'}×${plateImage.height || '?'} · ${PLATE_LABEL[state.plateSource] || PLATE_LABEL.bundled}`)

    const spriteOptions = state.packs.spritePacks
      .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}（${p.spriteCount}）</option>`)
      .join('')
    if (ui.spritePack.dataset.signature !== spriteOptions) {
      ui.spritePack.dataset.signature = spriteOptions
      ui.spritePack.innerHTML = spriteOptions || '<option value="">（未找到立绘包）</option>'
    }
    ui.spritePack.value = c.spritePack || ''
    const spritePack = packOf(state.packs.spritePacks, c.spritePack)
    ui.spritePackInfo.textContent = spritePack
      ? `${spritePack.spriteCount} 张立绘 · ${spritePack.source === 'user' ? '用户目录' : '插件内置'}` +
        defaultSpriteNote(spritePack)
      : '把立绘包放进 ~/.dsh/dsh-gal/packs'

    const voiceOptions = state.packs.voicePacks
      .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}（${p.voiceCount}）</option>`)
      .join('')
    if (ui.voicePack.dataset.signature !== voiceOptions) {
      ui.voicePack.dataset.signature = voiceOptions
      ui.voicePack.innerHTML = voiceOptions || '<option value="">（未找到语音包）</option>'
    }
    ui.voicePack.value = c.voicePack || ''
    const voicePack = packOf(state.packs.voicePacks, c.voicePack)
    ui.voicePackInfo.textContent = voicePack
      ? `${voicePack.voiceCount} 条语音 · ${voicePack.scriptCount} 条台词` +
        (voicePack.weightedVoiceCount ? ` · 权重 ${voicePack.weightedVoiceCount} 条` : '')
      : '把语音包放进 ~/.dsh/dsh-gal/packs'
  }

  function renderAll() {
    renderForm()
    // Order matters: everything that changes the footer's content must run
    // before layout, and the line is rendered last so its auto-fit measures the
    // final box and its typing animation is never interrupted by a re-flow.
    renderWallet()
    renderCost()
    applySheet()
    applyLayout()
    renderVoiceSheet()
    root.style.visibility = 'visible'
  }

  // ── interactions ──────────────────────────────────────────────────────────
  let drag = null

  spriteBox.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0) return
    // The settings button sits inside the art box but must not start a drag.
    if (gear.contains(event.target)) return
    drag = { x: event.clientX, y: event.clientY, moved: false, id: event.pointerId }
    try {
      spriteBox.setPointerCapture(event.pointerId)
    } catch {
      // pointer capture is a nicety, not a requirement
    }
  })

  spriteBox.addEventListener('pointermove', (event) => {
    if (!drag || drag.id !== event.pointerId) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < DRAG_SLOP) return
    if (!drag.moved) {
      drag.moved = true
      root.classList.add('dsg-dragging')
      drag.startX = drag.x
      drag.startY = drag.y
      const c = cfg()
      const pos = c.pos || {}
      drag.originX = pos.hx === 'left' ? num(pos.hd, 24) : window.innerWidth - num(pos.hd, 24) - spriteBox.offsetWidth
      drag.originY = pos.vy === 'top' ? num(pos.vd, 24) : window.innerHeight - num(pos.vd, 24) - spriteBox.offsetHeight
    }
    const nx = clamp(drag.originX + (event.clientX - drag.startX), -spriteBox.offsetWidth * 0.4, window.innerWidth - spriteBox.offsetWidth * 0.6)
    const ny = clamp(drag.originY + (event.clientY - drag.startY), -spriteBox.offsetHeight * 0.4, window.innerHeight - spriteBox.offsetHeight * 0.6)
    stage.style.transform = `translate(${Math.round(nx)}px, ${Math.round(ny)}px)`
    drag.liveX = nx
    drag.liveY = ny
  })

  function endDrag(event) {
    if (!drag || (event && drag.id !== event.pointerId)) return
    const finished = drag
    drag = null
    root.classList.remove('dsg-dragging')
    if (!finished.moved) {
      onSpriteClick()
      return
    }
    // Persist as a nearest-edge anchor so resizing the window keeps the art put.
    const w = spriteBox.offsetWidth
    const h = spriteBox.offsetHeight
    const x = finished.liveX !== undefined ? finished.liveX : finished.originX
    const y = finished.liveY !== undefined ? finished.liveY : finished.originY
    const pos = {
      hx: x + w / 2 < window.innerWidth / 2 ? 'left' : 'right',
      hd: Math.max(0, Math.round(x + w / 2 < window.innerWidth / 2 ? x : window.innerWidth - x - w)),
      vy: y + h / 2 < window.innerHeight / 2 ? 'top' : 'bottom',
      vd: Math.max(0, Math.round(y + h / 2 < window.innerHeight / 2 ? y : window.innerHeight - y - h)),
    }
    state.config = { ...cfg(), pos }
    applyLayout()
    save({ pos }, true)
  }

  spriteBox.addEventListener('pointerup', endDrag)
  spriteBox.addEventListener('pointercancel', endDrag)

  // Hover is tracked on the art box itself: the root is a zero-sized anchor and
  // would never receive pointer events of its own.
  spriteBox.addEventListener('pointerenter', () => {
    state.hover = true
    root.classList.add('dsg-hover')
  })
  spriteBox.addEventListener('pointerleave', () => {
    state.hover = false
    root.classList.remove('dsg-hover')
  })

  gear.addEventListener('click', (event) => {
    event.stopPropagation()
    playClick()
    togglePanel(!state.panelOpen)
  })

  // The box itself is the control that swaps the sheet. Deliberately silent:
  // switching to the balance figures is a quiet read-out, not a button press.
  // (The gear keeps its click sound — that one is an explicit button.)
  dialog.addEventListener('click', (event) => {
    event.stopPropagation()
    showWalletSheet()
  })

  function togglePanel(open) {
    state.panelOpen = open
    panel.classList.toggle('dsg-panel-open', open)
    gear.classList.toggle('dsg-gear-open', open)
    if (open) {
      renderForm()
      // Pin the box open so every dialogue slider previews live.
      if (cfg().dialogEnabled !== false) {
        cancelAutoHide()
        state.dialogShown = true
      }
      applyLayout()
    } else if (state.dialogShown) {
      scheduleAutoHide()
    }
  }

  document.addEventListener(
    'pointerdown',
    (event) => {
      if (!state.panelOpen) return
      if (panel.contains(event.target) || gear.contains(event.target)) return
      togglePanel(false)
    },
    true,
  )

  window.addEventListener('resize', () => {
    applyLayout()
  })

  // ── the three things a click does ─────────────────────────────────────────
  /** Swap the art, preloading first so the box never flashes empty. */
  function setSprite({ file, url, crop, aspect, persist = true }) {
    if (!file || !url) return
    state.sprite = { file, url, crop, aspect }
    const image = new Image()
    image.onload = () => {
      // Ignore a stale load if another swap already superseded it.
      if (state.sprite && state.sprite.file === file) {
        spriteImg.src = url
        applyLayout()
      }
    }
    image.src = url
    if (persist && cfg().spriteFile !== file) {
      state.config = { ...cfg(), spriteFile: file }
      save({ spriteFile: file })
    }
  }

  /**
   * Return to the pack's own resting pose once the dialogue box has gone.
   *
   * Each interaction shows a random frame, which is what makes the widget feel
   * alive — but leaving a random frame up after the line disappears looks like a
   * glitch. `spriteRevertOnHide: false` keeps whatever was last drawn.
   */
  function revertToDefaultSprite() {
    if (cfg().spriteRevertOnHide === false) return
    const pack = packOf(state.packs.spritePacks, cfg().spritePack)
    const file = pack && pack.defaultSprite
    if (!pack || !file) return
    if (state.sprite && state.sprite.file === file) return
    // Carry the pack's cache token: after the art on disk is replaced (a mirrored
    // pack, say) the plain URL is one the browser has already cached for a week.
    const version = pack.defaultSpriteVersion
      ? `&v=${encodeURIComponent(pack.defaultSpriteVersion)}`
      : ''
    setSprite({
      file,
      url: `${ROUTE}/asset/sprite?pack=${encodeURIComponent(pack.id)}&file=${encodeURIComponent(file)}${version}`,
      crop: pack.crop || { x: 0, y: 0, w: 1, h: 1 },
      aspect: pack.aspect || 1,
      // Not persisted: this would otherwise write the config on every hide, and
      // alternate with the random frame stored on every click.
      persist: false,
    })
  }

  async function roll(playAudio = true) {
    try {
      const c = cfg()
      const params = new URLSearchParams({
        spritePack: c.spritePack || '',
        voicePack: c.voicePack || '',
      })
      if (state.sprite && state.sprite.file) params.set('currentSprite', state.sprite.file)
      if (state.voice && state.voice.clip) params.set('currentClip', state.voice.clip)
      const data = await getJson(`${API}/next?${params.toString()}`)
      if (!data || !data.ok) return

      if (data.sprite) {
        const pack = packOf(state.packs.spritePacks, data.spritePack)
        const crop = data.sprite.crop || (pack && pack.crop) || { x: 0, y: 0, w: 1, h: 1 }
        const size = data.sprite.size
        const aspect = size && size.w && size.h ? (crop.w * size.w) / (crop.h * size.h) : (pack && pack.aspect) || 1
        setSprite({ file: data.sprite.file, url: data.sprite.url, crop, aspect })
      }
      if (!data.voice) {
        // Nothing to say and nothing to swap to: a fresh install whose packs were
        // removed. That is the one case worth interrupting the user about.
        if (!data.sprite && state.packs.spritePacks.length === 0 && state.packs.voicePacks.length === 0) {
          showNotice('未找到立绘包 / 语音包，请放入 ~/.dsh/dsh-gal/packs/<包名>/')
        }
        return
      }
      state.voice = { clip: data.voice.clip, ja: data.voice.ja, zh: data.voice.zh }
      // Start loading the bytes the moment the line is chosen, not when the user
      // clicks. The first click after a fresh page load is the one that used to
      // arrive silent, and this gives it the whole boot-to-click gap as a head
      // start; the cache makes the later play a no-op fetch.
      if (data.voice.url) audioBytesFor(data.voice.url)
      // A sound is only pending if one is actually going to be played, and the
      // countdown must not start before it ends.
      const willPlay = playAudio && Boolean(data.voice.url)
      renderVoiceSheet({ waitForVoice: willPlay })
      if (willPlay) playVoice(data.voice.url)
    } catch {
      // A failed roll simply leaves the previous line and art in place.
    }
  }

  function onSpriteClick() {
    // The box itself is shown further in: by renderLine() when the voice has a
    // transcript, or by showVoiceWalletSheet() when it does not. roll() reaches
    // one of the two.
    roll(true)
  }

  /**
   * Draw the figures and put the box on screen. False when the box is switched
   * off, in which case there is nothing to show at all.
   */
  function renderWalletSheet() {
    if (cfg().dialogEnabled === false) return false
    state.sheet = 'wallet'
    state.dialogShown = true
    renderWallet()
    applySheet()
    applyLayout()
    return true
  }

  /**
   * Clicking the box swaps it to 余额 / 今日已用 and restarts the countdown from
   * now — deliberately bypassing the typing/voice gate, because the user asked
   * for "3 seconds from this click", not "3 seconds after the voice ends".
   */
  function showWalletSheet() {
    if (!renderWalletSheet()) return
    holdLatched = true
    typingFinished = true
    voiceFinished = true
    clearVoiceFallback()
    scheduleAutoHide()
  }

  /**
   * 余额 / 今日已用 standing in for a line that does not exist.
   *
   * Same figures as a click on the box, but reached by clicking the *art* while
   * the voice pack has no transcript table, so the countdown must wait for the
   * sound that is about to start — see `renderVoiceSheet`.
   */
  function showVoiceWalletSheet({ waitForVoice = false } = {}) {
    // Clears the latch and cancels any countdown left over from the last line.
    resetLineGate()
    typingFinished = true // nothing to type; at most the audio is still pending
    if (!renderWalletSheet()) return
    if (!waitForVoice) scheduleAutoHide()
  }

  function setTurnCost(tokens, amount) {
    state.cost = { tokens, amount }
    renderCost()
  }

  // ── polling ───────────────────────────────────────────────────────────────
  let polling = false
  // False until the turn counter has been read once (from bootstrap, or failing
  // that from the first poll). See readTurnPoll().
  let turnAligned = false

  /** Fold one poll into the turn state; true when it is a fresh receipt. */
  function applyTurnPoll(data) {
    if (!data || !data.ok) return false
    const r = readTurnPoll(state.turnSeq, turnAligned, data.seq, data.tokens, data.amount)
    turnAligned = r.aligned
    state.turnSeq = r.seq
    return r.show
  }

  async function pollTurn() {
    if (polling) return
    // A hidden window is not being watched, and every poll competes for the same
    // handful of connections the audio needs. Stop asking until it is visible again.
    if (document.hidden) return
    polling = true
    try {
      const data = await getJson(`${API}/turn`)
      if (applyTurnPoll(data)) {
        // 对话结束只报账：显示本轮消耗与花费。
        // 不播语音、不换立绘、也不重新抽台词 —— 这里是一张收据，不是又一次互动。
        setTurnCost(data.tokens, data.amount)
        state.sheet = 'cost'
        applySheet()
        showDialog()
        // Restart the linger countdown. Anything already pending belongs to the
        // line this receipt is being appended to.
        cancelAutoHide()
        if (typingFinished && voiceFinished) scheduleAutoHide()
      }
    } catch {
      // offline / server restarting: try again next tick
    } finally {
      polling = false
    }
  }

  async function refreshState() {
    try {
      if (document.hidden) return
      const data = await getJson(`${API}/state`)
      if (data && data.ok) {
        state.balance = data.balance
        state.today = data.today
        renderWallet()
      }
    } catch {
      // keep the last known values
    }
  }

  // ── auto play ─────────────────────────────────────────────────────────────
  let autoTimer = null
  function scheduleAuto() {
    if (autoTimer) {
      clearTimeout(autoTimer)
      autoTimer = null
    }
    const c = cfg()
    if (c.autoPlay !== true) return
    const minutes = clamp(num(c.autoPlayMinutes, 1), 0.5, 240)
    autoTimer = setTimeout(async () => {
      autoTimer = null
      await roll(true)
      showDialog()
      scheduleAuto()
    }, minutes * 60000)
  }

  // ── settings wiring ───────────────────────────────────────────────────────
  /**
   * A 0..1 fraction slider (volume). The stored unit is a fraction, so the
   * percentage is only ever a presentation detail.
   */
  function bindRange(input, key, display) {
    input.addEventListener('input', () => {
      const value = num(input.value, 50) / 100
      state.config = { ...cfg(), [key]: value }
      if (display) display.textContent = `${Math.round(value * 100)}%`
      applyLayout()
      save({ [key]: value })
    })
  }

  /**
   * A 0..95 slider whose stored unit *is* the percentage (dialog opacity).
   * It must not share bindRange(): dividing by 100 here stored 0.4 for a 40%
   * setting, and everywhere that read it back as a percentage rounded it to 0 —
   * the slider appeared to snap to zero no matter what you chose.
   */
  function bindPercent(input, key, display) {
    input.addEventListener('input', () => {
      const value = clamp(Math.round(num(input.value, 0)), 0, 95)
      state.config = { ...cfg(), [key]: value }
      if (display) display.textContent = `${value}%`
      applyLayout()
      save({ [key]: value })
    })
  }

  /** A 1..10 stepper. The two ends disable themselves, so the range is visible. */
  function bindStepper(decEl2, incEl2, valueEl, key) {
    const apply = (next) => {
      const value = clamp(next, SCALE_MIN, SCALE_MAX)
      state.config = { ...cfg(), [key]: value }
      if (valueEl) valueEl.textContent = String(value)
      decEl2.disabled = value <= SCALE_MIN
      incEl2.disabled = value >= SCALE_MAX
      applyLayout()
      save({ [key]: value }, true)
    }
    decEl2.addEventListener('click', () => apply(levelOf(cfg()[key]) - 1))
    incEl2.addEventListener('click', () => apply(levelOf(cfg()[key]) + 1))
  }

  bindStepper(ui.scaleDec, ui.scaleInc, ui.scaleVal, 'scale')
  bindStepper(ui.dialogScaleDec, ui.dialogScaleInc, ui.dialogScaleVal, 'dialogScale')
  bindRange(ui.volume, 'volume', ui.volumeVal)
  bindPercent(ui.dialogOpacity, 'dialogOpacity', ui.dialogOpacityVal)

  ui.volume.addEventListener('input', applyVolume)

  ui.lang.addEventListener('click', () => {
    const next = cfg().lang === 'zh' ? 'ja' : 'zh'
    state.config = { ...cfg(), lang: next }
    ui.lang.textContent = next === 'zh' ? '中文' : '日文'
    renderVoiceSheet()
    save({ lang: next }, true)
  })

  /* Voice draw order. The host plans the round, so switching takes effect on the
     very next click — the config it reads is the live one. */
  ui.voiceOrder.addEventListener('click', () => {
    const next = cfg().voiceOrder === 'random' ? 'shuffle' : 'random'
    state.config = { ...cfg(), voiceOrder: next }
    ui.voiceOrder.textContent = next === 'random' ? '纯随机' : '洗牌池'
    save({ voiceOrder: next }, true)
  })

  ui.autoPlay.addEventListener('change', () => {
    state.config = { ...cfg(), autoPlay: ui.autoPlay.checked }
    ui.autoPlayMin.disabled = !ui.autoPlay.checked
    scheduleAuto()
    save({ autoPlay: ui.autoPlay.checked }, true)
  })

  ui.autoPlayMin.addEventListener('change', () => {
    const minutes = clamp(num(ui.autoPlayMin.value, 1), 0.5, 240)
    ui.autoPlayMin.value = String(minutes)
    state.config = { ...cfg(), autoPlayMinutes: minutes }
    scheduleAuto()
    save({ autoPlayMinutes: minutes }, true)
  })

  ui.dialogEnabled.addEventListener('change', () => {
    state.config = { ...cfg(), dialogEnabled: ui.dialogEnabled.checked }
    applyLayout()
    save({ dialogEnabled: ui.dialogEnabled.checked }, true)
  })

  ui.dialogSide.addEventListener('click', () => {
    const next = cfg().dialogSide === 'below' ? 'above' : 'below'
    state.config = { ...cfg(), dialogSide: next }
    ui.dialogSide.textContent = next === 'below' ? '立绘下方' : '立绘上方'
    applyLayout()
    save({ dialogSide: next }, true)
  })

  /* Plate replacement. The file dialog is opened by clicking a hidden input,
     which is allowed inside the button's own click handler; the input is cleared
     before reading so that picking the same file twice still fires `change`. */
  ui.platePick.addEventListener('click', () => ui.plateFile.click())

  ui.plateFile.addEventListener('change', () => {
    const file = ui.plateFile.files && ui.plateFile.files[0]
    ui.plateFile.value = ''
    if (file) applyPlate({ file })
  })

  ui.plateBlank.addEventListener('click', () => applyPlate({ preset: 'blank' }))
  ui.plateDefault.addEventListener('click', () => applyPlate({ preset: 'default' }))

  ui.spritePack.addEventListener('change', async () => {
    const id = ui.spritePack.value
    state.config = { ...cfg(), spritePack: id, spriteFile: '' }
    state.sprite = null
    renderForm()
    await save({ spritePack: id, spriteFile: '' }, true)
    roll(false)
  })

  ui.voicePack.addEventListener('change', async () => {
    const id = ui.voicePack.value
    state.config = { ...cfg(), voicePack: id }
    state.voice = null
    renderForm()
    await save({ voicePack: id }, true)
    roll(false)
  })

  panel.querySelector('[data-act="close"]').addEventListener('click', () => togglePanel(false))
  panel.addEventListener('pointerdown', (event) => event.stopPropagation())

  // ── boot ──────────────────────────────────────────────────────────────────
  async function boot() {
    try {
      const data = await getJson(`${API}/bootstrap`)
      if (data && data.ok) {
        state.config = data.config
        state.packs = data.packs || state.packs
        if (data.dialog) state.dialog = data.dialog
        if (data.dialogSource) state.plateSource = data.dialogSource
        state.balance = data.balance
        state.today = data.today
        // Bootstrap reports where the turn counter stands *now* (0 when nothing has
        // settled yet), which is all the baseline the poller needs: from here on,
        // any increase is a turn that finished while this page was open.
        if (data.turn) {
          const seq = Math.trunc(Number(data.turn.seq))
          state.turnSeq = Number.isFinite(seq) && seq > 0 ? seq : 0
          turnAligned = true
        }
      }
    } catch {
      // Fall through: the widget still renders with built-in defaults.
    }
    if (!state.config) {
      state.config = {
        scale: 5, volume: 0.5, lang: 'ja', autoPlay: false, autoPlayMinutes: 1,
        dialogScale: 5, dialogEnabled: true, dialogSide: 'above', dialogOpacity: 0,
        spritePack: '', voicePack: '', spriteFile: '', spriteVisible: true,
        voiceOrder: 'shuffle',
        pos: { hx: 'right', hd: 24, vy: 'bottom', vd: 24 },
      }
    }
    renderAll()
    scheduleAuto()
    // Get the two sounds into the byte cache before they are ever needed: the
    // first click after a fresh page load is exactly when the page's connections
    // are busiest, and a media element that has to fetch then is the one that
    // arrives ten seconds late.
    warmClickSound()
    await roll(false)
    applyLayout()
    setInterval(pollTurn, TURN_POLL_MS)
    setInterval(refreshState, STATE_POLL_MS)
    pollTurn()
    refreshState()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true })
  else boot()
})()
