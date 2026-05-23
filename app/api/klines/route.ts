export const runtime = 'edge'

import { NextRequest, NextResponse } from 'next/server'

// Two-layer cache: in-process Map (L1) + next: revalidate (L2, Vercel Data Cache)

function ttlMs(resolution: string): number {
  // Historical candles don't change — cache aggressively.
  // Only recent sub-hourly bars need short TTLs.
  if (resolution === '1M')  return 24 * 60 * 60 * 1000   // 24 h
  if (resolution === '1W')  return 12 * 60 * 60 * 1000   // 12 h
  if (resolution === '1D')  return  6 * 60 * 60 * 1000   //  6 h
  if (resolution === '240') return 30 * 60 * 1000         // 30 min
  if (resolution === '60')  return 15 * 60 * 1000         // 15 min
  return 3 * 60 * 1000                                    //  3 min
}
function ttlS(resolution: string): number { return ttlMs(resolution) / 1000 }

const cache = new Map<string, { data: unknown; ts: number }>()

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const chain      = searchParams.get('chain')      ?? 'wax'
  const tickerId   = searchParams.get('ticker_id')  ?? ''
  const resolution = searchParams.get('resolution') ?? '1D'
  const from       = searchParams.get('from')       ?? ''
  const to         = searchParams.get('to')         ?? ''

  if (!tickerId) return NextResponse.json({ error: 'ticker_id required' }, { status: 400 })

  const key = `${chain}:${tickerId}:${resolution}:${from}:${to}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.ts < ttlMs(resolution)) return NextResponse.json(hit.data)

  const url = new URL(`https://${chain}.alcor.exchange/api/v2/tickers/${encodeURIComponent(tickerId)}/charts`)
  url.searchParams.set('resolution', resolution)
  if (from) url.searchParams.set('from', from)
  if (to)   url.searchParams.set('to',   to)

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
