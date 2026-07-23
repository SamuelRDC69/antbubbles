import { describe, expect, it } from 'vitest'
import { isAlcorTradingAllowed, isEuCountry } from './tradingAccess'

describe('isEuCountry', () => {
  it('recognizes all 27 EU member countries', () => {
    const members = [
      'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI',
      'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU',
      'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
    ]
    expect(members.every(isEuCountry)).toBe(true)
    expect(isEuCountry(' de ')).toBe(true)
  })

  it('does not treat non-EU or unavailable locations as EU', () => {
    expect(isEuCountry('GB')).toBe(false)
    expect(isEuCountry('US')).toBe(false)
    expect(isEuCountry(null)).toBe(false)
  })
})

describe('isAlcorTradingAllowed', () => {
  it('allows a valid non-EU country and fails closed without a valid country', () => {
    expect(isAlcorTradingAllowed('GB')).toBe(true)
    expect(isAlcorTradingAllowed('US')).toBe(true)
    expect(isAlcorTradingAllowed('ES')).toBe(false)
    expect(isAlcorTradingAllowed(null)).toBe(false)
    expect(isAlcorTradingAllowed('unknown')).toBe(false)
  })
})
