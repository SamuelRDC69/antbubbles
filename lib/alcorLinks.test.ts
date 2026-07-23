import { afterEach, describe, expect, it } from 'vitest'
import { CHAINS } from './chains'
import { buildAlcorSwapUrl } from './alcorLinks'

afterEach(() => {
  delete process.env.NEXT_PUBLIC_ALCOR_MARKET
})

describe('buildAlcorSwapUrl', () => {
  it('opens the current WAX swap frontend with WAX as input', () => {
    const url = new URL(buildAlcorSwapUrl(CHAINS.wax, { id: 'kek-waxpepetoken' })!)

    expect(url.origin + url.pathname).toBe('https://alcor.exchange/v/wax/swap')
    expect(url.searchParams.get('input')).toBe('wax-eosio.token')
    expect(url.searchParams.get('output')).toBe('kek-waxpepetoken')
  })

  it('uses the active chain native token and includes a valid referral market', () => {
    process.env.NEXT_PUBLIC_ALCOR_MARKET = 'antbubblesgm'
    const url = new URL(buildAlcorSwapUrl(CHAINS.telos, { id: 'token-example' })!)

    expect(url.pathname).toBe('/v/telos/swap')
    expect(url.searchParams.get('input')).toBe('tlos-eosio.token')
    expect(url.searchParams.get('market')).toBe('antbubblesgm')
  })

  it('omits invalid referral accounts and native-to-native swaps', () => {
    process.env.NEXT_PUBLIC_ALCOR_MARKET = 'not-a-wax-account'

    expect(buildAlcorSwapUrl(CHAINS.wax, { id: 'wax-eosio.token' })).toBeNull()
    expect(new URL(buildAlcorSwapUrl(CHAINS.wax, { id: 'kek-waxpepetoken' })!)
      .searchParams.has('market')).toBe(false)
  })
})
