export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { startPoller } from '@/lib/dex-poller'
import { buildOffchainChartData, buildUsdChartDataFromRawCandles, filterRawCandles } from '@/lib/offchain-chart-service'
import { getRedis, REDIS_KEYS } from '@/lib/redis'
import type { Candle } from '@/lib/taco-db'

startPoller('nefty')

async function maybeReadRedis(req: NextRequest) {
  const tokenId = req.nextUrl.searchParams.get('token') ?? ''
  const resolution = Number(req.nextUrl.searchParams.get('resolution') ?? '3600')
  if (!tokenId || !resolution) return null
  const redis = getRedis()
  if (!redis) return null
  try {
    const cached = await redis.get<Candle[]>(REDIS_KEYS.offchainChart('nefty', tokenId, resolution))
    if (!Array.isArray(cached) || cached.length === 0) return null
    const filtered = filterRawCandles(cached, {
      pair: req.nextUrl.searchParams.get('pair'),
      path: req.nextUrl.searchParams.get('path'),
      symbol: req.nextUrl.searchParams.get('symbol'),
      resolution: req.nextUrl.searchParams.get('resolution'),
      from: req.nextUrl.searchParams.get('from'),
      to: req.nextUrl.searchParams.get('to'),
    })
    const data = await buildUsdChartDataFromRawCandles('nefty', {
      pair: req.nextUrl.searchParams.get('pair'),
      path: req.nextUrl.searchParams.get('path'),
      symbol: req.nextUrl.searchParams.get('symbol'),
      resolution: req.nextUrl.searchParams.get('resolution'),
      from: req.nextUrl.searchParams.get('from'),
      to: req.nextUrl.searchParams.get('to'),
    }, filtered)
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'no-store', 'X-Data-Source': 'redis' },
    })
  } catch {
    return null
  }
}

export async function GET(req: NextRequest) {
  const proxied = await maybeReadRedis(req)
  if (proxied) return proxied

  const out = await buildOffchainChartData('nefty', {
    pair: req.nextUrl.searchParams.get('pair'),
    path: req.nextUrl.searchParams.get('path'),
    symbol: req.nextUrl.searchParams.get('symbol'),
    resolution: req.nextUrl.searchParams.get('resolution'),
    from: req.nextUrl.searchParams.get('from'),
    to: req.nextUrl.searchParams.get('to'),
  })

  return NextResponse.json(out, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
