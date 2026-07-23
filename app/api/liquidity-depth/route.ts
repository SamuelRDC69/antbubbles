export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { loadAlcorV2Pool, positionUsdAtTick } from '@/lib/alcorV2'

const N_BUCKETS = 80
const TICK_RANGE = 6000

function toTick(price: number, currentPrice: number, currentTick: number, selectedIsB: boolean): number {
  const relative = price / currentPrice
  return currentTick + Math.log(selectedIsB ? 1 / relative : relative) / Math.log(1.0001)
}

export async function GET(req: NextRequest) {
  const chain = req.nextUrl.searchParams.get('chain') ?? 'wax'
  const tokenId = req.nextUrl.searchParams.get('token_id') ?? ''
  const currentPrice = Number(req.nextUrl.searchParams.get('price'))
  const poolIds = (req.nextUrl.searchParams.get('pool_ids') ?? '')
    .split(',').map(Number).filter(Number.isSafeInteger).slice(0, 10)
  if (!tokenId || !Number.isFinite(currentPrice) || currentPrice <= 0 || poolIds.length === 0) {
    return NextResponse.json({ error: 'token_id, price, and pool_ids are required' }, { status: 400 })
  }

  try {
    const low = currentPrice * Math.pow(1.0001, -TICK_RANGE)
    const high = currentPrice * Math.pow(1.0001, TICK_RANGE)
    const step = (high - low) / N_BUCKETS
    const buckets = Array.from({ length: N_BUCKETS }, (_, i) => ({ priceMid: low + (i + .5) * step, liquidity: 0 }))
    const pools = await Promise.all(poolIds.map(id => loadAlcorV2Pool(chain, id)))

    for (const pool of pools) {
      const selectedIsB = pool.raw.tokenB.id === tokenId
      if (!selectedIsB && pool.raw.tokenA.id !== tokenId) continue
      const raw = buckets.map(bucket => {
        const price0 = bucket.priceMid - step / 2
        const price1 = bucket.priceMid + step / 2
        const t0 = toTick(price0, currentPrice, pool.raw.tick, selectedIsB)
        const t1 = toTick(price1, currentPrice, pool.raw.tick, selectedIsB)
        const lower = Math.min(t0, t1)
        const upper = Math.max(t0, t1)
        const mid = Math.round((lower + upper) / 2)
        const spacing = pool.sdk.tickSpacing
        return pool.positions.reduce((sum, position) => {
          const start = Math.ceil(Math.max(lower, position.tickLower) / spacing) * spacing
          const end = Math.floor(Math.min(upper, position.tickUpper) / spacing) * spacing
          return sum + positionUsdAtTick(pool, position, start, end, mid, tokenId, bucket.priceMid)
        }, 0)
      })
      const total = raw.reduce((sum, value) => sum + value, 0)
      const tvl = pool.raw.tvlUSD ?? 0
      if (total <= 0 || tvl <= 0) continue
      raw.forEach((value, i) => { buckets[i].liquidity += value / total * tvl })
    }
    return NextResponse.json({ buckets, poolCount: pools.length, timestamp: Date.now() }, {
      headers: { 'Cache-Control': 'public, max-age=15, s-maxage=30, stale-while-revalidate=30' },
    })
  } catch (error) {
    console.error('Liquidity depth calculation failed', error)
    return NextResponse.json({ error: 'Unable to calculate liquidity depth' }, { status: 502 })
  }
}
