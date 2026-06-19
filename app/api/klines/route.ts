export const runtime = 'edge'

import { NextRequest, NextResponse } from 'next/server'
import { getRedis, REDIS_KEYS } from '@/lib/redis'

// Redis-only cache check — returns instantly.
// Browser handles the Alcor fetch directly when this is a miss (Alcor blocks
// datacenter IPs but allows browser requests, CORS: access-control-allow-origin: *)

function ttlMs(resolution: string): number {
  if (resolution === '1M')  return 24 * 60 * 60 * 1000
  if (resolution === '1W')  return 12 * 60 * 60 * 1000
  if (resolution === '1D')  return  6 * 60 * 60 * 1000
  if (resolution === '240') return 30 * 60 * 1000
  if (resolution === '60')  return 15 * 60 * 1000
  return 3 * 60 * 1000
}

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

  // L1 — in-process Map (sub-millisecond)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.ts < ttlMs(resolution)) {
    return NextResponse.json(hit.data, { headers: { 'X-Data-Source': 'memory' } })
  }

  // L0 — Redis (pre-warmed by Railway worker)
  const redis = getRedis()
  if (redis) {
    try {
      const cached = await redis.get<unknown>(REDIS_KEYS.klines(key))
      if (cached) {
        cache.set(key, { data: cached, ts: Date.now() })
        return NextResponse.json(cached, { headers: { 'X-Data-Source': 'redis' } })
      }

      let latest = await redis.get<unknown>(
        REDIS_KEYS.klinesLatest(chain, tickerId, resolution),
      )

      // Compatibility with chart entries written before stable latest keys
      // existed. This can be removed after old exact-hour keys expire.
      if (!latest) {
        const [, keys] = await redis.scan(0, {
          match: `chart:klines:${chain}:${tickerId}:${resolution}:*`,
          count: 100,
        })
        const newest = [...keys].sort().at(-1)
        if (newest) latest = await redis.get<unknown>(newest)
      }

      if (latest) {
        cache.set(key, { data: latest, ts: Date.now() })
        return NextResponse.json(latest, { headers: { 'X-Data-Source': 'redis-latest' } })
      }
    } catch { /* Redis unavailable */ }
  }

  // Cache miss — tell the browser to fetch Alcor directly (returns immediately)
  return NextResponse.json([], { headers: { 'X-Cache-Status': 'miss' } })
}
