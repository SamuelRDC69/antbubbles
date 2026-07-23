'use client'

import { useMemo } from 'react'
import { TokenBubbleData } from '@/lib/types'
import { formatVolume, formatChange } from '@/lib/bubbleUtils'

interface Props {
  tokens: TokenBubbleData[]
}

export default function StatsBar({ tokens }: Props) {
  const stats = useMemo(() => {
    if (tokens.length === 0) return null
    const gainers   = tokens.filter(t => t.change24 > 0).length
    const losers    = tokens.filter(t => t.change24 < 0).length
    const poolVolumes = new Map<number, number>()
    for (const token of tokens) for (const pool of token.pools ?? []) {
      poolVolumes.set(pool.id, pool.volume24usd)
    }
    const totalVol = tokens.reduce((s, token) => s + (token.spotVolume24usd ?? 0), 0)
      + [...poolVolumes.values()].reduce((s, volume) => s + volume, 0)
    const topGainer = tokens.reduce((best, t) => t.change24 > best.change24 ? t : best, tokens[0])
    const topLoser  = tokens.reduce((best, t) => t.change24 < best.change24 ? t : best, tokens[0])
    return { gainers, losers, totalVol, topGainer, topLoser }
  }, [tokens])

  if (!stats) return null

  return (
    <div className="flex items-center gap-3 px-3 py-1.5 bg-black border-t border-white/[0.06] text-xs text-gray-500 shrink-0 overflow-x-auto">

      {/* Token count */}
      <span className="shrink-0 text-gray-600">{tokens.length} tokens</span>

      {/* Market summary */}
      <span className="text-green-500 font-medium shrink-0">▲ {stats.gainers}</span>
      <span className="text-red-500 font-medium shrink-0">▼ {stats.losers}</span>
      <span className="shrink-0 hidden sm:inline">
        Vol 24h: <span className="text-gray-300">{formatVolume(stats.totalVol)}</span>
      </span>
      <span className="shrink-0 hidden md:inline">
        Top: <span className="text-green-400 font-medium">{stats.topGainer.symbol}</span>
        <span className="text-green-600 ml-1">{formatChange(stats.topGainer.change24)}</span>
      </span>
      <span className="shrink-0 hidden md:inline">
        Bot: <span className="text-red-400 font-medium">{stats.topLoser.symbol}</span>
        <span className="text-red-600 ml-1">{formatChange(stats.topLoser.change24)}</span>
      </span>

      {/* Spacer */}
      <span className="flex-1" />

      {/* Alcor credit */}
      <span className="shrink-0 hidden xl:inline text-gray-700">
        Powered by{' '}
        <a href="https://alcor.exchange" target="_blank" rel="noopener noreferrer"
          className="text-[#f89422] hover:underline">
          Alcor DEX
        </a>
      </span>
    </div>
  )
}
