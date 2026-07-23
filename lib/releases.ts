export const RELEASES = [
  {
    sequence: 1,
    version: '0.1.1',
    date: '2026-07-23',
    title: 'Native-pool data fix',
    summary: 'Prices, bubble moves, performance, ranges, and the default chart now use each token’s deepest chain-native pool. Reversed pools now flip both price and percentage correctly.',
  },
] as const

export const CURRENT_RELEASE = RELEASES[0]
