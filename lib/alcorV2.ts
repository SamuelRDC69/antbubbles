import 'server-only'

import { Pool, Position, Tick, TickMath, Token } from '@alcorexchange/alcor-swap-sdk'

const API_TTL_MS = 30_000
const cache = new Map<string, { value: LoadedPool; expires: number }>()

type ApiToken = { id: string; contract: string; decimals: number; symbol: string }
type ApiPool = {
  id: number; active: boolean; fee: number; sqrtPriceX64: string; liquidity: string; tick: number
  tvlUSD?: number
  feeGrowthGlobalAX64?: string; feeGrowthGlobalBX64?: string; tokenA: ApiToken; tokenB: ApiToken
}
type ApiTick = { id: number; liquidityGross: string; liquidityNet: string; feeGrowthOutsideAX64?: string; feeGrowthOutsideBX64?: string; tickCumulativeOutside?: number; secondsPerLiquidityOutsideX64?: string; secondsOutside?: number }
type ApiPosition = { id: number; owner?: string; tickLower: number; tickUpper: number; liquidity: string; feeGrowthInsideALastX64?: string; feeGrowthInsideBLastX64?: string; feesA?: string; feesB?: string }

export type LoadedPool = { raw: ApiPool; positions: ApiPosition[]; sdk: Pool; tokenA: Token; tokenB: Token }

function amount(value: string | undefined): bigint {
  return BigInt((value ?? '0').split(' ')[0].split('.')[0] || '0')
}

function toToken(token: ApiToken): Token {
  return new Token(token.contract, token.decimals, token.symbol)
}

function toPool(raw: ApiPool, ticks: ApiTick[]): LoadedPool {
  const tokenA = toToken(raw.tokenA)
  const tokenB = toToken(raw.tokenB)
  const sdk = new Pool({
    id: raw.id, active: raw.active, tokenA, tokenB, fee: raw.fee,
    sqrtPriceX64: raw.sqrtPriceX64, liquidity: raw.liquidity, tickCurrent: raw.tick,
    feeGrowthGlobalAX64: raw.feeGrowthGlobalAX64 ?? '0', feeGrowthGlobalBX64: raw.feeGrowthGlobalBX64 ?? '0',
    ticks: ticks.map(t => new Tick({
      id: t.id, liquidityGross: t.liquidityGross, liquidityNet: t.liquidityNet,
      feeGrowthOutsideAX64: t.feeGrowthOutsideAX64 ?? '0', feeGrowthOutsideBX64: t.feeGrowthOutsideBX64 ?? '0',
      tickCumulativeOutside: t.tickCumulativeOutside ?? 0,
      secondsPerLiquidityOutsideX64: t.secondsPerLiquidityOutsideX64 ?? '0', secondsOutside: t.secondsOutside ?? 0,
    })),
  })
  return { raw, positions: [], sdk, tokenA, tokenB }
}

export async function loadAlcorV2Pool(chain: string, id: number): Promise<LoadedPool> {
  const key = `${chain}:${id}`
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return hit.value

  const base = `https://${chain}.alcor.exchange/api/v2/swap/pools/${id}`
  const headers = { 'User-Agent': 'Mozilla/5.0' }
  const [poolRes, ticksRes, positionsRes] = await Promise.all([
    fetch(base, { headers, signal: AbortSignal.timeout(15_000) }),
    fetch(`${base}/ticks`, { headers, signal: AbortSignal.timeout(15_000) }),
    fetch(`${base}/positions`, { headers, signal: AbortSignal.timeout(15_000) }),
  ])
  if (!poolRes.ok || !ticksRes.ok || !positionsRes.ok) throw new Error('Unable to load Alcor v2 pool state')
  const [raw, ticks, positions] = await Promise.all([
    poolRes.json() as Promise<ApiPool>, ticksRes.json() as Promise<ApiTick[]>, positionsRes.json() as Promise<ApiPosition[]>,
  ])
  const value = toPool(raw, ticks)
  value.positions = Array.isArray(positions) ? positions : []
  cache.set(key, { value, expires: Date.now() + API_TTL_MS })
  return value
}

export function positionUsdAtTick(
  loaded: LoadedPool,
  position: ApiPosition,
  tickLower: number,
  tickUpper: number,
  tickCurrent: number,
  selectedTokenId: string,
  selectedUsdPrice: number,
): number {
  if (tickUpper <= tickLower || position.liquidity === '0') return 0
  const sdk = new Pool({
    id: loaded.sdk.id, active: loaded.sdk.active, tokenA: loaded.tokenA, tokenB: loaded.tokenB, fee: loaded.sdk.fee,
    sqrtPriceX64: TickMath.getSqrtRatioAtTick(tickCurrent), liquidity: loaded.sdk.liquidity, tickCurrent,
    feeGrowthGlobalAX64: loaded.sdk.feeGrowthGlobalAX64, feeGrowthGlobalBX64: loaded.sdk.feeGrowthGlobalBX64,
    ticks: loaded.sdk.tickDataProvider,
  })
  const virtual = new Position({
    id: position.id, owner: position.owner ?? '', pool: sdk, liquidity: position.liquidity, tickLower, tickUpper,
    feeGrowthInsideALastX64: position.feeGrowthInsideALastX64 ?? '0', feeGrowthInsideBLastX64: position.feeGrowthInsideBLastX64 ?? '0',
    feesA: amount(position.feesA), feesB: amount(position.feesB),
  })
  const amountA = Number(virtual.amountA.toExact())
  const amountB = Number(virtual.amountB.toExact())
  const priceBPerA = Number(sdk.tokenAPrice.toSignificant(18))
  if (!Number.isFinite(amountA) || !Number.isFinite(amountB) || !Number.isFinite(priceBPerA) || priceBPerA <= 0) return 0
  const selectedIsB = loaded.raw.tokenB.id === selectedTokenId
  const usdA = selectedIsB ? selectedUsdPrice * priceBPerA : selectedUsdPrice
  const usdB = selectedIsB ? selectedUsdPrice : selectedUsdPrice / priceBPerA
  return amountA * usdA + amountB * usdB
}
