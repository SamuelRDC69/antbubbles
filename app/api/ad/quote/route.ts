export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { getRedis } from '@/lib/redis'
import { AD_PERIODS, AD_REDIS_KEYS, AdPricingState, adDemandMultiplier, adQuoteUsd } from '@/lib/ads'

export async function GET() {
  const now = Date.now()
  const state = await getRedis()?.get<AdPricingState>(AD_REDIS_KEYS.pricing) ?? null
  return NextResponse.json({
    asOf: now,
    multiplier: adDemandMultiplier(state, now),
    quotes: AD_PERIODS.map(period => ({
      hours: period.hours,
      usd: adQuoteUsd(period.usd, state, now),
    })),
  }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
