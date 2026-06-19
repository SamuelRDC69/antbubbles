/**
 * Generic background poller for WAX EOSIO AMM DEXes.
 *
 * One poller instance per DEX (Taco, Nefty, …).
 * Fetches all pair reserves from the blockchain every POLL_INTERVAL ms,
 * computes the implied price (WAX/TOKEN or ratio for non-WAX pairs),
 * and persists candles into the SQLite store.
 *
 * Usage:
 *   import { startPoller } from '@/lib/dex-poller'
 *   startPoller('taco')   // idempotent — safe to call on every request
 */

import { DEX_CONFIGS, type DexId, type NormalisedPair } from './dex-contracts'
import { recordPriceBatch } from './taco-db'

const POLL_INTERVAL = 30_000   // 30 seconds
const PAGE_LIMIT    = 1000

const WAX_SYMBOL   = 'WAX'
const WAX_CONTRACT = 'eosio.token'

// ── One singleton per DEX ─────────────────────────────────────────────────────

const running = new Set<DexId>()

export function startPoller(dex: DexId) {
  if (running.has(dex)) return
  running.add(dex)
  console.log(`[dex-poller] starting ${dex}`)
  poll(dex).catch(() => {})           // first poll immediately
  setInterval(() => poll(dex).catch(() => {}), POLL_INTERVAL)
}

// ── Pair fetching ─────────────────────────────────────────────────────────────

async function fetchPairs(dex: DexId): Promise<NormalisedPair[]> {
  const cfg  = DEX_CONFIGS[dex]
  const all: NormalisedPair[] = []
  let nextKey: string | undefined

  for (let page = 0; page < cfg.maxPages; page++) {
    const body: Record<string, unknown> = {
      json:  true,
      code:  cfg.contract,
      scope: cfg.contract,
      table: cfg.table,
      limit: PAGE_LIMIT,
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

// ── Price computation ─────────────────────────────────────────────────────────

function parseAsset(asset: string): [number, string] {
  const parts = asset.trim().split(' ')
  return [parseFloat(parts[0]) || 0, parts[1] ?? '']
}

/**
 * Compute the implied price for the non-WAX token in a pair.
 * If neither side is WAX, returns the p2/p1 ratio (useful relative price).
 * Returns null if reserves are zero.
 */
function impliedPrice(pair: NormalisedPair): number | null {
  const [a1, sym1] = parseAsset(pair.p1.quantity)
  const [a2, sym2] = parseAsset(pair.p2.quantity)
  if (a1 <= 0 || a2 <= 0) return null

  const waxIsP1 = sym1 === WAX_SYMBOL && pair.p1.contract === WAX_CONTRACT
  const waxIsP2 = sym2 === WAX_SYMBOL && pair.p2.contract === WAX_CONTRACT

  if (waxIsP1) return a1 / a2   // WAX / TOKEN = token price in WAX
  if (waxIsP2) return a2 / a1   // WAX / TOKEN = token price in WAX
  return a1 > 0 ? a2 / a1 : null  // non-WAX pair: ratio
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function poll(dex: DexId) {
  const timeSec = Math.floor(Date.now() / 1000)

  let pairs: NormalisedPair[]
  try {
    pairs = await fetchPairs(dex)
  } catch (err) {
    console.error(`[dex-poller] ${dex} fetch error:`, err)
    return
  }

  const entries: Array<{ pairId: string; timeSec: number; price: number }> = []

  for (const pair of pairs) {
    const price = impliedPrice(pair)
    if (price !== null && isFinite(price) && price > 0) {
      entries.push({ pairId: pair.id, timeSec, price })
    }
  }

  if (entries.length > 0) {
    try {
      recordPriceBatch(dex, entries)
    } catch (err) {
      console.error(`[dex-poller] ${dex} db write error:`, err)
    }
  }

  console.log(`[dex-poller] ${dex}: recorded ${entries.length}/${pairs.length} pairs at ${new Date(timeSec * 1000).toISOString()}`)
}
