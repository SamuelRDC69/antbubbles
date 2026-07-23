'use client'

import { useEffect, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { formatPrice } from '@/lib/bubbleUtils'

interface Position {
  tickLower: number
  tickUpper: number
  liquidity: string
}

interface DepthData {
  currentTick: number
  tickSpacing:  number
  tokenA: { id: string; symbol: string; decimals: number } | null
  tokenB: { id: string; symbol: string; decimals: number } | null
  positions: Position[]
}

function parsePoolToken(value: unknown): { id: string; symbol: string; decimals: number } | null {
  if (!value || typeof value !== 'object') return null
  const id = (value as { id?: unknown }).id
  const symbol = (value as { symbol?: unknown }).symbol
  const decimals = Number((value as { decimals?: unknown }).decimals)
  return typeof symbol === 'string'
    ? { id: typeof id === 'string' ? id : '', symbol, decimals: Number.isFinite(decimals) ? decimals : 0 }
    : null
}

interface Bucket {
  tickMid:   number
  priceMid:  number
  liquidity: number
  rawLiquidity?: number
}

interface DepthPool {
  id: number
  tvl: number
  reversed: boolean
  counterpartSymbol: string
}

interface Props {
  poolId:          number
  chain:           string
  reversed:        boolean
  currentUsdPrice: number
  tokenSymbol:     string
  tokenId:         string
  counterpartSymbol: string
  mode?:           'single' | 'combined'
  pools?:          DepthPool[]
}

const N_BUCKETS  = 80
const TICK_RANGE = 6000  // ±6000 ticks ≈ ±45% price range from current
const PAD_L = 62
const PAD_R = 12
const PAD_T = 28
const PAD_B = 12

function relPriceToTick(relPrice: number, currentTick: number, selectedTokenIsB: boolean): number {
  if (!Number.isFinite(relPrice) || relPrice <= 0) return currentTick
  const rawRel = selectedTokenIsB ? 1 / relPrice : relPrice
  return currentTick + Math.log(rawRel) / Math.log(1.0001)
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0'
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)}M`
  if (value >= 1_000) return `$${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)}K`
  if (value >= 1) return `$${value.toFixed(value >= 100 ? 0 : 2)}`
  return `$${value.toPrecision(2)}`
}

function tokenAmountA(liquidity: number, sqrtLower: number, sqrtUpper: number): number {
  return liquidity * (sqrtUpper - sqrtLower) / (sqrtUpper * sqrtLower)
}

function tokenAmountB(liquidity: number, sqrtLower: number, sqrtUpper: number): number {
  return liquidity * (sqrtUpper - sqrtLower)
}

function tokenLiquidityUsdInTickRange(
  liquidity: number,
  tickLower: number,
  tickUpper: number,
  selectedPriceMidUsd: number,
  selectedTokenIsB: boolean,
  tokenADecimals: number,
  tokenBDecimals: number,
): number {
  if (!Number.isFinite(liquidity) || liquidity <= 0 || tickUpper <= tickLower) return 0

  const sqrtLower = Math.pow(1.0001, tickLower / 2)
  const sqrtUpper = Math.pow(1.0001, tickUpper / 2)
  if (!Number.isFinite(sqrtLower) || !Number.isFinite(sqrtUpper) || sqrtLower <= 0 || sqrtUpper <= 0) {
    return 0
  }

  const amountA = tokenAmountA(liquidity, sqrtLower, sqrtUpper)
  const amountB = tokenAmountB(liquidity, sqrtLower, sqrtUpper)

  const rawPriceBPerA = Math.pow((sqrtLower + sqrtUpper) / 2, 2)
  const decimalAdjustedPriceBPerA = rawPriceBPerA * Math.pow(10, tokenADecimals - tokenBDecimals)
  if (!Number.isFinite(decimalAdjustedPriceBPerA) || decimalAdjustedPriceBPerA <= 0) return 0

  const decimalAmountA = amountA / Math.pow(10, tokenADecimals)
  const decimalAmountB = amountB / Math.pow(10, tokenBDecimals)
  const usdA = selectedTokenIsB ? decimalAdjustedPriceBPerA * selectedPriceMidUsd : selectedPriceMidUsd
  const usdB = selectedTokenIsB ? selectedPriceMidUsd : selectedPriceMidUsd / decimalAdjustedPriceBPerA
  const value = decimalAmountA * usdA + decimalAmountB * usdB
  return Number.isFinite(value) && value > 0 ? value : 0
}

function buildBuckets(
  data: DepthData,
  currentUsdPrice: number,
  reversed: boolean,
  selectedTokenId: string,
  priceLow = currentUsdPrice * Math.pow(1.0001, -TICK_RANGE),
  priceHigh = currentUsdPrice * Math.pow(1.0001, TICK_RANGE),
): Bucket[] {
  const { currentTick, positions } = data
  const tokenADecimals = data.tokenA?.decimals ?? 0
  const tokenBDecimals = data.tokenB?.decimals ?? 0
  const selectedTokenIsB = data.tokenB?.id === selectedTokenId
    ? true
    : data.tokenA?.id === selectedTokenId
      ? false
      : reversed
  const step = (priceHigh - priceLow) / N_BUCKETS

  return Array.from({ length: N_BUCKETS }, (_, i) => {
    const price0 = priceLow + i * step
    const price1 = price0 + step
    const priceMid = (price0 + price1) / 2
    const tick0 = relPriceToTick(price0 / currentUsdPrice, currentTick, selectedTokenIsB)
    const tick1 = relPriceToTick(price1 / currentUsdPrice, currentTick, selectedTokenIsB)
    const bt0 = Math.min(tick0, tick1)
    const bt1 = Math.max(tick0, tick1)
    const btM = (bt0 + bt1) / 2

    let liq = 0
    for (const p of positions) {
      if (p.tickLower < bt1 && p.tickUpper > bt0) {
        liq += tokenLiquidityUsdInTickRange(
          parseFloat(p.liquidity),
          Math.max(p.tickLower, bt0),
          Math.min(p.tickUpper, bt1),
          priceMid,
          selectedTokenIsB,
          tokenADecimals,
          tokenBDecimals,
        )
      }
    }

    return {
      tickMid:  btM,
      priceMid,
      liquidity: liq,
    }
  })
}

function buildCombinedBuckets(
  depths: Array<{ pool: DepthPool; data: DepthData }>,
  currentUsdPrice: number,
  selectedTokenId: string,
): Bucket[] {
  const lowPrice  = currentUsdPrice * Math.pow(1.0001, -TICK_RANGE)
  const highPrice = currentUsdPrice * Math.pow(1.0001, TICK_RANGE)
  const buckets = buildEmptyPriceBuckets(lowPrice, highPrice)

  for (const { pool, data } of depths) {
    const poolBuckets = buildBuckets(data, currentUsdPrice, pool.reversed, selectedTokenId, lowPrice, highPrice)
    const rawTotal = poolBuckets.reduce((sum, bucket) => sum + bucket.liquidity, 0)
    if (rawTotal <= 0 || pool.tvl <= 0) continue

    for (let i = 0; i < buckets.length; i += 1) {
      buckets[i].liquidity += poolBuckets[i].liquidity / rawTotal * pool.tvl
    }
  }

  return buckets
}

function buildEmptyPriceBuckets(lowPrice: number, highPrice: number): Bucket[] {
  const step = (highPrice - lowPrice) / N_BUCKETS
  return Array.from({ length: N_BUCKETS }, (_, i) => ({
    tickMid: i,
    priceMid: lowPrice + (i + 0.5) * step,
    liquidity: 0,
  }))
}

function draw(
  canvas:          HTMLCanvasElement,
  buckets:         Bucket[],
  currentUsdPrice: number,
  tokenSymbol:     string,
  counterpartSymbol: string,
  mode:            'single' | 'combined' = 'single',
  poolCount = 1,
  hoverIdx: number | null = null,
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

  const chartW = W - PAD_L - PAD_R
  const chartH = H - PAD_T - PAD_B
  const barH   = chartH / N_BUCKETS

  const maxLiq = Math.max(...buckets.map(b => b.liquidity), 1)

  // Current-price bucket index (buckets[0] = lowest price)
  const currentIdx = buckets.reduce((best, b, i) =>
    Math.abs(b.priceMid - currentUsdPrice) < Math.abs(buckets[best].priceMid - currentUsdPrice) ? i : best
  , Math.floor(N_BUCKETS / 2))

  // ── Header label ────────────────────────────────────────────────────────────
  ctx.font      = 'bold 10px system-ui, sans-serif'
  ctx.fillStyle = '#6b7280'
  ctx.textAlign = 'left'
  ctx.fillText(
    mode === 'combined'
      ? `${tokenSymbol} combined USD liquidity distribution · ${poolCount} pools`
      : `${tokenSymbol} / ${counterpartSymbol} liquidity distribution`,
    PAD_L,
    16,
  )

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
    if (b.liquidity <= 0) return
    const y        = PAD_T + (N_BUCKETS - 1 - i) * barH
    const barWidth = Math.max(1, (b.liquidity / maxLiq) * chartW)
    const isAbove  = i > currentIdx

    // Base fill
    ctx.fillStyle = isAbove ? 'rgba(34,211,238,0.22)' : 'rgba(167,139,250,0.22)'
    ctx.fillRect(PAD_L + 1, y + 0.5, barWidth - 1, barH - 1)

    // Leading edge (bright stripe)
    ctx.fillStyle = isAbove ? 'rgba(34,211,238,0.75)' : 'rgba(167,139,250,0.75)'
    ctx.fillRect(PAD_L + barWidth - 1, y + 0.5, 2, barH - 1)

    if (hoverIdx === i) {
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'
      ctx.lineWidth = 1
      ctx.strokeRect(PAD_L + 0.5, y + 0.5, Math.max(1, barWidth), barH - 1)
    }
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
  // Count raw price-slice liquidity in the actual +/-10% price window.
  const priceLo = currentUsdPrice * 0.9
  const priceHi = currentUsdPrice * 1.1
  const rangeSum = buckets.reduce((s, b) => (
    b.priceMid >= priceLo && b.priceMid <= priceHi ? s + (b.rawLiquidity ?? b.liquidity) : s
  ), 0)
  const totalSum = buckets.reduce((s, b) => s + (b.rawLiquidity ?? b.liquidity), 0)
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
  poolId, chain, reversed, currentUsdPrice, tokenSymbol, tokenId, counterpartSymbol,
  mode = 'single', pools = [],
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [data,    setData]    = useState<{ buckets: Bucket[]; poolCount: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(false)
  const [hover,   setHover]   = useState<{ idx: number; x: number; y: number } | null>(null)

  useEffect(() => {
    queueMicrotask(() => { setLoading(true); setError(false); setHover(null) })
    const ctrl = new AbortController()

    const load = async () => {
      const ids = mode === 'combined'
        ? pools.filter(pool => pool.id !== 0 && pool.tvl > 0).slice(0, 10).map(pool => pool.id)
        : [poolId]
      const params = new URLSearchParams({ chain, token_id: tokenId, price: String(currentUsdPrice), pool_ids: ids.join(',') })
      const response = await fetch(`/api/liquidity-depth?${params}`, { signal: ctrl.signal })
      const result = await response.json() as { buckets?: Bucket[]; poolCount?: number }
      if (!response.ok || !result.buckets?.some(bucket => bucket.liquidity > 0)) throw new Error('No liquidity data')
      setData({ buckets: result.buckets, poolCount: result.poolCount ?? ids.length })
      setLoading(false)
    }

    load().catch(() => {
      if (!ctrl.signal.aborted) {
        setError(true)
        setLoading(false)
      }
    })

    return () => ctrl.abort()
  }, [poolId, chain, reversed, currentUsdPrice, tokenId, mode, pools])

  // Redraw whenever data, size, or price changes
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !data) return

    const { buckets } = data
    const hasLiq  = buckets.some(b => b.liquidity > 0)
    if (!hasLiq) return

    draw(canvas, buckets, currentUsdPrice, tokenSymbol, counterpartSymbol, mode, data.poolCount, hover?.idx ?? null)

    const ro = new ResizeObserver(() => {
      draw(canvas, buckets, currentUsdPrice, tokenSymbol, counterpartSymbol, mode, data.poolCount, hover?.idx ?? null)
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [data, currentUsdPrice, tokenSymbol, counterpartSymbol, mode, hover?.idx])

  const handleMove = (event: MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas || !data) return
    const rect = canvas.getBoundingClientRect()
    const y = event.clientY - rect.top
    const chartH = rect.height - PAD_T - PAD_B
    if (y < PAD_T || y > rect.height - PAD_B) {
      setHover(null)
      return
    }
    const fromTop = Math.floor((y - PAD_T) / (chartH / N_BUCKETS))
    const idx = N_BUCKETS - 1 - Math.max(0, Math.min(N_BUCKETS - 1, fromTop))
    setHover({ idx, x: event.clientX - rect.left, y })
  }

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
      <span className="text-[13px]">Couldn&apos;t load liquidity data</span>
    </div>
  )

  const hoveredBucket = hover && data ? data.buckets[hover.idx] : null

  return (
    <div className="relative w-full h-full">
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
      />
      {hover && hoveredBucket ? (
        <div
          className="pointer-events-none absolute z-10 rounded-lg border border-white/10 bg-black/85 px-2.5 py-1.5 text-[11px] shadow-xl backdrop-blur"
          style={{
            left: Math.min(hover.x + 12, 230),
            top: Math.max(8, hover.y - 34),
          }}
        >
          <div className="font-semibold text-white">{formatUsd(hoveredBucket.liquidity)}</div>
          <div className="font-mono text-gray-400">{formatPrice(hoveredBucket.priceMid)}</div>
        </div>
      ) : null}
    </div>
  )
}
