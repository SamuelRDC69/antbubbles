'use client'

import { TokenBubbleData, TokenPool, ChainConfig } from '@/lib/types'
import { formatPrice, formatPriceParts, formatChange, formatVolume, ringColor } from '@/lib/bubbleUtils'
import { getChart, setChart } from '@/lib/chartCache'
import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import dynamic from 'next/dynamic'
import { ErrorBoundary } from '@/components/ErrorBoundary'

const TradingChart   = dynamic(() => import('./TradingChart'),   { ssr: false })
const LiquidityDepth = dynamic(() => import('./LiquidityDepth'), { ssr: false })

interface Props {
  token:   TokenBubbleData
  chain:   ChainConfig
  onClose: () => void
}

interface Candle {
  time: number; open: number; high: number; low: number; close: number; volume: number
}

// All 9 resolutions the Alcor API actually supports
type ChartRange  = '1m' | '5m' | '15m' | '30m' | '1H' | '4H' | '1D' | '1W' | '1M'
type ChartView   = 'line' | 'candles' | 'depth'
type ChartSource = 'spot' | 'lp'

// Direct 1:1 mapping to Alcor resolution param
const RESOLUTION: Record<ChartRange, string> = {
  '1m': '1', '5m': '5', '15m': '15', '30m': '30',
  '1H': '60', '4H': '240', '1D': '1D', '1W': '1W', '1M': '1M',
}

// For line view: how far back to fetch (ms). Roughly 150–200 candles per window.
const LINE_WINDOW: Record<ChartRange, number> = {
  '1m':  2   * 60 * 60 * 1000,
  '5m':  12  * 60 * 60 * 1000,
  '15m': 36  * 60 * 60 * 1000,
  '30m': 3   * 24 * 60 * 60 * 1000,
  '1H':  7   * 24 * 60 * 60 * 1000,
  '4H':  30  * 24 * 60 * 60 * 1000,
  '1D':  365 * 24 * 60 * 60 * 1000,
  '1W':  2   * 365 * 24 * 60 * 60 * 1000,
  '1M':  5   * 365 * 24 * 60 * 60 * 1000,
}

// For candle view: how many candles to show on initial render (full history available by scrolling)
const INITIAL_CANDLES: Record<ChartRange, number> = {
  '1m': 120, '5m': 144, '15m': 96, '30m': 96,
  '1H': 168, '4H': 180, '1D': 365, '1W': 104, '1M': 60,
}

// For candle view: how far back to fetch (ms). Sub-daily resolutions are bounded to
// avoid 5–10 MB responses that stall the browser and overflow the Next.js 2 MB cache.
// 1D/1W/1M still use ALL_HISTORY_FROM — those datasets are tiny.
const CANDLE_WINDOW: Record<ChartRange, number | null> = {
  '1m':  2   * 24 * 60 * 60 * 1000,   //  2 days   → ~2 880 × 1m  candles
  '5m':  10  * 24 * 60 * 60 * 1000,   // 10 days   → ~2 880 × 5m
  '15m': 21  * 24 * 60 * 60 * 1000,   // 3 weeks   → ~2 016 × 15m
  '30m': 42  * 24 * 60 * 60 * 1000,   // 6 weeks   → ~2 016 × 30m
  '1H':  120 * 24 * 60 * 60 * 1000,   // 4 months  → ~2 880 × 1H
  '4H':  540 * 24 * 60 * 60 * 1000,   // 18 months → ~3 240 × 4H
  '1D':  null,                          // all time  (manageable dataset)
  '1W':  null,
  '1M':  null,
}

// Performance pills — fixed subset representing meaningful time windows
type PerfRange = '1H' | '4H' | '1D' | '1W' | '1M'
const PERF_RANGES: PerfRange[] = ['1H', '4H', '1D', '1W', '1M']

// Configs used ONLY for perf fetching — resolution + exact window so that
// (last.close - first.close) / first.close gives the correct period change.
// These are independent of LINE_WINDOW (which is for chart viewing context).
const PERF_CFGS: Record<PerfRange, { resolution: string; fromMs: number }> = {
  '1H': { resolution: '1',   fromMs:        60 * 60 * 1000 }, //  60 x 1-min  candles
  '4H': { resolution: '5',   fromMs:    4 * 60 * 60 * 1000 }, //  48 x 5-min  candles
  '1D': { resolution: '15',  fromMs:   24 * 60 * 60 * 1000 }, //  96 x 15-min candles
  '1W': { resolution: '60',  fromMs:  7*24 * 60 * 60 * 1000 },// 168 x 1H    candles
  '1M': { resolution: '240', fromMs: 30*24 * 60 * 60 * 1000 },// 180 x 4H    candles
}

// Far-past timestamp to request all available history (Jan 1 2019, ms)
const ALL_HISTORY_FROM = '1546300800000'

function roundHour(ms: number) {
  return Math.floor(ms / 3_600_000) * 3_600_000
}

// ── Sparkline ─────────────────────────────────────────────────────────────────
// Canvas-based so stroke weight stays physically 1 px regardless of aspect ratio.
// Uses quadratic bezier midpoint smoothing (same technique as OKX / Binance apps).

function smoothTrace(ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[]) {
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2
    const my = (pts[i].y + pts[i + 1].y) / 2
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my)
  }
  ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y)
}

function PriceSparkline({ candles, isPositive, chartRange }: {
  candles:    Candle[]
  isPositive: boolean
  chartRange: ChartRange
}) {
  const canvasRef  = useRef<HTMLCanvasElement>(null)
  const mouseRef   = useRef<{ x: number; y: number } | null>(null)
  const drawFnRef  = useRef<((mp: { x: number; y: number } | null) => void) | null>(null)
  // Track last canvas size to avoid unnecessary resize (resizing clears the canvas)
  const sizeRef    = useRef({ w: 0, h: 0, dpr: 1 })

  const fmtTime = useCallback((ms: number) => {
    const d = new Date(ms)
    if (['1m','5m','15m','30m','1H'].includes(chartRange))
      return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
    if (chartRange === '4H')
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
             d.getHours().toString().padStart(2, '0') + 'h'
    if (chartRange === '1D')
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
  }, [chartRange])

  const { prices, times, minP, maxP } = useMemo(() => {
    const prices = candles.map(c => c.close)
    const times  = candles.map(c => c.time)
    return { prices, times, minP: Math.min(...prices), maxP: Math.max(...prices) }
  }, [candles])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || prices.length < 2) return

    const color  = isPositive ? '#00e676' : '#ff4d6a'
    const PAD_L  = 12, PAD_R = 52, PAD_T = 14, PAD_B = 24
    // PAD_R = 52 to leave space for crosshair price pill

    const draw = (mp: { x: number; y: number } | null) => {
      const dpr  = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      const W = rect.width, H = rect.height
      if (W === 0 || H === 0) return

      // Only resize backing store when dimensions actually change (avoids flicker)
      const s = sizeRef.current
      if (W !== s.w || H !== s.h || dpr !== s.dpr) {
        canvas.width  = W * dpr
        canvas.height = H * dpr
        sizeRef.current = { w: W, h: H, dpr }
      }

      const ctx = canvas.getContext('2d')!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H)

      const cW         = W - PAD_L - PAD_R
      const cH         = H - PAD_T - PAD_B
      const priceRange = maxP - minP || minP * 0.01 || 1
      const toX        = (i: number) => PAD_L + (i / (prices.length - 1)) * cW
      const toY        = (p: number) => PAD_T + (1 - (p - minP) / priceRange) * cH
      const pts        = prices.map((p, i) => ({ x: toX(i), y: toY(p) }))
      const last       = pts[pts.length - 1]

      // ── Gradient fill ──────────────────────────────────────────────────────
      const grad = ctx.createLinearGradient(0, PAD_T, 0, PAD_T + cH)
      grad.addColorStop(0,   color + '28')
      grad.addColorStop(0.7, color + '08')
      grad.addColorStop(1,   color + '00')
      ctx.beginPath()
      smoothTrace(ctx, pts)
      ctx.lineTo(last.x, PAD_T + cH)
      ctx.lineTo(pts[0].x, PAD_T + cH)
      ctx.closePath()
      ctx.fillStyle = grad
      ctx.fill()

      // ── Glow pass ─────────────────────────────────────────────────────────
      ctx.save()
      ctx.shadowColor = color
      ctx.shadowBlur  = 10
      ctx.beginPath()
      smoothTrace(ctx, pts)
      ctx.strokeStyle = color + '55'
      ctx.lineWidth   = 3
      ctx.lineJoin    = 'round'
      ctx.lineCap     = 'round'
      ctx.stroke()
      ctx.restore()

      // ── Crisp line ────────────────────────────────────────────────────────
      ctx.beginPath()
      smoothTrace(ctx, pts)
      ctx.strokeStyle = color
      ctx.lineWidth   = 1.5
      ctx.lineJoin    = 'round'
      ctx.lineCap     = 'round'
      ctx.stroke()

      // ── End dot ───────────────────────────────────────────────────────────
      ctx.beginPath()
      ctx.arc(last.x, last.y, 2.5, 0, Math.PI * 2)
      ctx.fillStyle   = color
      ctx.shadowColor = color
      ctx.shadowBlur  = 8
      ctx.fill()
      ctx.shadowBlur  = 0

      // ── Static price axis (right) — clipped so long sub-cent labels can't
      //   bleed into the chart area regardless of how many decimal places ─────
      ctx.save()
      ctx.beginPath()
      ctx.rect(W - PAD_R, 0, PAD_R, H)
      ctx.clip()
      const priceLevels = [
        { p: maxP, y: PAD_T },
        { p: (maxP + minP) / 2, y: PAD_T + cH / 2 },
        { p: minP, y: PAD_T + cH },
      ]
      ctx.font      = `9px ui-monospace, monospace`
      ctx.textAlign = 'right'
      for (const { p, y } of priceLevels) {
        const lY  = y + 3
        const raw = formatPrice(p).slice(1)
        const m   = raw.match(/^(0\.0*)([1-9].*)$/)
        if (m) {
          const [, prefix, digits] = m
          const dW = ctx.measureText(digits).width
          ctx.fillStyle = '#9ca3af'; ctx.fillText(digits, W - 3, lY)
          ctx.fillStyle = '#374151'; ctx.fillText(prefix, W - 3 - dW, lY)
        } else {
          ctx.fillStyle = '#6b7280'; ctx.fillText(raw, W - 3, lY)
        }
      }
      ctx.restore()

      // ── Static time axis (bottom) — clipped to bottom strip ───────────────
      ctx.save()
      ctx.beginPath()
      ctx.rect(PAD_L, H - PAD_B, W - PAD_L - PAD_R, PAD_B)
      ctx.clip()
      ctx.font = `9px ui-monospace, monospace`
      const N = prices.length - 1
      const timeIdxs = [0, Math.round(N * 0.33), Math.round(N * 0.66), N]
        .filter((v, i, a) => a.indexOf(v) === i)
      for (const tIdx of timeIdxs) {
        const x     = toX(tIdx)
        const label = fmtTime(times[tIdx])
        const align = tIdx === 0 ? 'left' : tIdx === N ? 'right' : 'center'
        ctx.textAlign = align as CanvasTextAlign
        ctx.fillStyle = '#4b5563'
        ctx.fillText(label, x, H - 5)
      }
      ctx.restore()

      // ── Mid-price gridline ────────────────────────────────────────────────
      const midY = toY((maxP + minP) / 2)
      ctx.strokeStyle = '#ffffff06'
      ctx.lineWidth   = 1
      ctx.setLineDash([3, 4])
      ctx.beginPath()
      ctx.moveTo(PAD_L, midY)
      ctx.lineTo(W - PAD_R, midY)
      ctx.stroke()
      ctx.setLineDash([])

      // ── Crosshair ─────────────────────────────────────────────────────────
      if (mp) {
        const frac = Math.max(0, Math.min(1, (mp.x - PAD_L) / cW))
        const idx  = Math.round(frac * (prices.length - 1))
        const cx   = toX(idx)
        const cy   = toY(prices[idx])

        // Vertical dashed line
        ctx.strokeStyle = 'rgba(255,255,255,0.14)'
        ctx.lineWidth   = 1
        ctx.setLineDash([3, 4])
        ctx.beginPath()
        ctx.moveTo(cx, PAD_T)
        ctx.lineTo(cx, PAD_T + cH)
        ctx.stroke()

        // Horizontal dashed line
        ctx.beginPath()
        ctx.moveTo(PAD_L, cy)
        ctx.lineTo(W - PAD_R, cy)
        ctx.stroke()
        ctx.setLineDash([])

        // Snap dot (glowing, on the line)
        ctx.beginPath()
        ctx.arc(cx, cy, 3.5, 0, Math.PI * 2)
        ctx.fillStyle   = color
        ctx.shadowColor = color
        ctx.shadowBlur  = 8
        ctx.fill()
        ctx.shadowBlur  = 0

        // ── Floating tooltip box ───────────────────────────────────────────
        // Shows price (bold) and time below it, follows the snap dot.
        // Prefers right of the dot; flips left when near the right edge.
        const priceStr = formatPrice(prices[idx])
        const timeStr  = fmtTime(times[idx])

        ctx.font = `bold 10px ui-monospace, monospace`
        const priceTextW = ctx.measureText(priceStr).width
        ctx.font = `9px ui-monospace, monospace`
        const timeTextW  = ctx.measureText(timeStr).width

        const BPAD = 8                                // horizontal inner padding
        const boxW = Math.max(priceTextW, timeTextW) + BPAD * 2
        const boxH = 30                               // height for two text lines
        const GAP  = 10                               // dot → box edge gap

        // Horizontal: right of dot unless it would overlap the price axis
        let boxX = cx + GAP
        if (boxX + boxW > W - PAD_R - 4) boxX = cx - GAP - boxW
        boxX = Math.max(PAD_L + 2, Math.min(W - PAD_R - boxW - 2, boxX))

        // Vertical: centre on the dot, clamped inside the chart area
        let boxY = cy - boxH / 2
        boxY = Math.max(PAD_T, Math.min(PAD_T + cH - boxH, boxY))

        // Box background
        ctx.fillStyle = 'rgba(10,15,22,0.94)'
        roundRect(ctx, boxX, boxY, boxW, boxH, 5)
        ctx.fill()
        // Box border — tinted with the chart line colour
        ctx.strokeStyle = color + '55'
        ctx.lineWidth   = 0.75
        roundRect(ctx, boxX, boxY, boxW, boxH, 5)
        ctx.stroke()
        // Left accent stripe
        ctx.fillStyle = color + 'cc'
        roundRect(ctx, boxX, boxY + 5, 2, boxH - 10, 1)
        ctx.fill()

        const textX = boxX + BPAD + 2

        // Price — bold, two-tone for sub-cent
        ctx.font      = `bold 10px ui-monospace, monospace`
        ctx.textAlign = 'left'
        const rawP = priceStr.slice(1)
        const mP   = rawP.match(/^(0\.0*)([1-9].*)$/)
        if (mP) {
          const [, prefix, digits] = mP
          ctx.fillStyle = '#374151'; ctx.fillText('$' + prefix, textX, boxY + 12)
          ctx.fillStyle = '#e2e8f0'; ctx.fillText(digits, textX + ctx.measureText('$' + prefix).width, boxY + 12)
        } else {
          ctx.fillStyle = '#e2e8f0'
          ctx.fillText(priceStr, textX, boxY + 12)
        }

        // Time — dim, smaller
        ctx.font      = `9px ui-monospace, monospace`
        ctx.fillStyle = '#6b7280'
        ctx.fillText(timeStr, textX, boxY + 24)
      }
    }

    drawFnRef.current = draw
    draw(mouseRef.current)

    const ro = new ResizeObserver(() => draw(mouseRef.current))
    ro.observe(canvas)
    return () => { ro.disconnect(); drawFnRef.current = null }
  }, [prices, times, minP, maxP, isPositive, fmtTime])

  if (prices.length < 2) return null
  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full"
      onMouseMove={e => {
        const canvas = canvasRef.current
        if (!canvas) return
        const rect = canvas.getBoundingClientRect()
        mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
        drawFnRef.current?.(mouseRef.current)
      }}
      onMouseLeave={() => {
        mouseRef.current = null
        drawFnRef.current?.(null)
      }}
    />
  )
}

// Utility: draw a rounded rectangle path on a 2D canvas context
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

// Compact % formatter for narrow pills — reduces decimal places as magnitude grows.
// |c| < 10  → "+1.98%"   (2dp, same as formatChange)
// |c| < 100 → "+12.4%"   (1dp)
// |c| ≥ 100 → "+100%"    (0dp — avoids overflow in tiny pill)
function formatChangePill(c: number): string {
  const abs = Math.abs(c)
  if (abs >= 100) return `${c >= 0 ? '+' : ''}${Math.round(c)}%`
  if (abs >= 10)  return `${c >= 0 ? '+' : ''}${c.toFixed(1)}%`
  return formatChange(c)  // handles 0.00% correctly
}

function PerfPill({ label, change }: { label: string; change: number | undefined }) {
  const pos = change !== undefined && change > 0
  const neg = change !== undefined && change < 0
  const cls = pos ? 'bg-green-500/10 border-green-500/20 text-green-400'
    : neg ? 'bg-red-500/10 border-red-500/20 text-red-400'
    : 'bg-white/[0.04] border-white/[0.08] text-gray-600'
  return (
    <div className={`flex flex-col items-center justify-center px-1 py-2 rounded-lg border gap-0.5 min-w-0 ${cls}`}>
      <span className="text-[9px] text-gray-500 font-semibold uppercase tracking-wider leading-none">{label}</span>
      <span className="text-[10px] font-bold leading-none tabular-nums whitespace-nowrap">
        {change !== undefined ? formatChangePill(change) : '—'}
      </span>
    </div>
  )
}

// Renders a price with dimmed leading zeros and bright significant digits.
// "$0.0000000118" → "$0.0000000" in gray + "118" in white
// Makes tiny prices scannable at a glance — same technique used by GeckoTerminal / DEXScreener.
function PriceDisplay({ price, className = 'text-[22px] font-bold leading-none' }: {
  price:      number
  className?: string
}) {
  const parts = formatPriceParts(price)
  if (!parts) {
    return <span className={`text-white ${className}`}>{formatPrice(price)}</span>
  }
  const [prefix, digits] = parts
  return (
    <span className={className}>
      <span className="text-gray-400">{prefix}</span>
      <span className="text-white">{digits}</span>
    </span>
  )
}

// Tiny inline arrow badge for % change values (TVL, vol7d, vol30d, etc.)
function ChangeBadge({ pct }: { pct: number | undefined }) {
  if (pct === undefined) return null
  const pos = pct > 0
  return (
    <span className={`text-[9px] font-semibold leading-none tabular-nums
      ${pos ? 'text-green-500' : 'text-red-400'}`}>
      {pos ? '↑' : '↓'}{Math.min(9999, Math.abs(pct)).toFixed(pct !== 0 && Math.abs(pct) < 10 ? 1 : 0)}%
    </span>
  )
}

function StatRow({ label, value, price, badge }: {
  label:   string
  value?:  string
  price?:  number
  badge?:  React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-white/[0.04] last:border-0">
      <span className="text-[11px] text-gray-500">{label}</span>
      <span className="flex items-center gap-1.5">
        {price !== undefined ? (
          <PriceDisplay price={price} className="text-[11px] font-medium tabular-nums" />
        ) : (
          <span className="text-[11px] text-gray-200 font-medium tabular-nums">{value}</span>
        )}
        {badge}
      </span>
    </div>
  )
}

// 24h price range bar — temperature-style red→yellow→green gradient.
function RangeBar({ lo, hi, current, label = '24h Range' }: { lo: number; hi: number; current: number; label?: string }) {
  const pos = Math.min(100, Math.max(0, (current - lo) / (hi - lo) * 100))
  // Colour of the marker dot interpolated from the position
  const markerColor = pos >= 60 ? '#22c55e' : pos >= 40 ? '#eab308' : '#ef4444'
  return (
    <div className="py-2.5 border-b border-white/[0.04]">
      {/* Header row */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] text-gray-500">{label}</span>
        <span className="text-[9px] tabular-nums" style={{ color: markerColor }}>{pos.toFixed(0)}%</span>
      </div>

      {/* Track */}
      <div className="relative rounded-full" style={{ height: 6 }}>
        {/* Gradient fill — full red → yellow → green */}
        <div className="absolute inset-0 rounded-full" style={{
          background: 'linear-gradient(to right, #ef4444, #f97316 25%, #eab308 50%, #84cc16 75%, #22c55e)',
        }} />
        {/* Dark overlay on the right of current price to dim the "unreached" portion */}
        <div className="absolute inset-y-0 right-0 rounded-r-full" style={{
          left: `${pos}%`,
          background: 'rgba(0,0,0,0.55)',
        }} />
        {/* Marker — white ring with colored glow */}
        <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 rounded-full"
          style={{
            left: `${pos}%`,
            width: 10, height: 10,
            background: '#fff',
            boxShadow: `0 0 0 1.5px #0a0f14, 0 0 6px 1px ${markerColor}`,
          }} />
      </div>

      {/* Price labels */}
      <div className="flex items-center justify-between mt-1.5">
        <PriceDisplay price={lo} className="text-[9px] tabular-nums text-red-500/70" />
        <PriceDisplay price={hi} className="text-[9px] tabular-nums text-green-500/70" />
      </div>
    </div>
  )
}

// ── Pool selector ─────────────────────────────────────────────────────────────
// Dropdown showing token logos, symbols, and TVL for each LP pool.

function PoolLogo({ src, symbol, size = 18 }: { src: string; symbol: string; size?: number }) {
  const [err, setErr] = useState(false)
  if (err) {
    return (
      <span className="rounded-full bg-white/10 flex items-center justify-center text-[8px] font-bold text-white shrink-0"
        style={{ width: size, height: size }}>
        {symbol.slice(0, 2)}
      </span>
    )
  }
  return (
    <img src={src} alt={symbol} onError={() => setErr(true)}
      className="rounded-full object-contain shrink-0"
      style={{ width: size, height: size, background: 'rgba(255,255,255,0.06)' }} />
  )
}

function PoolSelector({
  pools,
  selected,
  tokenSymbol,
  tokenLogoUrl,
  chain,
  onSelect,
}: {
  pools:         TokenPool[]
  selected:      TokenPool | undefined
  tokenSymbol:   string
  tokenLogoUrl:  string
  chain:         ChainConfig
  onSelect:      (p: TokenPool) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const counterpartLogoUrl = (pool: TokenPool) =>
    `/api/logo?id=${encodeURIComponent(pool.counterpartId)}&chain=${chain.id}`

  return (
    <div ref={ref} className="relative">
      {/* ── Trigger button ── */}
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-semibold
          bg-white/[0.07] border border-white/[0.10] hover:bg-white/[0.10] transition-colors"
      >
        <PoolLogo src={tokenLogoUrl} symbol={tokenSymbol} size={14} />
        <span className="text-white">{tokenSymbol}</span>
        <span className="text-gray-600">/</span>
        <PoolLogo src={counterpartLogoUrl(selected ?? pools[0])} symbol={selected?.counterpartSymbol ?? ''} size={14} />
        <span className="text-gray-300">{selected?.counterpartSymbol ?? '—'}</span>
        {selected && selected.tvl > 0 && (
          <span className="text-gray-600">· {formatVolume(selected.tvl)}</span>
        )}
        <svg className={`w-2.5 h-2.5 text-gray-600 transition-transform shrink-0 ${open ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* ── Dropdown ── */}
      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 rounded-xl border border-white/[0.08] shadow-2xl overflow-hidden"
          style={{ background: '#0c1218', minWidth: 240 }}>

          {/* Column headers */}
          <div className="flex items-center px-3 py-1.5 border-b border-white/[0.06] gap-0">
            <span className="flex-1 text-[9px] font-semibold uppercase tracking-widest text-gray-600"
              title="Trading pair — token you are viewing / its liquidity counterpart">
              Pair
            </span>
            <span className="text-[9px] font-semibold uppercase tracking-widest text-gray-600 text-right w-16"
              title="Total Value Locked — combined USD value of both sides of this pool">
              TVL
            </span>
          </div>

          {/* Pool rows */}
          {pools.map(p => {
            const isSelected = p.id === selected?.id
            return (
              <button
                key={p.id}
                onClick={() => { onSelect(p); setOpen(false) }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors
                  border-b border-white/[0.03] last:border-0
                  ${isSelected ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]'}`}
              >
                {/* Pair: logos + symbols */}
                <div className="flex items-center gap-1 flex-1 min-w-0">
                  <PoolLogo src={tokenLogoUrl} symbol={tokenSymbol} size={16} />
                  <span className="text-[11px] font-semibold text-white">{tokenSymbol}</span>
                  <span className="text-[11px] text-gray-600">/</span>
                  <PoolLogo src={counterpartLogoUrl(p)} symbol={p.counterpartSymbol} size={16} />
                  <span className="text-[11px] font-semibold text-gray-300">{p.counterpartSymbol}</span>
                  {isSelected && <span className="w-1 h-1 rounded-full bg-green-500 shrink-0 ml-0.5" />}
                </div>
                {/* TVL */}
                <span className="text-[11px] tabular-nums text-gray-400 w-16 text-right shrink-0">
                  {p.tvl > 0 ? formatVolume(p.tvl) : <span className="text-gray-700">—</span>}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Modal ─────────────────────────────────────────────────────────────────────
export default function TokenModal({ token, chain, onClose }: Props) {
  const [logoError,    setLogoError]    = useState(false)
  const [contractCopied, setContractCopied] = useState(false)
  const [chartRange,   setChartRange]   = useState<ChartRange>('1D')
  const [chartView,    setChartView]    = useState<ChartView>('line')
  const [chartSource,  setChartSource]  = useState<ChartSource>(token.ticker_id ? 'spot' : 'lp')
  const [candles,      setCandles]      = useState<Candle[]>([])
  const [chartLoading, setChartLoading] = useState(true)

  const pools   = token.pools ?? []
  const hasSpot = !!token.ticker_id
  const hasLP   = pools.length > 0

  // Default LP pool: prefer WAX pair, else first by TVL
  const defaultPool = pools.find(p => p.counterpartId === `${chain.systemToken.toLowerCase()}-${chain.systemContract}`)
    ?? pools[0]

  const [selectedPool, setSelectedPool] = useState<TokenPool | undefined>(defaultPool)

  const cacheRef = useRef<Map<string, Candle[]>>(new Map())
  const abortRef = useRef<AbortController | null>(null)

  // Seed 1D/1W from API values immediately (accurate, no fetch needed).
  // All 5 are then refreshed from actual chart data in the background.
  const [perfs, setPerfs] = useState<Partial<Record<PerfRange, number>>>(() => ({
    '1D': token.change24 || undefined,
    '1W': token.change7d  || undefined,
  }))

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  // ── Fetch ──────────────────────────────────────────────────────────────────
  const fetchChart = useCallback(async (
    range: ChartRange, view: ChartView, source: ChartSource,
    pool: TokenPool | undefined, signal: AbortSignal,
  ): Promise<Candle[]> => {
    const cacheKey = `${range}:${view}:${source}:${pool?.id ?? ''}`
    const cached = cacheRef.current.get(cacheKey)
    if (cached) return cached

    let url = ''

    const res = RESOLUTION[range]


    // Candle view uses a bounded window for sub-daily resolutions (null = all history).
    // Line view always uses a tight recent window.
    const candleFromMs = CANDLE_WINDOW[range]
    const candleFrom   = candleFromMs != null
      ? roundHour(Date.now() - candleFromMs)
      : ALL_HISTORY_FROM

    if (source === 'lp' && pool) {
      url = `/api/pool-chart?chain=${chain.id}&pool_id=${pool.id}&resolution=${res}`
      if (pool.reversed) url += `&reverse=true`
      if (view === 'line') {
        const from = roundHour(Date.now() - LINE_WINDOW[range])
        url += `&from=${from}&to=${roundHour(Date.now())}`
      } else {
        url += `&from=${candleFrom}`
      }
    } else if (source === 'spot' && token.ticker_id) {
      url = `/api/klines?chain=${chain.id}&ticker_id=${encodeURIComponent(token.ticker_id)}&resolution=${res}`
      if (view === 'line') {
        const from = roundHour(Date.now() - LINE_WINDOW[range])
        url += `&from=${from}&to=${roundHour(Date.now())}`
      } else {
        url += `&from=${candleFrom}`
      }
    } else {
      return []
    }

    // Check global cache (filled by hover-prefetch or a previous modal open)
    const globalHit = getChart(url)
    if (globalHit) {
      cacheRef.current.set(cacheKey, globalHit)
      return globalHit
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    // Pool candles return OHLC as strings — normalise to numbers
    const normalise = (raw: Candle[]): Candle[] =>
      source === 'lp'
        ? raw.map(c => ({
            time:   c.time,
            open:   typeof c.open  === 'string' ? parseFloat(c.open)  : c.open,
            high:   typeof c.high  === 'string' ? parseFloat(c.high)  : c.high,
            low:    typeof c.low   === 'string' ? parseFloat(c.low)   : c.low,
            close:  typeof c.close === 'string' ? parseFloat(c.close) : c.close,
            volume: c.volume,
          }))
        : raw

    // Direct Alcor URL — browser requests aren't blocked (CORS: allow-origin: *)
    // Alcor blocks datacenter IPs (Vercel/Railway) so we always go direct from browser.
    const fromParam = view === 'line' ? roundHour(Date.now() - LINE_WINDOW[range]) : candleFrom
    const toParam   = view === 'line' ? roundHour(Date.now()) : undefined
    const alcorUrl: string | null = (() => {
      if (source === 'lp' && pool) {
        const u = new URL(`https://${chain.id}.alcor.exchange/api/v2/swap/pools/${pool.id}/candles`)
        u.searchParams.set('resolution', res)
        u.searchParams.set('from', String(fromParam))
        if (toParam)       u.searchParams.set('to',      String(toParam))
        if (pool.reversed) u.searchParams.set('reverse', 'true')
        return u.toString()
      }
      if (source === 'spot' && token.ticker_id) {
        const u = new URL(`https://${chain.id}.alcor.exchange/api/v2/tickers/${encodeURIComponent(token.ticker_id)}/charts`)
        u.searchParams.set('resolution', res)
        u.searchParams.set('from', String(fromParam))
        if (toParam) u.searchParams.set('to', String(toParam))
        return u.toString()
      }
      return null
    })()

    // ── Parallel race: Redis cache vs direct Alcor browser fetch ─────────────
    // Both start at exactly the same time.
    // Redis hit  → resolves in ~50 ms (instant chart).
    // Redis miss → server returns [] immediately, Alcor browser fetch wins
    //              (typically 2–5 s from a residential IP).
    // This is the same pattern DEX Screener uses: serve from own cache when warm,
    // go direct to the data source when cold — zero wasted wait time either way.

    const fetchWithData = (p: Promise<Response>): Promise<Candle[] | null> =>
      p.then(r => r.ok ? r.json() : null)
       .then((d: unknown) => {
         const raw = Array.isArray(d) ? d as Candle[] : []
         return raw.length > 0 ? normalise(raw) : null
       })
       .catch(() => null)

    const serverPromise = fetchWithData(fetch(url, { signal }))
    const alcorPromise  = alcorUrl ? fetchWithData(fetch(alcorUrl, { signal })) : Promise.resolve(null)

    // Resolve as soon as either returns data; fall back to the other if one is null
    const result = await new Promise<Candle[]>((resolve) => {
      let settled = 0
      const tryResolve = (data: Candle[] | null, other: Promise<Candle[] | null>) => {
        if (data && data.length > 0) { resolve(data); return }
        if (++settled === 2) resolve([])
        else other.then(d => { if (d && d.length > 0) resolve(d); else if (++settled >= 2) resolve([]) })
      }
      serverPromise.then(d => tryResolve(d, alcorPromise))
      alcorPromise.then(d  => tryResolve(d, serverPromise))
    })

    setChart(url, result)
    cacheRef.current.set(cacheKey, result)
    return result
  }, [token, chain])

  // Clear cache only when the token changes (not on range/view switches)
  useEffect(() => { cacheRef.current.clear() }, [token.id])

  // ── Load chart on param change ─────────────────────────────────────────────
  useEffect(() => {
    setChartLoading(true)
    setCandles([])

    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    fetchChart(chartRange, chartView, chartSource, selectedPool, ctrl.signal)
      .then(c => {
        if (!ctrl.signal.aborted) {
          setCandles(c)
        }
      })
      .catch(() => {})
      .finally(() => { if (!ctrl.signal.aborted) setChartLoading(false) })

    return () => ctrl.abort()
  }, [chartRange, chartView, chartSource, selectedPool, token.id, fetchChart])

  // Fetch all perf values using PERF_CFGS (exact windows, correct resolutions).
  // Runs on token/source/pool change; resets stale values first.
  useEffect(() => {
    // Reset to API-seeded values so we don't show stale data from previous source
    setPerfs({
      '1D': token.change24 || undefined,
      '1W': token.change7d  || undefined,
    })

    const ctrl = new AbortController()

    PERF_RANGES.forEach(r => {
      const { resolution, fromMs } = PERF_CFGS[r]
      const from = roundHour(Date.now() - fromMs)
      const to   = roundHour(Date.now())

      // Always use pool data for perf pills; fall back to spot if no pools exist
      let url = ''
      if (defaultPool) {
        url = `/api/pool-chart?chain=${chain.id}&pool_id=${defaultPool.id}&resolution=${resolution}&from=${from}&to=${to}`
        if (defaultPool.reversed) url += `&reverse=true`
      } else if (token.ticker_id) {
        url = `/api/klines?chain=${chain.id}&ticker_id=${encodeURIComponent(token.ticker_id)}&resolution=${resolution}&from=${from}&to=${to}`
      } else {
        return
      }

      // Build direct Alcor URL — same parallel-race strategy as fetchChart
      const alcorDirect: string | null = defaultPool
        ? (() => {
            const u = new URL(`https://${chain.id}.alcor.exchange/api/v2/swap/pools/${defaultPool.id}/candles`)
            u.searchParams.set('resolution', resolution)
            u.searchParams.set('from', String(from))
            u.searchParams.set('to', String(to))
            if (defaultPool.reversed) u.searchParams.set('reverse', 'true')
            return u.toString()
          })()
        : token.ticker_id
          ? (() => {
              const u = new URL(`https://${chain.id}.alcor.exchange/api/v2/tickers/${encodeURIComponent(token.ticker_id!)}/charts`)
              u.searchParams.set('resolution', resolution)
              u.searchParams.set('from', String(from))
              u.searchParams.set('to', String(to))
              return u.toString()
            })()
          : null

      const normCandles = (raw: Candle[]): Candle[] =>
        defaultPool
          ? raw.map((c: Candle) => ({
              ...c,
              open:  typeof c.open  === 'string' ? parseFloat(c.open  as unknown as string) : c.open,
              high:  typeof c.high  === 'string' ? parseFloat(c.high  as unknown as string) : c.high,
              low:   typeof c.low   === 'string' ? parseFloat(c.low   as unknown as string) : c.low,
              close: typeof c.close === 'string' ? parseFloat(c.close as unknown as string) : c.close,
            }))
          : raw

      // Return immediately from global cache if available (prevents different values on re-open)
      const cachedPerf = getChart(url)
      if (cachedPerf && cachedPerf.length >= 2) {
        const pct = (cachedPerf[cachedPerf.length-1].close - cachedPerf[0].close) / cachedPerf[0].close * 100
        setPerfs(prev => ({ ...prev, [r]: pct }))
        return
      }

      const getCandles = (fetchUrl: string) =>
        fetch(fetchUrl, { signal: ctrl.signal })
          .then(res => res.ok ? res.json() : [])
          .then((d: unknown) => { const raw = Array.isArray(d) ? d as Candle[] : []; return raw.length > 0 ? normCandles(raw) : null })
          .catch(() => null)

      // Fire both simultaneously — use the first one that returns data
      const serverP = getCandles(url)
      const alcorP  = alcorDirect ? getCandles(alcorDirect) : Promise.resolve(null)

      Promise.race([
        serverP.then(d => d ?? alcorP),
        alcorP.then(d  => d ?? serverP),
      ]).then(async result => {
        const candles = result instanceof Promise ? (await result ?? []) : (result ?? [])
        if (candles.length >= 2) {
          setChart(url, candles)
          const pct = (candles[candles.length-1].close - candles[0].close) / candles[0].close * 100
          setPerfs(prev => ({ ...prev, [r]: pct }))
        }
      }).catch(() => {})
    })

    return () => ctrl.abort()
  }, [token.id, token.change24, token.change7d, chain.id, token.ticker_id, defaultPool?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const isPositive = candles.length >= 2
    ? candles[candles.length-1].close >= candles[0].close
    : token.change24 >= 0

  const ringCol = ringColor(token.change24)
  const alcorUrl = token.ticker_id
    ? `https://${chain.id}.alcor.exchange/trade/${token.ticker_id}`
    : selectedPool
    ? `https://${chain.id}.alcor.exchange/swap?pool_id=${selectedPool.id}`
    : null
  const explorerUrl = `${chain.explorerBase}/account/${token.contract}`

  // All ticker values (high24, low24, bid, ask) are in the quote currency (WAX for WAX-chain
  // spot pairs). Convert to USD the same way the main price is derived.
  const waxToUsd = token.system_price > 0 ? token.usd_price / token.system_price : 0
  const hiUsd    = token.high24 > 0 && waxToUsd > 0 ? token.high24 * waxToUsd : 0
  const loUsd    = token.low24  > 0 && waxToUsd > 0 ? token.low24  * waxToUsd : 0
  const bidUsd   = token.bid    > 0 && waxToUsd > 0 ? token.bid    * waxToUsd : 0
  const askUsd   = token.ask    > 0 && waxToUsd > 0 ? token.ask    * waxToUsd : 0
  // ── Range bar — three-tier fallback ───────────────────────────────────────
  // A: spot ticker high24/low24 (real intraday range, almost always 0 on WAX)
  // B: last candle hi/lo — on default 1D view the last bar = today's candle,
  //    giving the true 24h intraday range. Falls back gracefully for other ranges.
  //    Requires candle prices in WAX (spot source, or LP with WAX counterpart).
  // C: open-close from change24, padded ±15% so the marker isn't at an extreme.
  //    Always works; produces a useful indicator even for illiquid tokens.

  const isWaxCounterpart = selectedPool?.counterpartId ===
    `${chain.systemToken.toLowerCase()}-${chain.systemContract}`
  const candleToUsd = (chartSource === 'spot' || (chartSource === 'lp' && isWaxCounterpart)) && waxToUsd > 0
    ? waxToUsd : 0

  // Tier A
  let rangeHiUsd: number = hiUsd
  let rangeLoUsd: number = loUsd
  let rangeLabel: string = '24h Range'

  // Tier B
  if (!(rangeHiUsd > rangeLoUsd && rangeHiUsd > 0)) {
    const last = !chartLoading && candles.length > 0 ? candles[candles.length - 1] : null
    if (last && candleToUsd > 0 && last.high > last.low) {
      rangeHiUsd = last.high * candleToUsd
      rangeLoUsd = last.low  * candleToUsd
      rangeLabel  = chartRange === '1D' ? '24h Range' : `${chartRange} Range`
    }
  }

  // Tier C: estimate from % change — always available
  if (!(rangeHiUsd > rangeLoUsd && rangeHiUsd > 0) && Math.abs(token.change24) > 0.01) {
    const open24  = token.usd_price / (1 + token.change24 / 100)
    const rawLo   = Math.min(token.usd_price, open24)
    const rawHi   = Math.max(token.usd_price, open24)
    const pad     = (rawHi - rawLo) * 0.15   // keeps marker off the extreme edges
    rangeHiUsd = rawHi + pad
    rangeLoUsd = Math.max(0, rawLo - pad)
    rangeLabel  = '24h Range'
  }

  const showRange = rangeHiUsd > rangeLoUsd && rangeHiUsd > 0

  // Volume trend: today vs 7D daily average
  const volTrendPct = token.volume7dusd && token.volume7dusd > 0
    ? (token.volume24usd - token.volume7dusd / 7) / (token.volume7dusd / 7) * 100
    : null

  // Bid/ask spread
  const spreadPct = bidUsd > 0 && askUsd > 0
    ? (askUsd - bidUsd) / bidUsd * 100
    : null
  const RANGES: ChartRange[] = ['1m', '5m', '15m', '30m', '1H', '4H', '1D', '1W', '1M']

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center sm:p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-5xl rounded-t-2xl sm:rounded-2xl overflow-y-auto sm:overflow-hidden flex flex-col sm:flex-row shadow-2xl border border-white/[0.07]"
        style={{ maxHeight: '92vh', background: '#0a0f14' }}>


        {/* ── Left panel ─────────────────────────────────────────────────── */}
        <div className="w-full sm:w-64 shrink-0 flex flex-col border-b sm:border-b-0 sm:border-r border-white/[0.06]" style={{ background: '#0c1218' }}>
          <div className="p-4 pb-3 border-b border-white/[0.06]">
            <div className="flex items-center gap-2.5 mb-3">
              {!logoError ? (
                <img src={token.logoUrl} alt={token.symbol}
                  className="w-9 h-9 rounded-full bg-white/10 object-contain shrink-0"
                  onError={() => setLogoError(true)} />
              ) : (
                <div className="w-9 h-9 rounded-full flex items-center justify-center text-white font-bold text-sm shrink-0"
                  style={{ background: ringCol }}>{token.symbol.slice(0, 2)}</div>
              )}
              <div className="min-w-0">
                <div className="text-white font-bold text-base leading-none">{token.symbol}</div>
                <div className="text-gray-600 text-[10px] truncate mt-0.5">{token.contract}</div>
              </div>
            </div>
            <div className="flex items-baseline justify-between">
              <PriceDisplay price={token.usd_price} />
              <span className="text-xs font-bold px-1.5 py-0.5 rounded" style={{
                color:      token.change24 >= 0 ? '#00cc44' : '#cc1122',
                background: token.change24 >= 0 ? 'rgba(0,200,68,0.12)' : 'rgba(200,17,34,0.12)',
              }}>{formatChange(token.change24)}</span>
            </div>
            <div className="text-gray-600 text-[10px] mt-0.5">
              {token.system_price.toFixed(8)} {chain.systemToken}
            </div>
          </div>

          {/* Performance pills — fixed meaningful windows */}
          <div className="p-4 pb-3 border-b border-white/[0.06]">
            <div className="text-[9px] text-gray-600 uppercase tracking-widest mb-2 font-semibold">Performance</div>
            <div className="grid grid-cols-5 gap-1">
              {PERF_RANGES.map(r => <PerfPill key={r} label={r} change={perfs[r]} />)}
            </div>
          </div>

          {/* Coin details */}
          <div className="p-4 sm:flex-1 sm:overflow-y-auto">
            <div className="text-[9px] text-gray-600 uppercase tracking-widest mb-2 font-semibold">Coin Details</div>

            {/* Rank */}
            {token.rank && (
              <StatRow
                label="Rank" value={`#${token.rank}`}
                badge={token.rankChange !== undefined && token.rankChange !== 0 ? (
                  <span className={`text-[9px] font-bold tabular-nums leading-none
                    ${token.rankChange > 0 ? 'text-green-500' : 'text-red-400'}`}>
                    {token.rankChange > 0 ? '↑' : '↓'}{Math.abs(token.rankChange)}
                  </span>
                ) : token.rankChange === 0 ? (
                  <span className="text-[9px] text-gray-700 leading-none">—</span>
                ) : undefined}
              />
            )}

            {/* Market Cap */}
            {token.marketCapUsd && <StatRow label="Market Cap" value={formatVolume(token.marketCapUsd)} />}

            {/* Fully Diluted Valuation — for EOSIO tokens issued supply = total supply */}
            {token.marketCapUsd && <StatRow label="Fully Diluted Val." value={formatVolume(token.marketCapUsd)} />}

            {/* Circulating Supply */}
            {token.supply != null && token.supply > 0 && (
              <div className="flex items-center justify-between py-1.5 border-b border-white/[0.04]">
                <span className="text-[11px] text-gray-500">Circulating Supply</span>
                <span className="flex items-center gap-1.5 text-right">
                  <span className="text-[11px] text-gray-200 font-medium tabular-nums">
                    {Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(token.supply)}{' '}
                    <span className="text-gray-500">{token.symbol}</span>
                  </span>
                  <span className="text-[9px] px-1 py-0.5 rounded bg-green-500/15 text-green-400 font-semibold shrink-0">
                    100%
                  </span>
                </span>
              </div>
            )}

            {/* Total Supply */}
            {token.supply != null && token.supply > 0 && (
              <StatRow
                label="Total Supply"
                value={`${Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(token.supply)} ${token.symbol}`}
              />
            )}

            {/* Volume 24h */}
            <StatRow
              label="Volume 24h" value={formatVolume(token.volume24usd)}
              badge={volTrendPct !== null ? (
                <span className={`text-[9px] font-semibold leading-none
                  ${volTrendPct >= 0 ? 'text-green-500' : 'text-red-400'}`}>
                  {volTrendPct >= 0 ? '↑' : '↓'}{Math.min(9999, Math.abs(volTrendPct)).toFixed(0)}%
                </span>
              ) : undefined}
            />

            {token.tvlUsd && (
              <StatRow label="TVL" value={formatVolume(token.tvlUsd)}
                badge={<ChangeBadge pct={token.tvlChange24h} />}
              />
            )}
            {token.volume7dusd && (
              <StatRow label="Volume 7D" value={formatVolume(token.volume7dusd)}
                badge={<ChangeBadge pct={token.vol7dChange} />}
              />
            )}
            {token.volume30dusd && (
              <StatRow label="Volume 30D" value={formatVolume(token.volume30dusd)}
                badge={<ChangeBadge pct={token.vol30dChange} />}
              />
            )}

            {showRange && (
              <RangeBar lo={rangeLoUsd} hi={rangeHiUsd} current={token.usd_price} label={rangeLabel} />
            )}

            {(bidUsd > 0 || askUsd > 0) && (
              <div className="py-1.5 border-b border-white/[0.04]">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-gray-500">Bid / Ask</span>
                  <span className="flex items-center gap-1 text-[11px] font-medium tabular-nums">
                    <PriceDisplay price={bidUsd} className="text-[11px] font-medium tabular-nums" />
                    <span className="text-gray-600">/</span>
                    <PriceDisplay price={askUsd} className="text-[11px] font-medium tabular-nums" />
                  </span>
                </div>
                {spreadPct !== null && spreadPct > 0 && (
                  <div className="flex justify-end mt-0.5">
                    <span className="text-[9px] text-gray-600">
                      {spreadPct < 10 ? spreadPct.toFixed(1) : spreadPct.toFixed(0)}% spread
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Contract */}
            <div className="py-2 border-b border-white/[0.04] last:border-0">
              <div className="text-[10px] text-gray-600 uppercase tracking-widest mb-1.5 font-semibold">Contract</div>
              <div className="flex items-center justify-between gap-2">
                {/* Chain badge */}
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.06] border border-white/[0.08] text-gray-400 font-semibold shrink-0">
                  {chain.displayName}
                </span>
                {/* Contract address — links to explorer */}
                <a
                  href={`${chain.explorerBase}/account/${token.contract}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-[#f89422] hover:underline font-mono truncate"
                  title={token.contract}
                >
                  {token.contract}
                </a>
                {/* Copy button */}
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(token.contract).then(() => {
                      setContractCopied(true)
                      setTimeout(() => setContractCopied(false), 1500)
                    })
                  }}
                  title="Copy contract address"
                  className="shrink-0 w-6 h-6 flex items-center justify-center rounded bg-white/[0.05] hover:bg-white/[0.12] transition-colors"
                >
                  {contractCopied ? (
                    <svg className="w-3 h-3 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    <svg className="w-3 h-3 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="p-4 flex flex-col gap-2 border-t border-white/[0.06]">
            {alcorUrl && (
              <a href={alcorUrl} target="_blank" rel="noopener noreferrer"
                className="w-full text-center py-2 rounded-xl bg-[#f89422] hover:bg-[#e07d10] text-white font-semibold text-[13px] transition-colors">
                {token.ticker_id ? 'Trade on Alcor ↗' : 'View Pool ↗'}
              </a>
            )}
            <a href={explorerUrl} target="_blank" rel="noopener noreferrer"
              className="w-full text-center py-2 rounded-xl bg-white/[0.07] hover:bg-white/[0.12] text-gray-400 hover:text-white font-medium text-[13px] transition-colors border border-white/[0.08]">
              Explorer ↗
            </a>
          </div>
        </div>

        {/* ── Right panel ────────────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col min-w-0">

          {/* ── Toolbar row 1: chart-type controls + close button ───────── */}
          <div className="flex items-center gap-2 px-4 pt-2.5 pb-2 border-b border-white/[0.03]">

            {/* Line / Candles / Depth */}
            <div className="flex items-center bg-white/[0.05] rounded-lg p-0.5 gap-0.5">
              {(['line', 'candles'] as ChartView[]).map(v => (
                <button key={v} onClick={() => setChartView(v)}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold transition-all ${
                    chartView === v ? 'bg-white/[0.12] text-white' : 'text-gray-600 hover:text-gray-300'
                  }`}>
                  {v === 'line'
                    ? <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4" /></svg>
                    : <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="4" y="6" width="4" height="10" rx="0.5" strokeWidth={1.5}/><rect x="16" y="9" width="4" height="7" rx="0.5" strokeWidth={1.5}/><line x1="6" y1="3" x2="6" y2="6" strokeWidth={1.5} strokeLinecap="round"/><line x1="6" y1="16" x2="6" y2="19" strokeWidth={1.5} strokeLinecap="round"/><line x1="18" y1="6" x2="18" y2="9" strokeWidth={1.5} strokeLinecap="round"/><line x1="18" y1="16" x2="18" y2="19" strokeWidth={1.5} strokeLinecap="round"/></svg>
                  }
                  {v === 'line' ? 'Line' : 'Candles'}
                </button>
              ))}
              {hasLP && (
                <button onClick={() => setChartView('depth')}
                  title="Liquidity Depth — shows where LP positions are concentrated across price levels"
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold transition-all ${
                    chartView === 'depth' ? 'bg-white/[0.12] text-white' : 'text-gray-600 hover:text-gray-300'
                  }`}>
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <line x1="4" y1="6"  x2="20" y2="6"  strokeWidth={2} strokeLinecap="round"/>
                    <line x1="4" y1="10" x2="16" y2="10" strokeWidth={2} strokeLinecap="round"/>
                    <line x1="4" y1="14" x2="20" y2="14" strokeWidth={2} strokeLinecap="round"/>
                    <line x1="4" y1="18" x2="12" y2="18" strokeWidth={2} strokeLinecap="round"/>
                  </svg>
                  Depth
                </button>
              )}
            </div>

            {/* Spot / LP source toggle */}
            {hasSpot && hasLP && (
              <div className="flex items-center bg-white/[0.05] rounded-lg p-0.5 gap-0.5">
                <button onClick={() => setChartSource('spot')}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-all uppercase ${
                    chartSource === 'spot' ? 'bg-white/[0.12] text-white' : 'text-gray-600 hover:text-gray-300'
                  }`}>Spot</button>
                <button onClick={() => setChartSource('lp')}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-all uppercase ${
                    chartSource === 'lp' ? 'bg-white/[0.12] text-white' : 'text-gray-600 hover:text-gray-300'
                  }`}>LP</button>
              </div>
            )}

            {/* LP pool selector — custom table dropdown (multiple pools) or static badge (1 pool) */}
            {(chartSource === 'lp' || (!hasSpot && hasLP)) && (
              pools.length > 1 ? (
                <PoolSelector
                  pools={pools}
                  selected={selectedPool}
                  tokenSymbol={token.symbol}
                  tokenLogoUrl={token.logoUrl}
                  chain={chain}
                  onSelect={setSelectedPool}
                />
              ) : selectedPool ? (
                <span className="flex items-center gap-1.5 text-[11px] font-semibold px-2 py-1 rounded-lg bg-white/[0.05] border border-white/[0.08]">
                  <PoolLogo src={token.logoUrl} symbol={token.symbol} size={14} />
                  <span className="text-white">{token.symbol}</span>
                  <span className="text-gray-600">/</span>
                  <PoolLogo src={`/api/logo?id=${encodeURIComponent(selectedPool.counterpartId)}&chain=${chain.id}`} symbol={selectedPool.counterpartSymbol} size={14} />
                  <span className="text-gray-300">{selectedPool.counterpartSymbol}</span>
                </span>
              ) : null
            )}

            {/* Spacer */}
            <div className="flex-1" />

            {/* Close — lives in the toolbar row so it never floats over content */}
            <button onClick={onClose}
              className="w-7 h-7 rounded-full bg-white/[0.07] hover:bg-white/[0.14] flex items-center justify-center text-gray-500 hover:text-white transition-all shrink-0">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* ── Toolbar row 2: timeframe pills (always stable, never wraps) ─ */}
          <div className="flex items-center gap-0 px-3 py-1.5 border-b border-white/[0.06]">
            <div className={`flex items-center bg-white/[0.04] rounded-lg p-0.5 gap-0.5 transition-opacity ${
              chartView === 'depth' ? 'opacity-30 pointer-events-none' : ''
            }`}>
              {RANGES.map(r => (
                <button key={r} onClick={() => setChartRange(r)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-all ${
                    chartRange === r ? 'bg-white/[0.12] text-white' : 'text-gray-600 hover:text-gray-300'
                  }`}>{r}</button>
              ))}
            </div>
          </div>

          {/* Chart body */}
          <div className="flex-1 relative" style={{ minHeight: 300 }}>
            {chartLoading ? (
              <div className="w-full h-full flex items-center justify-center gap-1.5">
                {[0,1,2].map(i => (
                  <div key={i} className="w-1.5 h-1.5 rounded-full bg-gray-700 animate-pulse"
                    style={{ animationDelay: `${i*150}ms` }} />
                ))}
              </div>
            ) : candles.length < 2 ? (
              <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 text-gray-700">
                <svg className="w-8 h-8 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
                </svg>
                <span className="text-[13px]">No chart data</span>
              </div>
            ) : chartView === 'depth' && selectedPool ? (
              <div className="absolute inset-0 p-3">
                <ErrorBoundary name="LiquidityDepth">
                  <LiquidityDepth
                    poolId={selectedPool.id}
                    chain={chain.id}
                    reversed={selectedPool.reversed}
                    currentUsdPrice={token.usd_price}
                    tokenSymbol={token.symbol}
                    counterpartSymbol={selectedPool.counterpartSymbol}
                  />
                </ErrorBoundary>
              </div>
            ) : chartView === 'candles' ? (
              <div className="absolute inset-0 p-2">
                <ErrorBoundary name="TradingChart">
                  <TradingChart
                    candles={candles}
                    isPositive={isPositive}
                    initialCandles={INITIAL_CANDLES[chartRange]}
                  />
                </ErrorBoundary>
              </div>
            ) : (
              <div className="absolute inset-0 p-4 pb-2">
                <PriceSparkline candles={candles} isPositive={isPositive} chartRange={chartRange} />
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-5 py-2.5 border-t border-white/[0.06] flex items-center justify-between">
            <span className="text-[10px] text-gray-700">
              {chartView === 'depth'
                ? 'liquidity distribution · current snapshot · '
                : chartView === 'candles'
                ? `${chartRange} candles · full history · `
                : `${chartRange} window · `}
              <a href="https://alcor.exchange" target="_blank" rel="noopener noreferrer"
                className="text-[#f89422] hover:underline">Alcor Exchange</a>
            </span>
            {alcorUrl && (
              <a href={alcorUrl} target="_blank" rel="noopener noreferrer"
                className="text-[10px] text-[#f89422] hover:underline font-medium">
                Open on Alcor ↗
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
