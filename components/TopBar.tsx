'use client'

import { DisplayMode, Metric, Timeframe, ChainConfig } from '@/lib/types'
import { CHAINS } from '@/lib/chains'
import { CURRENT_RELEASE } from '@/lib/releases'

const CHAIN_TABS = [CHAINS.wax]

// Which timeframes are valid for each metric
const TIMEFRAMES: Record<Metric, Timeframe[]> = {
  change: ['24h', '7d'],
  price:  [],
  volume: ['24h', '7d', '30d'],
  tvl:    [],
  mcap:   [],
}

const METRIC_LABELS: Record<Metric, string> = {
  change: '% Change',
  price:  'Price',
  volume: 'Volume',
  tvl:    'TVL',
  mcap:   'Mkt Cap',
}

const TIMEFRAME_LABELS: Record<Timeframe, string> = {
  '24h': '24h',
  '7d':  '7D',
  '30d': '30D',
}

interface Props {
  chain:          ChainConfig
  displayMode:    DisplayMode
  searchQuery:    string
  lastUpdated:    Date | null
  connected:      boolean
  onChainChange:  (chain: ChainConfig) => void
  onModeChange:   (mode: DisplayMode) => void
  onSearchChange: (q: string) => void
  onAdvertise:    () => void
}

export default function TopBar({
  chain,
  displayMode,
  searchQuery,
  lastUpdated,
  connected,
  onChainChange,
  onModeChange,
  onSearchChange,
  onAdvertise,
}: Props) {
  const validTimeframes = TIMEFRAMES[displayMode.metric]

  function setMetric(metric: Metric) {
    const frames = TIMEFRAMES[metric]
    // Keep current timeframe if valid, otherwise default to first available (or '24h')
    const timeframe = frames.includes(displayMode.timeframe)
      ? displayMode.timeframe
      : (frames[0] ?? '24h')
    onModeChange({ metric, timeframe })
  }

  function setTimeframe(timeframe: Timeframe) {
    onModeChange({ ...displayMode, timeframe })
  }

  return (
    <header className="flex items-center gap-2.5 px-4 py-2 bg-black border-b border-white/[0.07] z-20 flex-wrap shrink-0">

      {/* Logo */}
      <div className="flex items-center gap-2 mr-1 shrink-0">
        <div className="w-7 h-7 rounded-lg bg-[#f89422] flex items-center justify-center shadow-lg shadow-orange-500/30">
          <svg viewBox="0 0 24 24" className="w-4 h-4 text-white" fill="currentColor">
            <circle cx="12" cy="12" r="3.5" />
            <circle cx="5"  cy="7"  r="2.2" />
            <circle cx="19" cy="7"  r="1.8" />
            <circle cx="5"  cy="17" r="2.8" />
            <circle cx="19" cy="17" r="1.5" />
          </svg>
        </div>
        <span className="font-bold text-white text-[16px] leading-none hidden sm:block tracking-tight">
          Ant<span className="text-[#f89422]">Bubbles</span>
        </span>
        <span className="rounded border border-white/[0.08] px-1 py-0.5 font-mono text-[9px] leading-none text-gray-600">
          v{CURRENT_RELEASE.version}
        </span>
      </div>

      {/* Chain tabs */}
      <div className="flex items-center bg-white/[0.07] rounded-lg p-0.5 shrink-0" role="tablist" aria-label="Blockchain">
        {CHAIN_TABS.map(option => (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={chain.id === option.id}
            onClick={() => onChainChange(option)}
            className={`px-2.5 py-1.5 rounded-md text-[12px] font-semibold transition-all ${
              chain.id === option.id
                ? 'bg-white/[0.12] shadow-sm'
                : 'text-gray-500 hover:text-gray-300'
            }`}
            style={chain.id === option.id ? { color: option.color } : undefined}
          >
            {option.displayName}
          </button>
        ))}
      </div>

      {/* Metric selector */}
      <div className="flex items-center bg-white/[0.07] rounded-lg p-0.5 shrink-0">
        {(Object.keys(METRIC_LABELS) as Metric[]).map(m => (
          <button
            key={m}
            onClick={() => setMetric(m)}
            className={`px-2.5 py-1.5 rounded-md text-[12px] font-semibold transition-all ${
              displayMode.metric === m
                ? 'bg-white/[0.12] text-white shadow-sm'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {METRIC_LABELS[m]}
          </button>
        ))}
      </div>

      {/* Timeframe selector — only shown when metric has multiple timeframes */}
      {validTimeframes.length > 0 && (
        <div className="flex items-center bg-white/[0.07] rounded-lg p-0.5 shrink-0">
          {validTimeframes.map(tf => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              className={`px-2.5 py-1.5 rounded-md text-[12px] font-semibold transition-all ${
                displayMode.timeframe === tf
                  ? 'bg-white/[0.12] text-white shadow-sm'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {TIMEFRAME_LABELS[tf]}
            </button>
          ))}
        </div>
      )}

      {/* Search */}
      <div className="relative flex-1 min-w-[120px] max-w-xs">
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-600"
          fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          placeholder="Search…"
          value={searchQuery}
          onChange={e => onSearchChange(e.target.value)}
          className="w-full bg-white/[0.07] border border-white/[0.08] rounded-lg pl-7 pr-3 py-1.5 text-[12px] text-white placeholder-gray-600 focus:outline-none focus:border-white/20 transition-all"
        />
        {searchQuery && (
          <button onClick={() => onSearchChange('')}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-600 hover:text-white">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Live indicator — green + pulse when stream is healthy, amber static when reconnecting */}
      <div className="flex items-center gap-1.5 shrink-0 hidden sm:flex">
        <span className={`w-1.5 h-1.5 rounded-full transition-colors duration-500 ${
          connected ? 'bg-green-500 animate-pulse' : 'bg-amber-500'
        }`} />
        <span className={`text-[11px] uppercase tracking-wider font-medium transition-colors duration-500 ${
          connected ? 'text-gray-500' : 'text-amber-600'
        }`}>{connected ? 'LIVE' : 'CONNECTING…'}</span>
      </div>

      {/* Last updated */}
      {lastUpdated && (
        <div className="text-[11px] text-gray-700 shrink-0 hidden lg:block">
          {lastUpdated.toLocaleTimeString()}
        </div>
      )}

      <button
        onClick={onAdvertise}
        className="shrink-0 rounded-lg border border-[#ffd700]/40 px-3 py-1.5 text-[12px] font-semibold text-[#ffd700] transition-colors hover:bg-[#ffd700]/10"
      >
        ◆ Advertise
      </button>

      {/* Legend */}
      <div className="items-center gap-3 text-[11px] shrink-0 hidden xl:flex">
        <span className="flex items-center gap-1.5 text-gray-500">
          <span className="w-2 h-2 rounded-full bg-green-500 shadow shadow-green-500/50" /> Up
        </span>
        <span className="flex items-center gap-1.5 text-gray-500">
          <span className="w-2 h-2 rounded-full bg-red-600 shadow shadow-red-600/50" /> Down
        </span>
      </div>

    </header>
  )
}
