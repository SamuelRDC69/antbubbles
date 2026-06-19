/**
 * DEX contract definitions for WAX EOSIO AMMs.
 *
 * Adding a new DEX:
 *   1. Add a config object implementing DexContractConfig
 *   2. Add its key to DexId
 *   3. Export it from DEX_CONFIGS
 *   4. Wire up a stream route + chart route
 */

export type DexId = 'taco' | 'nefty'

export interface NormalisedPair {
  /** Unique pair identifier (e.g. "WAXEOS", "AIGCHA") */
  id: string
  p1: { quantity: string; contract: string }
  p2: { quantity: string; contract: string }
  active: boolean
}

export interface DexContractConfig {
  dex:      DexId
  contract: string   // EOSIO account name
  rpc:      string   // WAX RPC base URL
  table:    string   // pairs/pools table name
  maxPages: number   // max pagination pages (limit 1000 each)
  /** Map a raw table row → NormalisedPair, or null to skip */
  normalise: (row: Record<string, unknown>) => NormalisedPair | null
}

// ── swap.taco ─────────────────────────────────────────────────────────────────

export const TACO_CONFIG: DexContractConfig = {
  dex:      'taco',
  contract: 'swap.taco',
  rpc:      'https://wax.eosphere.io',
  table:    'pairs',
  maxPages: 4,
  normalise(row) {
    const id   = row.id as string
    const pool1 = row.pool1 as { quantity: string; contract: string }
    const pool2 = row.pool2 as { quantity: string; contract: string }
    if (!id || !pool1?.quantity || !pool2?.quantity) return null
    return { id, p1: pool1, p2: pool2, active: true }
  },
}

// ── swap.nefty ────────────────────────────────────────────────────────────────

export const NEFTY_CONFIG: DexContractConfig = {
  dex:      'nefty',
  contract: 'swap.nefty',
  rpc:      'https://wax.eosphere.io',
  table:    'pairs',
  maxPages: 1,     // 756 pairs — fits in a single 1000-row fetch
  normalise(row) {
    const code     = row.code as string
    const reserve0 = row.reserve0 as { quantity: string; contract: string }
    const reserve1 = row.reserve1 as { quantity: string; contract: string }
    const active   = row.active as number
    if (!code || !reserve0?.quantity || !reserve1?.quantity) return null
    return { id: code, p1: reserve0, p2: reserve1, active: active === 1 }
  },
}

export const DEX_CONFIGS: Record<DexId, DexContractConfig> = {
  taco:  TACO_CONFIG,
  nefty: NEFTY_CONFIG,
}
