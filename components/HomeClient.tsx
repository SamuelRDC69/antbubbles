'use client'

import { useState, useCallback, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { ChainConfig, TokenBubbleData, DisplayMode } from '@/lib/types'
import { MarketingAd } from '@/lib/ads'
import { CHAINS, DEFAULT_CHAIN } from '@/lib/chains'
import { useTokens } from '@/hooks/useTokens'
import TopBar from '@/components/TopBar'
import LoadingScreen from '@/components/LoadingScreen'
import TokenModalLoader from '@/components/TokenModalLoader'
import StatsBar from '@/components/StatsBar'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { prefetchChart, buildDefaultChartUrl } from '@/lib/chartCache'
import { CURRENT_RELEASE } from '@/lib/releases'

// Canvas and modal code stay out of the initial client bundle.
const BubbleChart = dynamic(() => import('@/components/BubbleChart'), { ssr: false })
const TokenModal = dynamic(() => import('@/components/TokenModal'), {
  ssr: false,
  loading: () => <TokenModalLoader />,
})
const AdvertiseModal = dynamic(() => import('@/components/AdvertiseModal'), { ssr: false })

interface Props {
  // Pre-rendered token data starts asset loading immediately.
  initialTokens: TokenBubbleData[]
}

export default function HomeClient({ initialTokens }: Props) {
  const [chain,          setChain]          = useState<ChainConfig>(CHAINS[DEFAULT_CHAIN])
  const [displayMode,    setDisplayMode]    = useState<DisplayMode>({ metric: 'change', timeframe: '24h' })
  const [searchQuery,    setSearchQuery]    = useState('')
  const [selectedToken,  setSelectedToken]  = useState<TokenBubbleData | null>(null)
  const [ad,             setAd]             = useState<MarketingAd | null>(null)
  const [advertiseOpen,  setAdvertiseOpen]  = useState(false)
  const [adReady,        setAdReady]        = useState(false)
  const [alcorTradingAllowed, setAlcorTradingAllowed] = useState(false)
  // The chart reports ready after its first complete frame and logo load.
  const [chartReady, setChartReady] = useState(false)

  // initialTokens seeds the default chain while the single loading gate remains visible.
  const { tokens, loading, error, lastUpdated, connected, suppliesReady } = useTokens(chain, initialTokens)

  useEffect(() => {
    let active = true
    let initial = true
    const refreshAd = () => fetch('/api/ad', { signal: AbortSignal.timeout(8_000) })
      .then(response => response.json())
      .then((nextAd: MarketingAd | null) => {
        if (!active) return
        if (initial && nextAd?.imageUrl) setChartReady(false)
        initial = false
        setAd(current => current?.id === nextAd?.id && current?.expiresAt === nextAd?.expiresAt
          ? current
          : nextAd)
      })
      .catch(() => {})
      .finally(() => {
        initial = false
        if (active) setAdReady(true)
      })
    refreshAd()
    const interval = setInterval(refreshAd, 30_000)
    return () => { active = false; clearInterval(interval) }
  }, [])

  useEffect(() => {
    let active = true
    fetch('/api/alcor-access', {
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    })
      .then(response => response.ok ? response.json() : null)
      .then((access: unknown) => {
        if (active && access && typeof access === 'object' && 'allowed' in access) {
          setAlcorTradingAllowed(access.allowed === true)
        }
      })
      .catch(() => {})
    return () => { active = false }
  }, [])

  const handleChainChange = useCallback((c: ChainConfig) => {
    setChain(c)
    setChartReady(false)
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
  const handleChartReady = useCallback(() => setChartReady(true), [])
  const openAdvertise = useCallback(() => setAdvertiseOpen(true), [])

  const appReady = !loading && !error && tokens.length > 0 && suppliesReady && adReady && chartReady

  return (
    <div className="flex flex-col h-screen bg-black text-white overflow-hidden">
      <TopBar
        chain={chain}
        displayMode={displayMode}
        searchQuery={searchQuery}
        lastUpdated={lastUpdated}
        connected={connected}
        onChainChange={handleChainChange}
        onModeChange={setDisplayMode}
        onSearchChange={setSearchQuery}
        onAdvertise={openAdvertise}
      />

      <aside
        aria-label={`AntBubbles version ${CURRENT_RELEASE.version} release announcement`}
        className="scrollbar-none flex shrink-0 items-center gap-2 overflow-x-auto whitespace-nowrap border-b border-[#f89422]/20 bg-[#f89422]/[0.06] px-4 py-1.5 text-[11px]"
      >
        <span className="font-mono font-bold uppercase tracking-wider text-[#f89422]">
          Release {String(CURRENT_RELEASE.sequence).padStart(3, '0')} · v{CURRENT_RELEASE.version}
        </span>
        <span className="text-gray-300">{CURRENT_RELEASE.title}</span>
        <span className="text-gray-600">—</span>
        <span className="text-gray-500">{CURRENT_RELEASE.summary}</span>
      </aside>

      <main className="flex-1 relative min-h-0">
        {!error && tokens.length > 0 && (
            <ErrorBoundary name="BubbleChart">
              <BubbleChart
                key={chain.id}
                tokens={tokens}
                displayMode={displayMode}
                searchQuery={searchQuery}
                onSelectToken={setSelectedToken}
                onHoverToken={handleHoverToken}
                onReady={handleChartReady}
                ad={ad}
                onAdvertise={openAdvertise}
              />
            </ErrorBoundary>
        )}
      </main>

      {!loading && tokens.length > 0 && (
        <StatsBar tokens={tokens} />
      )}

      {selectedToken && (
        <TokenModal
          token={selectedToken}
          chain={chain}
          allowAlcorTrade={alcorTradingAllowed}
          onClose={() => setSelectedToken(null)}
        />
      )}

      {advertiseOpen && (
        <AdvertiseModal
          tokens={tokens}
          marketDataAt={lastUpdated?.getTime() ?? null}
          onClose={() => setAdvertiseOpen(false)}
        />
      )}

      {!appReady && (
        <div className="fixed inset-0 z-50 bg-black" aria-live="polite">
          <LoadingScreen chain={chain} error={error} />
        </div>
      )}
    </div>
  )
}
