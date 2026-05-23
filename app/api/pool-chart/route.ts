export const runtime = 'edge'

import { NextRequest, NextResponse } from 'next/server'

// Two-layer cache: in-process Map (L1) + next: revalidate (L2, Vercel Data Cache)

function ttlMs(resolution: string): number {
  if (['1D', '1W'].includes(resolution)) return 60 * 60 * 1000
  if (resolution === '240') return 15 * 60 * 1000
  if (resolution === '60')  return 10 * 60 * 1000
  return 3 * 60 * 1000
}
function ttlS(resolution: string): number { return ttlMs(resolution) / 1000 }

const cache = new Map<string, { data: unknown; ts: number }>()

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const chain      = searchParams.get('chain')      ?? 'wax'
  const poolId     = searchParams.get('pool_id')    ?? ''
  const resolution = searchParams.get('resolution') ?? '1D'
  const from       = searchParams.get('from')       ?? ''
  const to         = searchParams.get('to')         ?? ''
  const reverse    = searchParams.get('reverse')    ?? ''

  if (!poolId) return NextResponse.json({ error: 'pool_id required' }, { status: 400 })

  const key = `pool:${chain}:${poolId}:${resolution}:${from}:${to}:${reverse}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.ts < ttlMs(resolution)) return NextResponse.json(hit.data)

  const url = new URL(`https://${chain}.alcor.exchange/api/v2/swap/pools/${poolId}/candles`)
  url.searchParams.set('resolution', resolution)
  if (from)    url.searchParams.set('from',    from)
  if (to)      url.searchParams.set('to',      to)
  if (reverse) url.searchParams.set('reverse', reverse)

  try {
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(12_000),
      next: { revalidate: ttlS(resolution) },
    })
    if (!res.ok) {
      if (hit) return NextResponse.json(hit.data)
      return NextResponse.json([], { status: res.status })
    }
    const data = await res.json()
    cache.set(key, { data, ts: Date.now() })
    const ttl = ttlS(resolution)
    return NextResponse.json(data, {
      headers: { 'Cache-Control': `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 2}` },
    })
  } catch {
    if (hit) return NextResponse.json(hit.data)
    return NextResponse.json([], { status: 504 })
  }
}
