/**
 * Generate the self-made blank dialogue plate.
 *
 * The shipped plate is a 1280x720 artwork whose only content is a logo in one
 * corner, which is why its geometry crops the empty top away and reserves a
 * band for the figures. A plate with nothing on it at all needs neither: this
 * one is a plain white rounded panel the whole height of which the text and the
 * figures may use, and it is what the settings panel's 「空白底图」 button
 * installs.
 *
 * Written as a script rather than a checked-in mystery binary: the artwork is
 * 1200x700 opaque white with a hairline border, and the matching geometry is
 * emitted from the same constants, so the two can never disagree.
 *
 *   node scripts/make-blank-plate.mjs
 *
 * The rounding is left to CSS (`radius`, applied to the plate element), exactly
 * as for the shipped artwork — the image itself is opaque edge to edge, because
 * a transparent corner would paint a hole in the element's own box-shadow.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const OUT_PNG = path.join(ROOT, 'assets', 'ui', 'dialog-blank.png')
const OUT_JSON = path.join(ROOT, 'assets', 'ui', 'dialog-blank.json')

const WIDTH = 1200
const HEIGHT = 700
/** Hairline frame, drawn in image pixels; the plate is scaled down on screen. */
const BORDER = 2
const FILL = [0xff, 0xff, 0xff]
const EDGE = [0xe6, 0xea, 0xf2]

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

/** Minimal RGBA PNG encoder: one filter-0 scanline per row, deflated. */
function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function plate() {
  const rgba = Buffer.alloc(WIDTH * HEIGHT * 4)
  for (let y = 0; y < HEIGHT; y++) {
    const onBorderRow = y < BORDER || y >= HEIGHT - BORDER
    for (let x = 0; x < WIDTH; x++) {
      const onBorder = onBorderRow || x < BORDER || x >= WIDTH - BORDER
      const [r, g, b] = onBorder ? EDGE : FILL
      const at = (y * WIDTH + x) * 4
      rgba[at] = r
      rgba[at + 1] = g
      rgba[at + 2] = b
      rgba[at + 3] = 0xff
    }
  }
  return rgba
}

/**
 * Geometry for the blank plate.
 *
 *   crop     the whole image is plate, so nothing is cut away
 *   logoShare 1 — there is no logo, so the receipt/balance sheets may use the
 *             full inner height instead of stopping at 72%
 *   footer.maxWidthRatio  no logo to dodge, so the strip may run nearly the
 *             whole width
 */
const GEOMETRY = {
  _comment:
    '自带的空白对话框底图（assets/ui/dialog-blank.png）的几何描述：纯白面板，没有任何 logo，所以不裁切、图形区也不再让出右下角。设定面板的「空白底图」按钮就是把它复制成 ui/dialog.png + ui/dialog.json。',
  _fields: {
    image: '底图尺寸，必须和 png 实际像素一致',
    crop: '显示原图的哪一块（0~1 比例）。x/y 是左上角，w/h 是宽高',
    inset: '文字区域相对裁切后画面四周的内边距（0~1 比例）',
    'footer.heightRatio': '底部（余额/花费）占文字区高度的比例',
    'footer.maxWidthRatio': '底部文字最多横向占用多少',
    radius: '圆角像素（由 CSS 施加在对话框元素上）',
    logoShare: '图形区最多用掉文字区高度的几分之几；底图右下角有 logo 时用 0.72',
  },
  image: { width: WIDTH, height: HEIGHT },
  crop: { x: 0, y: 0, w: 1, h: 1 },
  inset: { left: 0.06, right: 0.06, top: 0.09, bottom: 0.07 },
  footer: { heightRatio: 0.42, maxWidthRatio: 0.9 },
  radius: 12,
  logoShare: 1,
}

const png = encodePng(WIDTH, HEIGHT, plate())
fs.writeFileSync(OUT_PNG, png)
fs.writeFileSync(OUT_JSON, `${JSON.stringify(GEOMETRY, null, 2)}\n`, 'utf8')
console.log(`wrote ${path.relative(ROOT, OUT_PNG)} (${WIDTH}x${HEIGHT}, ${png.length} bytes)`)
console.log(`wrote ${path.relative(ROOT, OUT_JSON)}`)
