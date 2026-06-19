import type { TokenBubbleData } from './types'

export const LOGO_MANIFEST_REDIS_KEY = 'logos:manifest:v1'
export const LOGO_ATLAS_REDIS_KEY = 'logos:atlas:wax:v1'

export type LogoScope = 'alcor' | 'taco' | 'nefty'

export interface LogoManifestEntry {
  url: string
  sourceUrl: string
  etag?: string
  lastModified?: string
  checkedAt: number
}

export type LogoManifest = Record<string, LogoManifestEntry>

export interface LogoCandidate {
  key: string
  sourceUrl: string
}

export interface LogoAtlasEntry {
  x: number
  y: number
  width: number
  height: number
}

export interface LogoAtlasManifest {
  url: string
  width: number
  height: number
  cellSize: number
  sourceHash: string
  entries: Record<string, LogoAtlasEntry>
  updatedAt: number
}

function encodePart(value: string): string {
  return encodeURIComponent(value.trim().toLowerCase())
}

export function canonicalLogoKey(
  token: Pick<TokenBubbleData, 'contract' | 'symbol'>,
): string {
  return `wax:${encodePart(token.contract)}:${encodePart(token.symbol)}`
}

export function logoSourceUrl(
  scope: LogoScope,
  sourceId: string,
  token: Pick<TokenBubbleData, 'id' | 'contract' | 'symbol'>,
): string {
  if (scope === 'alcor') {
    const proxyBase = typeof process !== 'undefined'
      ? process.env.LOGO_PROXY_BASE_URL ?? 'https://antbubbles.vercel.app'
      : 'https://antbubbles.vercel.app'
    return `${proxyBase}/api/logo?id=${encodeURIComponent(token.id)}&chain=${encodeURIComponent(sourceId)}`
  }
  return `https://assets.tacostudios.io/tokens/${token.contract}_${token.symbol}.png`
}

export function buildLogoCandidates(
  tokens: TokenBubbleData[],
  scope: LogoScope,
  sourceId: string,
): LogoCandidate[] {
  return tokens.map((token) => ({
    key: canonicalLogoKey(token),
    sourceUrl: logoSourceUrl(scope, sourceId, token),
  }))
}

export function applyLogoManifest(
  tokens: TokenBubbleData[],
  manifest: LogoManifest,
  _scope: LogoScope,
  _sourceId: string,
): TokenBubbleData[] {
  return tokens.map((token) => {
    const entry = manifest[canonicalLogoKey(token)]
    return entry?.url ? { ...token, logoUrl: entry.url } : token
  })
}
