export const runtime = 'edge'

import { NextRequest, NextResponse } from 'next/server'

// Two-layer cache: in-process Map (L1) + next: revalidate (L2, Vercel Data Cache)

const TTL_MS = 30_000
const TTL_S  = 30

const cache = new Map<string, { data: unknown; ts: number }>()

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const chain  = searchParams.get('chain')   ?? 'wax'
  const poolId = searchParams.get('pool_id') ?? ''

  if (!poolId) return NextResponse.json({ error: 'pool_id required' }, { status: 400 })

  const key = `depth:${chain}:${poolId}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.ts < TTL_MS) return NextResponse.json(hit.data)

  const base = `https://${chain}.alcor.exchange/api/v2/swap/pools/${poolId}`

  try {
    const [poolRes, posRes] = await Promise.all([
      fetch(base,                { signal: AbortSignal.timeout(10_000), next: { revalidate: TTL_S } }),
      fetch(`${base}/positions`, { signal: AbortSignal.timeout(10_000), next: { revalidate: TTL_S } }),
    ])

    const pool      = poolRes.ok ? await poolRes.json() : null
    const posRaw    = posRes.ok  ? await posRes.json()  : []
    const positions = Array.isArray(posRaw) ? posRaw : (posRaw?.rows ?? [])

    const data = {
      currentTick: typeof pool?.tick === 'number' ? pool.tick : 0,
      tickSpacing:  typeof pool?.tickSpacing === 'number' ? pool.tickSpacing : 1,
      tokenA: pool?.tokenA ?? null,
      tokenB: pool?.tokenB ?? null,
      positions: positions.map((p: Record<string, unknown>) => ({
        tickLower: Number(p.tickLower ?? p.tick_lower ?? 0),
        tickUpper: Number(p.tickUpper ?? p.tick_upper ?? 0),
        liquidity: String(p.liquidity ?? '0'),
      })).filter((p: { tickLower: number; tickUpper: number }) => p.tickUpper > p.tickLower),
    }

    cache.set(key, { data, ts: Date.now() })
    return NextResponse.json(data)
  } catch {
    if (hit) return NextResponse.json(hit.data)
    return NextResponse.json(
      { currentTick: 0, tickSpacing: 1, tokenA: null, tokenB: null, positions: [] },
      { status: 504 },
    )
  }
}
