// ── Global client-side chart cache ───────────────────────────────────────────
// Module-level: survives React re-renders, modal open/close, and page navigation
// within the same session. Entries expire after CHART_TTL_MS.
//
// Used by:
//   - TokenModal  → check before fetching (instant if already loaded)
//   - HomeClient  → prefetch on bubble hover (fills cache before modal opens)

import type { TokenBubbleData, ChainConfig } from './types'

interface Candle {
  time: number; open: number; high: number; low: number; close: number; volume: number
}

interface Entry {
  data: Candle[]
  ts:   number
}

const CHART_TTL_MS = 10 * 60 * 1000   // 10 min — same data window as klines server TTL

const store    = new Map<string, Entry>()
const inflight = new Map<string, Promise<void>>()

export function getChart(url: string): Candle[] | null {
  const e = store.get(url)
  if (!e) return null
  if (Date.now() - e.ts > CHART_TTL_MS) { store.delete(url); return null }
  if (!Array.isArray(e.data) || e.data.length === 0) {
    store.delete(url)
    return null
  }
  return e.data
}

export function setChart(url: string, data: Candle[]): void {
  if (!Array.isArray(data) || data.length === 0) return
  store.set(url, { data, ts: Date.now() })
}

// Warm the cache before the user clicks — deduplicates concurrent calls
export function prefetchChart(url: string): void {
  if (store.has(url) || inflight.has(url)) return
  const p = fetch(url)
    .then(r => r.json())
    .then((d: unknown) => {
      const raw: Candle[] = Array.isArray(d) ? d : []
      // Normalise LP candle strings to numbers
      const normalized = raw.map(c => ({
        time:   c.time,
        open:   typeof c.open   === 'string' ? parseFloat(c.open   as unknown as string) : c.open,
        high:   typeof c.high   === 'string' ? parseFloat(c.high   as unknown as string) : c.high,
        low:    typeof c.low    === 'string' ? parseFloat(c.low    as unknown as string) : c.low,
        close:  typeof c.close  === 'string' ? parseFloat(c.close  as unknown as string) : c.close,
        volume: c.volume,
      }))
      if (normalized.length > 0) setChart(url, normalized)
    })
    .catch(() => {})
    .finally(() => inflight.delete(url))
  inflight.set(url, p)
}

// ── URL builder ───────────────────────────────────────────────────────────────
// Builds the same URL that TokenModal uses for the default view (1D line chart).
// Must stay in sync with TokenModal's fetchChart logic.

function roundHour(ms: number): number {
  return Math.floor(ms / (60 * 60 * 1000)) * 60 * 60 * 1000
}

const LINE_WINDOW_1D_MS = 365 * 24 * 60 * 60 * 1000

export function buildDefaultChartUrl(
  token: TokenBubbleData,
  chain: ChainConfig,
): string | null {
  const now  = roundHour(Date.now())
  const from = roundHour(Date.now() - LINE_WINDOW_1D_MS)
  const systemTokenId = `${chain.systemToken.toLowerCase()}-${chain.systemContract}`

  // Prefer LP pool (more tokens have liquidity data than a spot ticker)
  const defaultPool = token.pools?.find(p => p.counterpartId === systemTokenId)
    ?? token.pools?.[0]

  if (defaultPool) {
    let url = `/api/pool-chart?chain=${chain.id}&pool_id=${defaultPool.id}&resolution=1D&from=${from}&to=${now}`
    if (defaultPool.reversed) url += '&reverse=true'
    return url
  }

  if (token.ticker_id) {
    return `/api/klines?chain=${chain.id}&ticker_id=${encodeURIComponent(token.ticker_id)}&resolution=1D&from=${from}&to=${now}`
  }

  return null
}
