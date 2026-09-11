/**
 * Minimal, dependency-free PNG reader used to find the *visible* bounding box of
 * a sprite (i.e. the box that ignores fully transparent margins).
 *
 * Why: character art is usually exported on a fixed canvas (e.g. 1500x1200) with
 * a large transparent border. Dropping that border lets the widget render the
 * character at its真实 size and keeps the dialogue box hugging the art, whatever
 * canvas size a user's own pack happens to use.
 *
 * Only the pieces we need are implemented: 8-bit, non-interlaced PNGs in the
 * greyscale / RGB / grey+alpha / RGBA / palette-with-tRNS flavours. Anything else
 * returns null and the caller falls back to the full canvas.
 */
import zlib from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
// Any pixel whose alpha is at or below this counts as invisible. Matches the
// common "alpha > 8" convention so soft shadows do not inflate the box.
const ALPHA_FLOOR = 8

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/** Walk the chunk list. Returns { width, height, colorType, bitDepth, interlace, idat, trns }. */
function readChunks(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  let pos = 8
  const idat = []
  let header = null
  let trns = null
  while (pos + 8 <= buf.length) {
    const length = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const dataStart = pos + 8
    const dataEnd = dataStart + length
    if (dataEnd > buf.length) break
    if (type === 'IHDR') {
      if (length < 13) return null
      header = {
        width: buf.readUInt32BE(dataStart),
        height: buf.readUInt32BE(dataStart + 4),
        bitDepth: buf[dataStart + 8],
        colorType: buf[dataStart + 9],
        compression: buf[dataStart + 10],
        filter: buf[dataStart + 11],
        interlace: buf[dataStart + 12],
      }
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(dataStart, dataEnd))
    } else if (type === 'tRNS') {
      trns = buf.subarray(dataStart, dataEnd)
    } else if (type === 'IEND') {
      break
    }
    pos = dataEnd + 4 // + CRC
  }
  if (!header) return null
  return { ...header, idat, trns }
}

/** Reverse PNG scanline filtering. Returns the raw, unfiltered pixel bytes. */
function unfilter(raw, width, height, bytesPerPixel) {
  const stride = width * bytesPerPixel
  if (raw.length < height * (stride + 1)) return null
  const out = Buffer.alloc(height * stride)
  let pos = 0
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filterType = raw[pos]
    pos += 1
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    if (filterType === 0) {
      line.copy(cur)
    } else if (filterType === 1) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bytesPerPixel ? cur[i - bytesPerPixel] : 0
        cur[i] = (line[i] + a) & 0xff
      }
    } else if (filterType === 2) {
      for (let i = 0; i < stride; i++) cur[i] = (line[i] + prev[i]) & 0xff
    } else if (filterType === 3) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bytesPerPixel ? cur[i - bytesPerPixel] : 0
        cur[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xff
      }
    } else if (filterType === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bytesPerPixel ? cur[i - bytesPerPixel] : 0
        const c = i >= bytesPerPixel ? prev[i - bytesPerPixel] : 0
        cur[i] = (line[i] + paeth(a, prev[i], c)) & 0xff
      }
    } else {
      return null
    }
    prev = cur
  }
  return out
}

/** How many bytes per pixel, and where the alpha byte lives. null = unsupported. */
function alphaLayout(colorType, trns) {
  switch (colorType) {
    case 6: return { bpp: 4, alphaOffset: 3, indexed: false }
    case 4: return { bpp: 2, alphaOffset: 1, indexed: false }
    case 2: return { bpp: 3, alphaOffset: -1, indexed: false } // RGB, no alpha channel
    case 0: return { bpp: 1, alphaOffset: -1, indexed: false } // greyscale, no alpha channel
    case 3: return { bpp: 1, alphaOffset: -1, indexed: true, paletteAlpha: trns }
    default: return null
  }
}

/**
 * @param {Buffer} buf raw PNG bytes
 * @param {string} [name] used only in the returned descriptor
 * @returns {{name?:string,width:number,height:number,box:({x:number,y:number,w:number,h:number}|null)}|null}
 */
export function readPngAlphaBox(buf, name) {
  const info = readChunks(buf)
  if (!info) return null
  const { width, height, bitDepth, colorType, interlace, compression, filter, idat, trns } = info
  const base = { name, width, height, box: null }
  // Only the simple, overwhelmingly common encodings are handled.
  if (bitDepth !== 8 || interlace !== 0 || compression !== 0 || filter !== 0 || idat.length === 0) return base
  const layout = alphaLayout(colorType, trns)
  if (!layout) return base

  let raw
  try {
    raw = zlib.inflateSync(Buffer.concat(idat))
  } catch {
    return base
  }
  const pixels = unfilter(raw, width, height, layout.bpp)
  if (!pixels) return base

  const paletteAlpha = layout.paletteAlpha
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    const rowStart = y * width * layout.bpp
    for (let x = 0; x < width; x++) {
      let visible
      if (layout.indexed) {
        if (!paletteAlpha || paletteAlpha.length === 0) {
          visible = true // palette without tRNS is fully opaque
        } else {
          const index = pixels[rowStart + x]
          visible = index < paletteAlpha.length ? paletteAlpha[index] > ALPHA_FLOOR : true
        }
      } else if (layout.alphaOffset < 0) {
        visible = true
      } else {
        visible = pixels[rowStart + x * layout.bpp + layout.alphaOffset] > ALPHA_FLOOR
      }
      if (!visible) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return base
  base.box = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
  return base
}

/**
 * Convenience wrapper: the transparent-margin crop as normalised fractions.
 * Falls back to the whole canvas for formats we cannot inspect.
 */
export function pngVisibleCrop(buf) {
  const info = readPngAlphaBox(buf)
  if (!info) return null
  const { width, height, box } = info
  if (!box) return { x: 0, y: 0, w: 1, h: 1, width, height }
  return {
    x: box.x / width,
    y: box.y / height,
    w: box.w / width,
    h: box.h / height,
    width,
    height,
  }
}
