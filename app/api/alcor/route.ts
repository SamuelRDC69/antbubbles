export const runtime = 'edge'

import { NextRequest, NextResponse } from 'next/server'

// Two-layer cache:
//   L1 — in-process Map  (survives requests in dev + same-instance prod hits)
//   L2 — next: revalidate (Vercel Data Cache — shared across all instances in prod)

const ALLOWED = new Set(['tokens', 'tickers', 'swap/pools'])
const TTL_MS  = 30_000
const TTL_S   = 30

const cache = new Map<string, { data: unknown; ts: number }>()

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const chain    = searchParams.get('chain')    ?? 'wax'
  const endpoint = searchParams.get('endpoint') ?? 'tokens'

  if (!ALLOWED.has(endpoint)) {
    return NextResponse.json({ error: 'invalid endpoint' }, { status: 400 })
  }

  const key = `${chain}:${endpoint}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.ts < TTL_MS) return NextResponse.json(hit.data)

  const url = `https://${chain}.alcor.exchange/api/v2/${endpoint}`

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      next: { revalidate: TTL_S },
    })
    if (!res.ok) {
      if (hit) return NextResponse.json(hit.data)
      return NextResponse.json([], { status: res.status })
    }
    const data = await res.json()
    cache.set(key, { data, ts: Date.now() })
    return NextResponse.json(data)
  } catch {
    if (hit) return NextResponse.json(hit.data)
    return NextResponse.json([], { status: 504 })
  }
}
