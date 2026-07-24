'use client'

import { useEffect, useRef, useState } from 'react'
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  IChartApi,
  ISeriesApi,
  HistogramData,
  LineData,
  SeriesType,
  Time,
  type TickMarkFormatter,
} from 'lightweight-charts'
import { formatTokenPrice } from '@/lib/bubbleUtils'

interface Candle {
  time: number; open: number; high: number; low: number; close: number; volume: number
}

interface Props {
  candles:         Candle[]
  isPositive:      boolean
  initialCandles?: number
}

interface Indicators {
  ema9:   boolean
  ema21:  boolean
  ema50:  boolean
  bb:     boolean
  volume: boolean
  rsi:    boolean
  macd:   boolean
}

// ── Indicator math ────────────────────────────────────────────────────────────

function calcEMA(values: number[], period: number): (number | null)[] {
  if (values.length < period) return values.map(() => null)
  const k      = 2 / (period + 1)
  const result = values.map((): null => null) as (number | null)[]
  let ema      = values.slice(0, period).reduce((a, b) => a + b) / period
  result[period - 1] = ema
  for (let i = period; i < values.length; i++) {
    ema       = values[i] * k + ema * (1 - k)
    result[i] = ema
  }
  return result
}

function calcSMA(values: number[], period: number): (number | null)[] {
  return values.map((_, i) => {
    if (i < period - 1) return null
    return values.slice(i - period + 1, i + 1).reduce((a, b) => a + b) / period
  })
}

function calcBB(closes: number[], period = 20, mult = 2) {
  const sma = calcSMA(closes, period)
  return closes.map((_, i) => {
    if (sma[i] === null) return null
    const mean  = sma[i]!
    const slice = closes.slice(i - period + 1, i + 1)
    const std   = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period)
    return { upper: mean + mult * std, middle: mean, lower: mean - mult * std }
  })
}

function calcRSI(closes: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = closes.map(() => null)
  if (closes.length < period + 1) return result
  let avgGain = 0, avgLoss = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]
    if (d > 0) avgGain += d; else avgLoss -= d
  }
  avgGain /= period; avgLoss /= period
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(0, d))  / period
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return result
}

function calcMACD(closes: number[], fast = 12, slow = 26, sig = 9) {
  const fEMA     = calcEMA(closes, fast)
  const sEMA     = calcEMA(closes, slow)
  const macdLine = closes.map((_, i) =>
    fEMA[i] !== null && sEMA[i] !== null ? fEMA[i]! - sEMA[i]! : null
  )
  const startIdx = macdLine.findIndex(v => v !== null)
  const sigResult: (number | null)[] = macdLine.map(() => null)
  if (startIdx >= 0 && macdLine.length - startIdx >= sig) {
    const k    = 2 / (sig + 1)
    const seed = macdLine.slice(startIdx, startIdx + sig).map(v => v ?? 0)
    let sema   = seed.reduce((a, b) => a + b) / sig
    sigResult[startIdx + sig - 1] = sema
    for (let i = startIdx + sig; i < macdLine.length; i++) {
      if (macdLine[i] !== null) { sema = macdLine[i]! * k + sema * (1 - k) }
      sigResult[i] = sema
    }
  }
  return macdLine.map((m, i) => {
    if (m === null) return null
    const s = sigResult[i]
    return { macd: m, signal: s ?? null, histogram: s !== null ? m - s : null }
  })
}

// ── Compact price formatter for legend ───────────────────────────────────────
function fmtLegendPrice(v: number): string {
  if (v === 0) return '0'
  if (Math.abs(v) >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (Math.abs(v) >= 1)    return v.toFixed(4)
  // sub-1: show 4 significant figures
  const exp = Math.floor(Math.log10(Math.abs(v)))
  return v.toFixed(Math.max(0, -exp + 3))
}
function fmtVol(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000)     return `${(v / 1_000).toFixed(2)}K`
  return v.toFixed(4)
}

// ── Component ─────────────────────────────────────────────────────────────────

const UP   = '#00cc44'
const DOWN = '#cc1122'

const formatAxisDate: TickMarkFormatter = (time, _type, locale) => {
  const date = typeof time === 'number'
    ? new Date(time * 1000)
    : typeof time === 'string'
      ? new Date(`${time}T00:00:00Z`)
      : new Date(Date.UTC(time.year, time.month - 1, time.day))
  return date.toLocaleDateString(locale, {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  })
}

const IND_META: { key: keyof Indicators; label: string; color: string; tip: string }[] = [
  { key: 'ema9',   label: 'EMA 9',   color: '#fbbf24', tip: 'EMA 9 — Fast exponential moving average. Tracks short-term momentum; crosses above EMA 21 can signal a buy.' },
  { key: 'ema21',  label: 'EMA 21',  color: '#a78bfa', tip: 'EMA 21 — Medium-term trend line. Price above = bullish bias; below = bearish. Pairs well with EMA 9.' },
  { key: 'ema50',  label: 'EMA 50',  color: '#22d3ee', tip: 'EMA 50 — Slow moving average used as dynamic support/resistance. A common line traders watch for trend confirmation.' },
  { key: 'bb',     label: 'BB 20',   color: '#3b82f6', tip: 'Bollinger Bands (20, 2σ) — Price near the upper band = potentially overbought; near the lower band = potentially oversold. Squeeze = low volatility, often precedes a breakout.' },
  { key: 'volume', label: 'VOL',     color: '#6b7280', tip: 'Volume — Number of tokens traded each candle. High volume confirms a move; low volume moves are less reliable.' },
  { key: 'rsi',    label: 'RSI 14',  color: '#fb923c', tip: 'RSI 14 — Momentum oscillator (0–100). Above 70 = overbought (potential reversal down); below 30 = oversold (potential reversal up).' },
  { key: 'macd',   label: 'MACD',    color: '#60a5fa', tip: 'MACD (12, 26, 9) — Trend + momentum combo. Blue line crossing above yellow = bullish signal. Green histogram bars = momentum building upward; red = downward.' },
]

type DrawMode = 'off' | 'hline'
type ChartSeries = ISeriesApi<SeriesType>
type LineSeriesApi = ISeriesApi<'Line'>
type CandlestickSeriesApi = ISeriesApi<'Candlestick'>

export default function TradingChart({ candles, isPositive, initialCandles = 90 }: Props) {
  const containerRef     = useRef<HTMLDivElement>(null)
  const legendRef        = useRef<HTMLDivElement>(null)
  const chartRef         = useRef<IChartApi | null>(null)
  const candleSeriesRef  = useRef<CandlestickSeriesApi | null>(null)
  const priceLinesRef    = useRef<ReturnType<CandlestickSeriesApi['createPriceLine']>[]>([])
  const drawModeRef      = useRef<DrawMode>('off')

  const [ind, setInd] = useState<Indicators>({
    ema9: false, ema21: true, ema50: false,
    bb: false, volume: true, rsi: false, macd: false,
  })
  const [drawMode,  setDrawMode]  = useState<DrawMode>('off')
  const [lineCount, setLineCount] = useState(0)

  const toggle = (key: keyof Indicators) => setInd(p => ({ ...p, [key]: !p[key] }))

  const toggleDrawMode = (mode: DrawMode) => {
    const next: DrawMode = drawMode === mode ? 'off' : mode
    setDrawMode(next)
    drawModeRef.current = next
  }

  const clearLines = () => {
    const series = candleSeriesRef.current
    if (!series) return
    for (const line of priceLinesRef.current) {
      try { series.removePriceLine(line) } catch {}
    }
    priceLinesRef.current = []
    setLineCount(0)
  }

  useEffect(() => {
    const el = containerRef.current
    if (!el || candles.length < 2) return

    const chart = createChart(el, {
      width:  el.clientWidth,
      height: el.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor:  '#6b7280',
        fontSize:   11,
      },
      localization: { priceFormatter: formatTokenPrice },
      grid: {
        vertLines: { color: '#ffffff07', style: LineStyle.Dashed },
        horzLines: { color: '#ffffff07', style: LineStyle.Dashed },
      },
      crosshair: {
        mode:     CrosshairMode.Normal,
        vertLine: { color: '#ffffff22', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#1a2535' },
        horzLine: { color: '#ffffff22', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#1a2535' },
      },
      rightPriceScale: { visible: true, borderColor: '#ffffff0a' },
      timeScale: {
        borderColor: '#ffffff0a', timeVisible: true, secondsVisible: false,
        tickMarkFormatter: formatAxisDate,
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale:  { mouseWheel: true, pinch: true },
    })

    const sec    = candles.map(c => Math.floor(c.time / 1000))
    const closes = candles.map(c => c.close)
    // Volume lookup by Unix-second timestamp (candleSeries data omits volume field)
    const volByTime = new Map(candles.map(c => [Math.floor(c.time / 1000), c.volume]))

    // ── Pane 0: price ──────────────────────────────────────────────────────
    // Tracked series → legend key+color (used by crosshairMove to show live values)
    type SeriesEntry = { label: string; color: string; role: 'ohlc' | 'line' | 'bb' | 'vol' | 'rsi' | 'macd' | 'macdSig' }
    const tracked = new Map<ChartSeries, SeriesEntry>()

    // Bollinger Bands
    let bbUpper: LineSeriesApi | null = null
    let bbMid:   LineSeriesApi | null = null
    let bbLower: LineSeriesApi | null = null
    if (ind.bb) {
      const bb = calcBB(closes)
      const toLine = (getter: (b: NonNullable<ReturnType<typeof calcBB>[0]>) => number) =>
        bb.flatMap((b, i): LineData<Time>[] => b ? [{ time: sec[i] as Time, value: getter(b) }] : [])
      const bbOpts = { lineWidth: 1 as const, priceLineVisible: false, lastValueVisible: false }
      bbUpper = chart.addSeries(LineSeries, { ...bbOpts, color: '#3b82f650' }, 0)
      bbMid   = chart.addSeries(LineSeries, { ...bbOpts, color: '#3b82f670', lineStyle: LineStyle.Dashed }, 0)
      bbLower = chart.addSeries(LineSeries, { ...bbOpts, color: '#3b82f650' }, 0)
      bbUpper.setData(toLine(b => b.upper))
      bbMid.setData(toLine(b => b.middle))
      bbLower.setData(toLine(b => b.lower))
      tracked.set(bbUpper, { label: 'BB Upper', color: '#3b82f6', role: 'bb' })
      tracked.set(bbMid,   { label: 'BB Mid',   color: '#3b82f6', role: 'bb' })
      tracked.set(bbLower, { label: 'BB Lower', color: '#3b82f6', role: 'bb' })
    }

    // EMAs
    const emaConfigs: [boolean, number, string, string][] = [
      [ind.ema9,  9,  '#fbbf24', 'EMA 9'],
      [ind.ema21, 21, '#a78bfa', 'EMA 21'],
      [ind.ema50, 50, '#22d3ee', 'EMA 50'],
    ]
    for (const [active, period, col, label] of emaConfigs) {
      if (!active) continue
      const vals = calcEMA(closes, period)
      const data = vals.flatMap((v, i): LineData<Time>[] => v !== null ? [{ time: sec[i] as Time, value: v }] : [])
      const s = chart.addSeries(LineSeries, { color: col, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, 0)
      s.setData(data)
      tracked.set(s, { label, color: col, role: 'line' })
    }

    // Candles (added after EMAs/BB so they render on top)
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN,
      priceFormat: { type: 'custom', formatter: formatTokenPrice, minMove: 1e-18 },
    }, 0)
    candleSeries.setData(candles.map(c => ({
      time: Math.floor(c.time / 1000) as Time,
      open: c.open, high: c.high, low: c.low, close: c.close,
    })))
    tracked.set(candleSeries, { label: 'OHLC', color: '', role: 'ohlc' })
    candleSeriesRef.current = candleSeries

    // ── Horizontal-line drawing tool ───────────────────────────────────────
    chart.subscribeClick(params => {
      if (drawModeRef.current !== 'hline') return
      if (!params.point) return
      const price = candleSeries.coordinateToPrice(params.point.y)
      if (price === null || price === undefined) return
      const line = candleSeries.createPriceLine({
        price:              price as number,
        color:              '#f8942299',
        lineWidth:          1,
        lineStyle:          LineStyle.Dashed,
        axisLabelVisible:   true,
        title:              '',
      })
      priceLinesRef.current.push(line)
      setLineCount(c => c + 1)
    })

    // ── Sub-panes ──────────────────────────────────────────────────────────
    let paneIdx = 0
    let volSeries: ISeriesApi<'Histogram'> | null = null
    let rsiSeries: LineSeriesApi | null = null
    let macdLine:  LineSeriesApi | null = null
    let macdSig:   LineSeriesApi | null = null

    if (ind.volume) {
      paneIdx++
      chart.addPane()
      volSeries = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false,
      }, paneIdx)
      volSeries.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0 } })
      volSeries.setData(candles.map(c => ({
        time: Math.floor(c.time / 1000) as Time, value: c.volume,
        color: c.close >= c.open ? UP + '88' : DOWN + '88',
      })))
      tracked.set(volSeries, { label: 'Vol', color: '#6b7280', role: 'vol' })
    }

    if (ind.rsi) {
      paneIdx++
      chart.addPane()
      const rsiVals = calcRSI(closes)
      const rsiData = rsiVals.flatMap((v, i): LineData<Time>[] => v !== null ? [{ time: sec[i] as Time, value: v }] : [])
      rsiSeries = chart.addSeries(LineSeries, {
        color: '#fb923c', lineWidth: 2, priceLineVisible: false, lastValueVisible: true,
      }, paneIdx)
      rsiSeries.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } })
      rsiSeries.setData(rsiData)
      rsiSeries.createPriceLine({ price: 70, color: DOWN + '70', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true,  title: 'OB 70' })
      rsiSeries.createPriceLine({ price: 50, color: '#ffffff18', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' })
      rsiSeries.createPriceLine({ price: 30, color: UP   + '70', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true,  title: 'OS 30' })
      tracked.set(rsiSeries, { label: 'RSI', color: '#fb923c', role: 'rsi' })
    }

    if (ind.macd) {
      paneIdx++
      chart.addPane()
      const macdData = calcMACD(closes)
      const mLine = macdData.flatMap((d, i): LineData<Time>[] => d?.macd !== null && d ? [{ time: sec[i] as Time, value: d.macd! }] : [])
      const sLine = macdData.flatMap((d, i): LineData<Time>[] => d?.signal !== null && d ? [{ time: sec[i] as Time, value: d.signal! }] : [])
      const hist = macdData.flatMap((d, i): HistogramData<Time>[] => d?.histogram !== null && d
        ? [{ time: sec[i] as Time, value: d.histogram!, color: d.histogram! >= 0 ? UP + '99' : DOWN + '99' }]
        : [])

      macdLine = chart.addSeries(LineSeries, { color: '#60a5fa', lineWidth: 2, priceLineVisible: false, lastValueVisible: false }, paneIdx)
      macdLine.priceScale().applyOptions({ scaleMargins: { top: 0.15, bottom: 0.15 } })
      macdLine.setData(mLine)
      macdSig = chart.addSeries(LineSeries, { color: '#fbbf24', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, paneIdx)
      macdSig.setData(sLine)
      chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, paneIdx).setData(hist)
      tracked.set(macdLine, { label: 'MACD',   color: '#60a5fa', role: 'macd' })
      tracked.set(macdSig,  { label: 'Signal', color: '#fbbf24', role: 'macdSig' })
    }

    // ── Visible range ─────────────────────────────────────────────────────
    if (candles.length > initialCandles) {
      const last  = Math.floor(candles[candles.length - 1].time               / 1000)
      const first = Math.floor(candles[candles.length - initialCandles].time  / 1000)
      chart.timeScale().setVisibleRange({ from: first as Time, to: last as Time })
    } else {
      chart.timeScale().fitContent()
    }

    // ── Crosshair legend (direct DOM — avoids React re-renders on every pixel) ──
    chart.subscribeCrosshairMove(params => {
      const legend = legendRef.current
      if (!legend) return

      if (!params.time || !params.point) {
        legend.style.display = 'none'
        return
      }

      // Resolve OHLCV from candle series
      const ohlcData = params.seriesData.get(candleSeries)
      if (!ohlcData || !('open' in ohlcData)) { legend.style.display = 'none'; return }

      const tSec = Number(params.time)
      const d    = new Date(tSec * 1000)
      const timeStr = d.toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
      })

      const isUp = ohlcData.close >= ohlcData.open
      const clr  = isUp ? UP : DOWN
      // Look up volume from raw candle data (candleSeries data doesn't carry the volume field)
      const vol  = volByTime.get(tSec) ?? 0

      // Build HTML — keeping it raw for performance (no React re-render)
      let html = `
        <div style="color:#9ca3af;font-size:9px;margin-bottom:3px">${timeStr}</div>
        <div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-bottom:4px">
          <span style="color:#6b7280;font-size:9px">O</span><span style="color:${clr};font-size:10px;font-weight:600">${fmtLegendPrice(ohlcData.open)}</span>
          <span style="color:#6b7280;font-size:9px">H</span><span style="color:${UP};font-size:10px;font-weight:600">${fmtLegendPrice(ohlcData.high)}</span>
          <span style="color:#6b7280;font-size:9px">L</span><span style="color:${DOWN};font-size:10px;font-weight:600">${fmtLegendPrice(ohlcData.low)}</span>
          <span style="color:#6b7280;font-size:9px">C</span><span style="color:${clr};font-size:10px;font-weight:700">${fmtLegendPrice(ohlcData.close)}</span>
          ${vol > 0 ? `<span style="color:#6b7280;font-size:9px">V</span><span style="color:#9ca3af;font-size:10px">${fmtVol(vol)}</span>` : ''}
        </div>`

      // Indicator values row
      const indParts: string[] = []
      for (const [series, meta] of tracked) {
        if (meta.role === 'ohlc') continue
        const d2 = params.seriesData.get(series)
        if (!d2 || !('value' in d2) || d2.value == null) continue
        const v = d2.value
        const valStr = meta.role === 'vol'   ? fmtVol(v)
                     : meta.role === 'rsi'   ? v.toFixed(1)
                     : fmtLegendPrice(v)
        indParts.push(
          `<span style="display:inline-flex;align-items:center;gap:3px">` +
          `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${meta.color};flex-shrink:0"></span>` +
          `<span style="color:#6b7280;font-size:9px">${meta.label}</span>` +
          `<span style="color:${meta.color};font-size:10px;font-weight:600">${valStr}</span>` +
          `</span>`
        )
      }

      if (indParts.length > 0) {
        html += `<div style="display:flex;gap:8px;flex-wrap:wrap">${indParts.join('')}</div>`
      }

      legend.innerHTML = html
      legend.style.display = 'block'
    })

    chartRef.current = chart

    const ro = new ResizeObserver(() => {
      if (containerRef.current && chartRef.current)
        chartRef.current.resize(containerRef.current.clientWidth, containerRef.current.clientHeight)
    })
    ro.observe(el)

    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current        = null
      candleSeriesRef.current = null
      priceLinesRef.current   = []
      if (legendRef.current) legendRef.current.style.display = 'none'
    }
  }, [candles, isPositive, initialCandles, ind])

  return (
    <div className="flex flex-col w-full h-full gap-1.5">
      {/* Indicator + drawing tool toggles */}
      <div className="flex items-center gap-1 flex-wrap shrink-0 px-1">
        {IND_META.map(({ key, label, color, tip }) => {
          const on = ind[key]
          return (
            <button key={key} onClick={() => toggle(key)} title={tip}
              className="flex items-center gap-1 px-2 py-0.5 rounded border text-[9px] font-semibold uppercase tracking-wide transition-all"
              style={{
                borderColor: on ? color + '55' : '#ffffff12',
                background:  on ? color + '18' : 'transparent',
                color:       on ? color : '#4b5563',
              }}
            >
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: on ? color : '#374151' }} />
              {label}
            </button>
          )
        })}

        {/* Divider */}
        <span className="h-3 w-px bg-white/[0.08] mx-0.5 shrink-0" />

        {/* Horizontal line drawing tool */}
        <button
          onClick={() => toggleDrawMode('hline')}
          title="Horizontal line — click anywhere on the chart to draw a price level"
          className="flex items-center gap-1 px-2 py-0.5 rounded border text-[9px] font-semibold uppercase tracking-wide transition-all"
          style={{
            borderColor: drawMode === 'hline' ? '#f8942255' : '#ffffff12',
            background:  drawMode === 'hline' ? '#f8942218' : 'transparent',
            color:       drawMode === 'hline' ? '#f89422'   : '#4b5563',
          }}
        >
          {/* horizontal line icon */}
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="shrink-0">
            <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 1.5"/>
            <circle cx="5" cy="5" r="1.5" fill="currentColor"/>
          </svg>
          H-Line
        </button>

        {/* Clear lines button — only shown when lines exist */}
        {lineCount > 0 && (
          <button
            onClick={clearLines}
            title="Clear all drawn lines"
            className="flex items-center gap-1 px-2 py-0.5 rounded border text-[9px] font-semibold uppercase tracking-wide transition-all border-white/[0.08] text-gray-600 hover:text-red-400 hover:border-red-500/30"
          >
            <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className="shrink-0">
              <line x1="1" y1="1" x2="7" y2="7" stroke="currentColor" strokeWidth="1.5"/>
              <line x1="7" y1="1" x2="1" y2="7" stroke="currentColor" strokeWidth="1.5"/>
            </svg>
            Clear ({lineCount})
          </button>
        )}
      </div>

      {/* Chart + crosshair legend overlay */}
      <div className="flex-1 min-h-0 relative">
        <div
          ref={containerRef}
          className="w-full h-full"
          style={{ cursor: drawMode === 'hline' ? 'crosshair' : 'default' }}
        />
        {/* Legend — positioned top-left, updated via direct DOM for zero-lag crosshair */}
        <div
          ref={legendRef}
          style={{
            display: 'none',
            position: 'absolute',
            top: 4, left: 4,
            zIndex: 10,
            pointerEvents: 'none',
            userSelect: 'none',
            padding: '6px 10px',
            borderRadius: 8,
            lineHeight: 1.4,
            background: 'rgba(10,15,20,0.88)',
            backdropFilter: 'blur(4px)',
            border: '1px solid rgba(255,255,255,0.07)',
            fontFamily: 'ui-monospace, monospace',
          }}
        />
      </div>
    </div>
  )
}
