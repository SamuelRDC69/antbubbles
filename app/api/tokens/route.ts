export const runtime = 'edge'

import { NextRequest, NextResponse } from 'next/server'
import { getTokensForChain } from '@/lib/serverTokens'
import { getRedis, REDIS_KEYS } from '@/lib/redis'

// Consolidated token endpoint — fetches tokens + tickers + pools from Alcor in
// parallel server-side, merges and filters them, and returns a single processed
// payload. Users make 1 request instead of 3, and receive only what the UI needs.
//
// Data priority:
//   1. Upstash Redis (populated by the Railway worker every 30 s) → instant
//   2. Direct Alcor fetch via getTokensForChain()                 → ~1–2 s fallback

export async function GET(req: NextRequest) {
  const chainId = req.nextUrl.searchParams.get('chain') ?? 'wax'

  // 1. Try Redis (Railway worker keeps this fresh)
  const redis = getRedis()
  if (redis) {
    try {
      const cached = await redis.get<unknown>(REDIS_KEYS.tokens(chainId))
      if (cached) {
        return NextResponse.json(cached, {
          headers: { 'X-Data-Source': 'redis' },
        })
      }
    } catch { /* Redis unavailable — fall through */ }
  }

  // 2. Fallback: fetch directly from Alcor
  const { data, status } = await getTokensForChain(chainId)
  return NextResponse.json(data, { status })
}
