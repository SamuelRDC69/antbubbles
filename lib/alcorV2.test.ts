import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

describe('poolDepthBands', () => {
  beforeAll(() => {
    vi.resetModules()
  })

  it('finds executable buy and sell notionals at each impact limit', async () => {
    const { CurrencyAmount, Token } = await import('@alcorexchange/alcor-swap-sdk')
    const { poolDepthBands } = await import('./alcorV2')
    const tokenA = new Token('token.a', 4, 'AAA')
    const tokenB = new Token('token.b', 4, 'BBB')
    const reserve = 1_000

    const mockPool = {
      fee: 0,
      tokenA,
      tokenB,
      priceOf: () => ({ toSignificant: () => '1' }),
      getOutputAmount: (input: { currency: typeof tokenA; toExact(): string }) => {
        const amountIn = Number(input.toExact())
        const amountOut = reserve * amountIn / (reserve + amountIn)
        const rawOut = BigInt(Math.floor(amountOut * 10_000))
        const outputToken = input.currency.equals(tokenA) ? tokenB : tokenA
        return CurrencyAmount.fromRawAmount(outputToken, rawOut)
      },
    }

    const bands = poolDepthBands({
      raw: {
        id: 1,
        active: true,
        fee: 0,
        sqrtPriceX64: '0',
        liquidity: '0',
        tick: 0,
        tokenA: { id: 'aaa-token.a', contract: 'token.a', decimals: 4, symbol: 'AAA' },
        tokenB: { id: 'bbb-token.b', contract: 'token.b', decimals: 4, symbol: 'BBB' },
      },
      sdk: mockPool,
      tokenA,
      tokenB,
    } as unknown as Parameters<typeof poolDepthBands>[0], 'aaa-token.a', 1, [1, 5, 10])

    expect(bands.map(band => band.sellUsd)).toEqual([
      expect.closeTo(10.1, 1),
      expect.closeTo(52.6, 1),
      expect.closeTo(111.1, 1),
    ])
    expect(bands.map(band => band.buyUsd)).toEqual([
      expect.closeTo(10.1, 1),
      expect.closeTo(52.6, 1),
      expect.closeTo(111.1, 1),
    ])
  })
})
