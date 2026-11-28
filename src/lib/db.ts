import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getDatabasePath, getEnabledExchanges } from "./env";
import { isLeveragedToken, isTokenizedStock } from "./exchanges/stock-filter";
import { lastVsMidPct, spreadPct, staleInfo } from "./calc";
import { parseContractsJson, serializeContracts } from "./contracts";
import type {
  DerivedTicker,
  FetchLogRow,
  MarketInfo,
  NormalizedOrderBook,
  OrderBookRow,
  TickerRow,
} from "./types";

const globalForDb = globalThis as unknown as {
  __arbitDb?: DatabaseSync;
  __arbitMigrated?: number;
  __arbitEnabled?: string;
};
const SCHEMA_VERSION = 6;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS exchanges (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS markets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exchange TEXT NOT NULL,
  raw_symbol TEXT NOT NULL,
  base TEXT NOT NULL,
  quote TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  status TEXT,
  deposit_enabled INTEGER,
  withdraw_enabled INTEGER,
  chainstatus_raw TEXT,
  contracts_json TEXT,
  UNIQUE (exchange, raw_symbol),
  FOREIGN KEY (exchange) REFERENCES exchanges(id)
);

CREATE TABLE IF NOT EXISTS tickers_latest (
  exchange TEXT NOT NULL,
  raw_symbol TEXT NOT NULL,
  base TEXT NOT NULL,
  quote TEXT NOT NULL,
  last REAL,
  bid REAL,
  ask REAL,
  bid_size REAL,
  ask_size REAL,
  base_volume_24h REAL,
  quote_volume_24h REAL,
  change_24h_pct REAL,
  spread_pct REAL,
  last_vs_mid_pct REAL,
  stale INTEGER NOT NULL DEFAULT 0,
  stale_reasons TEXT,
  deposit_enabled INTEGER,
  withdraw_enabled INTEGER,
  exchange_timestamp TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (exchange, raw_symbol),
  FOREIGN KEY (exchange) REFERENCES exchanges(id)
);

CREATE TABLE IF NOT EXISTS ticker_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exchange TEXT NOT NULL,
  raw_symbol TEXT NOT NULL,
  base TEXT NOT NULL,
  quote TEXT NOT NULL,
  last REAL,
  bid REAL,
  ask REAL,
  bid_size REAL,
  ask_size REAL,
  base_volume_24h REAL,
  quote_volume_24h REAL,
  change_24h_pct REAL,
  spread_pct REAL,
  last_vs_mid_pct REAL,
  stale INTEGER NOT NULL DEFAULT 0,
  stale_reasons TEXT,
  deposit_enabled INTEGER,
  withdraw_enabled INTEGER,
  exchange_timestamp TEXT,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orderbook_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exchange TEXT NOT NULL,
  raw_symbol TEXT NOT NULL,
  bids TEXT NOT NULL,
  asks TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS asset_networks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exchange TEXT NOT NULL,
  coin TEXT NOT NULL,
  network TEXT,
  deposit_enabled INTEGER,
  withdraw_enabled INTEGER,
  withdraw_fee REAL
);

CREATE TABLE IF NOT EXISTS fetch_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exchange TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  error_message TEXT,
  row_count INTEGER
);

CREATE TABLE IF NOT EXISTS raw_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fetch_log_id INTEGER,
  exchange TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  FOREIGN KEY (fetch_log_id) REFERENCES fetch_logs(id)
);

CREATE INDEX IF NOT EXISTS idx_markets_exchange ON markets(exchange);
CREATE INDEX IF NOT EXISTS idx_ticker_history_lookup ON ticker_history(exchange, raw_symbol, fetched_at);
CREATE INDEX IF NOT EXISTS idx_orderbook_lookup ON orderbook_snapshots(exchange, raw_symbol, fetched_at);
CREATE INDEX IF NOT EXISTS idx_fetch_logs_exchange ON fetch_logs(exchange, started_at);
CREATE INDEX IF NOT EXISTS idx_raw_responses_log ON raw_responses(fetch_log_id);

CREATE TABLE IF NOT EXISTS blacklist (
  exchange TEXT NOT NULL,
  raw_symbol TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (exchange, raw_symbol)
);

CREATE TABLE IF NOT EXISTS favorites (
  exchange TEXT NOT NULL,
  raw_symbol TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (exchange, raw_symbol)
);
`;

const EXCHANGE_NAMES: Record<string, string> = {
  kraken: "Kraken",
  bingx: "BingX",
  binance: "Binance",
  bybit: "Bybit",
  lbank: "LBank",
  bitget: "Bitget",
  gate: "Gate",
  poloniex: "Poloniex",
  bitrue: "Bitrue",
  mexc: "MEXC",
  htx: "HTX",
  fameex: "FameEX",
  xt: "XT",
  bifinance: "BiFinance",
  hotcoin: "Hotcoin",
  bigone: "BigONE",
  cryptocom: "Crypto.com",
  asterdex: "AsterDEX",
  toobit: "Toobit",
  ourbit: "Ourbit",
  mgbx: "MGBX",
  btse: "BTSE",
  pionex: "Pionex",
  coinw: "CoinW",
  weex: "WEEX",
  phemex: "Phemex",
  dextrade: "Dex-Trade",
  p2pb2b: "P2PB2B",
  safetrade: "SafeTrade",
  "binance-alpha": "Binance Alpha",
  cexio: "CEX.IO",
  biconomy: "Biconomy",
};

function runTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Awal transaksi bisa saja sudah otomatis di-rollback.
    }
    throw error;
  }
}

function openDb(): DatabaseSync {
  const dbPath = getDatabasePath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // DELETE journal: semua data ada di satu file .db (lebih aman di lingkungan
  // yang kadang menghapus file sidecar *.db-wal).
  db.exec("PRAGMA journal_mode = DELETE");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  migrateSchema(db);
  seedExchanges(db);
  return db;
}

function migrateSchema(db: DatabaseSync) {
  const columns = db.prepare(`PRAGMA table_info(markets)`).all() as { name: string }[];
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("status")) {
    db.exec(`ALTER TABLE markets ADD COLUMN status TEXT`);
  }
  if (!names.has("deposit_enabled")) {
    db.exec(`ALTER TABLE markets ADD COLUMN deposit_enabled INTEGER`);
  }
  if (!names.has("withdraw_enabled")) {
    db.exec(`ALTER TABLE markets ADD COLUMN withdraw_enabled INTEGER`);
  }
  if (!names.has("chainstatus_raw")) {
    db.exec(`ALTER TABLE markets ADD COLUMN chainstatus_raw TEXT`);
  }
  if (!names.has("contracts_json")) {
    db.exec(`ALTER TABLE markets ADD COLUMN contracts_json TEXT`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS blacklist (
      exchange TEXT NOT NULL,
      raw_symbol TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (exchange, raw_symbol)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS favorites (
      exchange TEXT NOT NULL,
      raw_symbol TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (exchange, raw_symbol)
    )
  `);
}

function seedExchanges(db: DatabaseSync) {
  const enabled = new Set(getEnabledExchanges());
  const upsert = db.prepare(`
    INSERT INTO exchanges (id, name, enabled, created_at)
    VALUES (@id, @name, @enabled, @created_at)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      enabled = excluded.enabled
  `);
  const now = new Date().toISOString();
  runTransaction(db, () => {
    for (const id of enabled) {
      upsert.run({
        id,
        name: EXCHANGE_NAMES[id] ?? id,
        enabled: 1,
        created_at: now,
      });
    }
    // Exchange yang tidak ada di ENABLED_EXCHANGES ditandai nonaktif, tanpa dihapus.
    const existing = db.prepare(`SELECT id FROM exchanges`).all() as { id: string }[];
    const disable = db.prepare(`UPDATE exchanges SET enabled = 0 WHERE id = ?`);
    for (const row of existing) {
      if (!enabled.has(row.id)) disable.run(row.id);
    }
  });
}

export function getDb(): DatabaseSync {
  if (!globalForDb.__arbitDb) {
    globalForDb.__arbitDb = openDb();
  }
  // Koneksi lama (hot reload) tetap dimigrasi tanpa perlu restart dev server.
  if (globalForDb.__arbitMigrated !== SCHEMA_VERSION) {
    migrateSchema(globalForDb.__arbitDb);
    globalForDb.__arbitMigrated = SCHEMA_VERSION;
  }
  const enabledKey = getEnabledExchanges().join(",");
  if (globalForDb.__arbitEnabled !== enabledKey) {
    seedExchanges(globalForDb.__arbitDb);
    globalForDb.__arbitEnabled = enabledKey;
  }
  return globalForDb.__arbitDb;
}

export type BlacklistRow = {
  exchange: string;
  raw_symbol: string;
  created_at: string;
};

export function listBlacklist(): BlacklistRow[] {
  return getDb()
    .prepare(
      `SELECT exchange, raw_symbol, created_at
       FROM blacklist
       ORDER BY exchange ASC, raw_symbol ASC`,
    )
    .all() as BlacklistRow[];
}

export function addBlacklist(exchange: string, rawSymbol: string): void {
  const ex = exchange.trim();
  const symbol = rawSymbol.trim();
  if (!ex || !symbol) {
    throw new Error("exchange dan raw_symbol wajib diisi.");
  }
  getDb()
    .prepare(
      `INSERT INTO blacklist (exchange, raw_symbol, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(exchange, raw_symbol) DO NOTHING`,
    )
    .run(ex, symbol, new Date().toISOString());
}

export function removeBlacklist(exchange: string, rawSymbol: string): void {
  getDb()
    .prepare(`DELETE FROM blacklist WHERE exchange = ? AND raw_symbol = ?`)
    .run(exchange.trim(), rawSymbol.trim());
}

export type FavoriteRow = {
  exchange: string;
  raw_symbol: string;
  created_at: string;
};

export function listFavorites(): FavoriteRow[] {
  return getDb()
    .prepare(
      `SELECT exchange, raw_symbol, created_at
       FROM favorites
       ORDER BY created_at DESC, exchange ASC, raw_symbol ASC`,
    )
    .all() as FavoriteRow[];
}

export function addFavorite(exchange: string, rawSymbol: string): void {
  const ex = exchange.trim();
  const symbol = rawSymbol.trim();
  if (!ex || !symbol) {
    throw new Error("exchange dan raw_symbol wajib diisi.");
  }
  getDb()
    .prepare(
      `INSERT INTO favorites (exchange, raw_symbol, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(exchange, raw_symbol) DO NOTHING`,
    )
    .run(ex, symbol, new Date().toISOString());
}

export function removeFavorite(exchange: string, rawSymbol: string): void {
  getDb()
    .prepare(`DELETE FROM favorites WHERE exchange = ? AND raw_symbol = ?`)
    .run(exchange.trim(), rawSymbol.trim());
}

export function startFetchLog(exchange: string): number {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO fetch_logs (exchange, started_at, status) VALUES (?, ?, 'running')`,
    )
    .run(exchange, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function finishFetchLog(
  id: number,
  status: "success" | "error",
  rowCount: number | null,
  errorMessage: string | null,
) {
  getDb()
    .prepare(
      `UPDATE fetch_logs
       SET finished_at = ?, status = ?, row_count = ?, error_message = ?
       WHERE id = ?`,
    )
    .run(new Date().toISOString(), status, rowCount, errorMessage, id);
}

export function saveRawResponse(
  fetchLogId: number | null,
  exchange: string,
  endpoint: string,
  rawJson: string,
) {
  getDb()
    .prepare(
      `INSERT INTO raw_responses (fetch_log_id, exchange, endpoint, raw_json, fetched_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(fetchLogId, exchange, endpoint, rawJson, new Date().toISOString());
}

export function upsertMarkets(exchange: string, markets: MarketInfo[]) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO markets (exchange, raw_symbol, base, quote, active, status, deposit_enabled, withdraw_enabled, chainstatus_raw, contracts_json)
    VALUES (@exchange, @raw_symbol, @base, @quote, @active, @status, @deposit_enabled, @withdraw_enabled, @chainstatus_raw, @contracts_json)
    ON CONFLICT(exchange, raw_symbol) DO UPDATE SET
      base = excluded.base,
      quote = excluded.quote,
      active = excluded.active,
      status = excluded.status,
      deposit_enabled = excluded.deposit_enabled,
      withdraw_enabled = excluded.withdraw_enabled,
      chainstatus_raw = excluded.chainstatus_raw,
      contracts_json = COALESCE(excluded.contracts_json, markets.contracts_json)
  `);
  runTransaction(db, () => {
    for (const market of markets) {
      stmt.run({
        exchange,
        raw_symbol: market.rawSymbol,
        base: market.base,
        quote: market.quote,
        active: market.active ? 1 : 0,
        status: market.status ?? null,
        deposit_enabled: market.depositEnabled ?? null,
        withdraw_enabled: market.withdrawEnabled ?? null,
        chainstatus_raw: market.chainstatusRaw ?? null,
        contracts_json: serializeContracts(market.contracts),
      });
    }
  });
}

export function saveTickers(exchange: string, tickers: DerivedTicker[]) {
  const db = getDb();
  const latest = db.prepare(`
    INSERT INTO tickers_latest (
      exchange, raw_symbol, base, quote, last, bid, ask, bid_size, ask_size,
      base_volume_24h, quote_volume_24h, change_24h_pct, spread_pct, last_vs_mid_pct,
      stale, stale_reasons, deposit_enabled, withdraw_enabled, exchange_timestamp, fetched_at
    ) VALUES (
      @exchange, @raw_symbol, @base, @quote, @last, @bid, @ask, @bid_size, @ask_size,
      @base_volume_24h, @quote_volume_24h, @change_24h_pct, @spread_pct, @last_vs_mid_pct,
      @stale, @stale_reasons, @deposit_enabled, @withdraw_enabled, @exchange_timestamp, @fetched_at
    )
    ON CONFLICT(exchange, raw_symbol) DO UPDATE SET
      base = excluded.base,
      quote = excluded.quote,
      last = excluded.last,
      bid = excluded.bid,
      ask = excluded.ask,
      bid_size = excluded.bid_size,
      ask_size = excluded.ask_size,
      base_volume_24h = excluded.base_volume_24h,
      quote_volume_24h = excluded.quote_volume_24h,
      change_24h_pct = excluded.change_24h_pct,
      spread_pct = excluded.spread_pct,
      last_vs_mid_pct = excluded.last_vs_mid_pct,
      stale = excluded.stale,
      stale_reasons = excluded.stale_reasons,
      deposit_enabled = excluded.deposit_enabled,
      withdraw_enabled = excluded.withdraw_enabled,
      exchange_timestamp = excluded.exchange_timestamp,
      fetched_at = excluded.fetched_at
  `);
  const history = db.prepare(`
    INSERT INTO ticker_history (
      exchange, raw_symbol, base, quote, last, bid, ask, bid_size, ask_size,
      base_volume_24h, quote_volume_24h, change_24h_pct, spread_pct, last_vs_mid_pct,
      stale, stale_reasons, deposit_enabled, withdraw_enabled, exchange_timestamp, fetched_at
    ) VALUES (
      @exchange, @raw_symbol, @base, @quote, @last, @bid, @ask, @bid_size, @ask_size,
      @base_volume_24h, @quote_volume_24h, @change_24h_pct, @spread_pct, @last_vs_mid_pct,
      @stale, @stale_reasons, @deposit_enabled, @withdraw_enabled, @exchange_timestamp, @fetched_at
    )
  `);

  runTransaction(db, () => {
    for (const ticker of tickers) {
      const payload = {
        exchange,
        raw_symbol: ticker.rawSymbol,
        base: ticker.base,
        quote: ticker.quote,
        last: ticker.last,
        bid: ticker.bid,
        ask: ticker.ask,
        bid_size: ticker.bidSize,
        ask_size: ticker.askSize,
        base_volume_24h: ticker.baseVolume24h,
        quote_volume_24h: ticker.quoteVolume24h,
        change_24h_pct: ticker.change24hPct,
        spread_pct: ticker.spreadPct,
        last_vs_mid_pct: ticker.lastVsMidPct,
        stale: ticker.stale ? 1 : 0,
        stale_reasons: ticker.staleReasons.join(", "),
        deposit_enabled: null,
        withdraw_enabled: null,
        exchange_timestamp: ticker.exchangeTimestamp,
        fetched_at: ticker.fetchedAt,
      };
      latest.run(payload);
      history.run(payload);
    }
  });
}

export function saveOrderBook(orderbook: NormalizedOrderBook): number {
  const result = getDb()
    .prepare(
      `INSERT INTO orderbook_snapshots (exchange, raw_symbol, bids, asks, fetched_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      orderbook.exchange,
      orderbook.rawSymbol,
      JSON.stringify(orderbook.bids),
      JSON.stringify(orderbook.asks),
      orderbook.fetchedAt,
    );
  return Number(result.lastInsertRowid);
}

export function getLatestTickers(): TickerRow[] {
  const rows = getDb()
    .prepare(
      `SELECT
          t.exchange, t.raw_symbol, t.base, t.quote,
          t.last, t.bid, t.ask, t.bid_size, t.ask_size,
          t.base_volume_24h, t.quote_volume_24h,
          t.change_24h_pct, t.spread_pct, t.last_vs_mid_pct,
          t.stale, t.stale_reasons, t.exchange_timestamp, t.fetched_at,
          m.status AS status,
          m.active AS active,
          m.deposit_enabled AS deposit_enabled,
          m.withdraw_enabled AS withdraw_enabled,
          m.chainstatus_raw AS chainstatus_raw,
          m.contracts_json AS contracts_json
       FROM tickers_latest t
       LEFT JOIN markets m
         ON m.exchange = t.exchange AND m.raw_symbol = t.raw_symbol
       ORDER BY t.exchange ASC, t.raw_symbol ASC`,
    )
    .all() as TickerRow[];
  const basesByExchange = collectBasesByExchange(rows);
  return rows.filter((row) => keepNonExcludedTicker(row, basesByExchange)).map((row) => ({
    ...row,
    contracts: parseContractsJson(row.contracts_json),
  }));
}

const TICKER_SELECT = `
          t.exchange, t.raw_symbol, t.base, t.quote,
          t.last, t.bid, t.ask, t.bid_size, t.ask_size,
          t.base_volume_24h, t.quote_volume_24h,
          t.change_24h_pct, t.spread_pct, t.last_vs_mid_pct,
          t.stale, t.stale_reasons, t.exchange_timestamp, t.fetched_at,
          m.status AS status,
          m.active AS active,
          m.deposit_enabled AS deposit_enabled,
          m.withdraw_enabled AS withdraw_enabled,
          m.chainstatus_raw AS chainstatus_raw,
          m.contracts_json AS contracts_json
`;

function collectBasesByExchange(rows: Array<{ exchange: string; base: string }>): Map<string, Set<string>> {
  const basesByExchange = new Map<string, Set<string>>();
  for (const row of rows) {
    const exchange = row.exchange ?? "";
    let bases = basesByExchange.get(exchange);
    if (!bases) {
      bases = new Set();
      basesByExchange.set(exchange, bases);
    }
    if (row.base) bases.add(String(row.base).trim().toUpperCase());
  }
  return basesByExchange;
}

function keepNonExcludedTicker(row: TickerRow, basesByExchange: Map<string, Set<string>>): boolean {
  const input = {
    exchange: row.exchange,
    base: row.base,
    rawSymbol: row.raw_symbol,
    knownBases: basesByExchange.get(row.exchange ?? ""),
  };
  return !isTokenizedStock(input) && !isLeveragedToken(input);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function searchRank(row: TickerRow, query: string, compactQuery: string): number {
  const base = (row.base ?? "").trim().toUpperCase();
  const quote = (row.quote ?? "").trim().toUpperCase();
  const pair = `${base}/${quote}`;
  const compact = (row.raw_symbol ?? "").trim().toUpperCase().replace(/[-_/]/g, "");
  if (base === query) return 0;
  if (pair === query || compact === compactQuery) return 1;
  if (base.startsWith(query)) return 2;
  if (compact.startsWith(compactQuery)) return 3;
  return 4;
}

/**
 * Cari ticker terbaru di semua exchange yang aktif.
 * Filter saham/leverage sama seperti getLatestTickers.
 */
export function searchLatestTickers(query: string, limit = 80): TickerRow[] {
  const raw = query.trim().toUpperCase();
  if (raw.length < 2) return [];
  const enabled = getEnabledExchanges();
  if (enabled.length === 0) return [];

  const compactQuery = raw.replace(/[-_/]/g, "");
  const likeBase = `%${escapeLike(raw)}%`;
  const likePair = `${escapeLike(raw)}%`;
  const likeCompact = `${escapeLike(compactQuery)}%`;
  const placeholders = enabled.map(() => "?").join(",");

  const rows = getDb()
    .prepare(
      `SELECT ${TICKER_SELECT}
       FROM tickers_latest t
       LEFT JOIN markets m
         ON m.exchange = t.exchange AND m.raw_symbol = t.raw_symbol
       WHERE t.exchange IN (${placeholders})
         AND (
           UPPER(TRIM(t.base)) LIKE ? ESCAPE '\\'
           OR UPPER(TRIM(t.base) || '/' || TRIM(t.quote)) LIKE ? ESCAPE '\\'
           OR UPPER(REPLACE(REPLACE(REPLACE(TRIM(t.raw_symbol), '-', ''), '_', ''), '/', '')) LIKE ? ESCAPE '\\'
         )`,
    )
    .all(...enabled, likeBase, likePair, likeCompact) as TickerRow[];

  const involved = [...new Set(rows.map((row) => row.exchange))];
  let basesByExchange = new Map<string, Set<string>>();
  if (involved.length > 0) {
    const exchangePlaceholders = involved.map(() => "?").join(",");
    const baseRows = getDb()
      .prepare(`SELECT exchange, base FROM tickers_latest WHERE exchange IN (${exchangePlaceholders})`)
      .all(...involved) as Array<{ exchange: string; base: string }>;
    basesByExchange = collectBasesByExchange(baseRows);
  }

  const kept = rows.filter((row) => keepNonExcludedTicker(row, basesByExchange));
  kept.sort((a, b) => {
    const rankA = searchRank(a, raw, compactQuery);
    const rankB = searchRank(b, raw, compactQuery);
    if (rankA !== rankB) return rankA - rankB;
    const volA = a.quote_volume_24h;
    const volB = b.quote_volume_24h;
    if (volA == null && volB == null) {
      const name = a.exchange.localeCompare(b.exchange, "en", { sensitivity: "base" });
      if (name !== 0) return name;
      return `${a.base}/${a.quote}`.localeCompare(`${b.base}/${b.quote}`, "en", { numeric: true, sensitivity: "base" });
    }
    if (volA == null) return 1;
    if (volB == null) return -1;
    if (volB !== volA) return volB - volA;
    const name = a.exchange.localeCompare(b.exchange, "en", { sensitivity: "base" });
    if (name !== 0) return name;
    return `${a.base}/${a.quote}`.localeCompare(`${b.base}/${b.quote}`, "en", { numeric: true, sensitivity: "base" });
  });

  const cap = Number.isInteger(limit) && limit > 0 ? Math.min(200, limit) : 80;
  // Exact base/pair dari semua exchange selalu ikut, biar satu market volume besar
  // tidak menyingkirkan exchange lain.
  const exact = kept.filter((row) => searchRank(row, raw, compactQuery) <= 1);
  const rest = kept.filter((row) => searchRank(row, raw, compactQuery) > 1);
  return [...exact, ...rest].slice(0, Math.max(cap, exact.length));
}

export function getLatestOrderBook(exchange: string, rawSymbol: string): OrderBookRow | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM orderbook_snapshots
       WHERE exchange = ? AND raw_symbol = ?
       ORDER BY fetched_at DESC, id DESC
       LIMIT 1`,
    )
    .get(exchange, rawSymbol) as OrderBookRow | undefined;
  return row ?? null;
}

export function getOrderBookById(id: number): OrderBookRow | null {
  const row = getDb()
    .prepare(`SELECT * FROM orderbook_snapshots WHERE id = ?`)
    .get(id) as OrderBookRow | undefined;
  return row ?? null;
}

export function getLatestFetchLogs(): FetchLogRow[] {
  return getDb()
    .prepare(
      `SELECT f.*
       FROM fetch_logs f
       JOIN (
         SELECT exchange, MAX(id) AS max_id
         FROM fetch_logs
         GROUP BY exchange
       ) latest ON latest.max_id = f.id
       ORDER BY f.exchange ASC`,
    )
    .all() as FetchLogRow[];
}

export function getEnabledExchangeRows(): { id: string; name: string; enabled: number }[] {
  return getDb()
    .prepare(`SELECT id, name, enabled FROM exchanges WHERE enabled = 1 ORDER BY name COLLATE NOCASE, id`)
    .all() as { id: string; name: string; enabled: number }[];
}

export function getTickerCount(exchange?: string): number {
  if (exchange) {
    const row = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM tickers_latest WHERE exchange = ?`)
      .get(exchange) as { n: number };
    return row.n;
  }
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM tickers_latest`).get() as { n: number };
  return row.n;
}

/** Hapus markets + tickers_latest exchange ini yang tidak muncul di fetch terakhir. */
export function pruneMissingPairs(exchange: string, keepSymbols: string[]): number {
  if (keepSymbols.length === 0) return 0;
  const db = getDb();
  const keep = new Set(keepSymbols);
  let removed = 0;
  runTransaction(db, () => {
    const marketRows = db
      .prepare(`SELECT raw_symbol FROM markets WHERE exchange = ?`)
      .all(exchange) as { raw_symbol: string }[];
    const tickerRows = db
      .prepare(`SELECT raw_symbol FROM tickers_latest WHERE exchange = ?`)
      .all(exchange) as { raw_symbol: string }[];
    const delMarket = db.prepare(`DELETE FROM markets WHERE exchange = ? AND raw_symbol = ?`);
    const delTicker = db.prepare(`DELETE FROM tickers_latest WHERE exchange = ? AND raw_symbol = ?`);
    const symbols = new Set([...marketRows, ...tickerRows].map((row) => row.raw_symbol));
    for (const symbol of symbols) {
      if (!keep.has(symbol)) {
        delTicker.run(exchange, symbol);
        delMarket.run(exchange, symbol);
        removed += 1;
      }
    }
  });
  return removed;
}

export function patchTickerBidAsk(
  exchange: string,
  rawSymbol: string,
  quote: {
    bid: number | null;
    ask: number | null;
    bidSize?: number | null;
    askSize?: number | null;
  },
): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT last, base_volume_24h FROM tickers_latest WHERE exchange = ? AND raw_symbol = ?`,
    )
    .get(exchange, rawSymbol) as { last: number | null; base_volume_24h: number | null } | undefined;
  if (!row) return false;
  const stale = staleInfo({
    last: row.last,
    bid: quote.bid,
    ask: quote.ask,
    baseVolume24h: row.base_volume_24h,
  });
  const result = db
    .prepare(
      `UPDATE tickers_latest
       SET bid = ?, ask = ?, bid_size = ?, ask_size = ?,
           spread_pct = ?, last_vs_mid_pct = ?, stale = ?, stale_reasons = ?
       WHERE exchange = ? AND raw_symbol = ?`,
    )
    .run(
      quote.bid,
      quote.ask,
      quote.bidSize ?? null,
      quote.askSize ?? null,
      spreadPct(quote.bid, quote.ask),
      lastVsMidPct(row.last, quote.bid, quote.ask),
      stale.stale ? 1 : 0,
      stale.reasons.join(", ") || null,
      exchange,
      rawSymbol,
    );
  return Number(result.changes) > 0;
}

export function getMarketChainstatus(exchange: string, base: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT chainstatus_raw FROM markets WHERE exchange = ? AND upper(base) = upper(?) LIMIT 1`,
    )
    .get(exchange, base) as { chainstatus_raw: string | null } | undefined;
  return row?.chainstatus_raw ?? null;
}

export function patchMarketDeposit(
  exchange: string,
  base: string,
  depositEnabled: number | null,
  withdrawEnabled: number | null,
  chainstatusRaw: string | null,
): number {
  const result = getDb()
    .prepare(
      `UPDATE markets
       SET deposit_enabled = ?, withdraw_enabled = ?, chainstatus_raw = ?
       WHERE exchange = ? AND upper(base) = upper(?)`,
    )
    .run(depositEnabled, withdrawEnabled, chainstatusRaw, exchange, base);
  return Number(result.changes);
}

export function patchMarketContracts(exchange: string, base: string, contractsJson: string): number {
  const result = getDb()
    .prepare(
      `UPDATE markets
       SET contracts_json = ?
       WHERE exchange = ? AND upper(base) = upper(?)`,
    )
    .run(contractsJson, exchange, base);
  return Number(result.changes);
}

