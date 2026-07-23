export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { loadAlcorV2Pool, poolDepthBands } from '@/lib/alcorV2'

const IMPACTS = [1, 2, 5, 10]

export async function GET(req: NextRequest) {
  const chain = req.nextUrl.searchParams.get('chain') ?? 'wax'
  const tokenId = req.nextUrl.searchParams.get('token_id') ?? ''
  const currentPrice = Number(req.nextUrl.searchParams.get('price'))
  const poolIds = (req.nextUrl.searchParams.get('pool_ids') ?? '')
    .split(',')
    .map(Number)
    .filter(Number.isSafeInteger)
    .slice(0, 10)

  if (!tokenId || !Number.isFinite(currentPrice) || currentPrice <= 0 || poolIds.length === 0) {
    return NextResponse.json({ error: 'token_id, price, and pool_ids are required' }, { status: 400 })
  }

  try {
    const results = await Promise.allSettled(poolIds.map(async id => {
      const pool = await loadAlcorV2Pool(chain, id)
      return poolDepthBands(pool, tokenId, currentPrice, IMPACTS)
    }))
    const perPool = results
      .filter((result): result is PromiseFulfilledResult<ReturnType<typeof poolDepthBands>> => result.status === 'fulfilled')
      .map(result => result.value)
    if (perPool.length === 0) throw new Error('No usable Alcor pools')

    const bands = IMPACTS.map((impact, index) => ({
      impact,
      buyUsd: perPool.reduce((sum, pool) => sum + pool[index].buyUsd, 0),
      sellUsd: perPool.reduce((sum, pool) => sum + pool[index].sellUsd, 0),
    }))

    return NextResponse.json({
      bands,
      poolCount: perPool.length,
      source: 'alcor-sdk-swap-simulation',
      timestamp: Date.now(),
    }, {
      headers: { 'Cache-Control': 'public, max-age=15, s-maxage=30, stale-while-revalidate=30' },
    })
  } catch (error) {
    console.error('Liquidity depth calculation failed', error)
    return NextResponse.json({ error: 'Unable to simulate liquidity depth' }, { status: 502 })
  }
}
