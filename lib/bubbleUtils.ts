import { TokenBubbleData, DisplayMode } from './types'

const MIN_RADIUS = 28
const MAX_RADIUS = 140

// ── Metric value ──────────────────────────────────────────────────────────────

export function getMetricValue(token: TokenBubbleData, mode: DisplayMode): number {
  switch (mode.metric) {
    case 'change':
      return mode.timeframe === '7d'
        ? (token.change7d ?? token.change24)
        : token.change24
    case 'price':
      return token.usd_price
    case 'volume':
      if (mode.timeframe === '7d')  return token.volume7dusd  ?? token.volume24usd
      if (mode.timeframe === '30d') return token.volume30dusd ?? token.volume7dusd ?? token.volume24usd
      return token.volume24usd
    case 'tvl':
      return token.tvlUsd ?? 0
    case 'mcap':
      return token.marketCapUsd ?? 0
  }
}

// Scales bubble radii so that the total bubble area stays proportional to the
// available viewport space regardless of screen size. Both min and max scale
// together so the relative size range is preserved on every screen size.
export function computeRadii(
  tokens: TokenBubbleData[],
  mode: DisplayMode,
  containerWidth  = 0,
  containerHeight = 0,
): Map<string, number> {
  const radii = new Map<string, number>()
  if (tokens.length === 0) return radii

  // Derive a scale factor from how much screen area is available per bubble.
  // Reference calibration: ~1280×800 with ~30 tokens → scale ≈ 1.0 → original sizes.
  let scaledMin = MIN_RADIUS
  let scaledMax = MAX_RADIUS
  if (containerWidth > 0 && containerHeight > 0) {
    const areaPerToken = (containerWidth * containerHeight) / tokens.length
    const refRadius    = Math.sqrt(areaPerToken * 0.40 / Math.PI)
    const scale        = Math.min(1, Math.max(0.22, refRadius / 55))
    scaledMin = Math.max(14, Math.round(MIN_RADIUS * scale))
    scaledMax = Math.max(scaledMin + 10, Math.round(MAX_RADIUS * scale))
  }

  // Bubble size is always driven by |change24| so the layout stays stable
  // when switching display modes — only the label inside the bubble changes.
  const changeMode: DisplayMode = { metric: 'change', timeframe: mode.timeframe }
  const rawValues = tokens.map(t => getMetricValue(t, changeMode))
  const values    = rawValues.map(Math.abs)

  const max = Math.max(...values.filter(v => v > 0))
  if (max <= 0) {
    for (const t of tokens) radii.set(t.id, scaledMin)
    return radii
  }

  for (let i = 0; i < tokens.length; i++) {
    const v    = values[i]
    const norm = v > 0 ? Math.sqrt(v / max) : 0.05
    radii.set(tokens[i].id, scaledMin + norm * (scaledMax - scaledMin))
  }
  return radii
}

// ── Directional signal ────────────────────────────────────────────────────────
// Returns: positive number = green direction, negative = red, 0 = neutral.
// For 'change' metric the full % value is returned so ring intensity can vary.
// All other metrics return ±1 or 0 (direction only, no intensity gradient).

export function ringSignal(token: TokenBubbleData, mode: DisplayMode): number {
  switch (mode.metric) {

    case 'price':
      // Always driven by 24h price change
      return token.change24

    case 'change':
      return mode.timeframe === '7d'
        ? (token.change7d ?? token.change24)
        : token.change24

    case 'volume': {
      if (mode.timeframe === '24h') {
        // Today vs 7D daily average
        if (!token.volume7dusd) return 0
        return token.volume24usd > token.volume7dusd / 7 ? 1 : -1
      }
      if (mode.timeframe === '7d') {
        // This week vs 30D weekly average
        if (!token.volume30dusd) return 0
        return (token.volume7dusd ?? 0) > token.volume30dusd / 4 ? 1 : -1
      }
      // 30D — no prior period in API, neutral
      return 0
    }

    case 'tvl':
      // Proxy: TVL moves with price (no historical TVL in API)
      return token.change24 > 0 ? 1 : token.change24 < 0 ? -1 : 0

    case 'mcap':
      // Supply is static so market cap direction = price direction
      return token.change24 > 0 ? 1 : token.change24 < 0 ? -1 : 0
  }
}

// ── Colour functions ──────────────────────────────────────────────────────────

export function bubbleFillColor(signal: number): string {
  if (signal > 0) return '#001a0d'   // very dark green
  if (signal < 0) return '#1a0005'   // very dark red
  return '#0d0d14'
}

export function bubbleFillColorForMode(token: TokenBubbleData, mode: DisplayMode): string {
  return bubbleFillColor(ringSignal(token, mode))
}

// Glowing ring — 'change' metric gets full magnitude gradient; others get flat direction colour
export function ringColor(change: number): string {
  if (change >= 5)  return '#00ff55'
  if (change > 0)   return '#00cc44'
  if (change === 0) return '#3a5a6a'
  if (change > -5)  return '#cc1122'
  return '#ff1133'
}

export function ringColorForMode(token: TokenBubbleData, mode: DisplayMode): string {
  if (mode.metric === 'change') {
    const val = mode.timeframe === '7d'
      ? (token.change7d ?? token.change24)
      : token.change24
    return ringColor(val)
  }
  // Direction only for all other metrics
  const s = ringSignal(token, mode)
  return ringColor(s > 0 ? 1 : s < 0 ? -1 : 0)
}

export function glowColor(signal: number): string {
  if (signal > 0) return 'rgba(0,220,80,0.55)'
  if (signal < 0) return 'rgba(220,20,50,0.55)'
  return 'rgba(80,120,140,0.35)'
}

export function glowColorForMode(token: TokenBubbleData, mode: DisplayMode): string {
  return glowColor(ringSignal(token, mode))
}

// Text colour inside bubble
export function changeTextColor(change: number): string {
  if (change > 0) return '#44ff88'
  if (change < 0) return '#ff4466'
  return '#8899aa'
}

export function metricTextColor(token: TokenBubbleData, mode: DisplayMode): string {
  // % change: full green/red text to match ring intensity
  if (mode.metric === 'change') {
    const val = mode.timeframe === '7d'
      ? (token.change7d ?? token.change24)
      : token.change24
    return changeTextColor(val)
  }
  // Other metrics: soft directional colour
  const s = ringSignal(token, mode)
  if (s > 0) return '#44ff88'
  if (s < 0) return '#ff4466'
  return '#aabbcc'
}

// ── Formatters ────────────────────────────────────────────────────────────────

export function formatMetricValue(token: TokenBubbleData, mode: DisplayMode): string {
  switch (mode.metric) {
    case 'change': {
      const val = mode.timeframe === '7d'
        ? (token.change7d ?? token.change24)
        : token.change24
      return formatChange(val)
    }
    case 'price':
      return formatPrice(token.usd_price)
    case 'volume':
      return formatVolume(getMetricValue(token, mode))
    case 'tvl':
      return formatVolume(token.tvlUsd ?? 0)
    case 'mcap':
      return formatVolume(token.marketCapUsd ?? 0)
  }
}

export function formatPrice(p: number): string {
  if (p === 0) return '$0'
  if (p >= 1_000)  return `$${p.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  if (p >= 1)      return `$${p.toFixed(2)}`
  if (p >= 0.1)    return `$${p.toFixed(3)}`
  if (p >= 0.01)   return `$${p.toFixed(4)}`

  // For sub-cent prices, show exactly 3 significant figures using plain decimal notation.
  // e.g. 0.0000118 → "$0.0000118",  0.000000118 → "$0.000000118"
  // Avoids Unicode subscripts which render as commas/dots in many fonts.
  const exp      = Math.floor(Math.log10(p))       // e.g. -5 for 0.0000118
  const decimals = -exp + 2                         // leading zeros + 3 sig figs
  if (decimals <= 10) return `$${p.toFixed(decimals)}`

  // Truly microscopic prices (>10 decimal places): show what we can
  return `$${p.toFixed(10)}`
}

// Splits a sub-cent price into [dimmed-prefix, bright-digits] for two-tone display.
// e.g. 0.0000000118 → ["$0.0000000", "118"]
// Returns null for prices ≥ $0.01 (no splitting needed).
export function formatPriceParts(p: number): [string, string] | null {
  if (p <= 0 || p >= 0.01) return null
  const full = formatPrice(p).slice(1) // strip "$"
  // Match "0." + run of zeros, then the first non-zero digit onwards
  const m = full.match(/^(0\.0*)([1-9].*)$/)
  if (!m) return null
  return [`$${m[1]}`, m[2]]
}

export function formatChange(c: number): string {
  const fixed = c.toFixed(2)
  // Don't prefix +0.00% — it looks like a data error; show it as flat
  if (fixed === '0.00') return '0.00%'
  return `${c >= 0 ? '+' : ''}${fixed}%`
}

export function formatVolume(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}K`
  return `$${v.toFixed(0)}`
}
