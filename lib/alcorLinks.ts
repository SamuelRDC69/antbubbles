import type { ChainConfig, TokenBubbleData } from './types'

const ACCOUNT_NAME = /^[a-z1-5.]{1,12}$/

export function buildAlcorSwapUrl(
  chain: ChainConfig,
  token: Pick<TokenBubbleData, 'id'>,
): string | null {
  const nativeTokenId = `${chain.systemToken.toLowerCase()}-${chain.systemContract}`
  if (token.id === nativeTokenId) return null

  const url = new URL(`https://alcor.exchange/v/${chain.id}/swap`)
  url.searchParams.set('input', nativeTokenId)
  url.searchParams.set('output', token.id)

  const market = process.env.NEXT_PUBLIC_ALCOR_MARKET?.trim()
  if (market && ACCOUNT_NAME.test(market)) url.searchParams.set('market', market)

  return url.toString()
}
