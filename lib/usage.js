/**
 * DeepSeek balance + spend accounting.
 *
 * Two independent sources are supported:
 *
 *   platform  the official usage endpoint, reachable when DEEPSEEK_PLATFORM_TOKEN
 *             is configured. Exact, but optional.
 *   ledger    the balance is sampled and any *decrease* since the previous sample
 *             counts as spend. Works with nothing but DEEPSEEK_API_KEY, which is
 *             what the widget needs anyway.
 *
 * `auto` (the default) uses the platform endpoint when it answers and silently
 * falls back to the ledger otherwise. The ledger is updated on every successful
 * balance read either way, so the fallback stays warm.
 */
import fs from 'node:fs'
import { isPeakTime, priceFor } from './pricing.js'

export const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const BALANCE_TTL_MS = 25000
const PLATFORM_TTL_MS = 60000

export function todayKey(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}

function readJsonFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export function createUsageService({ credentials, usageFiles = [], pricing, log = () => {} } = {}) {
  let balanceCache = null
  let balanceInFlight = null
  let platformCache = null
  let platformInFlight = null

  async function resolveCredential(key) {
    try {
      if (!credentials || typeof credentials.resolve !== 'function') return null
      const cred = await credentials.resolve(key)
      return cred && cred.value ? cred : null
    } catch (err) {
      log(`credential ${key} failed: ${String(err && err.message)}`)
      return null
    }
  }

  // ── ledger ────────────────────────────────────────────────────────────────
  function readLedger() {
    for (const file of usageFiles) {
      const parsed = readJsonFile(file)
      if (parsed && typeof parsed.date === 'string') return parsed
    }
    return { date: todayKey(), lastBalance: null, lastCurrency: '', todayUsage: 0, history: {} }
  }

  function writeLedger(ledger) {
    const body = JSON.stringify(ledger)
    for (const file of usageFiles) {
      try {
        fs.writeFileSync(file, body, 'utf8')
        return true
      } catch {
        // try the next candidate
      }
    }
    return false
  }

  /**
   * Fold a freshly observed balance into the ledger. The delta between two
   * observations *is* the spend in between; the file rolls over at midnight and
   * archives the finished day into `history`.
   *
   * A currency switch only re-bases the ledger: the numeric jump comes from the
   * unit change, not from real spending.
   */
  function recordLedger(currentBalance, currency) {
    const led = readLedger()
    const cur = String(currency || '')
    const today = todayKey()
    const currencyChanged =
      typeof led.lastCurrency === 'string' && led.lastCurrency !== '' && cur !== '' && led.lastCurrency !== cur

    if (led.date !== today) {
      if (led.date && typeof led.todayUsage === 'number' && led.todayUsage > 0) {
        led.history = led.history && typeof led.history === 'object' ? led.history : {}
        led.history[led.date] = Number(led.todayUsage.toFixed(6))
      }
      led.date = today
      led.lastBalance = currentBalance
      led.lastCurrency = cur
      led.todayUsage = 0
    } else if (currencyChanged) {
      led.lastBalance = currentBalance
      led.lastCurrency = cur
    } else if (typeof currentBalance === 'number' && Number.isFinite(currentBalance)) {
      const prev = typeof led.lastBalance === 'number' ? led.lastBalance : null
      if (prev !== null && currentBalance < prev) {
        led.todayUsage = Number(((Number(led.todayUsage) || 0) + (prev - currentBalance)).toFixed(6))
      }
      led.lastBalance = currentBalance
      led.lastCurrency = cur || led.lastCurrency
    }
    writeLedger(led)
    return led
  }

  // ── balance ───────────────────────────────────────────────────────────────
  function pickBalanceInfo(infos) {
    if (!Array.isArray(infos) || infos.length === 0) return null
    const amount = (x) => (x && x.total_balance !== undefined ? Number(x.total_balance) : NaN)
    return (
      infos.find((x) => x && x.currency === 'CNY' && amount(x) > 0) ||
      infos.find((x) => amount(x) > 0) ||
      infos.find((x) => x && x.currency === 'CNY') ||
      infos[0]
    )
  }

  async function fetchBalanceOnce() {
    const cred = await resolveCredential('DEEPSEEK_API_KEY')
    if (!cred) return { ok: false, code: 'NO_KEY', error: '未配置 DEEPSEEK_API_KEY' }
    let lastErr = null
    for (let attempt = 0; attempt < 2; attempt++) {
      let res
      try {
        res = await fetch(BALANCE_URL, {
          headers: { Authorization: `Bearer ${cred.value}` },
          signal: AbortSignal.timeout(20000),
        })
      } catch (err) {
        lastErr = err
        if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
        continue
      }
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`)
        if (res.status < 500) break
        if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
        continue
      }
      let data
      try {
        data = await res.json()
      } catch {
        return { ok: false, code: 'PARSE', error: '余额接口返回的不是合法 JSON' }
      }
      const info = pickBalanceInfo(data && data.balance_infos)
      if (!info || info.total_balance === undefined) {
        return { ok: false, code: 'SHAPE', error: '余额接口返回结构异常' }
      }
      return {
        ok: true,
        totalBalance: Number(info.total_balance),
        currency: String(info.currency || 'CNY'),
        updatedAt: new Date().toISOString(),
      }
    }
    const message = String((lastErr && lastErr.message) || lastErr)
    return {
      ok: false,
      code: 'HTTP',
      // 4xx is our fault (bad key); anything else is worth keeping the old value for.
      transient: !/^HTTP 4\d\d/.test(message),
      error: `余额接口请求失败: ${message.slice(0, 200)}`,
    }
  }

  async function getBalance() {
    const now = Date.now()
    if (balanceCache && now - balanceCache.at < BALANCE_TTL_MS) return balanceCache.payload
    if (balanceInFlight) return balanceInFlight
    balanceInFlight = (async () => {
      try {
        const payload = await fetchBalanceOnce()
        if (payload.ok) {
          const ledger = recordLedger(payload.totalBalance, payload.currency)
          balanceCache = { at: Date.now(), payload }
          return { ...payload, ledgerToday: Number(ledger.todayUsage) || 0 }
        }
        if (payload.transient && balanceCache) {
          // Network blip: keep showing the last known balance rather than flashing an error.
          return { ...balanceCache.payload, stale: true, error: payload.error }
        }
        if (!payload.transient) log(`balance: ${payload.code} ${payload.error}`)
        return payload
      } finally {
        balanceInFlight = null
      }
    })()
    return balanceInFlight
  }

  // ── today's spend ─────────────────────────────────────────────────────────
  function computePlatformToday(data) {
    // { data: { biz_data: { series: [ { model, buckets: [ { time, usage: {
    //   RESPONSE_TOKEN, PROMPT_CACHE_HIT_TOKEN, PROMPT_CACHE_MISS_TOKEN } } ] } ] } } }
    let root = data
    if (root && root.data && root.data.biz_data && Array.isArray(root.data.biz_data.series)) root = root.data.biz_data
    else if (root && root.data && Array.isArray(root.data.series)) root = root.data
    const series = Array.isArray(root && root.series) ? root.series : null
    if (!series) return null
    let amount = 0
    let tokens = 0
    let found = false
    for (const entry of series) {
      if (!entry || typeof entry !== 'object') continue
      const price = priceFor(pricing, entry.model)
      for (const bucket of Array.isArray(entry.buckets) ? entry.buckets : []) {
        const usage = bucket && bucket.usage
        if (!usage || typeof usage !== 'object') continue
        const hit = Number(usage.PROMPT_CACHE_HIT_TOKEN) || 0
        const miss = Number(usage.PROMPT_CACHE_MISS_TOKEN) || 0
        const out = Number(usage.RESPONSE_TOKEN) || 0
        if (hit + miss + out === 0) continue
        found = true
        tokens += hit + miss + out
        const off = isPeakTime(pricing, bucket.time) ? 1 : 0
        amount += (hit / 1e6) * price.hit[off] + (miss / 1e6) * price.miss[off] + (out / 1e6) * price.out[off]
      }
    }
    return found ? { amount, tokens } : null
  }

  async function getPlatformToday() {
    const now = Date.now()
    if (platformCache && now - platformCache.at < PLATFORM_TTL_MS) return platformCache.value
    if (platformInFlight) return platformInFlight
    platformInFlight = (async () => {
      try {
        const cred = await resolveCredential('DEEPSEEK_PLATFORM_TOKEN')
        if (!cred) return null
        const token = String(cred.value).replace(/^Bearer\s+/i, '')
        const start = new Date()
        start.setHours(0, 0, 0, 0)
        const startSec = Math.floor(start.getTime() / 1000)
        const tz = -new Date().getTimezoneOffset() * 60
        const url =
          'https://platform.deepseek.com/api/v0/usage/by_api_key/amount' +
          `?start=${startSec}&end=${startSec + 86400}&tz=${tz}`
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15000),
        })
        if (!res.ok) return null
        const value = computePlatformToday(await res.json())
        if (value && Number.isFinite(value.amount)) {
          platformCache = { at: Date.now(), value }
          return value
        }
        return null
      } catch (err) {
        log(`platform usage failed: ${String(err && err.message)}`)
        return null
      } finally {
        platformInFlight = null
      }
    })()
    return platformInFlight
  }

  /** Today's spend, honouring the configured source preference. */
  async function getToday(source = 'auto') {
    if (source !== 'ledger') {
      const platform = await getPlatformToday()
      if (platform) return { amount: platform.amount, tokens: platform.tokens, source: 'platform' }
      if (source === 'platform') return { amount: null, tokens: null, source: 'platform', error: 'unavailable' }
    }
    const ledger = readLedger()
    const today = todayKey()
    const amount = ledger.date === today ? Number(ledger.todayUsage) || 0 : 0
    return { amount, tokens: null, source: 'ledger' }
  }

  function ledgerSnapshot() {
    const ledger = readLedger()
    return {
      date: ledger.date,
      todayUsage: Number(ledger.todayUsage) || 0,
      history: ledger.history && typeof ledger.history === 'object' ? ledger.history : {},
    }
  }

  function invalidate() {
    balanceCache = null
    platformCache = null
  }

  return { getBalance, getToday, getPlatformToday, ledgerSnapshot, recordLedger, invalidate }
}
