'use client'

import { useEffect, useRef, useCallback, useState } from 'react'
import { forceSimulation } from 'd3-force'
import type { Simulation } from 'd3-force'
import { TokenBubbleData, DisplayMode } from '@/lib/types'
import {
  computeRadii,
  bubbleFillColorForMode,
  ringColorForMode,
  glowColorForMode,
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
}

interface WanderNode extends SimNode { _angle?: number }

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

// ── Draw one bubble ───────────────────────────────────────────────────────────
function drawBubble(
  ctx:         CanvasRenderingContext2D,
  node:        SimNode,
  img:         HTMLImageElement | null | undefined,
  isHovered:   boolean,
  isDragging:  boolean,
  isDimmed:    boolean,
  displayMode: DisplayMode,
) {
  const { x = 0, y = 0, radius, symbol } = node
  const fill  = bubbleFillColorForMode(node, displayMode)
  const ring  = ringColorForMode(node, displayMode)
  const glow  = glowColorForMode(node, displayMode)

  // drawR: float for smooth anti-aliased arcs.
  // drawRi: integer for all text/image layout so sizes are frame-stable.
  // ctx.translate(x, y) puts the bubble centre at (0,0) in local space —
  // every subsequent draw call uses offsets relative to centre, so the clip
  // path and all content are always in perfect alignment no matter the
  // sub-pixel position of the bubble. This eliminates the ±0.5 px drift that
  // made logos/text appear to shift inside the ring each frame.
  const drawR  = isDragging ? radius : isHovered ? radius * 1.07 : radius
  const drawRi = Math.round(drawR)
  const ringW  = Math.max(2, drawR * 0.07)
  const alpha  = isDimmed ? 0.18 : 1

  ctx.save()
  // Round the translate so every draw call lands on integer pixels.
  // Canvas arcs are anti-aliased at any integer position so circles still
  // look smooth; text/images have no float pixel-snap jitter at all.
  ctx.translate(Math.round(x), Math.round(y))   // ← bubble centre at integer pixel
  ctx.globalAlpha = alpha

  // Outer pulse ring on hover
  if (isHovered && !isDimmed) {
    ctx.beginPath()
    ctx.arc(0, 0, drawR + 5, 0, Math.PI * 2)
    ctx.strokeStyle = ring + '50'
    ctx.lineWidth   = 1.5
    ctx.shadowBlur  = 0
    ctx.stroke()
  }

  // Glow + fill
  ctx.shadowBlur  = isDragging ? radius * 0.7 : isHovered ? radius * 0.75 : radius * 0.3
  ctx.shadowColor = glow
  ctx.beginPath()
  ctx.arc(0, 0, drawR, 0, Math.PI * 2)
  ctx.fillStyle = fill
  ctx.fill()

  // Ring
  ctx.lineWidth   = isDragging ? ringW * 1.5 : isHovered ? ringW * 1.4 : ringW
  ctx.strokeStyle = ring
  ctx.stroke()
  ctx.shadowBlur  = 0

  // Clip interior — everything below is clipped to the bubble disc
  ctx.beginPath()
  ctx.arc(0, 0, drawR - ringW / 2, 0, Math.PI * 2)
  ctx.clip()

  // ── Content tiers (all coordinates relative to centre = 0, 0) ───────────
  // Tiny  (< 16px): logo or 2-letter abbrev only
  // Small (16-27px): logo + symbol
  // Full  (≥ 28px): logo (larger, upper half) + symbol + metric value

  if (drawRi < 16) {
    ctx.globalAlpha = alpha
    if (img) {
      const s = Math.round(drawRi * 1.1)
      ctx.drawImage(img, -(s >> 1), -(s >> 1), s, s)
    } else {
      ctx.font         = `700 ${Math.max(6, Math.round(drawRi * 0.55))}px Inter, system-ui, sans-serif`
      ctx.fillStyle    = '#ffffff'
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(symbol.slice(0, 2), 0, 0)
    }
  } else {
    // All sizes derived from drawRi so layout never changes mid-tween.
    // Logo is 63% of diameter (was 42%) — more prominent, matches the modal's
    // round token image. Content is shifted up ~10% of radius so the logo
    // occupies the upper half and text sits in the lower half.
    const symFontSize = Math.round(Math.max(9,  Math.min(drawRi * 0.33, 20)))
    const valFontSize = Math.round(Math.max(7,  Math.min(drawRi * 0.22, 13)))
    const logoH       = Math.round(drawRi * 0.63)
    const hasLogo     = !!img

    const showValue = drawRi >= 28
    const gap    = Math.round(symFontSize * 0.15)
    const textH  = symFontSize + (showValue ? gap + valFontSize : 0)
    const totalH = hasLogo ? logoH + gap + textH : textH

    // Shift the whole group up so the logo lands in the upper half
    const lift    = Math.round(drawRi * 0.10)
    let cursorY = Math.round(-totalH / 2) - lift

    if (hasLogo) {
      ctx.globalAlpha = alpha
      ctx.drawImage(img!, -(logoH >> 1), cursorY, logoH, logoH)
      cursorY += logoH + gap
    }

    ctx.globalAlpha  = alpha
    ctx.font         = `700 ${symFontSize}px Inter, system-ui, sans-serif`
    ctx.fillStyle    = '#ffffff'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText(symbol.length > 7 ? symbol.slice(0, 6) + '…' : symbol, 0, cursorY)
    cursorY += symFontSize + gap

    if (showValue) {
      ctx.globalAlpha  = isDimmed ? 0.18 : 0.9
      ctx.font         = `600 ${valFontSize}px Inter, system-ui, sans-serif`
      ctx.fillStyle    = metricTextColor(node, displayMode)
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'top'
      ctx.fillText(formatMetricValue(node, displayMode), 0, cursorY)
    }
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
          x:  p?.x  ?? width  / 2 + (Math.random() - 0.5) * width  * 0.5,
          y:  p?.y  ?? height / 2 + (Math.random() - 0.5) * height * 0.5,
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
      const isMobileSim = width < 600
      simRef.current = forceSimulation(nodes)
        .alphaDecay(0)
        .alphaTarget(0.3)
        .velocityDecay(isMobileSim ? 0.60 : 0.45)
        .force('radiusTween', buildRadiusTweenForce(nodesRef))
        .force('mouseSpring', buildMouseSpringForce(nodesRef, dragRef, mouseTargetRef))
        .force('collide',     buildHardCollideForce(nodesRef, dimRef))
        .force('boundary',    buildBoundaryForce(nodesRef, dimRef))
        .force('center',      buildCenterForce(nodesRef, dimRef))
        .force('wander',      buildWanderForce(nodesRef, dragRef, dimRef))
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

    if (width > 0) {
      const dpr = window.devicePixelRatio || 1
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

      const nodes = nodesRef.current
      const q     = searchQuery.toLowerCase()

      for (const node of nodes) {
        const isHovered  = hoveredRef.current === node.id
        const isDragging = dragRef.current    === node
        const isMatch    = q.length > 1 && node.symbol.toLowerCase().includes(q)
        const isDimmed   = q.length > 1 && !isMatch
        drawBubble(ctx, node, imagesRef.current.get(node.id), isHovered, isDragging, isDimmed, displayMode)
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
function buildRadiusTweenForce(nodesRef: React.RefObject<SimNode[]>) {
  return function radiusTweenForce() {
    for (const n of nodesRef.current!) {
      const diff = n.targetRadius - n.radius
      if (Math.abs(diff) < 0.3) { n.radius = n.targetRadius; continue }
      n.radius += diff * 0.08
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

function buildHardCollideForce(
  nodesRef: React.RefObject<SimNode[]>,
  dimRef:   React.RefObject<{ width: number; height: number }>,
) {
  const GAP       = 4     // px gap between bubble rings (prevents visual ring merging)
  const VEL_SCALE = 0.25

  return function hardCollideForce() {
    const nodes             = nodesRef.current!
    const { width, height } = dimRef.current!
    // Fewer iterations on mobile: less correction per tick reduces micro-oscillation
    // in tight spaces, and cuts CPU so the GPU can maintain 60fps.
    const ITERATIONS = width < 600 ? 3 : 8

    for (let iter = 0; iter < ITERATIONS; iter++) {
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]

        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j]

          const dx     = (b.x ?? 0) - (a.x ?? 0)
          const dy     = (b.y ?? 0) - (a.y ?? 0)
          const distSq = dx * dx + dy * dy
          const minD   = a.radius + b.radius + GAP

          if (distSq >= minD * minD || distSq === 0) continue

          const dist    = Math.sqrt(distSq)
          const overlap = minD - dist
          const nx      = dx / dist  // unit vector a→b
          const ny      = dy / dist
          const half    = overlap * 0.5

          const aPad = a.radius + GAP
          const bPad = b.radius + GAP
          const ax0  = a.x ?? 0,  ay0 = a.y ?? 0
          const bx0  = b.x ?? 0,  by0 = b.y ?? 0

          // Proposed corrections (split evenly)
          const aWantX = ax0 - nx * half,  aWantY = ay0 - ny * half
          const bWantX = bx0 + nx * half,  bWantY = by0 + ny * half

          // Clamp to walls
          const aNewX = Math.max(aPad, Math.min(width  - aPad, aWantX))
          const aNewY = Math.max(aPad, Math.min(height - aPad, aWantY))
          const bNewX = Math.max(bPad, Math.min(width  - bPad, bWantX))
          const bNewY = Math.max(bPad, Math.min(height - bPad, bWantY))

          // Whatever a couldn't absorb (wall-blocked), pass to b and vice-versa
          const aBlockedX = (aWantX - aNewX),  aBlockedY = (aWantY - aNewY)
          const bBlockedX = (bWantX - bNewX),  bBlockedY = (bWantY - bNewY)

          a.x = aNewX - bBlockedX;  a.y = aNewY - bBlockedY
          b.x = bNewX - aBlockedX;  b.y = bNewY - aBlockedY

          // Re-clamp after receiving the extra push
          a.x = Math.max(aPad, Math.min(width  - aPad, a.x!))
          a.y = Math.max(aPad, Math.min(height - aPad, a.y!))
          b.x = Math.max(bPad, Math.min(width  - bPad, b.x!))
          b.y = Math.max(bPad, Math.min(height - bPad, b.y!))

          a.vx! += (a.x! - ax0) * VEL_SCALE
          a.vy! += (a.y! - ay0) * VEL_SCALE
          b.vx! += (b.x! - bx0) * VEL_SCALE
          b.vy! += (b.y! - by0) * VEL_SCALE
        }
      }
    }
  }
}

function buildBoundaryForce(
  nodesRef: React.RefObject<SimNode[]>,
  dimRef:   React.RefObject<{ width: number; height: number }>,
) {
  return function boundaryForce() {
    const { width, height } = dimRef.current!
    for (const n of nodesRef.current!) {
      const pad = n.radius + 2
      if (n.x < pad)          { n.x = pad;           n.vx =  Math.abs(n.vx) * 0.5 }
      if (n.x > width  - pad) { n.x = width  - pad;  n.vx = -Math.abs(n.vx) * 0.5 }
      if (n.y < pad)          { n.y = pad;            n.vy =  Math.abs(n.vy) * 0.5 }
      if (n.y > height - pad) { n.y = height - pad;  n.vy = -Math.abs(n.vy) * 0.5 }
    }
  }
}

// Gentle gravity toward canvas centre — prevents low-energy mobile bubbles
// from clustering in one corner and leaving the rest of the canvas empty.
function buildCenterForce(
  nodesRef: React.RefObject<SimNode[]>,
  dimRef:   React.RefObject<{ width: number; height: number }>,
) {
  const STRENGTH = 0.006
  return function centerForce() {
    const { width, height } = dimRef.current!
    const cx = width  / 2
    const cy = height / 2
    for (const n of nodesRef.current!) {
      n.vx! += (cx - (n.x ?? cx)) * STRENGTH
      n.vy! += (cy - (n.y ?? cy)) * STRENGTH
    }
  }
}

function buildWanderForce(
  nodesRef: React.RefObject<SimNode[]>,
  dragRef:  React.RefObject<SimNode | null>,
  dimRef:   React.RefObject<{ width: number; height: number }>,
) {
  const ANGLE_DRIFT  = 0.12
  const BASE_IMPULSE = 0.18
  const BASE_SPEED   = 2.2

  return function wanderForce() {
    const { width } = dimRef.current!
    // Scale down energy on narrow viewports so bubbles don't thrash in tight spaces.
    // 900px is the reference "desktop" width — below that energy tapers off.
    // On mobile (< 600px) cap energy lower so slow-moving bubbles don't
    // repeatedly push into each other before the collision force can correct.
    const scale     = width < 600
      ? Math.min(0.3, Math.max(0.15, width / 900))
      : Math.min(1,   Math.max(0.35, width / 900))
    const IMPULSE   = BASE_IMPULSE * scale
    const MAX_SPEED = Math.max(width < 600 ? 0.4 : 0.6, BASE_SPEED * scale)

    const dragged = dragRef.current
    for (const n of nodesRef.current! as WanderNode[]) {
      if (n === dragged) continue

      if (n._angle === undefined) n._angle = Math.random() * Math.PI * 2
      n._angle += (Math.random() - 0.5) * ANGLE_DRIFT * 2

      n.vx! += Math.cos(n._angle) * IMPULSE
      n.vy! += Math.sin(n._angle) * IMPULSE

      const speed = Math.sqrt(n.vx! * n.vx! + n.vy! * n.vy!)
      if (speed > MAX_SPEED) {
        n.vx! = (n.vx! / speed) * MAX_SPEED
        n.vy! = (n.vy! / speed) * MAX_SPEED
      }
    }
  }
}
