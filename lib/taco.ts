import { OffchainChartStep, TokenBubbleData } from './types'
import { getOffchainPairTokenVolumeWindows } from './offchain-volume'

// ── Constants ─────────────────────────────────────────────────────────────────

const WAX_CONTRACT  = 'eosio.token'
const WAX_SYMBOL    = 'WAX'
const SWAP_CONTRACT = 'swap.taco'
const WAX_RPC       = 'https://wax.eosphere.io'
const ANALYTICS_BASE = 'https://assets.tacostudios.io/swap/swap_analytics'
const LOGO_BASE      = 'https://assets.tacostudios.io/tokens'

const MIN_WAX_RESERVES = 1       // minimum WAX in pool to be included
const MIN_TVL_USD      = 50      // minimum $50 TVL
const MAX_PAIRS_PAGES  = 4       // fetch up to 4 × 1000 = 4000 pairs

// ── Types ─────────────────────────────────────────────────────────────────────

interface RawPair {
  id: string
  supply: string
  pool1: { quantity: string; contract: string }
  pool2: { quantity: string; contract: string }
}

interface AnalyticsSnapshot {
  p1: string   // "123.456 WAX"
  p2: string   // "7890 TACO"
  s:  string
  t:  number   // unix seconds
}

interface ParsedPair {
  id:       string
  sym1:     string
  amount1:  number
  contract1: string
  sym2:     string
  amount2:  number
  contract2: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseAsset(asset: string): [number, string] {
  const parts = asset.trim().split(' ')
  return [parseFloat(parts[0]) || 0, parts[1] ?? '']
}

function tokenId(contract: string, symbol: string): string {
  return `${symbol.toLowerCase()}-${contract}`
}

function tacoLogoUrl(contract: string, symbol: string): string {
  return `${LOGO_BASE}/${contract}_${symbol}.png`
}

// ── WAX/USD price ─────────────────────────────────────────────────────────────

let waxUsdCache: { price: number; ts: number } | null = null

export async function getWaxUsdPrice(): Promise<number> {
  if (waxUsdCache && Date.now() - waxUsdCache.ts < 60_000) return waxUsdCache.price
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=wax&vs_currencies=usd',
      { signal: AbortSignal.timeout(5000) },
    )
    if (res.ok) {
      const data = await res.json() as { wax?: { usd?: number } }
      const price = data.wax?.usd ?? 0
      if (price > 0) {
        waxUsdCache = { price, ts: Date.now() }
        return price
      }
    }
  } catch { /* fall through */ }
  return waxUsdCache?.price ?? 0.04   // last known or rough fallback
}

// ── Chain fetching ────────────────────────────────────────────────────────────

async function fetchAllPairs(): Promise<RawPair[]> {
  const all: RawPair[] = []
  let nextKey: string | undefined

  for (let page = 0; page < MAX_PAIRS_PAGES; page++) {
    const body: Record<string, unknown> = {
      json:  true,
      code:  SWAP_CONTRACT,
      scope: SWAP_CONTRACT,
      table: 'pairs',
      limit: 1000,
    }
    if (nextKey) body.lower_bound = nextKey

    try {
      const res = await fetch(`${WAX_RPC}/v1/chain/get_table_rows`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        signal:  AbortSignal.timeout(15_000),
      })
      if (!res.ok) break
      const data = await res.json() as { rows: RawPair[]; more: boolean; next_key?: string }
      all.push(...data.rows)
      if (!data.more) break
      nextKey = data.next_key
    } catch {
      break
    }
  }

  return all
}

// ── Analytics ─────────────────────────────────────────────────────────────────

async function fetchAnalytics(period: '24h' | '7d'): Promise<Record<string, AnalyticsSnapshot[]>> {
  try {
    const res = await fetch(`${ANALYTICS_BASE}/${period}.json`, {
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return {}
    return await res.json() as Record<string, AnalyticsSnapshot[]>
  } catch {
    return {}
  }
}

// Compute % price change for the token (non-WAX side) across snapshots.
// Detects which side is WAX so the result is always TOKEN price in WAX.
function priceChange(snapshots: AnalyticsSnapshot[]): number | null {
  if (snapshots.length < 2) return null
  const first = snapshots[0]
  const last  = snapshots[snapshots.length - 1]

  const [a1first, sym1] = parseAsset(first.p1)
  const [a2first]       = parseAsset(first.p2)
  const [a1last]        = parseAsset(last.p1)
  const [a2last]        = parseAsset(last.p2)

  if (a2first <= 0 || a2last <= 0 || a1first <= 0 || a1last <= 0) return null

  // Price expressed as WAX_amount / TOKEN_amount (token price in WAX)
  let priceBefore: number, priceNow: number
  if (sym1 === WAX_SYMBOL) {
    priceBefore = a1first / a2first
    priceNow    = a1last  / a2last
  } else {
    priceBefore = a2first / a1first
    priceNow    = a2last  / a1last
  }

  return (priceNow - priceBefore) / priceBefore * 100
}

// ── Token merging ─────────────────────────────────────────────────────────────

function parsePair(raw: RawPair): ParsedPair | null {
  const [amount1, sym1] = parseAsset(raw.pool1.quantity)
  const [amount2, sym2] = parseAsset(raw.pool2.quantity)
  if (!sym1 || !sym2) return null
  return {
    id:        raw.id,
    sym1,      amount1, contract1: raw.pool1.contract,
    sym2,      amount2, contract2: raw.pool2.contract,
  }
}

interface TokenAgg {
  id:        string
  symbol:    string
  contract:  string
  priceWax:  number    // token price in WAX
  waxAmount: number    // WAX in the best pool (used to weight multi-hop)
  tvlWax:    number    // 2 × wax in pool (best WAX pool)
  change24:  number
  tacoPairId: string
  chartPath: OffchainChartStep[]
}

export async function fetchTacoTokens(): Promise<TokenBubbleData[]> {
  const [rawPairs, analytics24h, waxUsd, pairTokenVolumes] = await Promise.all([
    fetchAllPairs(),
    fetchAnalytics('24h'),
    getWaxUsdPrice(),
    getOffchainPairTokenVolumeWindows('taco').catch(() => new Map()),
  ])

  const parsed = rawPairs.map(parsePair).filter(Boolean) as ParsedPair[]

  // ── Phase 1: Price WAX-paired tokens ──────────────────────────────────────
  // tokenId -> best WAX pool info (highest WAX reserves)
  const directPrices = new Map<string, TokenAgg>()

  for (const p of parsed) {
    const isWax1 = p.sym1 === WAX_SYMBOL && p.contract1 === WAX_CONTRACT
    const isWax2 = p.sym2 === WAX_SYMBOL && p.contract2 === WAX_CONTRACT

    if (!isWax1 && !isWax2) continue
    if (p.amount1 < MIN_WAX_RESERVES && p.amount2 < MIN_WAX_RESERVES) continue

    let tokenSym:      string
    let tokenContract: string
    let tokenAmount:   number
    let waxAmount:     number

    if (isWax1) {
      waxAmount     = p.amount1
      tokenSym      = p.sym2
      tokenContract = p.contract2
      tokenAmount   = p.amount2
    } else {
      waxAmount     = p.amount2
      tokenSym      = p.sym1
      tokenContract = p.contract1
      tokenAmount   = p.amount1
    }

    if (tokenAmount <= 0 || waxAmount <= 0) continue

    const id       = tokenId(tokenContract, tokenSym)
    const priceWax = waxAmount / tokenAmount  // WAX per token

    const existing = directPrices.get(id)
    if (!existing || waxAmount > existing.waxAmount) {
      directPrices.set(id, {
        id, symbol: tokenSym, contract: tokenContract,
        priceWax, waxAmount, tvlWax: waxAmount * 2,
        change24: analytics24h[p.id] ? (priceChange(analytics24h[p.id]) ?? 0) : 0,
        tacoPairId: p.id,
        chartPath: [{ pairId: p.id, invert: false }],
      })
    }
  }

  // ── Phase 2: Multi-hop — price non-WAX pairs using known prices ────────────
  // We iterate until no new prices are found (max 3 passes).
  const allPrices = new Map<string, TokenAgg>(directPrices)

  for (let pass = 0; pass < 3; pass++) {
    let newFound = 0

    for (const p of parsed) {
      const id1 = tokenId(p.contract1, p.sym1)
      const id2 = tokenId(p.contract2, p.sym2)
      const has1 = allPrices.has(id1)
      const has2 = allPrices.has(id2)

      if (has1 === has2) continue  // both known or both unknown — skip
      if (p.amount1 <= 0 || p.amount2 <= 0) continue

      if (has1 && !has2) {
        // Price token2 using token1's known WAX price
        const p1Wax   = allPrices.get(id1)!.priceWax
        const priceWax = (p.amount1 / p.amount2) * p1Wax
        const waxEq    = p.amount1 * p1Wax   // WAX equivalent of token1 side

        if (waxEq < MIN_WAX_RESERVES) continue

        const existing = allPrices.get(id2)
        if (!existing || waxEq > existing.waxAmount) {
          allPrices.set(id2, {
            id: id2, symbol: p.sym2, contract: p.contract2,
            priceWax, waxAmount: waxEq, tvlWax: waxEq * 2,
            change24: analytics24h[p.id] ? (priceChange(analytics24h[p.id]) ?? 0) : 0,
            tacoPairId: p.id,
            chartPath: [{ pairId: p.id, invert: true }, ...allPrices.get(id1)!.chartPath],
          })
          newFound++
        }
      } else if (has2 && !has1) {
        const p2Wax   = allPrices.get(id2)!.priceWax
        const priceWax = (p.amount2 / p.amount1) * p2Wax
        const waxEq    = p.amount2 * p2Wax

        if (waxEq < MIN_WAX_RESERVES) continue

        const existing = allPrices.get(id1)
        if (!existing || waxEq > existing.waxAmount) {
          allPrices.set(id1, {
            id: id1, symbol: p.sym1, contract: p.contract1,
            priceWax, waxAmount: waxEq, tvlWax: waxEq * 2,
            change24: analytics24h[p.id] ? (priceChange(analytics24h[p.id]) ?? 0) : 0,
            tacoPairId: p.id,
            chartPath: [{ pairId: p.id, invert: false }, ...allPrices.get(id2)!.chartPath],
          })
          newFound++
        }
      }
    }

    if (newFound === 0) break
  }

  // ── Build TokenBubbleData ─────────────────────────────────────────────────
  const results: TokenBubbleData[] = []

  for (const agg of allPrices.values()) {
    const usdPrice = agg.priceWax * waxUsd
    const tvlUsd   = agg.tvlWax   * waxUsd
    if (tvlUsd < MIN_TVL_USD) continue
    const pairVolumes = pairTokenVolumes.get(agg.tacoPairId)
    const tokenVolumes = pairVolumes?.get(agg.symbol)
    const tokenVolume24 = tokenVolumes?.current24 ?? 0
    const tokenVolume7d = tokenVolumes?.current7d ?? 0
    const tokenVolume30d = tokenVolumes?.current30d ?? 0

    results.push({
      id:            agg.id,
      symbol:        agg.symbol,
      contract:      agg.contract,
      usd_price:     usdPrice,
      system_price:  agg.priceWax,
      change24:      agg.change24,
      volume24usd:   tokenVolume24 * usdPrice,
      high24:        0,
      low24:         0,
      bid:           0,
      ask:           0,
      market_id:     null,
      ticker_id:     null,
      logoUrl:       tacoLogoUrl(agg.contract, agg.symbol),
      volume7dusd:   tokenVolume7d > 0 ? tokenVolume7d * usdPrice : undefined,
      volume30dusd:  tokenVolume30d > 0 ? tokenVolume30d * usdPrice : undefined,
      vol24hChange: tokenVolumes && tokenVolumes.previous24 > 0
        ? ((tokenVolumes.current24 - tokenVolumes.previous24) / tokenVolumes.previous24) * 100
        : undefined,
      vol7dChange: tokenVolumes && tokenVolumes.previous7d > 0
        ? ((tokenVolumes.current7d - tokenVolumes.previous7d) / tokenVolumes.previous7d) * 100
        : undefined,
      vol30dChange: tokenVolumes && tokenVolumes.previous30d > 0
        ? ((tokenVolumes.current30d - tokenVolumes.previous30d) / tokenVolumes.previous30d) * 100
        : undefined,
      tvlUsd,
      pools:         [],
      tacoPairId:    agg.tacoPairId,
      offchainChartPath: agg.chartPath,
    })
  }

  // Sort by TVL descending
  return results.sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0))
}

// Chart data is now served from SQLite via /api/taco-chart (see lib/taco-db.ts)
// and built in real-time by the poller in lib/dex-poller.ts.
