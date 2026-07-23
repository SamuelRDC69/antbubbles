import wax from '../data/wax.json'

export interface TokenMetadata {
  name?: string
  description?: string
  website?: { name?: string; link: string }
  socials: string[]
  tags: string[]
}

type RawMetadata = {
  name?: string | { short?: string; full?: string }
  description?: string
  website?: string | { name?: string; link?: string }
  socials?: string[]
  tags?: string[]
}

const waxMetadata = wax as unknown as Record<string, RawMetadata>

function safeUrl(value: string | undefined): string | undefined {
  try {
    const url = new URL(value ?? '')
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
  } catch {
    return undefined
  }
}

export function getTokenMetadata(chainId: string, symbol: string, contract: string): TokenMetadata | undefined {
  if (chainId !== 'wax') return undefined
  const raw = waxMetadata[`${symbol.toUpperCase()}@${contract.toLowerCase()}`]
  if (!raw) return undefined
  const link = safeUrl(typeof raw.website === 'string' ? raw.website : raw.website?.link)
  return {
    name: typeof raw.name === 'string' ? raw.name : raw.name?.full ?? raw.name?.short,
    description: raw.description,
    website: link ? { link, name: typeof raw.website === 'object' ? raw.website.name : undefined } : undefined,
    socials: (raw.socials ?? []).map(safeUrl).filter((link): link is string => Boolean(link)),
    tags: raw.tags ?? [],
  }
}
