import { NextRequest, NextResponse } from 'next/server'

// Supply data changes at most on token contract upgrades — 1h TTL is very conservative.
// Uses in-process Map (L1). POST bodies can't use next: revalidate, so L2 isn't available
// here, but supply is the lowest-traffic route and 1h TTL keeps Alcor hits minimal.

interface TokenRef {
  id:       string
  contract: string
  symbol:   string
}

const cache = new Map<string, { data: Record<string, number>; ts: number }>()
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

export async function POST(req: NextRequest) {
  const { chain, tokens }: { chain: string; tokens: TokenRef[] } = await req.json()

  const hit = cache.get(chain)
  if (hit && Date.now() - hit.ts < TTL_MS) {
    const result: Record<string, number> = {}
    for (const t of tokens) {
      if (hit.data[t.id] !== undefined) result[t.id] = hit.data[t.id]
    }
    return NextResponse.json(result)
  }

  const nodeUrl = NODE_URLS[chain] ?? NODE_URLS.wax
  const data: Record<string, number> = {}

  // All tokens fetched in parallel — greymass handles concurrent requests fine
  // and this is a background task so there's no UX cost to firing them all at once
  const results = await Promise.all(
    tokens.map(t => getSupply(nodeUrl, t.contract, t.symbol))
  )
  results.forEach((supply, i) => {
    if (supply !== null) data[tokens[i].id] = supply
  })

  cache.set(chain, { data, ts: Date.now() })
  return NextResponse.json(data)
}
