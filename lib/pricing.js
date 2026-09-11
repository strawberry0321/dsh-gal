/**
 * DeepSeek official pricing, in CNY per million tokens.
 *
 * Every entry is `[offPeak, peak]`:
 *   hit  - prompt tokens served from the context cache
 *   miss - prompt tokens that missed the cache
 *   out  - completion tokens (reasoning tokens are billed as output)
 *
 * Peak windows are Beijing time 09:00-12:00 and 14:00-18:00 on weekdays;
 * weekends are off-peak all day. Edit `assets/pricing.json` in the installed
 * package to track a price change without touching this file, or point the
 * `pricingFile` config key at your own JSON document.
 */

export const DEFAULT_PRICING = {
  updatedAt: '2026-08-17',
  currency: 'CNY',
  unit: 'per-million-tokens',
  peakHours: [[9, 12], [14, 18]],
  weekendOffPeak: true,
  models: {
    'deepseek-v4-flash': { hit: [0.05, 0.1], miss: [1.5, 3.0], out: [4.5, 9.0] },
    'deepseek-v4-pro': { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] },
    'deepseek-chat': { hit: [0.05, 0.1], miss: [1.5, 3.0], out: [4.5, 9.0] },
    'deepseek-reasoner': { hit: [0.05, 0.1], miss: [1.5, 3.0], out: [4.5, 9.0] },
    _default: { hit: [0.05, 0.1], miss: [1.5, 3.0], out: [4.5, 9.0] },
  },
}

// 2026-08-23 00:00 Beijing time: from this instant weekends bill at the off-peak
// rate. Buckets recorded before it must keep the old rule, so the switch is
// gated on the bucket timestamp rather than evaluated "now".
const WEEKEND_OFFPEAK_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000)

/** Merge a user-supplied pricing document over the built-in default. */
export function normalizePricing(raw) {
  const base = JSON.parse(JSON.stringify(DEFAULT_PRICING))
  if (!raw || typeof raw !== 'object') return base
  if (Array.isArray(raw.peakHours) && raw.peakHours.length > 0) base.peakHours = raw.peakHours
  if (typeof raw.weekendOffPeak === 'boolean') base.weekendOffPeak = raw.weekendOffPeak
  if (typeof raw.updatedAt === 'string') base.updatedAt = raw.updatedAt
  if (raw.models && typeof raw.models === 'object') {
    for (const [model, price] of Object.entries(raw.models)) {
      if (!price || typeof price !== 'object') continue
      const ok = ['hit', 'miss', 'out'].every(
        (k) => Array.isArray(price[k]) && price[k].length >= 2 && price[k].every((n) => typeof n === 'number'),
      )
      if (ok) base.models[model] = { hit: price.hit, miss: price.miss, out: price.out }
    }
  }
  return base
}

/** Longest-substring model lookup, so `deepseek-v4-flash-0731` matches flash. */
export function priceFor(pricing, model) {
  const m = String(model || '').toLowerCase()
  const models = pricing && pricing.models ? pricing.models : DEFAULT_PRICING.models
  let best = null
  for (const key of Object.keys(models)) {
    if (key === '_default') continue
    if (m && m.includes(key) && (!best || key.length > best.length)) best = key
  }
  return (best && models[best]) || models._default || DEFAULT_PRICING.models._default
}

/** True when `timeSec` falls in a peak-priced window (Beijing time). */
export function isPeakTime(pricing, timeSec) {
  const n = Number(timeSec)
  if (!Number.isFinite(n)) return false
  const bj = new Date(n * 1000 + 8 * 3600 * 1000)
  if (pricing.weekendOffPeak !== false && n >= WEEKEND_OFFPEAK_FROM_SEC) {
    const dow = bj.getUTCDay() // reading a Beijing-shifted instant in UTC yields the Beijing calendar day
    if (dow === 0 || dow === 6) return false
  }
  const hour = bj.getUTCHours()
  for (const [start, end] of pricing.peakHours || DEFAULT_PRICING.peakHours) {
    if (hour >= start && hour < end) return true
  }
  return false
}

/** Cost in CNY for one usage sample. `usage` uses the DSH token field names. */
export function costOf(pricing, model, usage, timeSec = Math.floor(Date.now() / 1000)) {
  const p = priceFor(pricing, model)
  const off = isPeakTime(pricing, timeSec) ? 1 : 0
  const hit = Number(usage?.cacheReadTokens) || 0
  const miss = Number(usage?.inputTokens) || 0
  const out = (Number(usage?.outputTokens) || 0) + (Number(usage?.reasoningTokens) || 0)
  return (hit / 1e6) * p.hit[off] + (miss / 1e6) * p.miss[off] + (out / 1e6) * p.out[off]
}

/** Total tokens in a DSH usage sample. */
export function tokensOf(usage) {
  return (
    (Number(usage?.inputTokens) || 0) +
    (Number(usage?.cacheReadTokens) || 0) +
    (Number(usage?.outputTokens) || 0) +
    (Number(usage?.reasoningTokens) || 0)
  )
}
