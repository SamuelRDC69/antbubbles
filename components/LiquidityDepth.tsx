'use client'

import { useEffect, useMemo, useState } from 'react'
import { formatPrice } from '@/lib/bubbleUtils'

interface DepthPool {
  id: number
  tvl: number
}

interface DepthBand {
  impact: number
  buyUsd: number
  sellUsd: number
}

interface Props {
  poolId: number
  chain: string
  currentUsdPrice: number
  tokenSymbol: string
  tokenId: string
  mode?: 'single' | 'combined'
  pools?: DepthPool[]
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0'
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)}M`
  if (value >= 1_000) return `$${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)}K`
  if (value >= 1) return `$${value.toFixed(value >= 100 ? 0 : 2)}`
  return `$${value.toPrecision(2)}`
}

export default function LiquidityDepth({
  poolId,
  chain,
  currentUsdPrice,
  tokenSymbol,
  tokenId,
  mode = 'single',
  pools = [],
}: Props) {
  const [data, setData] = useState<{ bands: DepthBand[]; poolCount: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    queueMicrotask(() => {
      setLoading(true)
      setError(false)
    })
    const ctrl = new AbortController()

    const load = async () => {
      const ids = mode === 'combined'
        ? pools.filter(pool => pool.id !== 0 && pool.tvl > 0).slice(0, 10).map(pool => pool.id)
        : [poolId]
      const params = new URLSearchParams({
        chain,
        token_id: tokenId,
        price: String(currentUsdPrice),
        pool_ids: ids.join(','),
      })
      const response = await fetch(`/api/liquidity-depth?${params}`, { signal: ctrl.signal })
      const result = await response.json() as { bands?: DepthBand[]; poolCount?: number }
      if (!response.ok || !result.bands?.some(band => band.buyUsd > 0 || band.sellUsd > 0)) {
        throw new Error('No executable liquidity')
      }
      setData({ bands: result.bands, poolCount: result.poolCount ?? ids.length })
      setLoading(false)
    }

    load().catch(() => {
      if (!ctrl.signal.aborted) {
        setError(true)
        setLoading(false)
      }
    })
    return () => ctrl.abort()
  }, [poolId, chain, currentUsdPrice, tokenId, mode, pools])

  const maxDepth = useMemo(() => data
    ? Math.max(...data.bands.flatMap(band => [band.buyUsd, band.sellUsd]), 1)
    : 1, [data])

  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center gap-1.5" aria-label="Loading market depth">
        {[0, 1, 2].map(i => (
          <div
            key={i}
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-gray-700"
            style={{ animationDelay: `${i * 150}ms` }}
          />
        ))}
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-gray-600">
        <span className="text-2xl" aria-hidden>∅</span>
        <span className="text-[13px]">No executable liquidity found</span>
      </div>
    )
  }

  return (
    <section className="flex h-full min-h-0 w-full flex-col" aria-label={`${tokenSymbol} executable market depth`}>
      <header className="flex items-start justify-between gap-4 pb-4">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-gray-600">Executable depth</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-mono text-lg font-semibold text-white">{formatPrice(currentUsdPrice)}</span>
            <span className="text-[11px] text-gray-600">{tokenSymbol} spot</span>
          </div>
        </div>
        <div className="rounded-full border border-white/[0.08] bg-white/[0.035] px-2.5 py-1 text-[10px] font-semibold text-gray-500">
          {data.poolCount} {data.poolCount === 1 ? 'pool' : 'pools'} · SDK simulated
        </div>
      </header>

      <div className="grid grid-cols-[1fr_54px_1fr] items-end gap-x-3 border-b border-white/[0.06] pb-2 text-[10px] font-bold uppercase tracking-[0.14em]">
        <div className="text-right text-rose-400/80">Sell {tokenSymbol}</div>
        <div className="text-center text-gray-700">Impact</div>
        <div className="text-emerald-400/80">Buy {tokenSymbol}</div>
      </div>

      <div className="flex flex-1 flex-col justify-evenly py-2">
        {data.bands.map(band => {
          const sellWidth = Math.max(2, band.sellUsd / maxDepth * 100)
          const buyWidth = Math.max(2, band.buyUsd / maxDepth * 100)
          return (
            <div key={band.impact} className="grid grid-cols-[1fr_54px_1fr] items-center gap-x-3">
              <div className="flex min-w-0 items-center justify-end gap-2">
                <span className="shrink-0 font-mono text-[11px] font-semibold text-gray-300">{formatUsd(band.sellUsd)}</span>
                <div className="flex h-7 min-w-0 flex-1 justify-end overflow-hidden rounded-l-md bg-rose-400/[0.04]">
                  <div
                    className="h-full rounded-l-md border-l border-rose-300/60 bg-gradient-to-l from-rose-400/10 to-rose-400/45"
                    style={{ width: `${sellWidth}%` }}
                  />
                </div>
              </div>
              <div className="rounded-md border border-white/[0.08] bg-white/[0.04] py-1.5 text-center font-mono text-[11px] font-bold text-gray-300">
                {band.impact}%
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <div className="h-7 min-w-0 flex-1 overflow-hidden rounded-r-md bg-emerald-400/[0.04]">
                  <div
                    className="h-full rounded-r-md border-r border-emerald-300/60 bg-gradient-to-r from-emerald-400/45 to-emerald-400/10"
                    style={{ width: `${buyWidth}%` }}
                  />
                </div>
                <span className="shrink-0 font-mono text-[11px] font-semibold text-gray-300">{formatUsd(band.buyUsd)}</span>
              </div>
            </div>
          )
        })}
      </div>

      <footer className="border-t border-white/[0.06] pt-3 text-center text-[10px] leading-4 text-gray-600">
        Maximum USD trade size before simulated price impact exceeds each level. Pool fees excluded.
      </footer>
    </section>
  )
}
