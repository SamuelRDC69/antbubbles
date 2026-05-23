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

export function computeRadii(
  tokens: TokenBubbleData[],
  mode: DisplayMode,
  containerWidth  = 0,
  containerHeight = 0,
): Map<string, number> {
  const radii = new Map<string, number>()
  if (tokens.length === 0) return radii

  // Bubble size is driven by the active metric so switching modes resizes bubbles.
  // Positions stay fixed — only targetRadius changes and the tween force animates it.
  const rawValues = tokens.map(t => getMetricValue(t, mode))
  const values    = rawValues.map(Math.abs)
  const maxVal    = Math.max(...values.filter(v => v > 0))

  // sqrt-compressed weights (0.05 floor for zero-change tokens)
  const norms   = values.map(v => maxVal > 0 && v > 0 ? Math.sqrt(v / maxVal) : 0.05)
  const avgNorm = norms.reduce((s, n) => s + n, 0) / norms.length

  // Calibrate min/max so the *actual* average bubble area hits ~85% of viewport,
  // accounting for the sqrt-skewed weight distribution.
  //
  // Solving:  targetAvgR = scaledMin + avgNorm × (scaledMax − scaledMin)
  //           scaledMax  = scaledMin × ratio
  // →         scaledMin  = targetAvgR / (1 + avgNorm × (ratio − 1))
  let scaledMin = MIN_RADIUS
  let scaledMax = MAX_RADIUS
  if (containerWidth > 0 && containerHeight > 0) {
    const targetAvgR = Math.sqrt(containerWidth * containerHeight * 0.85 / (tokens.length * Math.PI))
    const maxCap     = Math.round(Math.min(containerWidth, containerHeight) * 0.40)
    const ratio      = 6
    const rawMin     = targetAvgR / (1 + avgNorm * (ratio - 1))
    scaledMin = Math.max(12, Math.round(rawMin))
    scaledMax = Math.min(maxCap, Math.max(scaledMin + 10, Math.round(rawMin * ratio)))
  }

  if (maxVal <= 0) {
    for (const t of tokens) radii.set(t.id, scaledMin)
    return radii
  }

  for (let i = 0; i < tokens.length; i++) {
    radii.set(tokens[i].id, Math.round(scaledMin + norms[i] * (scaledMax - scaledMin)))
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
