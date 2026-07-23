import 'server-only'

import { CurrencyAmount, Pool, Tick, Token } from '@alcorexchange/alcor-swap-sdk'

const API_TTL_MS = 30_000
const cache = new Map<string, { value: LoadedPool; expires: number }>()

type ApiToken = { id: string; contract: string; decimals: number; symbol: string }
type ApiPool = {
  id: number
  active: boolean
  fee: number
  sqrtPriceX64: string
  liquidity: string
  tick: number
  feeGrowthGlobalAX64?: string
  feeGrowthGlobalBX64?: string
  tokenA: ApiToken
  tokenB: ApiToken
}
type ApiTick = {
  id: number
  liquidityGross: string
  liquidityNet: string
  feeGrowthOutsideAX64?: string
  feeGrowthOutsideBX64?: string
  tickCumulativeOutside?: number
  secondsPerLiquidityOutsideX64?: string
  secondsOutside?: number
}

export type LoadedPool = {
  raw: ApiPool
  sdk: Pool
  tokenA: Token
  tokenB: Token
}

export interface DepthBand {
  impact: number
  buyUsd: number
  sellUsd: number
}

function toToken(token: ApiToken): Token {
  return new Token(token.contract, token.decimals, token.symbol)
}

function toPool(raw: ApiPool, ticks: ApiTick[]): LoadedPool {
  const tokenA = toToken(raw.tokenA)
  const tokenB = toToken(raw.tokenB)
  const sdk = new Pool({
    id: raw.id,
    active: raw.active,
    tokenA,
    tokenB,
    fee: raw.fee,
    sqrtPriceX64: raw.sqrtPriceX64,
    liquidity: raw.liquidity,
    tickCurrent: raw.tick,
    feeGrowthGlobalAX64: raw.feeGrowthGlobalAX64 ?? '0',
    feeGrowthGlobalBX64: raw.feeGrowthGlobalBX64 ?? '0',
    ticks: ticks.map(t => new Tick({
      id: t.id,
      liquidityGross: t.liquidityGross,
      liquidityNet: t.liquidityNet,
      feeGrowthOutsideAX64: t.feeGrowthOutsideAX64 ?? '0',
      feeGrowthOutsideBX64: t.feeGrowthOutsideBX64 ?? '0',
      tickCumulativeOutside: t.tickCumulativeOutside ?? 0,
      secondsPerLiquidityOutsideX64: t.secondsPerLiquidityOutsideX64 ?? '0',
      secondsOutside: t.secondsOutside ?? 0,
    })),
  })
  return { raw, sdk, tokenA, tokenB }
}

export async function loadAlcorV2Pool(chain: string, id: number): Promise<LoadedPool> {
  const key = `${chain}:${id}`
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return hit.value

  const base = `https://${chain}.alcor.exchange/api/v2/swap/pools/${id}`
  const headers = { 'User-Agent': 'Mozilla/5.0' }
  const [poolRes, ticksRes] = await Promise.all([
    fetch(base, { headers, signal: AbortSignal.timeout(15_000) }),
    fetch(`${base}/ticks`, { headers, signal: AbortSignal.timeout(15_000) }),
  ])
  if (!poolRes.ok || !ticksRes.ok) throw new Error('Unable to load Alcor v2 pool state')
  const [raw, ticks] = await Promise.all([
    poolRes.json() as Promise<ApiPool>,
    ticksRes.json() as Promise<ApiTick[]>,
  ])
  const value = toPool(raw, ticks)
  cache.set(key, { value, expires: Date.now() + API_TTL_MS })
  return value
}

function quoteImpact(pool: Pool, inputToken: Token, rawInput: bigint): number {
  if (rawInput <= BigInt(0)) return 0
  try {
    const input = CurrencyAmount.fromRawAmount(inputToken, rawInput)
    const output = pool.getOutputAmount(input)
    const inputAmount = Number(input.toExact())
    const outputAmount = Number(output.toExact())
    const spot = Number(pool.priceOf(inputToken).toSignificant(18))
    const afterFee = inputAmount * spot * (1 - pool.fee / 1_000_000)
    if (afterFee <= 0 || outputAmount <= 0) return Number.POSITIVE_INFINITY
    return Math.max(0, (1 - outputAmount / afterFee) * 100)
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function inputUsdValue(pool: Pool, inputToken: Token, rawInput: bigint, selectedToken: Token, selectedUsdPrice: number): number {
  const amount = Number(CurrencyAmount.fromRawAmount(inputToken, rawInput).toExact())
  const inputUsdPrice = inputToken.equals(selectedToken)
    ? selectedUsdPrice
    : Number(pool.priceOf(inputToken).toSignificant(18)) * selectedUsdPrice
  const value = amount * inputUsdPrice
  return Number.isFinite(value) && value > 0 ? value : 0
}

function capacitiesForDirection(
  pool: Pool,
  inputToken: Token,
  selectedToken: Token,
  selectedUsdPrice: number,
  impacts: number[],
): number[] {
  const unit = BigInt(10) ** BigInt(inputToken.decimals)
  const hardLimit = unit * (BigInt(2) ** BigInt(60))
  const outputToken = inputToken.equals(pool.tokenA) ? pool.tokenB : pool.tokenA
  const spot = Number(pool.priceOf(inputToken).toSignificant(18))
  const preciseQuoteRaw = Number.isFinite(spot) && spot > 0
    ? BigInt(Math.max(1, Math.ceil((10_000 / (10 ** outputToken.decimals)) / spot * (10 ** inputToken.decimals))))
    : unit
  const inputForPreciseQuote = preciseQuoteRaw > unit ? preciseQuoteRaw : unit
  let previous = BigInt(0)

  return impacts.map(target => {
    let low = previous
    let high = low > BigInt(0) ? low * BigInt(2) : inputForPreciseQuote

    while (high < hardLimit && quoteImpact(pool, inputToken, high) <= target) {
      low = high
      high *= BigInt(2)
    }
    if (high > hardLimit) high = hardLimit

    for (let i = 0; i < 24 && high - low > BigInt(1); i += 1) {
      const mid = (low + high) / BigInt(2)
      if (quoteImpact(pool, inputToken, mid) <= target) low = mid
      else high = mid
    }

    previous = low
    return inputUsdValue(pool, inputToken, low, selectedToken, selectedUsdPrice)
  })
}

export function poolDepthBands(
  loaded: LoadedPool,
  selectedTokenId: string,
  selectedUsdPrice: number,
  impacts: number[],
): DepthBand[] {
  const selectedIsA = loaded.raw.tokenA.id === selectedTokenId
  const selectedIsB = loaded.raw.tokenB.id === selectedTokenId
  if ((!selectedIsA && !selectedIsB) || selectedUsdPrice <= 0) {
    return impacts.map(impact => ({ impact, buyUsd: 0, sellUsd: 0 }))
  }

  const selectedToken = selectedIsA ? loaded.tokenA : loaded.tokenB
  const counterpartToken = selectedIsA ? loaded.tokenB : loaded.tokenA
  const sell = capacitiesForDirection(loaded.sdk, selectedToken, selectedToken, selectedUsdPrice, impacts)
  const buy = capacitiesForDirection(loaded.sdk, counterpartToken, selectedToken, selectedUsdPrice, impacts)

  return impacts.map((impact, index) => ({
    impact,
    buyUsd: buy[index],
    sellUsd: sell[index],
  }))
}
