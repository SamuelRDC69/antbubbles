'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import dynamic from 'next/dynamic'
import { ChainConfig, TokenBubbleData, DisplayMode, DexMode } from '@/lib/types'
import { CHAINS, DEFAULT_CHAIN } from '@/lib/chains'
import { useTokens } from '@/hooks/useTokens'
import TopBar from '@/components/TopBar'
import TokenModal from '@/components/TokenModal'
import LoadingScreen from '@/components/LoadingScreen'
import StatsBar from '@/components/StatsBar'
import BubbleSkeleton from '@/components/BubbleSkeleton'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { prefetchChart, buildDefaultChartUrl } from '@/lib/chartCache'

const tokenCacheKey = (id: string) => `abt:v1:${id}`

// BubbleChart can't SSR (canvas + D3). The dynamic() loading prop only fires
// while the JS chunk is downloading — we handle skeleton display manually below.
const BubbleChart = dynamic(() => import('@/components/BubbleChart'), { ssr: false })

interface Props {
  // Pre-rendered token data for the default chain — skips the initial loading state
  initialTokens: TokenBubbleData[]
}

export default function HomeClient({ initialTokens }: Props) {
  const [chain,          setChain]          = useState<ChainConfig>(CHAINS[DEFAULT_CHAIN])
  const [dex,            setDex]            = useState<DexMode>('alcor')
  const [displayMode,    setDisplayMode]    = useState<DisplayMode>({ metric: 'change', timeframe: '24h' })
  const [searchQuery,    setSearchQuery]    = useState('')
  const [selectedToken,  setSelectedToken]  = useState<TokenBubbleData | null>(null)
  // Tracks whether the BubbleChart JS chunk has finished loading.
  // Shows skeleton in the gap between data-ready and chart-ready.
  const [chartReady, setChartReady] = useState(false)

  // initialTokens seeds the default chain so the loading screen is never shown on first paint
  const { tokens, loading, error, lastUpdated, connected } = useTokens(chain, initialTokens, dex)

  useEffect(() => {
    setChartReady(false)
  }, [chain.id, dex])

  const handleChainChange = useCallback((c: ChainConfig) => {
    setChain(c)
    setSelectedToken(null)
    setSearchQuery('')
  }, [])

  const handleDexChange = useCallback((d: DexMode) => {
    setDex(d)
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
  // the chart cache for the top 15 tokens by market cap.
  // Skipped for Taco Swap — those charts use a different endpoint.
  const prefetchedSetRef = useRef<string>('')
  useEffect(() => {
    if (tokens.length === 0 || dex === 'taco' || dex === 'nefty') return
    const key = chain.id
    if (prefetchedSetRef.current === key) return
    prefetchedSetRef.current = key

    const top15 = [...tokens]
      .sort((a, b) => (b.marketCapUsd ?? 0) - (a.marketCapUsd ?? 0))
      .slice(0, 15)

    top15.forEach((token, i) => {
      setTimeout(() => {
        const url = buildDefaultChartUrl(token, chain)
        if (url) prefetchChart(url)
      }, i * 120)
    })
  }, [tokens, chain, dex])

  // Once the user intentionally opens one off-chain DEX, warm the other one in
  // the background. This preserves the "both are ready after one loads" feeling
  // without slowing down the initial Alcor page.
  useEffect(() => {
    if (dex === 'alcor') return

    const ctrl = new AbortController()
    const warm = (url: string) =>
      fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } })
        .catch(() => {})

    const otherUrl = dex === 'taco' ? '/api/nefty-tokens' : '/api/taco-tokens'
    const t1 = setTimeout(() => { void warm(otherUrl) }, 150)

    return () => {
      ctrl.abort()
      clearTimeout(t1)
    }
  }, [dex])

  // Warm Taco/Nefty browser cache shortly after Alcor is stable so the first
  // switch can render from localStorage instead of showing a blocking loader.
  useEffect(() => {
    if (dex !== 'alcor' || loading || tokens.length === 0) return

    const ctrl = new AbortController()
    const warm = async (id: 'taco-wax' | 'nefty-wax', url: string) => {
      try {
        const data = await fetch(url, {
          signal: ctrl.signal,
          headers: { Accept: 'application/json' },
        }).then(r => r.ok ? r.json() : [])
        if (!Array.isArray(data) || data.length === 0) return
        localStorage.setItem(tokenCacheKey(id), JSON.stringify({ data, ts: Date.now() }))
      } catch {
        // best-effort only
      }
    }

    const t1 = setTimeout(() => { void warm('taco-wax', '/api/taco-tokens') }, 1200)
    const t2 = setTimeout(() => { void warm('nefty-wax', '/api/nefty-tokens') }, 2600)

    return () => {
      ctrl.abort()
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [dex, loading, tokens.length])

  return (
    <div className="flex flex-col h-screen bg-black text-white overflow-hidden">
      <TopBar
        chain={chain}
        dex={dex}
        displayMode={displayMode}
        searchQuery={searchQuery}
        lastUpdated={lastUpdated}
        connected={connected}
        onChainChange={handleChainChange}
        onDexChange={handleDexChange}
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
                key={`${dex}:${chain.id}`}
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
          dex={dex}
          onClose={() => setSelectedToken(null)}
        />
      )}

    </div>
  )
}
