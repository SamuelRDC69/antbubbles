import { describe, expect, it } from 'vitest'
import { formatPrice, formatTokenPrice } from './bubbleUtils'

describe('formatPrice', () => {
  it('compacts tiny prices without dropping significant digits', () => {
    expect(formatPrice(0.0000000001109)).toBe('$0.0₉1109')
  })

  it('formats a tiny native-token swap price without rounding it to eight decimals', () => {
    expect(formatTokenPrice(0.000000028734)).toBe('0.0₇28734')
  })

  it('keeps six significant digits in the chart-axis format', () => {
    expect(formatTokenPrice(0.00000260937)).toBe('0.0₅260937')
  })
})
