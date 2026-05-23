'use client'

import { useEffect, useRef, useState } from 'react'
import { formatPrice } from '@/lib/bubbleUtils'

interface Position {
  tickLower: number
  tickUpper: number
  liquidity: string
}

interface DepthData {
  currentTick: number
  tickSpacing:  number
  tokenA: { symbol: string } | null
  tokenB: { symbol: string } | null
  positions: Position[]
}

interface Bucket {
  tickMid:   number
  priceMid:  number
  liquidity: number
}

interface Props {
  poolId:          number
  chain:           string
  reversed:        boolean
  currentUsdPrice: number
  tokenSymbol:     string
  counterpartSymbol: string
}

const N_BUCKETS  = 80
const TICK_RANGE = 6000  // ±6000 ticks ≈ ±45% price range from current

function tickToRelPrice(tick: number, currentTick: number, reversed: boolean): number {
  const raw = Math.pow(1.0001, tick - currentTick)
  return reversed ? 1 / raw : raw
}

function buildBuckets(
  data: DepthData,
  currentUsdPrice: number,
  reversed: boolean,
): Bucket[] {
  const { currentTick, positions } = data
  const low  = currentTick - TICK_RANGE
  const high = currentTick + TICK_RANGE
  const step = (high - low) / N_BUCKETS

  return Array.from({ length: N_BUCKETS }, (_, i) => {
    const bt0 = low  + i * step
    const bt1 = bt0  + step
    const btM = (bt0 + bt1) / 2

    let liq = 0
    for (const p of positions) {
      if (p.tickLower < bt1 && p.tickUpper > bt0) {
        const span    = p.tickUpper - p.tickLower
        const overlap = Math.min(p.tickUpper, bt1) - Math.max(p.tickLower, bt0)
        const weight  = span > 0 ? overlap / span : 0
        // parseFloat handles uint128 strings; precision loss is fine for relative bars
        liq += parseFloat(p.liquidity) * weight
      }
    }

    return {
      tickMid:  btM,
      priceMid: currentUsdPrice * tickToRelPrice(btM, currentTick, reversed),
      liquidity: liq,
    }
  })
}

function draw(
  canvas:          HTMLCanvasElement,
  buckets:         Bucket[],
  currentTick:     number,
  currentUsdPrice: number,
  reversed:        boolean,
  tokenSymbol:     string,
  counterpartSymbol: string,
) {
  const dpr  = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()
  const W = rect.width, H = rect.height
  if (W === 0 || H === 0) return

  canvas.width  = W * dpr
  canvas.height = H * dpr
  const ctx = canvas.getContext('2d')!
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, W, H)

  const PAD_L = 62, PAD_R = 12, PAD_T = 28, PAD_B = 12
  const chartW = W - PAD_L - PAD_R
  const chartH = H - PAD_T - PAD_B
  const barH   = chartH / N_BUCKETS

  const maxLiq = Math.max(...buckets.map(b => b.liquidity), 1)

  // Current-price bucket index (buckets[0] = lowest price when not reversed)
  const currentIdx = buckets.reduce((best, b, i) =>
    Math.abs(b.tickMid - currentTick) < Math.abs(buckets[best].tickMid - currentTick) ? i : best
  , Math.floor(N_BUCKETS / 2))

  // ── Header label ────────────────────────────────────────────────────────────
  ctx.font      = 'bold 10px system-ui, sans-serif'
  ctx.fillStyle = '#6b7280'
  ctx.textAlign = 'left'
  ctx.fillText(`${tokenSymbol} / ${counterpartSymbol}  liquidity depth`, PAD_L, 16)

  // Legend dots
  const dotY = 11
  ctx.fillStyle = '#22d3ee99'
  ctx.beginPath(); ctx.arc(W - PAD_R - 100, dotY, 4, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle  = '#6b7280'
  ctx.font       = '9px system-ui, sans-serif'
  ctx.textAlign  = 'left'
  ctx.fillText('above price', W - PAD_R - 92, dotY + 3)

  ctx.fillStyle = '#a78bfa99'
  ctx.beginPath(); ctx.arc(W - PAD_R - 20, dotY, 4, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle  = '#6b7280'
  ctx.fillText('below', W - PAD_R - 12, dotY + 3)

  // ── Axis line ──────────────────────────────────────────────────────────────
  ctx.strokeStyle = '#ffffff08'
  ctx.lineWidth   = 1
  ctx.beginPath()
  ctx.moveTo(PAD_L, PAD_T)
  ctx.lineTo(PAD_L, H - PAD_B)
  ctx.stroke()

  // ── Bars ───────────────────────────────────────────────────────────────────
  // Index 0 = lowest price → draw at bottom; N-1 = highest → draw at top
  buckets.forEach((b, i) => {
    if (b.liquidity < 1) return
    const y        = PAD_T + (N_BUCKETS - 1 - i) * barH
    const barWidth = Math.max(1, (b.liquidity / maxLiq) * chartW)
    const isAbove  = i > currentIdx

    // Base fill
    ctx.fillStyle = isAbove ? 'rgba(34,211,238,0.22)' : 'rgba(167,139,250,0.22)'
    ctx.fillRect(PAD_L + 1, y + 0.5, barWidth - 1, barH - 1)

    // Leading edge (bright stripe)
    ctx.fillStyle = isAbove ? 'rgba(34,211,238,0.75)' : 'rgba(167,139,250,0.75)'
    ctx.fillRect(PAD_L + barWidth - 1, y + 0.5, 2, barH - 1)
  })

  // ── Current-price line ────────────────────────────────────────────────────
  const cpY = PAD_T + (N_BUCKETS - 1 - currentIdx) * barH + barH / 2
  ctx.save()
  ctx.strokeStyle = 'rgba(255,255,255,0.6)'
  ctx.lineWidth   = 1
  ctx.setLineDash([4, 3])
  ctx.beginPath()
  ctx.moveTo(PAD_L, cpY)
  ctx.lineTo(W - PAD_R, cpY)
  ctx.stroke()
  ctx.restore()

  // Current price label (on right)
  ctx.font      = 'bold 9px monospace'
  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ctx.textAlign = 'right'
  ctx.fillText(formatPrice(currentUsdPrice), PAD_L - 4, cpY + 3)

  // ── Y-axis price labels ───────────────────────────────────────────────────
  ctx.font      = '9px monospace'
  ctx.fillStyle = '#374151'
  ctx.textAlign = 'right'

  // 5 evenly-spaced labels, skip if too close to current-price label
  const labelIdxs = [4, 20, 40, 60, 75]
  for (const idx of labelIdxs) {
    if (idx >= buckets.length) continue
    const diff = Math.abs(idx - currentIdx)
    if (diff < 5) continue   // too close to current price — would overlap
    const y = PAD_T + (N_BUCKETS - 1 - idx) * barH + barH / 2 + 3
    ctx.fillText(formatPrice(buckets[idx].priceMid), PAD_L - 4, y)
  }

  // ── Active-range annotation ───────────────────────────────────────────────
  // Count liquidity in ±10% buckets around current as fraction of total
  const window10 = Math.round(N_BUCKETS * 0.10)
  const lo = Math.max(0, currentIdx - window10)
  const hi = Math.min(N_BUCKETS - 1, currentIdx + window10)
  const rangeSum = buckets.slice(lo, hi + 1).reduce((s, b) => s + b.liquidity, 0)
  const totalSum = buckets.reduce((s, b) => s + b.liquidity, 0)
  if (totalSum > 0) {
    const pct = Math.round(rangeSum / totalSum * 100)
    ctx.font      = '9px system-ui, sans-serif'
    ctx.fillStyle = '#4b5563'
    ctx.textAlign = 'left'
    ctx.fillText(`${pct}% of liquidity within ±10%`, PAD_L + 6, cpY - 5)
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function LiquidityDepth({
  poolId, chain, reversed, currentUsdPrice, tokenSymbol, counterpartSymbol,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [data,    setData]    = useState<DepthData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(false)

  useEffect(() => {
    setLoading(true)
    setError(false)
    const ctrl = new AbortController()

    // Parallel race: server cache vs direct Alcor (same pattern as charts)
    const base = `https://${chain}.alcor.exchange/api/v2/swap/pools/${poolId}`
    const parseDepth = (pool: Record<string,unknown>, posRaw: unknown) => {
      const positions = (Array.isArray(posRaw) ? posRaw : (posRaw as Record<string,unknown>)?.rows ?? []) as Record<string,unknown>[]
      return {
        currentTick: typeof pool?.tick === 'number' ? pool.tick : 0,
        tickSpacing:  typeof pool?.tickSpacing === 'number' ? pool.tickSpacing : 1,
        tokenA: pool?.tokenA ?? null,
        tokenB: pool?.tokenB ?? null,
        positions: positions
          .map((p) => ({
            tickLower: Number(p.tickLower ?? p.tick_lower ?? 0),
            tickUpper: Number(p.tickUpper ?? p.tick_upper ?? 0),
            liquidity: String(p.liquidity ?? '0'),
          }))
          .filter(p => p.tickUpper > p.tickLower),
      }
    }

    const serverFetch = fetch(`/api/pool-depth?chain=${chain}&pool_id=${poolId}`, { signal: ctrl.signal })
      .then(r => r.ok ? r.json() : null).catch(() => null)

    const alcorFetch = Promise.all([
      fetch(base,                { signal: ctrl.signal }).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`${base}/positions`, { signal: ctrl.signal }).then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([pool, pos]) => pool ? parseDepth(pool as Record<string,unknown>, pos) : null)
      .catch(() => null)

    Promise.race([
      serverFetch.then(d  => d  ?? alcorFetch),
      alcorFetch.then(d   => d  ?? serverFetch),
    ]).then(async result => {
      const d = result instanceof Promise ? await result : result
      if (d) { setData(d); setLoading(false) }
      else { setError(true); setLoading(false) }
    }).catch(e => { if (!ctrl.signal.aborted) { setError(true); setLoading(false) } })

    return () => ctrl.abort()
  }, [poolId, chain])

  // Redraw whenever data, size, or price changes
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !data) return

    const buckets = buildBuckets(data, currentUsdPrice, reversed)
    const hasLiq  = buckets.some(b => b.liquidity > 0)
    if (!hasLiq) return

    draw(canvas, buckets, data.currentTick, currentUsdPrice, reversed, tokenSymbol, counterpartSymbol)

    const ro = new ResizeObserver(() => {
      draw(canvas, buckets, data.currentTick, currentUsdPrice, reversed, tokenSymbol, counterpartSymbol)
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [data, currentUsdPrice, reversed, tokenSymbol, counterpartSymbol])

  if (loading) return (
    <div className="w-full h-full flex items-center justify-center gap-1.5">
      {[0, 1, 2].map(i => (
        <div key={i} className="w-1.5 h-1.5 rounded-full bg-gray-700 animate-pulse"
          style={{ animationDelay: `${i * 150}ms` }} />
      ))}
    </div>
  )

  if (error) return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 text-gray-700">
      <svg className="w-8 h-8 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      </svg>
      <span className="text-[13px]">Couldn't load liquidity data</span>
    </div>
  )

  if (data && !data.positions.length) return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 text-gray-700">
      <span className="text-[13px]">No open positions in this pool</span>
    </div>
  )

  return <canvas ref={canvasRef} className="w-full h-full" />
}
