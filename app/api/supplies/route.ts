import { NextRequest, NextResponse } from 'next/server'

// Supply data changes at most on token contract upgrades — 1h TTL is very conservative.
// Uses in-process Map (L1). POST bodies can't use next: revalidate, so L2 isn't available
// here, but supply is the lowest-traffic route and 1h TTL keeps Alcor hits minimal.

interface TokenRef {
  id:       string
  contract: string
  symbol:   string
}

interface SupplyInfo {
  total: number
  circulating: number
  burned: number
  burnedPct: number
}

const cache = new Map<string, { data: Record<string, SupplyInfo>; ts: number }>()
const TTL_MS = 60 * 60 * 1000

const NODE_URLS: Record<string, string> = {
  wax:    'https://wax.greymass.com',
  eos:    'https://eos.greymass.com',
  telos:  'https://telos.greymass.com',
  proton: 'https://proton.greymass.com',
}

async function getSupply(nodeUrl: string, contract: string, symbol: string): Promise<number | null> {
  try {
    const res = await fetch(`${nodeUrl}/v1/chain/get_table_rows`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code:  contract,
        scope: symbol.toUpperCase(),
        table: 'stat',
        json:  true,
        limit: 1,
      }),
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return null
    const json  = await res.json()
    const raw: string | undefined = json.rows?.[0]?.supply
    return raw ? parseFloat(raw) : null
  } catch {
    return null
  }
}

async function getBurnedSupply(nodeUrl: string, contract: string, symbol: string): Promise<number> {
  try {
    const res = await fetch(`${nodeUrl}/v1/chain/get_currency_balance`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: contract,
        account: 'eosio.null',
        symbol: symbol.toUpperCase(),
      }),
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return 0
    const rows = await res.json() as string[]
    return rows[0] ? parseFloat(rows[0]) || 0 : 0
  } catch {
    return 0
  }
}

async function getSupplyInfo(nodeUrl: string, token: TokenRef): Promise<SupplyInfo | null> {
  const [total, burned] = await Promise.all([
    getSupply(nodeUrl, token.contract, token.symbol),
    getBurnedSupply(nodeUrl, token.contract, token.symbol),
  ])
  if (total === null) return null

  const safeBurned = Math.max(0, Math.min(burned, total))
  const circulating = Math.max(0, total - safeBurned)
  return {
    total,
    circulating,
    burned: safeBurned,
    burnedPct: total > 0 ? safeBurned / total * 100 : 0,
  }
}

export async function POST(req: NextRequest) {
  const { chain, tokens }: { chain: string; tokens: TokenRef[] } = await req.json()

  const hit = cache.get(chain)
  if (hit && Date.now() - hit.ts < TTL_MS) {
    const result: Record<string, SupplyInfo> = {}
    for (const t of tokens) {
      if (hit.data[t.id] !== undefined) result[t.id] = hit.data[t.id]
    }
    return NextResponse.json(result)
  }

  const nodeUrl = NODE_URLS[chain] ?? NODE_URLS.wax
  const data: Record<string, SupplyInfo> = {}

  // All tokens fetched in parallel — this runs in the background and is cached.
  const results = await Promise.all(
    tokens.map(t => getSupplyInfo(nodeUrl, t))
  )
  results.forEach((info, i) => {
    if (info !== null) data[tokens[i].id] = info
  })

  cache.set(chain, { data, ts: Date.now() })
  return NextResponse.json(data)
}
