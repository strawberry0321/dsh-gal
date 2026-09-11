/**
 * RFC-4180-ish CSV parsing for a voice-pack script index.
 *
 * The shipped transcript files contain quoted fields that span multiple lines
 * (`"そんなこと言わない。\n放っておけないでしょ。"`), so a naive `split(',')`
 * would shred them. This parser walks the text once and honours quotes.
 */

/** Parse CSV text into a rectangular array of strings. */
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  let fieldStarted = false
  // Strip a UTF-8 BOM: it would otherwise become part of the first header cell.
  const src = String(text).replace(/^\uFEFF/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++ } else { inQuotes = false }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') { inQuotes = true; fieldStarted = true; continue }
    if (ch === ',') { row.push(field); field = ''; fieldStarted = false; continue }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; fieldStarted = false; continue }
    if (ch === '\r') continue
    field += ch
    fieldStarted = true
  }
  if (fieldStarted || field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}

const CLIP_KEYS = ['clip', 'file', 'id', 'name', 'filename', '音频', '文件名', '语音']
const JA_KEYS = ['japanese', 'jp', 'ja', '日本語', '日文', '原文']
const ZH_KEYS = ['chinese', 'zh', 'cn', '中文', '译文', 'translation']

/**
 * Drop cue tags such as `<dash=2>` from a line of dialogue.
 *
 * The transcript files that ship with the sample packs (and most transcripts
 * exported from a game engine) embed the sound cues inline, so the dialogue box
 * would otherwise print a literal `<dash=2>` in the middle of a sentence. The
 * tag marks an effect, not something to read, so it goes away entirely.
 *
 * Only the tag shape is stripped — a letter, an optional `=value`, and a closing
 * bracket — so ordinary punctuation (`1 < 2`, `<3`) survives untouched.
 */
const CUE_TAG = /<\s*[a-z][a-z0-9_]*(\s*=\s*[^<>]{0,32})?\s*>/gi
const stripCueTags = (text) => String(text).replace(CUE_TAG, '')

function findColumn(header, keys) {
  const cells = header.map((h) => String(h || '').trim().toLowerCase())
  // Exact matches win outright: in `clip,chapter,speaker_jp,japanese,chinese`
  // a substring pass would claim `speaker_jp` for the `jp` key before ever
  // reaching the real `japanese` column.
  for (const key of keys) {
    const index = cells.indexOf(key)
    if (index >= 0) return index
  }
  for (const key of keys) {
    if (key.length < 3) continue // short keys are too trigger-happy for substring use
    const index = cells.findIndex((h) => h && h.includes(key))
    if (index >= 0) return index
  }
  return -1
}

/**
 * Build `{ clipId -> { ja, zh } }` from raw CSV text.
 *
 * Column positions are discovered from the header when it is recognisable and
 * otherwise fall back to the layout this project ships (`clip,chapter,speaker,
 * japanese,chinese,sec`), so a hand-made pack with no header still works.
 */
export function parseScriptIndex(text) {
  const rows = parseCsv(text).filter((r) => r.some((c) => String(c).trim() !== ''))
  if (rows.length === 0) return { lines: {}, count: 0, columns: null }

  let headerIndex = -1
  let clipCol = -1
  let jaCol = -1
  let zhCol = -1
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const c = findColumn(rows[i], CLIP_KEYS)
    const j = findColumn(rows[i], JA_KEYS)
    const z = findColumn(rows[i], ZH_KEYS)
    if (c >= 0 && j >= 0) { headerIndex = i; clipCol = c; jaCol = j; zhCol = z; break }
  }
  if (headerIndex < 0) {
    // No recognisable header: infer the layout from the first row's width.
    clipCol = 0
    const width = rows[0].length
    if (width >= 5) {
      jaCol = 3
      zhCol = 4 // the layout this project ships
    } else if (width >= 3) {
      jaCol = 1
      zhCol = 2
    } else {
      jaCol = 1
      zhCol = -1
    }
  }
  if (zhCol < 0 || zhCol === jaCol) zhCol = -1

  const lines = {}
  let count = 0
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i]
    const clip = String(row[clipCol] ?? '').trim()
    if (!clip) continue
    const ja = stripCueTags(String(row[jaCol] ?? '')).trim()
    const zh = zhCol >= 0 ? stripCueTags(String(row[zhCol] ?? '')).trim() : ''
    if (!ja && !zh) continue
    lines[clip.toLowerCase()] = { ja, zh }
    count++
  }
  return { lines, count, columns: { clip: clipCol, ja: jaCol, zh: zhCol } }
}

/** `ner0037.wav` -> `ner0037`. Used to join an audio file to its script row. */
export function clipIdOf(fileName) {
  return String(fileName || '').replace(/\.[^.]+$/, '').trim().toLowerCase()
}
