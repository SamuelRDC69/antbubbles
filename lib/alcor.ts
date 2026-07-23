import { AlcorToken, AlcorTicker, AlcorPool, TokenBubbleData, TokenPool, ChainConfig, TokenSupplyInfo } from './types'
import { getLocalLogoUrl } from './localTokenLogos'

// Single call — server merges tokens/tickers/pools and returns processed data.
export async function fetchMergedTokens(chain: ChainConfig): Promise<TokenBubbleData[]> {
  const res = await fetch(`/api/tokens?chain=${chain.id}`)
  if (!res.ok) throw new Error(`Failed to fetch tokens: ${res.status}`)
  return res.json()
}

export async function fetchSupplies(
  chain: ChainConfig,
  tokens: Array<{ id: string; contract: string; symbol: string }>,
): Promise<Map<string, TokenSupplyInfo>> {
  try {
    const res = await fetch('/api/supplies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chain: chain.id, tokens }),
      signal: AbortSignal.timeout(12_000),
    })
    if (!res.ok) return new Map()
    const data: Record<string, TokenSupplyInfo | number> = await res.json()
    return new Map(Object.entries(data).map(([id, value]) => {
      if (typeof value === 'number') {
        return [id, { total: value, circulating: value, burned: 0, burnedPct: 0 }]
      }
      return [id, value]
    }))
  } catch {
    return new Map()
  }
}

export function getLogoUrl(chain: ChainConfig, tokenId: string): string {
  return getLocalLogoUrl(chain.id, tokenId) ?? `/api/logo?id=${encodeURIComponent(tokenId)}&chain=${chain.id}`
}

function canonicalTokenKey(token: Pick<AlcorToken, 'contract' | 'symbol'>): string {
  return `${token.contract.trim().toLowerCase()}:${token.symbol.trim().toLowerCase()}`
}

// Minimum thresholds to filter out dead/scam tokens
const MIN_VOL24_USD = 5     // at least $5 combined 24h volume
const MIN_TVL_USD   = 100   // OR at least $100 TVL in pools
function changeForPoolSide(change: number, reversed: boolean): number {
  if (!reversed) return change
  const ratio = 1 + change / 100
  return ratio > 0 ? (1 / ratio - 1) * 100 : 0
}

export function mergeTokenData(
  tokens: AlcorToken[],
  tickers: AlcorTicker[],
  pools: AlcorPool[],
  chain: ChainConfig,
): TokenBubbleData[] {
  const systemTokenId = `${chain.systemToken.toLowerCase()}-${chain.systemContract}`
  const systemUsdPrice = tokens.find(token => token.id === systemTokenId)?.usd_price ?? 0

  // Ticker map: base currency → ticker (vs system token)
  const tickerMap = new Map<string, AlcorTicker>()
  for (const ticker of tickers) {
    if (ticker.target_currency === systemTokenId) {
      tickerMap.set(ticker.base_currency, ticker)
    }
  }

  interface PoolAgg {
    totalTvl:  number
    vol24usd:  number
    vol7dusd:  number
    vol30dusd: number
    primarySwap?: { poolId: number; price: number; tvl: number; change24: number; change7d: number }
    pools:     TokenPool[]
  }
  const poolMap = new Map<string, PoolAgg>()

  for (const pool of pools) {
    if (!pool.active) continue
    for (const side of [pool.tokenA, pool.tokenB]) {
      if (side.id === systemTokenId) continue
      const counterpart = side === pool.tokenA ? pool.tokenB : pool.tokenA
      const reversed = side === pool.tokenB
      const tvl = pool.tvlUSD || 0
      const agg = poolMap.get(side.id) ?? {
        totalTvl: 0, vol24usd: 0, vol7dusd: 0, vol30dusd: 0, pools: [],
      }
      agg.totalTvl  += tvl
      agg.vol24usd  += pool.volumeUSD24  || 0
      agg.vol7dusd  += pool.volumeUSDWeek  || 0
      agg.vol30dusd += pool.volumeUSDMonth || 0
      if (counterpart.id === systemTokenId && systemUsdPrice > 0) {
        const priceInSystem = side === pool.tokenA ? pool.priceA : pool.priceB
        if (Number.isFinite(priceInSystem) && priceInSystem! > 0) {
          // Match the default chart: the deepest system-token pool is the
          // canonical swap price and its own 24h move drives the bubble.
          if (!agg.primarySwap || tvl > agg.primarySwap.tvl) {
            agg.primarySwap = {
              poolId: pool.id,
              price: priceInSystem! * systemUsdPrice,
              tvl,
              change24: changeForPoolSide(pool.change24 || 0, reversed),
              change7d: changeForPoolSide(pool.changeWeek || 0, reversed),
            }
          }
        }
      }
      if (tvl > 0) {
        agg.pools.push({
          id:                pool.id,
          tvl,
          volume24usd:       pool.volumeUSD24 || 0,
          counterpartId:     counterpart.id,
          counterpartSymbol: counterpart.symbol,
          reversed, // tokenB needs reverse=true to show correct price direction
        })
      }
      poolMap.set(side.id, agg)
    }
  }

  // Sort each token's pools by TVL desc so the best pool is first
  for (const agg of poolMap.values()) {
    agg.pools.sort((a, b) => b.tvl - a.tvl)
  }

  const byIdentity = new Map<string, TokenBubbleData>()

  for (const token of tokens) {
    if (token.id === systemTokenId) continue
    if (!token.usd_price || token.usd_price <= 0) continue
    if (token.is_scam) continue

    const ticker = tickerMap.get(token.id)
    const agg    = poolMap.get(token.id)
    if (!agg?.primarySwap) continue

    const usdPrice = agg.primarySwap.price
    const systemPrice = systemUsdPrice > 0 ? usdPrice / systemUsdPrice : token.system_price
    const waxUsdPrice  = systemUsdPrice || (token.system_price > 0 ? token.usd_price / token.system_price : 0)
    const vol24spot    = ticker && waxUsdPrice > 0 ? ticker.target_volume * waxUsdPrice : 0
    const vol24pool    = agg?.vol24usd ?? 0
    const volume24usd  = vol24pool || vol24spot

    const tvlUsd = agg && agg.totalTvl > 0 ? agg.totalTvl : undefined

    // Quality filter: skip tokens with no meaningful activity
    if (volume24usd < MIN_VOL24_USD && (tvlUsd ?? 0) < MIN_TVL_USD) continue

    const change24 = agg.primarySwap.change24
    const change7d = agg.primarySwap.change7d

    const mergedToken: TokenBubbleData = {
      id:           token.id,
      symbol:       token.symbol,
      contract:     token.contract,
      usd_price:    usdPrice,
      system_price: systemPrice,
      change24,
      volume24usd,
      spotVolume24usd: vol24spot,
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
      nativePoolId: agg.primarySwap.poolId,
    }

    const key = canonicalTokenKey(token)
    const existing = byIdentity.get(key)
    if (!existing || (mergedToken.tvlUsd ?? 0) > (existing.tvlUsd ?? 0) || mergedToken.volume24usd > existing.volume24usd) {
      byIdentity.set(key, mergedToken)
    }
  }

  // Sort by Alcor score descending (100 = best). Tokens without a score go last.
  return [...byIdentity.values()].sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
}
