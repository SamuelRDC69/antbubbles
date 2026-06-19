import fs from 'node:fs'
import path from 'node:path'

import Database from 'better-sqlite3'

import { fetchNeftyTokens } from '../lib/nefty'
import { fetchTacoTokens } from '../lib/taco'

const SOURCE_DB = path.join(process.cwd(), '.dex-candles.db')
const OUTPUT_DB = path.join(process.cwd(), 'worker', 'offchain-seed.db')
const DAYS = Number(process.env.OFFCHAIN_SEED_DAYS ?? '7')

function ensureParent(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

function collectPairs(tokens: any[], pairKey: string): string[] {
  const set = new Set<string>()
  for (const token of tokens) {
    if (token?.[pairKey]) set.add(token[pairKey])
    for (const step of token?.offchainChartPath ?? []) {
      if (step?.pairId) set.add(step.pairId)
    }
  }
  return [...set]
}

async function main() {
  if (!fs.existsSync(SOURCE_DB)) {
    throw new Error(`source DB not found: ${SOURCE_DB}`)
  }

  const [tacoTokens, neftyTokens] = await Promise.all([
    fetchTacoTokens(),
    fetchNeftyTokens(),
  ])

  const selected = {
    taco: collectPairs(tacoTokens, 'tacoPairId'),
    nefty: collectPairs(neftyTokens, 'neftyPairId'),
  }

  const source = new Database(SOURCE_DB, { readonly: true })
  ensureParent(OUTPUT_DB)
  if (fs.existsSync(OUTPUT_DB)) fs.unlinkSync(OUTPUT_DB)

  const out = new Database(OUTPUT_DB)
  out.pragma('journal_mode = DELETE')
  out.exec(`
    CREATE TABLE candles (
      dex        TEXT    NOT NULL,
      pair_id    TEXT    NOT NULL,
      resolution INTEGER NOT NULL,
      time       INTEGER NOT NULL,
      open       REAL    NOT NULL,
      high       REAL    NOT NULL,
      low        REAL    NOT NULL,
      close      REAL    NOT NULL,
      volume     REAL    NOT NULL DEFAULT 0,
      PRIMARY KEY (dex, pair_id, resolution, time)
    );
    CREATE INDEX idx_candles_query
      ON candles (dex, pair_id, resolution, time);
  `)

  const since = Math.floor(Date.now() / 1000) - DAYS * 24 * 3600
  const insert = out.prepare(`
    INSERT OR IGNORE INTO candles (dex, pair_id, resolution, time, open, high, low, close, volume)
    VALUES (@dex, @pair_id, @resolution, @time, @open, @high, @low, @close, @volume)
  `)

  const copyForDex = out.transaction((dex: 'taco' | 'nefty', pairIds: string[]) => {
    if (pairIds.length === 0) return 0
    const placeholders = pairIds.map(() => '?').join(',')
    const rows = source.prepare(`
      SELECT dex, pair_id, resolution, time, open, high, low, close, volume
      FROM candles
      WHERE dex = ? AND pair_id IN (${placeholders}) AND time >= ?
      ORDER BY resolution, pair_id, time
    `).iterate(dex, ...pairIds, since) as Iterable<any>

    let count = 0
    for (const row of rows) {
      insert.run(row)
      count++
    }
    return count
  })

  const copied = {
    taco: copyForDex('taco', selected.taco),
    nefty: copyForDex('nefty', selected.nefty),
  }

  out.pragma('wal_checkpoint(TRUNCATE)')
  out.close()
  source.close()

  const size = fs.statSync(OUTPUT_DB).size
  console.log(JSON.stringify({
    source: SOURCE_DB,
    output: OUTPUT_DB,
    days: DAYS,
    selectedPairs: {
      taco: selected.taco.length,
      nefty: selected.nefty.length,
    },
    copiedRows: copied,
    outputBytes: size,
  }, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
