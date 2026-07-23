import { describe, expect, it } from 'vitest'
import { mergeTokenData } from './alcor'
import { CHAINS } from './chains'

describe('mergeTokenData', () => {
  it('uses the default swap pool price and change', () => {
    const tokens = [
      { id: 'wax-eosio.token', symbol: 'WAX', contract: 'eosio.token', decimals: 8, system_price: 1, usd_price: 0.03 },
      { id: 'foo-token', symbol: 'FOO', contract: 'token', decimals: 4, system_price: 1, usd_price: 99 },
    ]
    const pools = [
      { id: 1, active: true, tokenA: { id: 'foo-token', symbol: 'FOO', contract: 'token' }, tokenB: { id: 'wax-eosio.token', symbol: 'WAX', contract: 'eosio.token' }, change24: 2, changeWeek: 3, volumeUSD24: 10, volumeUSDWeek: 10, volumeUSDMonth: 10, tvlUSD: 100, priceA: 2, priceB: 0.5 },
      { id: 2, active: true, tokenA: { id: 'foo-token', symbol: 'FOO', contract: 'token' }, tokenB: { id: 'wax-eosio.token', symbol: 'WAX', contract: 'eosio.token' }, change24: 9, changeWeek: 8, volumeUSD24: 10, volumeUSDWeek: 10, volumeUSDMonth: 10, tvlUSD: 200, priceA: 4, priceB: 0.25 },
    ]

    const [token] = mergeTokenData(tokens, [], pools, CHAINS.wax)
    expect(token.usd_price).toBe(0.12)
    expect(token.change24).toBe(9)
    expect(token.change7d).toBe(8)
  })
})
