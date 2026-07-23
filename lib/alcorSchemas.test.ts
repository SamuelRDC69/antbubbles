import { describe, expect, it } from 'vitest'
import { parseAlcorPayloads } from './alcorSchemas'

const token = { contract: 'eosio.token', decimals: '8', symbol: 'WAX', id: 'wax-eosio.token', system_price: '1', usd_price: '0.03' }
const ticker = { ticker_id: 'wax-usdt', market_id: '1', base_currency: 'wax-eosio.token', target_currency: 'usdt-tethertether', global_ticker_id: null, last_price: '0.03', change24: '0', high24: '0.04', low24: '0.02', bid: '0.03', ask: '0.031', base_volume: '1', target_volume: '1', frozen: false, fee: '0', base_amm_liquidity: '0', target_amm_liquidity: '0' }
const pool = { id: '1', active: true, tokenA: { id: 'wax-eosio.token', symbol: 'WAX', contract: 'eosio.token' }, tokenB: { id: 'usdt-tethertether', symbol: 'USDT', contract: 'tethertether' }, change24: '0', changeWeek: '0', volumeUSD24: '1', volumeUSDWeek: '1', volumeUSDMonth: '1', tvlUSD: '1', priceA: '1', priceB: '1' }

describe('parseAlcorPayloads', () => {
  it('coerces numeric API fields and rejects malformed payloads', () => {
    const parsed = parseAlcorPayloads([token], [{ ...ticker, bid: 'NaN', ask: 'NaN' }], [pool])
    expect(parsed.tokens[0].usd_price).toBe(0.03)
    expect(parsed.tickers[0].bid).toBe(0)
    expect(() => parseAlcorPayloads([{ ...token, decimals: 'bad' }], [ticker], [pool])).toThrow()
  })
})
