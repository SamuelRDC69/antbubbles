import { AlcorToken, AlcorTicker, AlcorPool, TokenBubbleData, TokenPool, ChainConfig } from './types'

// Single call — server merges tokens/tickers/pools and returns processed data.
export async function fetchMergedTokens(chain: ChainConfig): Promise<TokenBubbleData[]> {
  const res = await fetch(`/api/tokens?chain=${chain.id}`)
  if (!res.ok) throw new Error(`Failed to fetch tokens: ${res.status}`)
  return res.json()
}

export async function fetchSupplies(
  chain: ChainConfig,
  tokens: Array<{ id: string; contract: string; symbol: string }>,
): Promise<Map<string, number>> {
  try {
    const res = await fetch('/api/supplies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chain: chain.id, tokens }),
    })
    if (!res.ok) return new Map()
    const data: Record<string, number> = await res.json()
    return new Map(Object.entries(data))
  } catch {
    return new Map()
  }
}

export function getLogoUrl(chain: ChainConfig, tokenId: string): string {
  return `/api/logo?id=${encodeURIComponent(tokenId)}&chain=${chain.id}`
}

// Minimum thresholds to filter out dead/scam tokens
const MIN_VOL24_USD = 5     // at least $5 combined 24h volume
const MIN_TVL_USD   = 100   // OR at least $100 TVL in pools

export function mergeTokenData(
  tokens: AlcorToken[],
  tickers: AlcorTicker[],
  pools: AlcorPool[],
  chain: ChainConfig,
): TokenBubbleData[] {
  const systemTokenId = `${chain.systemToken.toLowerCase()}-${chain.systemContract}`

  // Ticker map: base currency → ticker (vs system token)
  const tickerMap = new Map<string, AlcorTicker>()
  for (const ticker of tickers) {
    if (ticker.target_currency === systemTokenId) {
      tickerMap.set(ticker.base_currency, ticker)
    }
  }

  interface PoolAgg {
    totalTvl:  number
    wChange24: number
    wChange7d: number
    vol24usd:  number
    vol7dusd:  number
    vol30dusd: number
    pools:     TokenPool[]
  }
  const poolMap = new Map<string, PoolAgg>()

  for (const pool of pools) {
    if (!pool.active) continue
    for (const side of [pool.tokenA, pool.tokenB]) {
      if (side.id === systemTokenId) continue
      const counterpart = side === pool.tokenA ? pool.tokenB : pool.tokenA
      const tvl = pool.tvlUSD || 0
      const agg = poolMap.get(side.id) ?? {
        totalTvl: 0, wChange24: 0, wChange7d: 0,
        vol24usd: 0, vol7dusd: 0, vol30dusd: 0, pools: [],
      }
      agg.totalTvl  += tvl
      agg.wChange24 += (pool.change24    || 0) * tvl
      agg.wChange7d += (pool.changeWeek  || 0) * tvl
      agg.vol24usd  += pool.volumeUSD24  || 0
      agg.vol7dusd  += pool.volumeUSDWeek  || 0
      agg.vol30dusd += pool.volumeUSDMonth || 0
      agg.pools.push({
        id:                pool.id,
        tvl,
        counterpartId:     counterpart.id,
        counterpartSymbol: counterpart.symbol,
        reversed:          side === pool.tokenB, // tokenB needs reverse=true to show correct price direction
      })
      poolMap.set(side.id, agg)
    }
  }

  // Sort each token's pools by TVL desc so the best pool is first
  for (const agg of poolMap.values()) {
    agg.pools.sort((a, b) => b.tvl - a.tvl)
  }

  const results: TokenBubbleData[] = []

  for (const token of tokens) {
    if (token.id === systemTokenId) continue
    if (!token.usd_price || token.usd_price <= 0) continue
    if (token.is_scam) continue

    const ticker = tickerMap.get(token.id)
    const agg    = poolMap.get(token.id)

    // WAX/USD price for converting spot volume
    const waxUsdPrice  = token.system_price > 0 ? token.usd_price / token.system_price : 0
    const vol24spot    = ticker && waxUsdPrice > 0 ? ticker.target_volume * waxUsdPrice : 0
    const vol24pool    = agg?.vol24usd ?? 0
    const volume24usd  = vol24spot + vol24pool   // combined spot + AMM volume

    const tvlUsd = agg && agg.totalTvl > 0 ? agg.totalTvl : undefined

    // Quality filter: skip tokens with no meaningful activity
    if (volume24usd < MIN_VOL24_USD && (tvlUsd ?? 0) < MIN_TVL_USD) continue

    // change24: pool TVL-weighted average is far more reliable than ticker.change24
    // (ticker.change24 is 0 for ~99% of WAX pairs). Fall back to ticker only if no pool data.
    const poolChange24 = agg && agg.totalTvl > 0 ? agg.wChange24 / agg.totalTvl : null
    const change24     = poolChange24 !== null
      ? poolChange24
      : (ticker?.change24 ?? 0)

    const change7d = agg && agg.totalTvl > 0
      ? agg.wChange7d / agg.totalTvl
      : undefined

    results.push({
      id:           token.id,
      symbol:       token.symbol,
      contract:     token.contract,
      usd_price:    token.usd_price,
      system_price: token.system_price,
      change24,
      volume24usd,
      high24:       ticker?.high24 ?? 0,
      low24:        ticker?.low24  ?? 0,
      bid:          ticker?.bid    ?? 0,
      ask:          ticker?.ask    ?? 0,
      market_id:    ticker?.market_id ?? null,
      ticker_id:    ticker?.ticker_id ?? null,
      logoUrl:      getLogoUrl(chain, token.id),
      decimals:     token.decimals,
      score:        token.score,
      cmc_id:       token.cmc_id,
      change7d,
      volume7dusd:  agg && agg.vol7dusd  > 0 ? agg.vol7dusd  : undefined,
      volume30dusd: agg && agg.vol30dusd > 0 ? agg.vol30dusd : undefined,
      tvlUsd,
      pools:        agg?.pools ?? [],
    })
  }

  // Sort by Alcor score descending (100 = best). Tokens without a score go last.
  return results.sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
}
