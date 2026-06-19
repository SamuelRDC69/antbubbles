import { createHash } from 'node:crypto'
import { put } from '@vercel/blob'
import type { Redis } from '@upstash/redis'
import sharp from 'sharp'
import {
  LOGO_ATLAS_REDIS_KEY,
  LOGO_MANIFEST_REDIS_KEY,
  type LogoAtlasManifest,
  type LogoCandidate,
  type LogoManifest,
  type LogoManifestEntry,
} from '../lib/logoManifest.js'

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const MAX_LOGO_BYTES = 2 * 1024 * 1024
const CONCURRENCY = 4
const ATLAS_CELL_SIZE = 64
const ALCOR_HEADERS = {
  'User-Agent': 'AntBubbles logo mirror/1.0',
}

const CONTENT_TYPES: Record<string, string> = {
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
}

function normalizeContentType(value: string | null): string {
  return (value ?? '').split(';', 1)[0].trim().toLowerCase()
}

function safePathPart(value: string): string {
  return value
    .replace(/%/g, '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function dedupeLogoCandidates(candidates: LogoCandidate[]): LogoCandidate[] {
  const unique = new Map<string, LogoCandidate>()
  for (const candidate of candidates) {
    if (!unique.has(candidate.key)) unique.set(candidate.key, candidate)
  }
  return [...unique.values()]
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  })[character]!)
}

export function fallbackLogoSvg(key: string): Buffer {
  const symbol = decodeURIComponent(key.split(':').at(-1) ?? '?')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 5)
    .toUpperCase() || '?'
  const digest = createHash('sha256').update(key).digest()
  const hue = Math.round((digest.readUInt16BE(0) / 65_535) * 360)
  const hueEnd = (hue + 34) % 360
  const fontSize = symbol.length > 4 ? 15 : symbol.length > 3 ? 18 : symbol.length > 2 ? 21 : 25

  return Buffer.from(`
    <svg width="${ATLAS_CELL_SIZE}" height="${ATLAS_CELL_SIZE}" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="8" y1="6" x2="56" y2="58" gradientUnits="userSpaceOnUse">
          <stop stop-color="hsl(${hue} 72% 58%)"/>
          <stop offset="1" stop-color="hsl(${hueEnd} 72% 34%)"/>
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="29" fill="url(#g)"/>
      <circle cx="32" cy="32" r="27.5" fill="none" stroke="white" stroke-opacity=".28"/>
      <text x="32" y="33" fill="white" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="700" text-anchor="middle" dominant-baseline="central">${escapeXml(symbol)}</text>
    </svg>
  `)
}

async function persistManifest(redis: Redis, manifest: LogoManifest): Promise<void> {
  await redis.set(LOGO_MANIFEST_REDIS_KEY, manifest)
}

export async function loadLogoManifest(redis: Redis): Promise<LogoManifest> {
  try {
    const manifest = await redis.get<LogoManifest>(LOGO_MANIFEST_REDIS_KEY)
    return manifest && typeof manifest === 'object' ? manifest : {}
  } catch (error) {
    console.error('[logos] failed to load manifest:', error)
    return {}
  }
}

export async function loadLogoAtlas(redis: Redis): Promise<LogoAtlasManifest | null> {
  try {
    return await redis.get<LogoAtlasManifest>(LOGO_ATLAS_REDIS_KEY)
  } catch (error) {
    console.error('[logos] failed to load atlas manifest:', error)
    return null
  }
}

async function mirrorCandidate(
  candidate: LogoCandidate,
  current: LogoManifestEntry | undefined,
): Promise<LogoManifestEntry | null> {
  const now = Date.now()
  if (current && now - current.checkedAt < CHECK_INTERVAL_MS) return current

  const headers: Record<string, string> = candidate.sourceUrl.includes('.alcor.exchange/')
    ? { ...ALCOR_HEADERS }
    : {}
  if (current?.etag) headers['If-None-Match'] = current.etag
  if (current?.lastModified) headers['If-Modified-Since'] = current.lastModified

  const response = await fetch(candidate.sourceUrl, {
    headers,
    signal: AbortSignal.timeout(10_000),
  })

  if (response.status === 304 && current) {
    return { ...current, checkedAt: now }
  }
  if (!response.ok) {
    throw new Error(`upstream returned ${response.status}`)
  }

  const contentType = normalizeContentType(response.headers.get('content-type'))
  const extension = CONTENT_TYPES[contentType]
  if (!extension) throw new Error(`unsupported content type ${contentType || '(missing)'}`)

  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (contentLength > MAX_LOGO_BYTES) throw new Error(`image exceeds ${MAX_LOGO_BYTES} bytes`)

  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_LOGO_BYTES) {
    throw new Error(`invalid image size ${bytes.byteLength}`)
  }

  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 24)
  const pathname = `logos/${safePathPart(candidate.key)}/${hash}.${extension}`
  const blob = await put(pathname, bytes, {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 365 * 24 * 60 * 60,
    contentType,
  })

  return {
    url: blob.url,
    sourceUrl: candidate.sourceUrl,
    etag: response.headers.get('etag') ?? undefined,
    lastModified: response.headers.get('last-modified') ?? undefined,
    checkedAt: now,
  }
}

export async function syncLogoCandidates(
  redis: Redis,
  manifest: LogoManifest,
  candidates: LogoCandidate[],
): Promise<{ checked: number; mirrored: number; failed: number }> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.warn('[logos] BLOB_READ_WRITE_TOKEN is missing; mirror sync skipped')
    return { checked: 0, mirrored: 0, failed: 0 }
  }

  const unique = dedupeLogoCandidates(candidates)
  let cursor = 0
  let checked = 0
  let mirrored = 0
  let failed = 0

  async function worker(): Promise<void> {
    while (cursor < unique.length) {
      const candidate = unique[cursor++]
      const previous = manifest[candidate.key]
      if (previous && Date.now() - previous.checkedAt < CHECK_INTERVAL_MS) continue

      checked++
      try {
        const entry = await mirrorCandidate(candidate, previous)
        if (!entry) continue
        manifest[candidate.key] = entry
        if (!previous || entry.url !== previous.url) mirrored++
      } catch (error) {
        failed++
        console.warn(`[logos] ${candidate.key} mirror failed:`, error)
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
  if (checked > 0) await persistManifest(redis, manifest)
  return { checked, mirrored, failed }
}

async function fetchAtlasCell(entry: LogoManifestEntry): Promise<Buffer> {
  const response = await fetch(entry.url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`blob returned ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  return sharp(bytes)
    .resize(ATLAS_CELL_SIZE, ATLAS_CELL_SIZE, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      withoutEnlargement: true,
    })
    .png()
    .toBuffer()
}

export async function buildLogoAtlas(
  redis: Redis,
  manifest: LogoManifest,
  current: LogoAtlasManifest | null,
  candidates: LogoCandidate[],
): Promise<LogoAtlasManifest | null> {
  const sourceEntries = dedupeLogoCandidates(candidates)
    .filter(({ key }) => key.startsWith('wax:'))
    .map(({ key }) => ({ key, entry: manifest[key] }))
    .sort((a, b) => a.key.localeCompare(b.key))

  if (sourceEntries.length === 0) return current

  const sourceHash = createHash('sha256')
    .update(sourceEntries.map(({ key, entry }) => `${key}:${entry?.url ?? 'fallback-v1'}`).join('|'))
    .digest('hex')
    .slice(0, 24)
  if (current?.sourceHash === sourceHash) return current

  const cells: Array<{ key: string; input: Buffer }> = []
  let cursor = 0

  async function worker(): Promise<void> {
    while (cursor < sourceEntries.length) {
      const { key, entry } = sourceEntries[cursor++]
      if (entry) {
        try {
          cells.push({ key, input: await fetchAtlasCell(entry) })
          continue
        } catch (error) {
          console.warn(`[logos] ${key} atlas cell failed; using generated fallback:`, error)
        }
      }
      cells.push({ key, input: await sharp(fallbackLogoSvg(key)).png().toBuffer() })
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
  cells.sort((a, b) => a.key.localeCompare(b.key))
  if (cells.length === 0) return current

  const columns = Math.ceil(Math.sqrt(cells.length))
  const rows = Math.ceil(cells.length / columns)
  const width = columns * ATLAS_CELL_SIZE
  const height = rows * ATLAS_CELL_SIZE
  const entries: LogoAtlasManifest['entries'] = {}
  const composites = cells.map((cell, index) => {
    const x = (index % columns) * ATLAS_CELL_SIZE
    const y = Math.floor(index / columns) * ATLAS_CELL_SIZE
    entries[cell.key] = { x, y, width: ATLAS_CELL_SIZE, height: ATLAS_CELL_SIZE }
    return { input: cell.input, left: x, top: y }
  })

  const bytes = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .webp({ quality: 88, alphaQuality: 100, effort: 5 })
    .toBuffer()

  const atlasHash = createHash('sha256').update(bytes).digest('hex').slice(0, 24)
  const blob = await put(`logos/atlas/wax-${atlasHash}.webp`, bytes, {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 365 * 24 * 60 * 60,
    contentType: 'image/webp',
  })

  const atlas: LogoAtlasManifest = {
    url: blob.url,
    width,
    height,
    cellSize: ATLAS_CELL_SIZE,
    sourceHash,
    entries,
    updatedAt: Date.now(),
  }
  await redis.set(LOGO_ATLAS_REDIS_KEY, atlas)
  return atlas
}
