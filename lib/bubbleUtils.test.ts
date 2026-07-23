import { describe, expect, it } from 'vitest'
import { formatPrice } from './bubbleUtils'

describe('formatPrice', () => {
  it('compacts tiny prices without dropping significant digits', () => {
    expect(formatPrice(0.0000000001109)).toBe('$0.0₉1109')
  })
})
