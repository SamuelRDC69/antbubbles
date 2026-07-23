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
      // Price mode keeps the same bubble sizes as % Change so switching between
      // them doesn't cause a resize — only the displayed label changes.
      return token.change24
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

  // Normalization exponent — chosen per metric to balance visual spread:
  //
  //   change / price  → sqrt (1/2): standard, works well for ±% distributions
  //   volume/tvl/mcap → cbrt (1/3): these have extreme outliers (one token at
  //     100× the rest). Cube root compresses less aggressively so mid-range
  //     tokens stay visually distinct instead of all clustering at minimum size.
  //
  // Example with a 1000× outlier:
  //   sqrt: outlier=1.0, next=0.032 → basically invisible difference
  //   cbrt: outlier=1.0, next=0.1   → clearly smaller but not tiny
  const exp = (mode.metric === 'volume' || mode.metric === 'tvl' || mode.metric === 'mcap')
    ? 1 / 3
    : 1 / 2

  // Two-segment normalization — handles extreme outliers while keeping variation.
  //
  // The 95th-percentile value is used as the boundary between segments:
  //   Bottom 95%: normalized against p95 → mapped to [0, TOP_FLOOR]
  //   Top    5%:  log-scale spread       → mapped to [TOP_FLOOR, 1.0]
  //
  // Using cbrt/sqrt for the bottom segment (good spread for moderate variation)
  // and log for the top segment (so a 10,000× outlier still looks larger than
  // a 2× outlier, rather than all top tokens converging on the same max size).
  //
  // When there are no meaningful outliers above p95, TOP_FLOOR = 1.0 so the
  // formula collapses back to standard normalization with no wasted range.
  const posVals     = values.filter(v => v > 0).sort((a, b) => a - b)
  const p95         = posVals.length > 0
    ? posVals[Math.max(0, Math.floor(posVals.length * 0.95) - 1)]
    : maxVal
  const normRef     = Math.max(p95, 1)
  const hasOutliers = maxVal > normRef * 1.01  // anything >1% above p95 triggers two-segment mode
  const TOP_FLOOR   = hasOutliers ? 0.85 : 1.0

  // Floor of 0.05 keeps zero-value tokens visible as small bubbles.
  const norms = values.map(v => {
    if (v <= 0) return 0.05
    if (v <= normRef) return Math.pow(v / normRef, exp) * TOP_FLOOR
    // Above p95 — log scale so the true outlier is visibly the largest
    const logRatio = Math.log(v / normRef) / Math.log(maxVal / normRef)
    return TOP_FLOOR + logRatio * (1 - TOP_FLOOR)
  })

  // Exact area formula — solve for scaledMin so Σ π·r_i² = fillTarget×W×H exactly.
  // With scaledMax = ratio×scaledMin and r = ratio−1:
  //   π·scaledMin²·(N + 2r·ΣN + r²·Σn²) = target
  // → scaledMin = sqrt(target / (π·(N + 2r·ΣN + r²·Σn²)))
  const sumN  = norms.reduce((s, n) => s + n, 0)
  const sumN2 = norms.reduce((s, n) => s + n * n, 0)

  let scaledMin = MIN_RADIUS
  let scaledMax = MAX_RADIUS
  if (containerWidth > 0 && containerHeight > 0) {
    const isMobile = containerWidth < 600

    // Mobile: 90% fill — pack bubbles tightly so they spread to fill the canvas.
    // Desktop: 80% fill — dense visual without bouncing.
    const fillTarget = isMobile ? 0.90 : 0.80

    // Mobile ratio 5 (vs desktop 8): tighter size range so small bubbles are
    // proportionally much larger relative to the big ones.
    const ratio = isMobile ? 5 : 8
    const r     = ratio - 1  // mobile=4, desktop=7
    const denom = tokens.length + 2 * r * sumN + r * r * sumN2
    const rawMin = Math.sqrt(containerWidth * containerHeight * fillTarget / (Math.PI * denom))

    // Max-bubble cap: raised to 10% on mobile (was 3%) so the largest bubbles
    // can actually grow to fill space. Desktop stays at 6%.
    const maxSinglePct = isMobile ? 0.10 : 0.06
    const areaMaxR     = Math.round(Math.sqrt(containerWidth * containerHeight * maxSinglePct / Math.PI))
    const maxCap       = Math.round(Math.min(containerWidth, containerHeight) * 0.40)

    // Allow scaledMin as small as 10px on mobile — ensures tiny bubbles
    // are meaningfully visible; desktop floor stays at 10px.
    scaledMin = Math.max(10, Math.round(rawMin))

    // Desktop: ×0.85 trims the largest bubbles so they don't dominate.
    // Mobile:  ×0.84 (dialled back another 10% after live sizing check).
    const sizeMultiplier = isMobile ? 0.84 : 0.85
    scaledMax = Math.round(Math.min(maxCap, areaMaxR, Math.max(scaledMin + 8, Math.round(rawMin * ratio))) * sizeMultiplier)

    if (isMobile) {
      scaledMin = Math.round(scaledMin * 0.84)
    }
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

// Slightly lighter centre colour for the radial gradient (matches Banter Bubbles 3D look)
export function bubbleFillLightColor(signal: number): string {
  if (signal > 0) return '#004d20'   // lighter green centre
  if (signal < 0) return '#4d0010'   // lighter red centre
  return '#1a1a2e'
}

export function bubbleFillColorForMode(token: TokenBubbleData, mode: DisplayMode): string {
  return bubbleFillColor(ringSignal(token, mode))
}

export function bubbleFillLightForMode(token: TokenBubbleData, mode: DisplayMode): string {
  return bubbleFillLightColor(ringSignal(token, mode))
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
  if (signal > 0) return 'rgba(0,255,80,0.85)'
  if (signal < 0) return 'rgba(255,20,50,0.85)'
  return 'rgba(80,120,140,0.5)'
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

export function formatTokenPrice(p: number): string {
  if (p === 0) return '0'
  if (p >= 1_000) return p.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (p >= 1)     return p.toFixed(2)
  if (p >= 0.1)   return p.toFixed(3)
  if (p >= 0.01)  return p.toFixed(4)

  // Compact leading zeroes while retaining up to six significant digits:
  // 0.0000000001109 → 0.0₉1109
  // 0.000000028734  → 0.0₇28734
  const [mantissa, exponentText] = p.toExponential(5).split('e')
  const exponent = Number(exponentText)
  const zeroes = -exponent - 1
  const digits = mantissa.replace('.', '').replace(/0+$/, '')
  const subscriptZeroes = String(zeroes).replace(/\d/g, digit => '₀₁₂₃₄₅₆₇₈₉'[Number(digit)])
  return `0.0${subscriptZeroes}${digits}`
}

export function formatPrice(p: number): string {
  return `$${formatTokenPrice(p)}`
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
