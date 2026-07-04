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

function tickToRelPrice(tick: number, currentTick: number, reversed: boolean): number {
  const raw = Math.pow(1.0001, tick - currentTick)
  return reversed ? 1 / raw : raw
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
): Bucket[] {
  const { currentTick, positions } = data
  const tokenADecimals = data.tokenA?.decimals ?? 0
  const tokenBDecimals = data.tokenB?.decimals ?? 0
  const selectedTokenIsB = data.tokenB?.id === selectedTokenId
    ? true
    : data.tokenA?.id === selectedTokenId
      ? false
      : reversed
  const low  = currentTick - TICK_RANGE
  const high = currentTick + TICK_RANGE
  const step = (high - low) / N_BUCKETS

  return Array.from({ length: N_BUCKETS }, (_, i) => {
    const bt0 = low  + i * step
    const bt1 = bt0  + step
    const btM = (bt0 + bt1) / 2

    let liq = 0
    const priceMid = currentUsdPrice * tickToRelPrice(btM, currentTick, selectedTokenIsB)
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
  const step = (highPrice - lowPrice) / N_BUCKETS

  const buckets = Array.from({ length: N_BUCKETS }, (_, i) => ({
    tickMid: i,
    priceMid: lowPrice + (i + 0.5) * step,
    liquidity: 0,
  }))

  for (const { pool, data } of depths) {
    const poolBuckets = buildBuckets(data, currentUsdPrice, pool.reversed, selectedTokenId)
    const rawTotal = poolBuckets.reduce((sum, bucket) => sum + bucket.liquidity, 0)
    if (rawTotal <= 0 || pool.tvl <= 0) continue

    for (const bucket of poolBuckets) {
      if (bucket.liquidity <= 0) continue
      const idx = Math.floor((bucket.priceMid - lowPrice) / step)
      if (idx < 0 || idx >= buckets.length) continue
      buckets[idx].liquidity += bucket.liquidity / rawTotal * pool.tvl
    }
  }

  return buckets
}

function draw(
  canvas:          HTMLCanvasElement,
  buckets:         Bucket[],
  currentUsdPrice: number,
  tokenSymbol:     string,
  counterpartSymbol: string,
  mode:            'single' | 'combined' = 'single',
  poolCount = 1,
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

  useEffect(() => {
    setLoading(true)
    setError(false)
    const ctrl = new AbortController()

    const parseDepth = (pool: Record<string,unknown>, posRaw: unknown): DepthData => {
      const positions = (Array.isArray(posRaw) ? posRaw : (posRaw as Record<string,unknown>)?.rows ?? []) as Record<string,unknown>[]
      return {
        currentTick: typeof pool?.tick === 'number' ? pool.tick : 0,
        tickSpacing:  typeof pool?.tickSpacing === 'number' ? pool.tickSpacing : 1,
        tokenA: parsePoolToken(pool?.tokenA),
        tokenB: parsePoolToken(pool?.tokenB),
        positions: positions
          .map((p) => ({
            tickLower: Number(p.tickLower ?? p.tick_lower ?? 0),
            tickUpper: Number(p.tickUpper ?? p.tick_upper ?? 0),
            liquidity: String(p.liquidity ?? '0'),
          }))
          .filter(p => p.tickUpper > p.tickLower),
      }
    }

    const fetchDepth = async (id: number): Promise<DepthData | null> => {
      const base = `https://${chain}.alcor.exchange/api/v2/swap/pools/${id}`
      const serverFetch = fetch(`/api/pool-depth?chain=${chain}&pool_id=${id}`, { signal: ctrl.signal })
        .then(r => r.ok ? r.json() : null).catch(() => null)

      const alcorFetch = Promise.all([
        fetch(base,                { signal: ctrl.signal }).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(`${base}/positions`, { signal: ctrl.signal }).then(r => r.ok ? r.json() : null).catch(() => null),
      ]).then(([pool, pos]) => pool ? parseDepth(pool as Record<string,unknown>, pos) : null)
        .catch(() => null)

      const result = await Promise.race([
        serverFetch.then(d => d ?? alcorFetch),
        alcorFetch.then(d => d ?? serverFetch),
      ])
      return result instanceof Promise ? result : result
    }

    const load = async () => {
      if (mode === 'combined') {
        const candidates = pools
          .filter(pool => pool.id !== 0 && pool.tvl > 0)
          .slice(0, 10)
        const settled = await Promise.allSettled(
          candidates.map(async pool => ({ pool, data: await fetchDepth(pool.id) }))
        )
        const depths = settled
          .filter((result): result is PromiseFulfilledResult<{ pool: DepthPool; data: DepthData | null }> =>
            result.status === 'fulfilled' && Boolean(result.value.data?.positions.length)
          )
          .map(result => ({ pool: result.value.pool, data: result.value.data! }))

        const buckets = buildCombinedBuckets(depths, currentUsdPrice, tokenId)
        if (buckets.some(bucket => bucket.liquidity > 0)) {
          setData({ buckets, poolCount: depths.length })
          setLoading(false)
        } else {
          setError(true)
          setLoading(false)
        }
        return
      }

      const d = await fetchDepth(poolId)
      if (d) {
        setData({
          buckets: buildBuckets(d, currentUsdPrice, reversed, tokenId),
          poolCount: 1,
        })
        setLoading(false)
      } else {
        setError(true)
        setLoading(false)
      }
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

    draw(canvas, buckets, currentUsdPrice, tokenSymbol, counterpartSymbol, mode, data.poolCount)

    const ro = new ResizeObserver(() => {
      draw(canvas, buckets, currentUsdPrice, tokenSymbol, counterpartSymbol, mode, data.poolCount)
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [data, currentUsdPrice, tokenSymbol, counterpartSymbol, mode])

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

  return <canvas ref={canvasRef} className="w-full h-full" />
}
