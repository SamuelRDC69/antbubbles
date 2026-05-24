'use client'

import { useEffect, useRef, useCallback, useState } from 'react'
import { forceSimulation } from 'd3-force'
import type { Simulation } from 'd3-force'
import { TokenBubbleData, DisplayMode } from '@/lib/types'
import {
  computeRadii,
  bubbleFillColorForMode,
  ringColorForMode,
  metricTextColor,
  formatMetricValue,
  formatPrice,
  formatPriceParts,
  formatChange,
  changeTextColor,
} from '@/lib/bubbleUtils'

interface Props {
  tokens:         TokenBubbleData[]
  displayMode:    DisplayMode
  searchQuery:    string
  onSelectToken:  (token: TokenBubbleData) => void
  onHoverToken?:  (token: TokenBubbleData | null) => void
  onReady?:       () => void
}

interface SimNode extends TokenBubbleData {
  x:            number
  y:            number
  vx:           number
  vy:           number
  fx:           number | null
  fy:           number | null
  radius:       number
  targetRadius: number
  // Per-bubble drift direction (radians) — held for ~100 ticks, then randomly reset
  _direction?:  number
  isColliding?: boolean
}

interface TooltipState {
  x: number
  y: number
  token: SimNode
}

// ── Image loader ──────────────────────────────────────────────────────────────
// Logos are served by our own /api/logo proxy (cached 24h) so all requests
// can fire in parallel — no stagger needed.
const imageCache = new Map<string, HTMLImageElement | null>()

function loadImage(url: string): Promise<HTMLImageElement | null> {
  if (imageCache.has(url)) return Promise.resolve(imageCache.get(url)!)
  return new Promise(resolve => {
    const img = new Image()
    img.onload  = () => { imageCache.set(url, img);  resolve(img)  }
    img.onerror = () => { imageCache.set(url, null); resolve(null) }
    img.src = url
  })
}

// ── Offscreen-canvas helpers ──────────────────────────────────────────────────
// Matches banterbubbles.com exactly: each bubble is pre-rendered into a small
// dedicated canvas (2·radius+6 px², centred at integer (radius+3, radius+3)),
// then composited onto the main canvas with ctx.drawImage at the float position.
//
// Why this eliminates jitter:
//   Old approach — fillText called on main canvas at float coordinates every
//   frame → browser re-rasterises each glyph at a slightly different sub-pixel
//   offset → anti-aliasing pattern changes frame-to-frame → shimmering jitter.
//
//   New approach — text/logos are rendered once into the offscreen canvas at an
//   integer physical-pixel centre; only regenerated when radius or visible data
//   changes. drawImage composites the bitmap at the float position via bilinear
//   interpolation — the whole image shifts as a unit, no per-glyph rasterisation.

type BubbleCanvasEntry = { key: string; canvas: HTMLCanvasElement }

// Paint bubble content into a ctx whose origin is already at the bubble centre.
// Radius is always integer here (the offscreen canvas is sized to match it).
//
// Mobile tier thresholds are much lower because on mobile scaledMax ≈ 29 px —
// every bubble would fall in the logo-only tier with desktop thresholds.
// Banterbubbles handles this the same way: on isMobileWeb they always render
// text regardless of radius, then shrink the font to fit.
function paintBubbleContent(
  ctx:         CanvasRenderingContext2D,
  node:        SimNode,
  img:         HTMLImageElement | null | undefined,
  displayMode: DisplayMode,
  isMobile:    boolean,
) {
  const { symbol, radius: r } = node   // r is always integer
  const fill = bubbleFillColorForMode(node, displayMode)
  const ring = ringColorForMode(node, displayMode)

  // Responsive tier thresholds
  // Desktop: plenty of space — reserve logo-only tier for mid-size bubbles.
  // Mobile:  max radius ≈ 29 px, so drop thresholds so text shows on all but tiny bubbles.
  const TIER_TINY  = isMobile ? 10 : 16   // below → logo / 2-char abbrev only
  const TIER_SMALL = isMobile ? 16 : 30   // below → logo only (symbol fallback if no logo)
  const TIER_VALUE = isMobile ? 22 : 40   // at/above → show metric value

  // Background: dark fill → ring colour at edge
  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, r)
  grad.addColorStop(0,    fill)
  grad.addColorStop(0.82, fill)
  grad.addColorStop(1.0,  ring)
  ctx.beginPath()
  ctx.arc(0, 0, r, 0, Math.PI * 2)
  ctx.fillStyle = grad
  ctx.fill()

  // Content clipped to inner 88% so the rim stays visible
  ctx.save()
  ctx.beginPath()
  ctx.arc(0, 0, r * 0.88, 0, Math.PI * 2)
  ctx.clip()

  if (r < TIER_TINY) {
    // Tiny: logo or 2-char abbrev
    if (img) {
      const s = Math.round(r * 1.1)
      ctx.drawImage(img, -(s >> 1), -(s >> 1), s, s)
    } else {
      ctx.font         = `700 ${Math.max(6, Math.round(r * 0.55))}px Inter, system-ui, sans-serif`
      ctx.fillStyle    = '#ffffff'
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(symbol.slice(0, 2), 0, 0)
    }
  } else if (r <= TIER_SMALL) {
    // Small: logo only — symbol name fallback if no logo
    if (img) {
      const s = Math.round(r * 1.1)
      ctx.drawImage(img, -(s >> 1), -(s >> 1), s, s)
    } else {
      ctx.font         = `700 ${Math.round(Math.max(7, r * 0.38))}px Inter, system-ui, sans-serif`
      ctx.fillStyle    = '#ffffff'
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(symbol.length > 5 ? symbol.slice(0, 4) + '…' : symbol, 0, 0)
    }
  } else {
    // Full: logo (if space) + symbol + metric value
    const symFontSize = Math.round(Math.max(9,  Math.min(r * 0.32, 40)))
    const valFontSize = Math.round(Math.max(7,  Math.min(r * 0.20, 18)))
    const logoH       = Math.round(symFontSize * 1.5625)
    // On mobile, only include logo when the bubble is large enough to fit
    // logo + text without crowding. On desktop keep the existing r≥30 threshold.
    const hasLogo     = !!img && r >= (isMobile ? 28 : 30)
    const showValue   = r >= TIER_VALUE
    const gap         = Math.round(symFontSize * 0.12)
    const textH       = symFontSize + (showValue ? gap + valFontSize : 0)
    const totalH      = hasLogo ? logoH + gap + textH : textH
    let   cursorY     = Math.round(-totalH / 2)

    if (hasLogo) {
      ctx.drawImage(img!, -(logoH >> 1), cursorY, logoH, logoH)
      cursorY += logoH + gap
    }

    ctx.font         = `700 ${symFontSize}px Inter, system-ui, sans-serif`
    ctx.fillStyle    = '#ffffff'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText(symbol.length > 7 ? symbol.slice(0, 6) + '…' : symbol, 0, cursorY)
    cursorY += symFontSize + gap

    if (showValue) {
      ctx.globalAlpha  = 0.9
      ctx.font         = `600 ${valFontSize}px Inter, system-ui, sans-serif`
      ctx.fillStyle    = metricTextColor(node, displayMode)
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'top'
      ctx.fillText(formatMetricValue(node, displayMode), 0, cursorY)
    }
  }

  ctx.restore()
}

// Returns a cached offscreen canvas for this bubble, regenerating only when
// radius, fill colour, or the displayed metric value actually changes.
function getOrCreateBubbleCanvas(
  node:        SimNode,
  img:         HTMLImageElement | null | undefined,
  displayMode: DisplayMode,
  dpr:         number,
  isMobile:    boolean,
  cache:       Map<string, BubbleCanvasEntry>,
): HTMLCanvasElement {
  const fill  = bubbleFillColorForMode(node, displayMode)
  const val   = formatMetricValue(node, displayMode)
  const key   = `${node.radius}_${fill}_${val}_${img ? 1 : 0}_${dpr}_${isMobile ? 'm' : 'd'}`

  const entry = cache.get(node.id)
  if (entry && entry.key === key) return entry.canvas

  // (Re)build offscreen canvas — size matches banterbubbles: 2·r + 6 (3px padding each side)
  const r    = node.radius        // integer
  const size = 2 * r + 6
  const oc   = document.createElement('canvas')
  oc.width   = size * dpr
  oc.height  = size * dpr
  const c2   = oc.getContext('2d')!
  c2.scale(dpr, dpr)
  c2.translate(r + 3, r + 3)     // integer centre — text always at integer physical pixels

  paintBubbleContent(c2, node, img, displayMode, isMobile)

  cache.set(node.id, { key, canvas: oc })
  return oc
}

// ── Draw one bubble (composite offscreen canvas + optional hover ring) ────────
function drawBubble(
  ctx:            CanvasRenderingContext2D,
  node:           SimNode,
  img:            HTMLImageElement | null | undefined,
  isHovered:      boolean,
  isDragging:     boolean,
  isDimmed:       boolean,
  displayMode:    DisplayMode,
  offscreenCache: Map<string, BubbleCanvasEntry>,
  dpr:            number,
  isMobile:       boolean,
) {
  const { x = 0, y = 0, radius } = node
  const alpha = isDimmed ? 0.18 : 1

  ctx.save()
  ctx.globalAlpha = alpha

  // Composite the pre-rendered bubble bitmap at the float simulation position.
  // drawImage uses bilinear interpolation so the whole image shifts smoothly —
  // no per-frame glyph rasterisation, no shimmering.
  const bc   = getOrCreateBubbleCanvas(node, img, displayMode, dpr, isMobile, offscreenCache)
  const size = 2 * radius + 6
  ctx.drawImage(bc, x - radius - 3, y - radius - 3, size, size)

  // Hover ring drawn directly on the main canvas — slightly outside the bubble
  if (isHovered && !isDimmed) {
    const drawR = isDragging ? radius : radius * 1.07
    ctx.beginPath()
    ctx.arc(x, y, drawR + 3, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.lineWidth   = 2
    ctx.stroke()
  }

  ctx.restore()
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function BubbleChart({ tokens, displayMode, searchQuery, onSelectToken, onHoverToken, onReady }: Props) {
  const canvasRef    = useRef<HTMLCanvasElement>(null)
  const simRef       = useRef<Simulation<SimNode, undefined> | null>(null)
  const nodesRef     = useRef<SimNode[]>([])
  const rafRef       = useRef<number>(0)
  const imagesRef    = useRef<Map<string, HTMLImageElement | null>>(new Map())
  // Per-bubble offscreen canvas cache — keyed by node.id, invalidated on radius/value change
  const offscreenCacheRef = useRef<Map<string, BubbleCanvasEntry>>(new Map())
  const hoveredRef      = useRef<string | null>(null)
  const dragRef         = useRef<SimNode | null>(null)
  const mouseTargetRef  = useRef<{ x: number; y: number } | null>(null)
  const hasDraggedRef   = useRef(false)
  const dragStartRef    = useRef<{ x: number; y: number } | null>(null)
  const DRAG_THRESHOLD  = 6   // pixels — below this a press+release is treated as a click
  const containerRef  = useRef<HTMLDivElement>(null)
  const dimRef        = useRef({ width: 0, height: 0 })
  const prevDimRef    = useRef({ width: 0, height: 0 })
  const onReadyFiredRef = useRef(false)
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })
  const [tooltip, setTooltip]       = useState<TooltipState | null>(null)

  const tokenIdsRef = useRef<string>('')

  // ── Resize observer ────────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      dimRef.current = { width, height }
      setDimensions({ width, height })
    })
    ro.observe(el)
    const { clientWidth: width, clientHeight: height } = el
    dimRef.current = { width, height }
    setDimensions({ width, height })
    return () => ro.disconnect()
  }, [])

  // ── Logo preload ───────────────────────────────────────────────────────────
  useEffect(() => {
    for (const t of tokens) {
      if (!imagesRef.current.has(t.id)) {
        loadImage(t.logoUrl).then(img => imagesRef.current.set(t.id, img))
      }
    }
  }, [tokens])

  // ── Simulation init / update ───────────────────────────────────────────────
  useEffect(() => {
    if (dimensions.width === 0 || tokens.length === 0) return

    const { width, height } = dimensions
    const radii = computeRadii(tokens, displayMode, width, height)

    const newKey       = tokens.map(t => t.id).sort().join(',')
    const isNewTokenSet = newKey !== tokenIdsRef.current
    tokenIdsRef.current = newKey

    if (isNewTokenSet) {
      // Preserve positions/velocities for tokens already on screen.
      // Only new tokens (e.g. a token that just crossed the quality threshold)
      // get a random starting position. This prevents a full scatter on every
      // 30-second SSE refresh that changes the token set by even one entry.
      const prevPos = new Map(
        (nodesRef.current ?? []).map(n => [n.id, { x: n.x, y: n.y, vx: n.vx, vy: n.vy }])
      )

      const nodes: SimNode[] = tokens.map(t => {
        const p = prevPos.get(t.id)
        const r = radii.get(t.id) ?? 28
        return {
          ...t,
          radius:       p ? (nodesRef.current.find(n => n.id === t.id)?.radius ?? r) : r,
          targetRadius: r,
          x:  p?.x  ?? width  / 2 + (Math.random() - 0.5) * width  * 0.85,
          y:  p?.y  ?? height / 2 + (Math.random() - 0.5) * height * 0.85,
          vx: p?.vx ?? 0,
          vy: p?.vy ?? 0,
          fx: null, fy: null,
        }
      })
      nodesRef.current = nodes
      simRef.current?.stop()

      // velocityDecay: higher on mobile (0.6) to damp oscillation in tight spaces.
      // .stop(): disable D3's internal RAF timer — we tick manually inside our
      // own RAF draw loop so physics and rendering are always in sync (one tick
      // per drawn frame, no stale-position draws or double-tick frames).
      simRef.current = forceSimulation(nodes)
        .alphaDecay(0)
        .alphaTarget(0.3)
        .velocityDecay(0.4)   // D3 default — matches banterbubbles.com exactly
        .force('radiusTween', buildRadiusTweenForce(nodesRef))
        .force('mouseSpring', buildMouseSpringForce(nodesRef, dragRef, mouseTargetRef))
        .force('coin',        buildCoinForce(nodesRef, dragRef, dimRef))
        .stop()  // manual RAF ticking below

      // First ever load has no previous positions — start at high energy so
      // bubbles spread from the centre. All other cases keep current energy.
      const isFirstLoad = !tokens.some(t => prevPos.has(t.id))
      simRef.current.alpha(isFirstLoad ? 1 : 0.3)

    } else {
      // If canvas grew significantly (e.g. window resize), re-scatter nodes into new space
      const prev = prevDimRef.current
      const bigResize = prev.width > 0 && (
        width  / prev.width  > 1.4 || height / prev.height > 1.4 ||
        width  / prev.width  < 0.7 || height / prev.height < 0.7
      )
      if (bigResize) {
        for (const node of nodesRef.current) {
          node.x  = width  / 2 + (Math.random() - 0.5) * width  * 0.6
          node.y  = height / 2 + (Math.random() - 0.5) * height * 0.6
          node.vx = 0; node.vy = 0
        }
        simRef.current?.alpha(1)
      }

      // Data refresh or display mode change: update values in-place
      const dataById = new Map(tokens.map(t => [t.id, t]))

      for (const node of nodesRef.current) {
        const fresh = dataById.get(node.id)
        if (!fresh) continue
        // Update all market data fields
        node.change24     = fresh.change24
        node.usd_price    = fresh.usd_price
        node.system_price = fresh.system_price
        node.volume24usd  = fresh.volume24usd
        node.high24       = fresh.high24
        node.low24        = fresh.low24
        node.bid          = fresh.bid
        node.ask          = fresh.ask
        node.change7d     = fresh.change7d
        node.volume7dusd  = fresh.volume7dusd
        node.volume30dusd = fresh.volume30dusd
        node.tvlUsd       = fresh.tvlUsd
        node.supply       = fresh.supply
        node.marketCapUsd = fresh.marketCapUsd

        const newR = radii.get(node.id) ?? node.radius
        node.targetRadius = newR
      }
    }

    prevDimRef.current = { width, height }
  }, [tokens, displayMode, dimensions])

  // ── Canvas render loop ─────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let running = true
    const { width, height } = dimensions
    const dpr = window.devicePixelRatio || 1

    if (width > 0) {
      canvas.width  = width  * dpr
      canvas.height = height * dpr
      ctx.scale(dpr, dpr)
    }

    const draw = () => {
      if (!running) return
      if (width === 0) { rafRef.current = requestAnimationFrame(draw); return }

      // Advance physics exactly one step per rendered frame.
      // D3's simulation is stopped (.stop() on creation) so it never fires its
      // own RAF callback — this call is the sole tick source. Result: one tick
      // per draw, no stale-position frames, no double-tick frames = smooth motion.
      simRef.current?.tick()

      ctx.fillStyle = '#000000'
      ctx.fillRect(0, 0, width, height)

      const nodes    = nodesRef.current
      const q        = searchQuery.toLowerCase()
      const cache    = offscreenCacheRef.current
      const isMobile = width < 600

      for (const node of nodes) {
        const isHovered  = hoveredRef.current === node.id
        const isDragging = dragRef.current    === node
        const isMatch    = q.length > 1 && node.symbol.toLowerCase().includes(q)
        const isDimmed   = q.length > 1 && !isMatch
        drawBubble(ctx, node, imagesRef.current.get(node.id), isHovered, isDragging, isDimmed, displayMode, cache, dpr, isMobile)
      }

      // Signal skeleton can be hidden after first real frame with nodes
      if (!onReadyFiredRef.current && nodes.length > 0) {
        onReadyFiredRef.current = true
        onReady?.()
      }

      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)
    return () => { running = false; cancelAnimationFrame(rafRef.current) }
  }, [dimensions, searchQuery, displayMode])

  // ── Hit test ───────────────────────────────────────────────────────────────
  const getNodeAt = useCallback((cx: number, cy: number): SimNode | null => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return null
    const x = cx - rect.left
    const y = cy - rect.top
    for (let i = nodesRef.current.length - 1; i >= 0; i--) {
      const n  = nodesRef.current[i]
      const dx = (n.x ?? 0) - x
      const dy = (n.y ?? 0) - y
      if (dx * dx + dy * dy <= n.radius * n.radius) return n
    }
    return null
  }, [])

  // ── Pointer events ─────────────────────────────────────────────────────────
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    const mx   = rect ? e.clientX - rect.left : 0
    const my   = rect ? e.clientY - rect.top  : 0

    if (dragRef.current) {
      mouseTargetRef.current = { x: mx, y: my }
      // Only count as a drag once the pointer has moved beyond the threshold
      if (!hasDraggedRef.current && dragStartRef.current) {
        const dx = mx - dragStartRef.current.x
        const dy = my - dragStartRef.current.y
        if (dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) {
          hasDraggedRef.current = true
        }
      }
      if (hasDraggedRef.current) {
        simRef.current?.alpha(0.8)
        canvasRef.current!.style.cursor = 'grabbing'
        setTooltip(null)
      }
      return
    }

    const node = getNodeAt(e.clientX, e.clientY)
    canvasRef.current!.style.cursor = node ? 'pointer' : 'default'

    // Emit hover change for prefetch — only fire when the hovered token actually changes
    if ((node?.id ?? null) !== hoveredRef.current) {
      onHoverToken?.(node ?? null)
    }
    hoveredRef.current = node?.id ?? null

    if (node) {
      setTooltip({ x: mx, y: my, token: node })
    } else {
      setTooltip(null)
    }
  }, [getNodeAt])

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const node = getNodeAt(e.clientX, e.clientY)
    if (!node) return
    const rect = canvasRef.current?.getBoundingClientRect()
    const px = e.clientX - (rect?.left ?? 0)
    const py = e.clientY - (rect?.top  ?? 0)
    dragRef.current        = node
    hasDraggedRef.current  = false
    dragStartRef.current   = { x: px, y: py }
    mouseTargetRef.current = { x: px, y: py }
    setTooltip(null)
    canvasRef.current!.style.cursor = 'grabbing'
  }, [getNodeAt])

  const handleMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (dragRef.current) {
      const wasDrag = hasDraggedRef.current
      if (!wasDrag) onSelectToken(dragRef.current)
      dragRef.current        = null
      mouseTargetRef.current = null
      hasDraggedRef.current  = false
      dragStartRef.current   = null
      simRef.current?.alpha(0.3)
    }
    canvasRef.current!.style.cursor = 'default'
  }, [onSelectToken])

  const handleMouseLeave = useCallback(() => {
    dragRef.current        = null
    mouseTargetRef.current = null
    hasDraggedRef.current  = false
    dragStartRef.current   = null
    hoveredRef.current     = null
    setTooltip(null)
    canvasRef.current!.style.cursor = 'default'
  }, [])

  // ── Touch events (passive: false so preventDefault() works) ───────────────
  // React synthetic touch events are passive by default, which means
  // preventDefault() is a no-op and the page scrolls under the canvas.
  // Attaching via addEventListener with { passive: false } fixes this.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    function getTouchCanvasPos(touch: Touch): { cx: number; cy: number } {
      const rect = canvas!.getBoundingClientRect()
      return { cx: touch.clientX - rect.left, cy: touch.clientY - rect.top }
    }

    function onTouchStart(e: TouchEvent) {
      const touch = e.touches[0]
      if (!touch) return
      const node = getNodeAt(touch.clientX, touch.clientY)
      if (!node) return
      e.preventDefault()
      const { cx, cy } = getTouchCanvasPos(touch)
      dragRef.current        = node
      hasDraggedRef.current  = false
      dragStartRef.current   = { x: cx, y: cy }
      mouseTargetRef.current = { x: cx, y: cy }
      hoveredRef.current     = node.id
      setTooltip(null)
    }

    function onTouchMove(e: TouchEvent) {
      const touch = e.touches[0]
      if (!touch || !dragRef.current) return
      e.preventDefault()
      const { cx, cy } = getTouchCanvasPos(touch)
      mouseTargetRef.current = { x: cx, y: cy }
      if (!hasDraggedRef.current && dragStartRef.current) {
        const dx = cx - dragStartRef.current.x
        const dy = cy - dragStartRef.current.y
        if (dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) {
          hasDraggedRef.current = true
        }
      }
      if (hasDraggedRef.current) {
        simRef.current?.alpha(0.8)
        setTooltip(null)
      }
    }

    function onTouchEnd(e: TouchEvent) {
      if (dragRef.current) {
        const wasDrag = hasDraggedRef.current
        if (!wasDrag) onSelectToken(dragRef.current)
        dragRef.current        = null
        mouseTargetRef.current = null
        hasDraggedRef.current  = false
        dragStartRef.current   = null
        simRef.current?.alpha(0.3)
      }
      hoveredRef.current = null
      setTooltip(null)
      // Don't preventDefault on touchend — that blocks native tap feedback
      void e
    }

    canvas.addEventListener('touchstart',  onTouchStart, { passive: false })
    canvas.addEventListener('touchmove',   onTouchMove,  { passive: false })
    canvas.addEventListener('touchend',    onTouchEnd,   { passive: false })
    canvas.addEventListener('touchcancel', onTouchEnd,   { passive: false })
    return () => {
      canvas.removeEventListener('touchstart',  onTouchStart)
      canvas.removeEventListener('touchmove',   onTouchMove)
      canvas.removeEventListener('touchend',    onTouchEnd)
      canvas.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [getNodeAt, onSelectToken])

  return (
    <div ref={containerRef} className="w-full h-full relative overflow-hidden bg-black">
      <canvas
        ref={canvasRef}
        className="w-full h-full select-none"
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        style={{ display: 'block' }}
      />

      {tooltip && !dragRef.current && (
        <div
          className="pointer-events-none absolute z-10 px-3 py-2 rounded-xl bg-black/90 border border-white/10 shadow-xl"
          style={{
            left:      tooltip.x + 16,
            top:       tooltip.y - 10,
            transform: tooltip.x > dimensions.width - 190 ? 'translateX(-110%)' : undefined,
          }}
        >
          <div className="font-bold text-white text-[13px] leading-tight">{tooltip.token.symbol}</div>
          <div className="text-[11px] tabular-nums mt-0.5">
            {(() => {
              const parts = formatPriceParts(tooltip.token.usd_price)
              if (!parts) return <span className="text-gray-300">{formatPrice(tooltip.token.usd_price)}</span>
              const [prefix, digits] = parts
              return (
                <span>
                  <span className="text-gray-600">{prefix}</span>
                  <span className="text-gray-200">{digits}</span>
                </span>
              )
            })()}
          </div>
          <div className="font-semibold text-[11px]" style={{ color: changeTextColor(tooltip.token.change24) }}>
            {formatChange(tooltip.token.change24)}
          </div>
          <div className="text-gray-700 text-[10px] mt-0.5">click to open</div>
        </div>
      )}
    </div>
  )
}

// ── Custom D3 forces ──────────────────────────────────────────────────────────

// Smoothly tweens node.radius toward node.targetRadius each tick so that
// viewport resize and token updates animate rather than snap.
// Radius is kept at integer pixels to prevent micro-collisions: if radius
// were a sub-pixel float that grows 0.1 px/tick, it would repeatedly clip
// into a neighbour and trigger collision corrections every frame — jitter.
// Integer steps mean the radius is stable between 1-px jumps.
function buildRadiusTweenForce(nodesRef: React.RefObject<SimNode[]>) {
  return function radiusTweenForce() {
    for (const n of nodesRef.current!) {
      const diff = n.targetRadius - n.radius
      if (Math.abs(diff) < 1) { n.radius = n.targetRadius; continue }
      n.radius = Math.round(n.radius + diff * 0.08)
    }
  }
}

function buildMouseSpringForce(
  nodesRef:       React.RefObject<SimNode[]>,
  dragRef:        React.RefObject<SimNode | null>,
  mouseTargetRef: React.RefObject<{ x: number; y: number } | null>,
) {
  return function mouseSpringForce() {
    const node   = dragRef.current
    const target = mouseTargetRef.current
    if (!node || !target) return
    // Strong spring toward mouse — bubble tracks closely but yields to collisions
    node.vx! += (target.x - (node.x ?? 0)) * 0.9
    node.vy! += (target.y - (node.y ?? 0)) * 0.9
  }
}

// ── Coin force — reverse-engineered from banterbubbles.com ────────────────────
// Their entire physics is one custom force. Key properties:
//   • Each bubble holds a `_direction` (random angle) for ~100 ticks (~1.7 s at
//     60 fps) before randomly resetting — this gives straight-line drift that
//     occasionally changes heading, exactly like a bubble floating in still air.
//   • Impulse of 0.1 px/tick² applied in that direction whenever the bubble is
//     colliding OR on a random 30% chance each tick.
//   • Velocity clamped to ±2 px/tick after impulse.
//   • Collision: velocity-based separation proportional to overlap, split by
//     mass ratio (larger bubble absorbs less of the push).
//   • Boundary clamping is inlined so bubbles can't escape.
//   • velocityDecay = 0.4 (D3 default) provides the friction that keeps speeds
//     manageable without any explicit speed cap on the decay side.
function buildCoinForce(
  nodesRef: React.RefObject<SimNode[]>,
  dragRef:  React.RefObject<SimNode | null>,
  dimRef:   React.RefObject<{ width: number; height: number }>,
) {
  return function coinForce() {
    const nodes             = nodesRef.current!
    const { width, height } = dimRef.current!
    const maxX = width  - 5
    const maxY = height - 5
    const dragged = dragRef.current

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]
      if (a === dragged) continue
      a.isColliding = false
      if (Number.isNaN(a.vx) || Number.isNaN(a.vy)) { a.vx = 0; a.vy = 0 }

      // ── Collision pass ──────────────────────────────────────────────────
      for (let j = 0; j < nodes.length; j++) {
        if (i === j) continue
        const b = nodes[j]
        if (Number.isNaN(b.vx) || Number.isNaN(b.vy)) { b.vx = 0; b.vy = 0 }

        const ar     = a.radius * 1.05   // 5% padding so rings don't visually merge
        const br     = b.radius * 1.05
        const minD   = ar + br
        const dx     = a.x - b.x
        const dy     = a.y - b.y
        const distSq = dx * dx + dy * dy

        if (distSq > 0 && distSq < minD * minD) {
          const dist   = Math.sqrt(distSq)
          const force  = 0.36 * (minD - dist) / dist
          const total  = ar + br
          const aShare = br / total   // smaller bubble gets pushed more
          const bShare = ar / total

          a.vx! += dx * force * aShare / 2
          a.vy! += dy * force * aShare / 2
          b.vx! -= dx * force * bShare / 2
          b.vy! -= dy * force * bShare / 2
          a.isColliding = true
        }
      }

      // ── Always clamp inside canvas ──────────────────────────────────────
      // Hard boundary — prevents bubbles from drifting off-screen regardless
      // of whether they're colliding or got the drift impulse this tick.
      a.x = Math.max(a.radius, Math.min(maxX - a.radius, a.x))
      a.y = Math.max(a.radius, Math.min(maxY - a.radius, a.y))

      // ── Gravity toward canvas centre (mobile only) ────────────────────
      // On mobile the canvas is narrow and tall, so bubbles can drift to
      // the bottom corner leaving the top empty. This gentle pull keeps
      // the cluster centred. Desktop doesn't need it — fill is dense enough.
      if (width < 600) {
        a.vx! += (width  / 2 - a.x) * 0.015
        a.vy! += (height / 2 - a.y) * 0.015
      }

      // ── Drift impulse ───────────────────────────────────────────────────
      if (a.isColliding || Math.random() < 0.3) {
        // Direction held for ~100 ticks; 1 % chance of new heading each tick
        if (a._direction === undefined || Math.random() < 0.01) {
          a._direction = Math.random() * Math.PI * 2
        }

        a.vx! += 0.1 * Math.cos(a._direction)
        a.vy! += 0.1 * Math.sin(a._direction)

        // Hard velocity cap — matches banterbubbles.com exactly
        a.vx = Math.min(2, Math.max(-2, a.vx!))
        a.vy = Math.min(2, Math.max(-2, a.vy!))
      }
    }
  }
}
