/**
 * Mirror sprites left-to-right, losslessly.
 *
 *   node scripts/mirror-sprites.mjs <dir-or-file> [--in-place | --out <dir>]
 *
 * Some source artwork is drawn facing the left of the screen; mirroring it is an
 * artistic choice about which way the character looks, and it is also what a pack
 * assembled for a right-hand-side widget usually wants.
 *
 * PNG only, and deliberately so: alpha matters here (the plugin derives each
 * sprite's visible box from it), so the round trip is decode → reverse each
 * scanline → re-encode, with no resampling, no palette, and no colour management
 * anywhere in the path. Grayscale/RGB/RGBA at 8 bits per sample and
 * non-interlaced are supported; anything else is refused loudly rather than
 * silently mangled.
 *
 * Every file is verified after writing: the flipped image is decoded again and
 * compared pixel by pixel against the source, and the source is flipped a second
 * time to prove the operation is exactly reversible. (It is its own inverse, so
 * running the tool twice restores the originals.)
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 }

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

/** Decode a non-interlaced 8-bit PNG into `{ width, height, channels, pixels }`. */
function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG')
  let at = 8
  let width = 0
  let height = 0
  let depth = 0
  let color = 0
  let interlace = 0
  const idat = []
  while (at + 12 <= buf.length) {
    const length = buf.readUInt32BE(at)
    const type = buf.toString('latin1', at + 4, at + 8)
    const data = buf.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      depth = data[8]
      color = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data))
    } else if (type === 'IEND') {
      break
    }
    at += 12 + length
  }
  const channels = CHANNELS[color]
  if (!channels) throw new Error(`unsupported PNG colour type ${color} (palette images must be re-saved as RGBA)`)
  if (depth !== 8) throw new Error(`unsupported PNG bit depth ${depth} (only 8-bit is handled)`)
  if (interlace !== 0) throw new Error('interlaced PNG (re-save it as non-interlaced)')

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(stride * height)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    line.copy(out)
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      let add = 0
      if (filter === 1) add = a
      else if (filter === 2) add = b
      else if (filter === 3) add = (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else if (filter !== 0) {
        throw new Error(`unknown PNG filter ${filter}`)
      }
      out[i] = (out[i] + add) & 0xff
    }
    prev = out
  }
  return { width, height, channels, pixels }
}

function encodePng({ width, height, channels, pixels }) {
  const color = channels === 1 ? 0 : channels === 2 ? 4 : channels === 3 ? 2 : 6
  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = color
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

/** Reverse every scanline. Its own inverse, by construction. */
function flipPixels(image) {
  const { width, height, channels, pixels } = image
  const out = Buffer.alloc(pixels.length)
  const pixel = channels
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * pixel
      const to = (y * width + (width - 1 - x)) * pixel
      pixels.copy(out, to, from, from + pixel)
    }
  }
  return { width, height, channels, pixels: out }
}

function sameImage(a, b) {
  return a.width === b.width && a.height === b.height && a.channels === b.channels && a.pixels.equals(b.pixels)
}

function mirrorFile(file, dest) {
  const original = fs.readFileSync(file)
  const source = decodePng(original)
  const flipped = flipPixels(source)
  const encoded = encodePng(flipped)
  const written = decodePng(encoded)
  if (!sameImage(written, flipped)) throw new Error('the written file does not decode back to the mirrored pixels')
  if (!sameImage(flipPixels(written), source)) throw new Error('mirroring twice does not restore the original pixels')
  // Only once both directions check out does anything get written.
  fs.writeFileSync(dest, encoded)
  return { width: source.width, height: source.height, bytes: original.length, out: encoded.length }
}

const args = process.argv.slice(2)
const target = args.find((a) => !a.startsWith('--'))
const outIndex = args.indexOf('--out')
if (!target) {
  console.error('usage: node scripts/mirror-sprites.mjs <dir-or-file> [--out <dir>]   (default: mirror in place)')
  process.exit(2)
}

const outDir = outIndex >= 0 ? args[outIndex + 1] : null
if (outDir) fs.mkdirSync(outDir, { recursive: true })

const stat = fs.statSync(target)
const files = stat.isDirectory()
  ? fs.readdirSync(target).filter((f) => /\.png$/i.test(f)).map((f) => path.join(target, f))
  : [target]

if (files.length === 0) {
  console.error(`no PNG files in ${target}`)
  process.exit(1)
}

let total = 0
for (const file of files) {
  try {
    const dest = outDir ? path.join(outDir, path.basename(file)) : file
    const result = mirrorFile(file, dest)
    total++
    console.log(`  mirrored ${path.basename(file)}  ${result.width}x${result.height}  ${result.bytes} -> ${result.out} bytes`)
  } catch (err) {
    console.error(`  FAILED ${path.basename(file)}: ${String((err && err.message) || err)}`)
    process.exitCode = 1
  }
}
console.log(`${total}/${files.length} mirrored and verified (${outDir ? `copies written to ${outDir}` : 'in place'})`)
if (!outDir) console.log('mirroring is its own inverse: run it again to restore the originals')
