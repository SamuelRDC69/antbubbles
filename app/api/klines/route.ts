export const runtime = 'edge'

import { NextRequest, NextResponse } from 'next/server'
import { getRedis, REDIS_KEYS, chartTtlS } from '@/lib/redis'

const ALCOR_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// Three-layer cache:
//   L0 — Upstash Redis (written by Railway worker, shared across all edge instances)
//   L1 — in-process Map (per-instance, sub-millisecond)
//   L2 — next: revalidate  (Vercel Data Cache)

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

  // L1 — in-process Map
  const hit = cache.get(key)
  if (hit && Date.now() - hit.ts < ttlMs(resolution)) return NextResponse.json(hit.data)

  // L0 — Redis (pre-warmed by Railway worker)
  const redis = getRedis()
  if (redis) {
    try {
      const cached = await redis.get<unknown>(REDIS_KEYS.klines(key))
      if (cached) {
        cache.set(key, { data: cached, ts: Date.now() })   // warm L1 too
        return NextResponse.json(cached, {
          headers: { 'X-Data-Source': 'redis' },
        })
      }
    } catch { /* Redis unavailable — fall through */ }
  }

  const url = new URL(`https://${chain}.alcor.exchange/api/v2/tickers/${encodeURIComponent(tickerId)}/charts`)
  url.searchParams.set('resolution', resolution)
  if (from) url.searchParams.set('from', from)
  if (to)   url.searchParams.set('to',   to)

  try {
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(25_000),
      headers: { 'User-Agent': ALCOR_UA },
      next: { revalidate: ttlS(resolution) },
    })
    if (!res.ok) {
      if (hit) return NextResponse.json(hit.data)
      return NextResponse.json([], { status: res.status })
    }
    const data = await res.json()
    cache.set(key, { data, ts: Date.now() })
    // Write back to Redis so other edge instances skip Alcor too
    if (redis) {
      try { await redis.set(REDIS_KEYS.klines(key), data, { ex: chartTtlS(resolution) }) } catch { /* non-fatal */ }
    }
    const ttl = ttlS(resolution)
    return NextResponse.json(data, {
      headers: { 'Cache-Control': `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 2}` },
    })
  } catch {
    if (hit) return NextResponse.json(hit.data)
    return NextResponse.json([], { status: 504 })
  }
}
