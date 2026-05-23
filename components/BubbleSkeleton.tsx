'use client'

import { useMemo } from 'react'
import { TokenBubbleData, DisplayMode } from '@/lib/types'
import { computeRadii } from '@/lib/bubbleUtils'

interface Props {
  tokens:      TokenBubbleData[]
  displayMode: DisplayMode
}

// Sunflower/Vogel spiral — produces a natural circular packing that looks like
// a real bubble chart, used as a skeleton while BubbleChart JS is loading.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)) // ≈ 137.5°

export default function BubbleSkeleton({ tokens, displayMode }: Props) {
  const radii = useMemo(() => computeRadii(tokens, displayMode), [tokens, displayMode])

  const circles = useMemo(() => {
    const items = tokens.slice(0, 50)
    return items.map((t, i) => {
      const r     = radii.get(t.id) ?? 28
      const angle = i * GOLDEN_ANGLE
      const dist  = 38 * Math.sqrt(i + 1)   // spiral outward
      return {
        key:  t.id,
        r,
        // expressed as % of container for responsive layout
        cx: 50 + (Math.cos(angle) * dist) / 12,
        cy: 50 + (Math.sin(angle) * dist) / 12,
      }
    })
  }, [tokens, radii])

  return (
    <div className="w-full h-full bg-black overflow-hidden">
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="xMidYMid meet"
        className="w-full h-full"
        style={{ opacity: 0.5 }}
        suppressHydrationWarning
      >
        {circles.map((c, i) => (
          <circle
            key={c.key}
            cx={`${c.cx}%`}
            cy={`${c.cy}%`}
            r={`${c.r * 0.09}%`}
            fill="#0d1117"
            stroke="#1f2937"
            strokeWidth="0.3"
            style={{
              animation: `pulse 1.8s ease-in-out ${(i % 6) * 0.15}s infinite`,
            }}
            suppressHydrationWarning
          />
        ))}
        <style>{`
          @keyframes pulse {
            0%, 100% { opacity: 0.4; }
            50%       { opacity: 0.9; }
          }
        `}</style>
      </svg>
    </div>
  )
}
