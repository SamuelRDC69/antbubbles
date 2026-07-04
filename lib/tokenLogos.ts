import type { ChainConfig } from './types'

const ALCOR_UI_REPO = 'https://raw.githubusercontent.com/alcorexchange/alcor-ui/master'
const ALCOR_UI_TREE_API = 'https://api.github.com/repos/alcorexchange/alcor-ui/git/trees/master?recursive=1'

type LogoManifest = Map<string, string>

let manifestCache: { value: LogoManifest; ts: number } | null = null
const MANIFEST_TTL_MS = 24 * 60 * 60 * 1000

export function alcorLogoManifestKey(chainId: string, symbol: string, contract: string): string {
  return `${chainId}:${symbol.trim().toLowerCase()}_${contract.trim().toLowerCase()}`
}

export function alcorGithubLogoUrl(
  chain: Pick<ChainConfig, 'id'>,
  token: Pick<{ symbol: string; contract: string }, 'symbol' | 'contract'>,
): string {
  return `${ALCOR_UI_REPO}/assets/tokens/${encodeURIComponent(chain.id)}/${encodeURIComponent(`${token.symbol.trim().toLowerCase()}_${token.contract.trim().toLowerCase()}.png`)}`
}

export async function loadAlcorLogoManifest(): Promise<LogoManifest> {
  const now = Date.now()
  if (manifestCache && now - manifestCache.ts < MANIFEST_TTL_MS) return manifestCache.value

  try {
    const res = await fetch(ALCOR_UI_TREE_API, {
      headers: { Accept: 'application/vnd.github+json' },
      next: { revalidate: 24 * 60 * 60 },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) throw new Error(`GitHub tree returned ${res.status}`)
    const json = await res.json() as { tree?: Array<{ path?: string; type?: string }> }
    const value: LogoManifest = new Map()

    for (const item of json.tree ?? []) {
      if (item.type !== 'blob' || !item.path) continue
      const match = item.path.match(/^assets\/tokens\/([^/]+)\/(.+)\.png$/i)
      if (!match) continue

      const [, chainId, fileName] = match
      const underscore = fileName.indexOf('_')
      if (underscore <= 0) continue

      const symbol = fileName.slice(0, underscore)
      const contract = fileName.slice(underscore + 1)
      value.set(
        alcorLogoManifestKey(chainId, symbol, contract),
        `${ALCOR_UI_REPO}/${item.path.split('/').map(encodeURIComponent).join('/')}`,
      )
    }

    manifestCache = { value, ts: now }
    return value
  } catch {
    return manifestCache?.value ?? new Map()
  }
}

export async function resolveAlcorGithubLogoUrl(
  chain: Pick<ChainConfig, 'id'>,
  token: Pick<{ symbol: string; contract: string }, 'symbol' | 'contract'>,
): Promise<string> {
  const manifest = await loadAlcorLogoManifest()
  return manifest.get(alcorLogoManifestKey(chain.id, token.symbol, token.contract))
    ?? alcorGithubLogoUrl(chain, token)
}
