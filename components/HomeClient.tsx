'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import dynamic from 'next/dynamic'
import { ChainConfig, TokenBubbleData, DisplayMode } from '@/lib/types'
import { CHAINS, DEFAULT_CHAIN } from '@/lib/chains'
import { useTokens } from '@/hooks/useTokens'
import TopBar from '@/components/TopBar'
import TokenModal from '@/components/TokenModal'
import LoadingScreen from '@/components/LoadingScreen'
import StatsBar from '@/components/StatsBar'
import BubbleSkeleton from '@/components/BubbleSkeleton'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { prefetchChart, buildDefaultChartUrl } from '@/lib/chartCache'

// BubbleChart can't SSR (canvas + D3). The dynamic() loading prop only fires
// while the JS chunk is downloading — we handle skeleton display manually below.
const BubbleChart = dynamic(() => import('@/components/BubbleChart'), { ssr: false })

interface Props {
  // Pre-rendered token data for the default chain — skips the initial loading state
  initialTokens: TokenBubbleData[]
}

export default function HomeClient({ initialTokens }: Props) {
  const [chain,          setChain]          = useState<ChainConfig>(CHAINS[DEFAULT_CHAIN])
  const [displayMode,    setDisplayMode]    = useState<DisplayMode>({ metric: 'change', timeframe: '24h' })
  const [searchQuery,    setSearchQuery]    = useState('')
  const [selectedToken,  setSelectedToken]  = useState<TokenBubbleData | null>(null)
  // Tracks whether the BubbleChart JS chunk has finished loading.
  // Shows skeleton in the gap between data-ready and chart-ready.
  const [chartReady, setChartReady] = useState(false)

  // initialTokens seeds the default chain so the loading screen is never shown on first paint
  const { tokens, loading, error, lastUpdated } = useTokens(chain, initialTokens)

  const handleChainChange = useCallback((c: ChainConfig) => {
    setChain(c)
    setSelectedToken(null)
    setSearchQuery('')
  }, [])

  // Prefetch chart data when a bubble is hovered — by the time the user clicks,
  // the data is already cached so the modal opens instantly.
  const handleHoverToken = useCallback((token: TokenBubbleData | null) => {
    if (!token) return
    const url = buildDefaultChartUrl(token, chain)
    if (url) prefetchChart(url)
  }, [chain])

  // Proactive prefetch: as soon as the first token batch arrives, silently warm
  // the chart cache for the top 15 tokens by market cap. These are the largest
  // bubbles users click most — especially important on mobile where hover doesn't fire.
  const prefetchedSetRef = useRef<string>('')
  useEffect(() => {
    if (tokens.length === 0) return
    const key = chain.id
    if (prefetchedSetRef.current === key) return   // already prefetched for this chain
    prefetchedSetRef.current = key

    const top15 = [...tokens]
      .sort((a, b) => (b.marketCapUsd ?? 0) - (a.marketCapUsd ?? 0))
      .slice(0, 15)

    // Stagger slightly so we don't fire 15 requests simultaneously on page load
    top15.forEach((token, i) => {
      setTimeout(() => {
        const url = buildDefaultChartUrl(token, chain)
        if (url) prefetchChart(url)
      }, i * 120)
    })
  }, [tokens, chain])

  return (
    <div className="flex flex-col h-screen bg-black text-white overflow-hidden">
      <TopBar
        chain={chain}
        displayMode={displayMode}
        searchQuery={searchQuery}
        lastUpdated={lastUpdated}
        onChainChange={handleChainChange}
        onModeChange={setDisplayMode}
        onSearchChange={setSearchQuery}
      />

      <main className="flex-1 relative min-h-0">
        {loading ? (
          <LoadingScreen chain={chain} error={null} />
        ) : error ? (
          <LoadingScreen chain={chain} error={error} />
        ) : (
          <>
            {/* Skeleton visible until BubbleChart JS chunk is ready */}
            {!chartReady && tokens.length > 0 && (
              <div className="absolute inset-0 z-10">
                <BubbleSkeleton tokens={tokens} displayMode={displayMode} />
              </div>
            )}
            <ErrorBoundary name="BubbleChart">
              <BubbleChart
                tokens={tokens}
                displayMode={displayMode}
                searchQuery={searchQuery}
                onSelectToken={setSelectedToken}
                onHoverToken={handleHoverToken}
                onReady={() => setChartReady(true)}
              />
            </ErrorBoundary>
          </>
        )}
      </main>

      {!loading && tokens.length > 0 && (
        <StatsBar tokens={tokens} />
      )}

      {selectedToken && (
        <TokenModal
          token={selectedToken}
          chain={chain}
          onClose={() => setSelectedToken(null)}
        />
      )}

    </div>
  )
}
