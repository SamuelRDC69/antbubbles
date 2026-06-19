'use server'

/**
 * NeftyBlocks DEX (swap.nefty) data fetching.
 * Mirrors lib/taco.ts but uses the NEFTY_CONFIG normaliser.
 */

import { OffchainChartStep, TokenBubbleData } from './types'
import { NEFTY_CONFIG, type NormalisedPair } from './dex-contracts'
import { getOffchainPairTokenVolumeWindows } from './offchain-volume'
import { buildOffchainWaxCandles } from './offchain-chart'
import { getWaxUsdPrice } from './taco'   // reuse WAX/USD cache

const WAX_CONTRACT  = 'eosio.token'
const WAX_SYMBOL    = 'WAX'
const MIN_WAX_RESERVES = 1
const MIN_TVL_USD      = 50
const LOGO_BASE = 'https://assets.tacostudios.io/tokens'   // same CDN works for nefty tokens

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseAsset(asset: string): [number, string] {
  const parts = asset.trim().split(' ')
  return [parseFloat(parts[0]) || 0, parts[1] ?? '']
}

function tokenId(contract: string, symbol: string): string {
  return `${symbol.toLowerCase()}-${contract}`
}

function logoUrl(contract: string, symbol: string): string {
  return `${LOGO_BASE}/${contract}_${symbol}.png`
}

// ── Pair fetching ─────────────────────────────────────────────────────────────

async function fetchAllPairs(): Promise<NormalisedPair[]> {
  const cfg  = NEFTY_CONFIG
  const all: NormalisedPair[] = []
  let nextKey: string | undefined

  for (let page = 0; page < cfg.maxPages; page++) {
    const body: Record<string, unknown> = {
      json:  true,
      code:  cfg.contract,
      scope: cfg.contract,
      table: cfg.table,
      limit: 1000,
    }
    if (nextKey) body.lower_bound = nextKey

    const res = await fetch(`${cfg.rpc}/v1/chain/get_table_rows`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(15_000),
    })
    if (!res.ok) break

    const data = await res.json() as {
      rows: Record<string, unknown>[]
      more: boolean
      next_key?: string
    }

    for (const row of data.rows) {
      const pair = cfg.normalise(row)
      if (pair && pair.active) all.push(pair)
    }

    if (!data.more) break
    nextKey = data.next_key
  }

  return all
}

// ── Token pricing (same Phase 1 + Phase 2 logic as Taco) ─────────────────────

interface TokenAgg {
  id:         string
  symbol:     string
  contract:   string
  priceWax:   number
  waxAmount:  number
  tvlWax:     number
  change24:   number
  neftyPairId: string
  chartPath: OffchainChartStep[]
}

export async function fetchNeftyTokens(): Promise<TokenBubbleData[]> {
  const [pairs, waxUsd, pairTokenVolumes] = await Promise.all([
    fetchAllPairs(),
    getWaxUsdPrice(),
    getOffchainPairTokenVolumeWindows('nefty').catch(() => new Map()),
  ])

  // ── Phase 1: WAX-direct pairs ─────────────────────────────────────────────
  const directPrices = new Map<string, TokenAgg>()

  for (const p of pairs) {
    const [amount1, sym1] = parseAsset(p.p1.quantity)
    const [amount2, sym2] = parseAsset(p.p2.quantity)

    const isWax1 = sym1 === WAX_SYMBOL && p.p1.contract === WAX_CONTRACT
    const isWax2 = sym2 === WAX_SYMBOL && p.p2.contract === WAX_CONTRACT

    if (!isWax1 && !isWax2) continue

    const waxAmount   = isWax1 ? amount1 : amount2
    const tokenSym    = isWax1 ? sym2    : sym1
    const tokenCon    = isWax1 ? p.p2.contract : p.p1.contract
    const tokenAmount = isWax1 ? amount2 : amount1

    if (waxAmount < MIN_WAX_RESERVES || tokenAmount <= 0) continue

    const id       = tokenId(tokenCon, tokenSym)
    const priceWax = waxAmount / tokenAmount

    const existing = directPrices.get(id)
    if (!existing || waxAmount > existing.waxAmount) {
      directPrices.set(id, {
        id, symbol: tokenSym, contract: tokenCon,
        priceWax, waxAmount, tvlWax: waxAmount * 2,
        change24:    0,   // no analytics JSON for nefty; DB-driven change coming later
        neftyPairId: p.id,
        chartPath: [{ pairId: p.id, invert: false }],
      })
    }
  }

  // ── Phase 2: Multi-hop pricing ────────────────────────────────────────────
  const allPrices = new Map<string, TokenAgg>(directPrices)

  for (let pass = 0; pass < 3; pass++) {
    let newFound = 0

    for (const p of pairs) {
      const [amount1, sym1] = parseAsset(p.p1.quantity)
      const [amount2, sym2] = parseAsset(p.p2.quantity)
      const id1 = tokenId(p.p1.contract, sym1)
      const id2 = tokenId(p.p2.contract, sym2)
      const has1 = allPrices.has(id1)
      const has2 = allPrices.has(id2)

      if (has1 === has2) continue
      if (amount1 <= 0 || amount2 <= 0) continue

      if (has1 && !has2) {
        const p1Wax  = allPrices.get(id1)!.priceWax
        const priceWax = (amount1 / amount2) * p1Wax
        const waxEq    = amount1 * p1Wax
        if (waxEq < MIN_WAX_RESERVES) continue
        const existing = allPrices.get(id2)
        if (!existing || waxEq > existing.waxAmount) {
          allPrices.set(id2, {
            id: id2, symbol: sym2, contract: p.p2.contract,
            priceWax, waxAmount: waxEq, tvlWax: waxEq * 2,
            change24: 0, neftyPairId: p.id,
            chartPath: [{ pairId: p.id, invert: true }, ...allPrices.get(id1)!.chartPath],
          })
          newFound++
        }
      } else if (has2 && !has1) {
        const p2Wax  = allPrices.get(id2)!.priceWax
        const priceWax = (amount2 / amount1) * p2Wax
        const waxEq    = amount2 * p2Wax
        if (waxEq < MIN_WAX_RESERVES) continue
        const existing = allPrices.get(id1)
        if (!existing || waxEq > existing.waxAmount) {
          allPrices.set(id1, {
            id: id1, symbol: sym1, contract: p.p1.contract,
            priceWax, waxAmount: waxEq, tvlWax: waxEq * 2,
            change24: 0, neftyPairId: p.id,
            chartPath: [{ pairId: p.id, invert: false }, ...allPrices.get(id2)!.chartPath],
          })
          newFound++
        }
      }
    }

    if (newFound === 0) break
  }

  // ── Derive change24 from SQLite candle history ────────────────────────────
  // Use 1H candles over the last 25 hours so a full 24h window is always covered.
  const nowForChangeSec = Math.floor(Date.now() / 1000)
  const fromChange24hSec = nowForChangeSec - 25 * 3600
  // ── Build TokenBubbleData ─────────────────────────────────────────────────
  const results: TokenBubbleData[] = []

  for (const agg of allPrices.values()) {
    const usdPrice = agg.priceWax * waxUsd
    const tvlUsd   = agg.tvlWax   * waxUsd
    if (tvlUsd < MIN_TVL_USD) continue
    const pairVolumes = pairTokenVolumes.get(agg.neftyPairId)
    const tokenVolumes = pairVolumes?.get(agg.symbol)
    const tokenVolume24 = tokenVolumes?.current24 ?? 0
    const tokenVolume7d = tokenVolumes?.current7d ?? 0
    const tokenVolume30d = tokenVolumes?.current30d ?? 0
    let change24 = 0
    try {
      const history = buildOffchainWaxCandles(
        'nefty',
        agg.chartPath,
        3600,
        fromChange24hSec,
        nowForChangeSec,
      )
      const first = history[0]?.open
      const last = history[history.length - 1]?.close
      if (first > 0 && last > 0) change24 = (last - first) / first * 100
    } catch {
      // Keep zero when history is not available yet.
    }

    results.push({
      id:           agg.id,
      symbol:       agg.symbol,
      contract:     agg.contract,
      usd_price:    usdPrice,
      system_price: agg.priceWax,
      change24,
      volume24usd:  tokenVolume24 * usdPrice,
      high24:       0,
      low24:        0,
      bid:          0,
      ask:          0,
      market_id:    null,
      ticker_id:    null,
      logoUrl:      logoUrl(agg.contract, agg.symbol),
      volume7dusd:  tokenVolume7d > 0 ? tokenVolume7d * usdPrice : undefined,
      volume30dusd: tokenVolume30d > 0 ? tokenVolume30d * usdPrice : undefined,
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
      pools:        [],
      neftyPairId:  agg.neftyPairId,
      offchainChartPath: agg.chartPath,
    })
  }

  return results.sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0))
}
