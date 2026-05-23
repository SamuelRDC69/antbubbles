// GET /api/swap-quote?chain=wax&tokenIn=wax-eosio.token&tokenOut=usdt-usdt.alcor&amountIn=100
//
// Returns the best swap route + expected output for a given input amount.
// Uses Alcor pool reserves to compute quotes via the constant-product AMM formula.
// Handles direct pools and 2-hop routes through the chain's system token.

import { NextRequest } from 'next/server'
import { CHAINS } from '@/lib/chains'

// Alcor's full pool response includes token quantities (reserves).
// The /swap/pools endpoint returns these even though we only use TVL/volume
// in our bubble chart — here we use the raw quantity strings.
interface PoolToken {
  id:       string
  symbol:   string
  contract: string
  decimals: number
  quantity: number   // human-readable reserve, e.g. 5000.00000000
}

interface AlcorPoolFull {
  id:      number
  active:  boolean
  fee:     number    // parts-per-million, e.g. 3000 = 0.3%
  tokenA:  PoolToken
  tokenB:  PoolToken
}

export interface SwapQuote {
  amountOut:   number   // raw output amount (not formatted)
  minAmountOut:number   // after default 0.5% slippage
  priceImpact: number   // percent
  route:       number[] // ordered pool IDs
  outDecimals: number
  outSymbol:   string
  outContract: string
  inDecimals:  number
  fee:         number   // total pool fee (parts-per-million)
}

function parseReserve(quantity: number): number {
  return quantity ?? 0
}

// Constant-product AMM with Alcor fee denominator of 1,000,000
function ammOut(amtIn: number, resIn: number, resOut: number, fee: number): number {
  if (resIn <= 0 || resOut <= 0 || amtIn <= 0) return 0
  const comp = 1_000_000 - fee
  return (amtIn * comp * resOut) / (resIn * 1_000_000 + amtIn * comp)
}

function priceImpact(amtIn: number, resIn: number, resOut: number, amtOut: number): number {
  const spot = resOut / resIn   // tokens out per token in at current price
  const ideal = amtIn * spot
  if (ideal <= 0) return 0
  return Math.max(0, (ideal - amtOut) / ideal * 100)
}

export async function GET(req: NextRequest) {
  const sp       = req.nextUrl.searchParams
  const chainId  = sp.get('chain')    ?? 'wax'
  const tokenIn  = sp.get('tokenIn')  ?? ''
  const tokenOut = sp.get('tokenOut') ?? ''
  const amtIn    = parseFloat(sp.get('amountIn') ?? '0')

  const chain = CHAINS[chainId]
  if (!chain || !tokenIn || !tokenOut || amtIn <= 0) {
    return Response.json({ error: 'invalid params' }, { status: 400 })
  }
  if (tokenIn === tokenOut) {
    return Response.json({ error: 'same token' }, { status: 400 })
  }

  try {
    const poolsRes = await fetch(`${chain.apiBase}/swap/pools`, {
      next:   { revalidate: 5 },
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
    })
    if (!poolsRes.ok) throw new Error('pools fetch failed')
    const allPools: AlcorPoolFull[] = await poolsRes.json()

    // Only use active pools that have reserve data
    const active = allPools.filter(p =>
      p.active && (p.tokenA?.quantity ?? 0) > 0 && (p.tokenB?.quantity ?? 0) > 0
    )

    const sysToken = `${chain.systemToken.toLowerCase()}-${chain.systemContract}`

    // Helper: get reserve amounts given desired direction
    function reserves(p: AlcorPoolFull, inId: string) {
      const aIsIn = p.tokenA.id === inId
      return {
        resIn:    parseReserve(aIsIn ? p.tokenA.quantity : p.tokenB.quantity),
        resOut:   parseReserve(aIsIn ? p.tokenB.quantity : p.tokenA.quantity),
        outToken: aIsIn ? p.tokenB : p.tokenA,
      }
    }

    type RouteResult = SwapQuote

    const candidates: RouteResult[] = []

    // ── Direct pools ────────────────────────────────────────────────────────
    const directPools = active.filter(p =>
      (p.tokenA.id === tokenIn && p.tokenB.id === tokenOut) ||
      (p.tokenB.id === tokenIn && p.tokenA.id === tokenOut)
    )
    for (const pool of directPools) {
      const { resIn, resOut, outToken } = reserves(pool, tokenIn)
      const out    = ammOut(amtIn, resIn, resOut, pool.fee)
      const impact = priceImpact(amtIn, resIn, resOut, out)
      const inToken = pool.tokenA.id === tokenIn ? pool.tokenA : pool.tokenB
      candidates.push({
        amountOut:    out,
        minAmountOut: out * 0.995,   // 0.5% default slippage
        priceImpact:  impact,
        route:        [pool.id],
        outDecimals:  outToken.decimals,
        outSymbol:    outToken.symbol,
        outContract:  outToken.contract,
        inDecimals:   inToken.decimals,
        fee:          pool.fee,
      })
    }

    // ── 2-hop via system token ───────────────────────────────────────────────
    if (tokenIn !== sysToken && tokenOut !== sysToken) {
      const leg1 = active.filter(p =>
        (p.tokenA.id === tokenIn && p.tokenB.id === sysToken) ||
        (p.tokenB.id === tokenIn && p.tokenA.id === sysToken)
      )
      const leg2 = active.filter(p =>
        (p.tokenA.id === sysToken && p.tokenB.id === tokenOut) ||
        (p.tokenB.id === sysToken && p.tokenA.id === tokenOut)
      )
      if (leg1.length > 0 && leg2.length > 0) {
        // Best leg1: maximise mid amount
        const bestLeg1 = leg1
          .map(p => {
            const r = reserves(p, tokenIn)
            return { pool: p, mid: ammOut(amtIn, r.resIn, r.resOut, p.fee), inToken: p.tokenA.id === tokenIn ? p.tokenA : p.tokenB }
          })
          .sort((a, b) => b.mid - a.mid)[0]

        // Best leg2: maximise final output given mid
        const bestLeg2 = leg2
          .map(p => {
            const r = reserves(p, sysToken)
            return { pool: p, out: ammOut(bestLeg1.mid, r.resIn, r.resOut, p.fee), outToken: r.outToken }
          })
          .sort((a, b) => b.out - a.out)[0]

        const r1      = reserves(bestLeg1.pool, tokenIn)
        const r2      = reserves(bestLeg2.pool, sysToken)
        const impact1 = priceImpact(amtIn,          r1.resIn, r1.resOut, bestLeg1.mid)
        const impact2 = priceImpact(bestLeg1.mid,   r2.resIn, r2.resOut, bestLeg2.out)

        candidates.push({
          amountOut:    bestLeg2.out,
          minAmountOut: bestLeg2.out * 0.995,
          priceImpact:  impact1 + impact2,
          route:        [bestLeg1.pool.id, bestLeg2.pool.id],
          outDecimals:  bestLeg2.outToken.decimals,
          outSymbol:    bestLeg2.outToken.symbol,
          outContract:  bestLeg2.outToken.contract,
          inDecimals:   bestLeg1.inToken.decimals,
          fee:          bestLeg1.pool.fee + bestLeg2.pool.fee,
        })
      }
    }

    if (candidates.length === 0) {
      return Response.json({ error: 'no route found' }, { status: 404 })
    }

    // Return the route with the best output
    const best = candidates.sort((a, b) => b.amountOut - a.amountOut)[0]
    return Response.json(best)

  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown error'
    return Response.json({ error: msg }, { status: 502 })
  }
}
