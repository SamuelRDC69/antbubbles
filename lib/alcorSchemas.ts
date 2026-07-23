import { z } from 'zod'
import type { AlcorPool, AlcorTicker, AlcorToken } from './types'

const number = z.coerce.number().finite()
const quoteNumber = z.preprocess((value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}, z.number())

const poolToken = z.object({
  id: z.string().min(1),
  symbol: z.string().min(1),
  contract: z.string().min(1),
})

const token = z.object({
  contract: z.string().min(1),
  decimals: number.int().nonnegative(),
  symbol: z.string().min(1),
  id: z.string().min(1),
  system_price: number,
  usd_price: number,
  score: number.optional(),
  is_scam: z.boolean().optional(),
  is_trusted: z.boolean().optional(),
  cmc_id: number.int().optional(),
})

const ticker = z.object({
  ticker_id: z.string(),
  market_id: number.int(),
  base_currency: z.string().min(1),
  target_currency: z.string().min(1),
  global_ticker_id: z.string().nullable(),
  last_price: number,
  change24: number,
  high24: number,
  low24: number,
  // Alcor uses the string "NaN" for empty order-book sides.
  bid: quoteNumber,
  ask: quoteNumber,
  base_volume: number,
  target_volume: number,
  frozen: z.boolean(),
  fee: number,
  base_amm_liquidity: number,
  target_amm_liquidity: number,
})

const pool = z.object({
  id: number.int(),
  active: z.boolean(),
  tokenA: poolToken,
  tokenB: poolToken,
  change24: number,
  changeWeek: number,
  volumeUSD24: number,
  volumeUSDWeek: number,
  volumeUSDMonth: number,
  tvlUSD: number,
  priceA: number.optional(),
  priceB: number.optional(),
})

export function parseAlcorPayloads(tokens: unknown, tickers: unknown, pools: unknown): {
  tokens: AlcorToken[]
  tickers: AlcorTicker[]
  pools: AlcorPool[]
} {
  return {
    tokens: z.array(token).parse(tokens) as AlcorToken[],
    tickers: z.array(ticker).parse(tickers) as AlcorTicker[],
    pools: z.array(pool).parse(pools) as AlcorPool[],
  }
}
