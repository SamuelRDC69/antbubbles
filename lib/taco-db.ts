/**
 * SQLite candle store shared by all non-Alcor DEXes (Taco, Nefty, …).
 *
 * Schema
 * ──────
 *   candles(dex, pair_id, resolution, time, open, high, low, close, volume)
 *   PRIMARY KEY (dex, pair_id, resolution, time)
 *
 * `time`       – Unix seconds, start of the candle bucket
 * `resolution` – bucket width in seconds (60, 300, 900, 3600, 14400, 86400)
 *
 * Singleton: the DB connection is opened once per Node.js process.
 */

import Database from 'better-sqlite3'
import path     from 'path'
import fs       from 'fs'

import type { DexId } from './dex-contracts'

// ── Supported resolutions (seconds) ──────────────────────────────────────────

export const RESOLUTIONS = [60, 300, 900, 1800, 3600, 14400, 86400, 604800] as const
export type  Resolution  = typeof RESOLUTIONS[number]

export interface Candle {
  time:   number   // Unix seconds (bucket start)
  open:   number
  high:   number
  low:    number
  close:  number
  volume: number
}

// ── DB file location ──────────────────────────────────────────────────────────
// Stored in <project-root>/.dex-candles.db  (gitignored)

const DB_PATH = path.join(process.cwd(), '.dex-candles.db')
const DEFAULT_SEED_DB_PATH = path.join(process.cwd(), 'offchain-seed.db')

// ── Singleton connection ──────────────────────────────────────────────────────

let _db: Database.Database | null = null

function getDb(): Database.Database {
  if (_db) return _db
  _db = new Database(DB_PATH)
  _db.pragma('journal_mode = WAL')
  _db.pragma('synchronous  = NORMAL')

  _db.exec(`
    CREATE TABLE IF NOT EXISTS candles (
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
    CREATE INDEX IF NOT EXISTS idx_candles_query
      ON candles (dex, pair_id, resolution, time);
  `)

  return _db
}

// ── Prepared statement cache ──────────────────────────────────────────────────

let _upsert: Database.Statement | null = null
let _query:  Database.Statement | null = null
let _last:   Database.Statement | null = null

function upsertStmt() {
  if (_upsert) return _upsert
  _upsert = getDb().prepare(`
    INSERT INTO candles (dex, pair_id, resolution, time, open, high, low, close, volume)
    VALUES (@dex, @pairId, @resolution, @time, @open, @high, @low, @close, @volume)
    ON CONFLICT (dex, pair_id, resolution, time) DO UPDATE SET
      high   = MAX(high,  excluded.high),
      low    = MIN(low,   excluded.low),
      close  = excluded.close,
      volume = volume + excluded.volume
  `)
  return _upsert
}

function queryStmt() {
  if (_query) return _query
  _query = getDb().prepare(`
    SELECT time, open, high, low, close, volume
    FROM   candles
    WHERE  dex = @dex AND pair_id = @pairId AND resolution = @resolution
      AND  time >= @from AND time <= @to
    ORDER  BY time ASC
  `)
  return _query
}

function lastStmt() {
  if (_last) return _last
  _last = getDb().prepare(`
    SELECT MAX(time) AS last_time
    FROM   candles
    WHERE  dex = @dex AND pair_id = @pairId AND resolution = @resolution
  `)
  return _last
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Upsert a price observation into all resolution buckets.
 * Called once per snapshot (every ~30 s) for each pair.
 */
export function recordPrice(
  dex:    DexId,
  pairId: string,
  timeSec: number,
  price:  number,
) {
  const stmt = upsertStmt()
  for (const res of RESOLUTIONS) {
    const bucket = Math.floor(timeSec / res) * res
    stmt.run({
      dex,
      pairId,
      resolution: res,
      time:  bucket,
      open:  price,   // ON CONFLICT keeps original open
      high:  price,
      low:   price,
      close: price,
      volume: 0,
    })
  }
}

/**
 * Batch-record prices for many pairs in a single transaction (fast).
 */
export function recordPriceBatch(
  dex: DexId,
  entries: Array<{ pairId: string; timeSec: number; price: number }>,
) {
  const db   = getDb()
  const stmt = upsertStmt()
  const tx   = db.transaction(() => {
    for (const { pairId, timeSec, price } of entries) {
      for (const res of RESOLUTIONS) {
        const bucket = Math.floor(timeSec / res) * res
        stmt.run({
          dex, pairId, resolution: res,
          time: bucket, open: price, high: price, low: price, close: price, volume: 0,
        })
      }
    }
  })
  tx()
}

/**
 * Query candles for a pair.
 * `from` and `to` are Unix seconds.
 */
export function queryCandles(
  dex:        DexId,
  pairId:     string,
  resolution: Resolution,
  fromSec:    number,
  toSec:      number,
): Candle[] {
  return queryStmt().all({ dex, pairId, resolution, from: fromSec, to: toSec }) as Candle[]
}

/**
 * Returns the Unix-second timestamp of the newest stored candle for a pair,
 * or null if no data exists yet.
 */
export function getLastTime(dex: DexId, pairId: string, resolution: Resolution): number | null {
  const row = lastStmt().get({ dex, pairId, resolution }) as { last_time: number | null }
  return row?.last_time ?? null
}

/** How many unique pairs are stored for a DEX */
export function getPairCount(dex: DexId): number {
  const db = getDb()
  const row = db.prepare(
    'SELECT COUNT(DISTINCT pair_id) AS n FROM candles WHERE dex = ?'
  ).get(dex) as { n: number }
  return row?.n ?? 0
}

export function getTotalCandleCountForDexes(dexes: DexId[]): number {
  if (dexes.length === 0) return 0
  const db = getDb()
  const placeholders = dexes.map(() => '?').join(',')
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM candles WHERE dex IN (${placeholders})`
  ).get(...dexes) as { n: number }
  return row?.n ?? 0
}

export function restoreSeedDbIfEmpty(
  dexes: DexId[] = ['taco', 'nefty'],
  seedDbPath = process.env.OFFCHAIN_SEED_DB_PATH || DEFAULT_SEED_DB_PATH,
): { restored: boolean; rowsInserted: number; seedDbPath: string } {
  if (dexes.length === 0) {
    return { restored: false, rowsInserted: 0, seedDbPath }
  }

  if (!fs.existsSync(seedDbPath)) {
    return { restored: false, rowsInserted: 0, seedDbPath }
  }

  const existingRows = getTotalCandleCountForDexes(dexes)
  if (existingRows > 0) {
    return { restored: false, rowsInserted: 0, seedDbPath }
  }

  const db = getDb()
  const placeholders = dexes.map(() => '?').join(',')
  const attachName = 'seeddb'

  db.exec(`ATTACH DATABASE '${seedDbPath.replace(/'/g, "''")}' AS ${attachName}`)
  try {
    const before = db.prepare(
      `SELECT COUNT(*) AS n FROM candles WHERE dex IN (${placeholders})`
    ).get(...dexes) as { n: number }

    db.prepare(`
      INSERT OR IGNORE INTO candles (dex, pair_id, resolution, time, open, high, low, close, volume)
      SELECT dex, pair_id, resolution, time, open, high, low, close, volume
      FROM ${attachName}.candles
      WHERE dex IN (${placeholders})
    `).run(...dexes)

    const after = db.prepare(
      `SELECT COUNT(*) AS n FROM candles WHERE dex IN (${placeholders})`
    ).get(...dexes) as { n: number }

    return {
      restored: true,
      rowsInserted: Math.max(0, (after?.n ?? 0) - (before?.n ?? 0)),
      seedDbPath,
    }
  } finally {
    db.exec(`DETACH DATABASE ${attachName}`)
  }
}

/**
 * For every pair that has candles in [fromSec, toSec] at the given resolution,
 * returns the % price change: (close_of_newest - open_of_oldest) / open_of_oldest × 100.
 * Pairs with no data or a zero open price are omitted from the result.
 */
export function queryChange24Batch(
  dex:        DexId,
  resolution: Resolution,
  fromSec:    number,
  toSec:      number,
): Map<string, number> {
  const db   = getDb()
  const rows = db.prepare(`
    WITH ranked AS (
      SELECT pair_id, time, open, close,
        ROW_NUMBER() OVER (PARTITION BY pair_id ORDER BY time ASC)  AS rn_asc,
        ROW_NUMBER() OVER (PARTITION BY pair_id ORDER BY time DESC) AS rn_desc
      FROM candles
      WHERE dex = ? AND resolution = ? AND time >= ? AND time <= ?
    )
    SELECT pair_id,
      MAX(CASE WHEN rn_asc  = 1 THEN open  END) AS open_first,
      MAX(CASE WHEN rn_desc = 1 THEN close END) AS close_last
    FROM ranked
    GROUP BY pair_id
  `).all(dex, resolution, fromSec, toSec) as Array<{
    pair_id:    string
    open_first: number
    close_last: number
  }>

  const result = new Map<string, number>()
  for (const row of rows) {
    if (row.open_first > 0 && row.close_last > 0) {
      result.set(row.pair_id, (row.close_last - row.open_first) / row.open_first * 100)
    }
  }
  return result
}
