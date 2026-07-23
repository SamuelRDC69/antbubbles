import { describe, expect, it } from 'vitest'
import {
  AD_PERIODS,
  AD_RECIPIENT,
  PAYMENT_TOKENS,
  AdPricingState,
  AdReservation,
  adDemandMultiplier,
  adQuoteUsd,
  bookingOverlaps,
  hasExpectedPayment,
  ipfsImageUrl,
  recordAdUsage,
  safeAdColor,
  safeHttpUrl,
  tokenQuantity,
} from './ads'

const reservation: AdReservation = {
  id: 'abc',
  submissionId: 'submission',
  text: 'Try this',
  imageUrl: '',
  linkUrl: 'https://example.com/',
  hours: 1,
  buyer: 'buyer.gm',
  contract: 'waxpepetoken',
  symbol: 'KEK',
  quantity: '10.0000 KEK',
  memo: 'antbubbles-ad:abc',
  feeUsd: 1,
  quotedAt: 0,
  startAt: 3_600_000,
  endAt: 7_200_000,
}

describe('marketing ad payments', () => {
  it('accepts only the exact executed transfer', () => {
    const payment = {
      executed: true,
      actions: [{ act: { account: 'waxpepetoken', name: 'transfer', data: {
        from: 'buyer.gm', to: AD_RECIPIENT, quantity: '10.0000 KEK', memo: 'antbubbles-ad:abc',
      } } }],
    }
    expect(hasExpectedPayment(payment, reservation)).toBe(true)
    expect(hasExpectedPayment({ ...payment, executed: false }, reservation)).toBe(false)
    expect(hasExpectedPayment({ ...payment, actions: [{ act: { ...payment.actions[0].act, data: {
      ...payment.actions[0].act.data, quantity: '1.0000 KEK',
    } } }] }, reservation)).toBe(false)

    const waxReservation = {
      ...reservation,
      contract: PAYMENT_TOKENS.WAX.contract,
      symbol: 'WAX' as const,
      quantity: '25.00000000 WAX',
    }
    expect(hasExpectedPayment({
      executed: true,
      actions: [{ act: { account: 'eosio.token', name: 'transfer', data: {
        from: 'buyer.gm', to: AD_RECIPIENT, quantity: '25.00000000 WAX', memo: 'antbubbles-ad:abc',
      } } }],
    }, waxReservation)).toBe(true)
  })

  it('rounds payment up and rejects unsafe links', () => {
    expect(tokenQuantity(1, 3, 'KEK')).toBe('0.3334 KEK')
    expect(tokenQuantity(1, 0.04, 'WAX')).toBe('25.00000000 WAX')
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull()
    expect(safeHttpUrl('https://example.com')).toBe('https://example.com/')
    expect(safeHttpUrl('/api/logo?id=kek-waxpepetoken', true, true)).toBe('/api/logo?id=kek-waxpepetoken')
    expect(safeHttpUrl('//evil.example/logo.png', true, true)).toBeNull()
    expect(ipfsImageUrl('ipfs://bafybeigdyrztabcdefghijklmnop')).toBe(
      'https://ipfs.io/ipfs/bafybeigdyrztabcdefghijklmnop',
    )
    expect(ipfsImageUrl('https://example.com/image.png')).toBeNull()
    expect(safeAdColor('#FfD700')).toBe('#ffd700')
    expect(safeAdColor('red')).toBeNull()
  })

  it('makes longer bundles cheaper per hour', () => {
    const hourlyRates = AD_PERIODS.map(period => period.usd / period.hours)
    expect(hourlyRates.every((rate, index) => index === 0 || rate < hourlyRates[index - 1])).toBe(true)
  })

  it('allows adjacent hourly bookings but rejects overlaps', () => {
    const slot = { startAt: 3_600_000, endAt: 7_200_000 }
    expect(bookingOverlaps(0, 3_600_000, slot)).toBe(false)
    expect(bookingOverlaps(7_200_000, 10_800_000, slot)).toBe(false)
    expect(bookingOverlaps(3_600_000, 7_200_000, slot)).toBe(true)
  })

  it('raises demand pricing without a cap and decays back to the floor', () => {
    const now = 1_000_000_000_000
    let state: AdPricingState | null = null
    for (let index = 0; index < 20; index++) {
      state = recordAdUsage(state, 720, now, `tx-${index}`)
    }
    expect(adDemandMultiplier(state, now)).toBeGreaterThan(1_000)
    expect(adQuoteUsd(0.25, state, now)).toBeGreaterThan(250)
    expect(adQuoteUsd(0.25, state, now + 365 * 24 * 3600 * 1000)).toBe(0.25)
  })

  it('does not count a confirmed transaction twice', () => {
    const state = recordAdUsage(null, 24, 1, 'same-tx')
    expect(recordAdUsage(state, 24, 2, 'same-tx')).toBe(state)
  })
})
