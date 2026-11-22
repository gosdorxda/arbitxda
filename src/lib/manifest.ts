/**
 * Official Manifest Trade stats client (server-only).
 *
 * Data source: https://mfx-stats-mainnet.fly.dev only.
 *   GET /tickers   — markets, last, bid/ask, 24h volume
 *   GET /metadata  — marketAddress -> [baseSymbol, quoteSymbol]
 *   GET /asset     — fallback mint -> symbol (used only if /metadata misses a mint)
 *   GET /orderbook?ticker_id=&depth= — bid/ask levels for the depth column
 *
 * This page is exempt from the scanner's USDT/USD-only quote rule: every
 * quote mint is shown. Tokenized stocks are still excluded when metadata
 * is available (see isManifestTokenizedStock).
 */
import fs from "node:fs";
import path from "node:path";
import { midPrice, spreadPct } from "@/lib/calc";
import { getLatestTickers } from "@/lib/db";
import { getSpotUrl } from "@/lib/exchanges/spot-urls";
import { CRYPTO_KEEP, EQUITY_TICKERS, isTokenizedStock } from "@/lib/exchanges/stock-filter";
import { ExchangeApiError, fetchJson } from "@/lib/http";
import type {
  ManifestCexGap,
  ManifestDepthItem,
  ManifestMarket,
  ManifestOrderBook,
  ManifestSnapshot,
  ManifestSolRate,
  ManifestTokenGroup,
} from "@/lib/manifest-types";
import { MANIFEST_STATS_BASE, MANIFEST_TRADE_URL } from "@/lib/manifest-types";

export { MANIFEST_STATS_BASE, MANIFEST_TRADE_URL };

const TICKERS_TTL_MS = 60_000;
const TICKERS_STALE_MS = 30 * 60_000;
const METADATA_TTL_MS = 15 * 60_000;
const DEPTH_TTL_MS = 60_000;
const DEPTH_ERROR_TTL_MS = 15_000;
const TICKERS_TIMEOUT_MS = 20_000;
const METADATA_TIMEOUT_MS = 20_000;
const DEPTH_TIMEOUT_MS = 12_000;
const DEPTH_CONCURRENCY = 3;
const DEPTH_MAX_MARKETS = 80;
/** CoinGecko-style depth: total levels, split evenly, so 10 => 5 bids + 5 asks. */
const DEPTH_LEVELS = 10;
/** Official /orderbook depth is total levels split evenly; 40 => 20 bids + 20 asks. */
export const MANIFEST_BOOK_LEVELS = 20;
const BOOK_DEPTH_PARAM = MANIFEST_BOOK_LEVELS * 2;
const BOOK_TIMEOUT_MS = 20_000;

/** Official well-known Solana mints, used as symbol + USD-rate seeds when metadata is thin. */
export const KNOWN_MINTS: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  So11111111111111111111111111111111111111112: "SOL",
};

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOL_RATE_TTL_MS = 60_000;
const SOL_RATE_TIMEOUT_MS = 8_000;

/**
 * Manifest tokenized-stock heuristic (this page only).
 *
 * Official /tickers identifies tokens by mint, not by CoinGecko names, so we
 * only see whatever /metadata (or /asset) returns — usually a short symbol,
 * sometimes a longer display string. A market / token group is dropped when:
 *
 * 1. Name or symbol text matches xStock / xStocks, "Ondo Tokenized",
 *    "Backpack Securities", "tokenized/tokenised stock|etf|equity",
 *    or "pre-IPO" equity wrappers.
 * 2. The existing scanner `isTokenizedStock()` matches the resolved symbol
 *    plus those names (NVDAX-style suffix against known equity tickers, and
 *    the shared name regex). Crypto keep-list symbols (ONDO, RENDER, …)
 *    are not dropped by suffix rules.
 * 3. The symbol itself is a known equity ticker of length >= 3, except
 *    CRYPTO_KEEP and a short conflict list (META is MetaDAO on Solana,
 *    APP/SOLV/ARM also collide with crypto or ambiguous tickers).
 *
 * If /metadata and /asset are both unavailable we cannot apply this safely
 * (we only have mints), so the snapshot keeps every market and sets
 * `stockFilterApplied: false`.
 */
const NAME_STOCK_RE =
  /\b(x[\s-]?stocks?|ondo\s+tokenized|backpack\s+securities|tokenized\s+(stock|equity|etf|asset)|tokenised\s+(stock|equity|etf|asset)|pre-?ipo)\b/i;

const SYMBOL_CONFLICT_KEEP = new Set(["META", "APP", "SOLV", "ARM", "NOW", "ALL", "HAS", "NET", "FUN", "GAS", "KEY", "WIN", "ICE", "BOX", "CAT", "LOW"]);

export function isManifestTokenizedStock(input: {
  symbol?: string | null;
  name?: string | null;
  mint?: string | null;
}): boolean {
  const symbol = (input.symbol ?? "").trim();
  const name = (input.name ?? "").trim();
  const blob = `${symbol} ${name}`.trim();
  if (blob && NAME_STOCK_RE.test(blob)) return true;
  if (
    isTokenizedStock({
      base: symbol || input.mint || "",
      names: [name, symbol],
    })
  ) {
    return true;
  }
  const upper = symbol.toUpperCase();
  if (!upper || CRYPTO_KEEP.has(upper) || SYMBOL_CONFLICT_KEEP.has(upper)) return false;
  if (upper.length >= 3 && EQUITY_TICKERS.has(upper)) return true;
  return false;
}

type RawTicker = {
  ticker_id?: unknown;
  base_currency?: unknown;
  target_currency?: unknown;
  last_price?: unknown;
  base_volume?: unknown;
  target_volume?: unknown;
  pool_id?: unknown;
  liquidity_in_usd?: unknown;
  trade_url?: unknown;
  bid?: unknown;
  ask?: unknown;
};

export type ParsedTicker = {
  tickerId: string;
  baseMint: string;
  quoteMint: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
  baseVolume: number | null;
  quoteVolume: number | null;
  liquidityUsd: number | null;
};

type CacheBox<T> = { value: T; at: number; ttl: number };

let solRateCache: CacheBox<ManifestSolRate> | null = null;
let tickersCache: CacheBox<ParsedTicker[]> | null = null;
let metadataCache: CacheBox<Map<string, [string, string]>> | null = null;
let lastGoodTickers: CacheBox<ParsedTicker[]> | null = null;
let lastGoodMetadata: CacheBox<Map<string, [string, string]>> | null = null;
let diskSnapshotLoaded = false;
let refreshInFlight: Promise<void> | null = null;
let lastRefreshError: string | null = null;

function manifestSnapshotPath(): string {
  return path.resolve(process.cwd(), "data", "manifest-snapshot.json");
}

const depthCache = new Map<string, CacheBox<ManifestDepthItem>>();
const assetSymbolCache = new Map<string, CacheBox<string | null>>();

function nowMs(): number {
  return Date.now();
}

function readCache<T>(box: CacheBox<T> | null, now = nowMs()): T | null {
  if (!box) return null;
  if (now - box.at >= box.ttl) return null;
  return box.value;
}

function asFinite(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
}

export function isSolanaAddress(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function parseTickers(data: unknown): ParsedTicker[] {
  if (!Array.isArray(data)) {
    throw new Error("Respons /tickers Manifest bukan array");
  }
  const out: ParsedTicker[] = [];
  for (const row of data as RawTicker[]) {
    const tickerId = asText(row.ticker_id);
    const baseMint = asText(row.base_currency);
    const quoteMint = asText(row.target_currency);
    if (!tickerId || !baseMint || !quoteMint) continue;
    if (!isSolanaAddress(tickerId) || !isSolanaAddress(baseMint) || !isSolanaAddress(quoteMint)) continue;
    out.push({
      tickerId,
      baseMint,
      quoteMint,
      last: asFinite(row.last_price),
      bid: asFinite(row.bid),
      ask: asFinite(row.ask),
      baseVolume: asFinite(row.base_volume),
      quoteVolume: asFinite(row.target_volume),
      liquidityUsd: asFinite(row.liquidity_in_usd),
    });
  }
  return out;
}

function parseMetadata(data: unknown): Map<string, [string, string]> {
  const map = new Map<string, [string, string]>();
  if (!data || typeof data !== "object") return map;
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (!isSolanaAddress(key)) continue;
    if (Array.isArray(value) && value.length >= 2) {
      const base = asText(value[0]) ?? "";
      const quote = asText(value[1]) ?? "";
      if (base || quote) map.set(key, [base, quote]);
      continue;
    }
    if (value && typeof value === "object") {
      const rec = value as { base?: unknown; quote?: unknown; 0?: unknown; 1?: unknown };
      const base = asText(rec.base) ?? asText(rec[0]) ?? "";
      const quote = asText(rec.quote) ?? asText(rec[1]) ?? "";
      if (base || quote) map.set(key, [base, quote]);
    }
  }
  return map;
}

async function fetchTickersFresh(): Promise<ParsedTicker[]> {
  const { data } = await fetchJson<unknown>(`${MANIFEST_STATS_BASE}/tickers`, {
    timeoutMs: TICKERS_TIMEOUT_MS,
    retries: 0,
  });
  return parseTickers(data);
}

async function fetchMetadataFresh(): Promise<Map<string, [string, string]>> {
  const { data } = await fetchJson<unknown>(`${MANIFEST_STATS_BASE}/metadata`, {
    timeoutMs: METADATA_TIMEOUT_MS,
    retries: 0,
  });
  return parseMetadata(data);
}

type PersistedManifestSnapshot = {
  version: 1;
  fetchedAt: string;
  tickers: ParsedTicker[];
  metadata: Record<string, [string, string]>;
  metadataFetchedAt?: string;
};

function reviveTickers(data: unknown): ParsedTicker[] | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const out: ParsedTicker[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Partial<ParsedTicker>;
    const tickerId = asText(rec.tickerId);
    const baseMint = asText(rec.baseMint);
    const quoteMint = asText(rec.quoteMint);
    if (!tickerId || !baseMint || !quoteMint) continue;
    if (!isSolanaAddress(tickerId) || !isSolanaAddress(baseMint) || !isSolanaAddress(quoteMint)) continue;
    out.push({
      tickerId,
      baseMint,
      quoteMint,
      last: asFinite(rec.last),
      bid: asFinite(rec.bid),
      ask: asFinite(rec.ask),
      baseVolume: asFinite(rec.baseVolume),
      quoteVolume: asFinite(rec.quoteVolume),
      liquidityUsd: asFinite(rec.liquidityUsd),
    });
  }
  return out.length > 0 ? out : null;
}

function ensureDiskSnapshotLoaded(): void {
  if (diskSnapshotLoaded) return;
  diskSnapshotLoaded = true;
  if (lastGoodTickers?.value.length) return;
  const file = manifestSnapshotPath();
  try {
    if (!fs.existsSync(file)) return;
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PersistedManifestSnapshot>;
    if (raw.version !== 1) return;
    const tickers = reviveTickers(raw.tickers);
    const at = raw.fetchedAt ? Date.parse(raw.fetchedAt) : Number.NaN;
    if (!tickers || !Number.isFinite(at)) return;
    lastGoodTickers = { value: tickers, at, ttl: TICKERS_STALE_MS };
    if (raw.metadata && typeof raw.metadata === "object") {
      const metadata = parseMetadata(raw.metadata);
      if (metadata.size > 0) {
        const metaAt = raw.metadataFetchedAt ? Date.parse(raw.metadataFetchedAt) : at;
        lastGoodMetadata = {
          value: metadata,
          at: Number.isFinite(metaAt) ? metaAt : at,
          ttl: TICKERS_STALE_MS,
        };
      }
    }
  } catch (error) {
    console.warn(
      "[manifest] gagal baca data/manifest-snapshot.json:",
      error instanceof Error ? error.message : error,
    );
  }
}

function persistDiskSnapshot(): void {
  if (!lastGoodTickers?.value.length) return;
  const file = manifestSnapshotPath();
  const payload: PersistedManifestSnapshot = {
    version: 1,
    fetchedAt: new Date(lastGoodTickers.at).toISOString(),
    tickers: lastGoodTickers.value,
    metadata: Object.fromEntries(lastGoodMetadata?.value ?? []),
    metadataFetchedAt: lastGoodMetadata ? new Date(lastGoodMetadata.at).toISOString() : undefined,
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, file);
  } catch (error) {
    console.warn(
      "[manifest] gagal tulis data/manifest-snapshot.json:",
      error instanceof Error ? error.message : error,
    );
    try {
      fs.unlinkSync(`${file}.tmp`);
    } catch {
      // ignore leftover tmp
    }
  }
}

async function refreshManifestFromUpstream(): Promise<void> {
  const [tickersResult, metaResult] = await Promise.allSettled([
    fetchTickersFresh(),
    fetchMetadataFresh(),
  ]);
  if (tickersResult.status === "rejected") {
    if (metaResult.status === "fulfilled" && metaResult.value.size > 0) {
      const now = nowMs();
      metadataCache = { value: metaResult.value, at: now, ttl: METADATA_TTL_MS };
      lastGoodMetadata = { value: metaResult.value, at: now, ttl: TICKERS_STALE_MS };
    }
    throw tickersResult.reason;
  }
  const tickers = tickersResult.value;
  if (tickers.length === 0) throw new Error("Respons /tickers Manifest kosong");
  const now = nowMs();
  tickersCache = { value: tickers, at: now, ttl: TICKERS_TTL_MS };
  lastGoodTickers = { value: tickers, at: now, ttl: TICKERS_STALE_MS };

  let metadata = lastGoodMetadata?.value ?? new Map<string, [string, string]>();
  if (metaResult.status === "fulfilled") {
    metadata = metaResult.value;
    metadataCache = { value: metadata, at: now, ttl: METADATA_TTL_MS };
    lastGoodMetadata = { value: metadata, at: now, ttl: TICKERS_STALE_MS };
  }
  if (metadata.size < tickers.length) {
    try {
      metadata = await fillMissingSymbols(tickers, metadata);
      lastGoodMetadata = { value: metadata, at: now, ttl: TICKERS_STALE_MS };
      metadataCache = { value: metadata, at: now, ttl: METADATA_TTL_MS };
    } catch (error) {
      console.warn(
        "[manifest] fillMissingSymbols gagal:",
        error instanceof Error ? error.message : error,
      );
    }
  }
  persistDiskSnapshot();
}

function startManifestRefresh(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  const run = refreshManifestFromUpstream()
    .then(() => {
      lastRefreshError = null;
    })
    .catch((error) => {
      lastRefreshError = describeManifestError(error);
      throw error;
    })
    .finally(() => {
      refreshInFlight = null;
    });
  refreshInFlight = run;
  return run;
}

function scheduleManifestRefresh(): boolean {
  void startManifestRefresh().catch((error) => {
    console.warn("[manifest] refresh latar gagal:", lastRefreshError ?? describeManifestError(error));
  });
  return true;
}

function tickersAreFresh(box: CacheBox<ParsedTicker[]> | null, now = nowMs()): box is CacheBox<ParsedTicker[]> {
  return Boolean(box && now - box.at < TICKERS_TTL_MS);
}

async function lookupAssetSymbol(mint: string): Promise<string | null> {
  const hit = readCache(assetSymbolCache.get(mint) ?? null);
  if (hit !== null) return hit;
  try {
    const { data } = await fetchJson<{ asset?: { symbol?: unknown } }>(
      `${MANIFEST_STATS_BASE}/asset?id=${encodeURIComponent(mint)}`,
      { timeoutMs: 8_000, retries: 0 },
    );
    const symbol = asText(data?.asset?.symbol);
    assetSymbolCache.set(mint, { value: symbol, at: nowMs(), ttl: METADATA_TTL_MS });
    return symbol;
  } catch {
    assetSymbolCache.set(mint, { value: null, at: nowMs(), ttl: 5 * 60_000 });
    return null;
  }
}

export async function getManifestTickers(): Promise<{
  tickers: ParsedTicker[];
  cached: boolean;
  stale: boolean;
  warning: string | null;
}> {
  ensureDiskSnapshotLoaded();
  const now = nowMs();
  if (tickersAreFresh(tickersCache, now)) {
    return { tickers: tickersCache.value, cached: true, stale: false, warning: null };
  }
  if (lastGoodTickers?.value.length) {
    const stale = now - lastGoodTickers.at >= TICKERS_TTL_MS;
    if (stale) scheduleManifestRefresh();
    return {
      tickers: lastGoodTickers.value,
      cached: true,
      stale,
      warning: stale && lastRefreshError
        ? `API Manifest gagal (${lastRefreshError}). Menampilkan data cache.`
        : null,
    };
  }
  await startManifestRefresh();
  if (!lastGoodTickers?.value.length) throw new Error("Snapshot Manifest kosong");
  return { tickers: lastGoodTickers.value, cached: false, stale: false, warning: null };
}

export async function getManifestMetadata(): Promise<{
  metadata: Map<string, [string, string]>;
  ok: boolean;
}> {
  ensureDiskSnapshotLoaded();
  const fresh = readCache(metadataCache);
  if (fresh) return { metadata: fresh, ok: true };
  if (lastGoodMetadata && lastGoodMetadata.value.size > 0) {
    if (!tickersAreFresh(tickersCache) && !tickersAreFresh(lastGoodTickers)) {
      scheduleManifestRefresh();
    }
    return { metadata: lastGoodMetadata.value, ok: true };
  }
  try {
    const metadata = await fetchMetadataFresh();
    const box = { value: metadata, at: nowMs(), ttl: METADATA_TTL_MS };
    metadataCache = box;
    lastGoodMetadata = { value: metadata, at: box.at, ttl: TICKERS_STALE_MS };
    return { metadata, ok: true };
  } catch {
    return { metadata: new Map(), ok: false };
  }
}

export function describeManifestError(error: unknown): string {
  if (error instanceof ExchangeApiError) {
    return `HTTP ${error.status ?? "?"} dari ${MANIFEST_STATS_BASE}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export function manifestErrorStatus(error: unknown): number | null {
  if (error instanceof ExchangeApiError && typeof error.status === "number") return error.status;
  return null;
}

function shortFallback(mint: string): string {
  if (mint.length <= 8) return mint;
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

function symbolForMint(
  mint: string,
  metadata: Map<string, [string, string]>,
  side: "base" | "quote",
  tickerId?: string,
): string {
  const known = KNOWN_MINTS[mint];
  if (known) return known;
  if (tickerId) {
    const pair = metadata.get(tickerId);
    if (pair) {
      const symbol = side === "base" ? pair[0] : pair[1];
      if (symbol) return symbol;
    }
  }
  return shortFallback(mint);
}

function marketPrice(ticker: ParsedTicker): number | null {
  if (ticker.last != null && ticker.last > 0) return ticker.last;
  return midPrice(ticker.bid, ticker.ask);
}

/**
 * Official SOL/USDT mid from public REST, used to convert SOL-quoted
 * Manifest prices to USDT. Order: Binance bookTicker, Bybit, OKX,
 * scanner DB SOL/USDT, then Manifest SOL/USDC.
 */
export async function getSolUsdRate(options?: {
  refresh?: boolean;
  tickers?: ParsedTicker[];
  allowNetwork?: boolean;
}): Promise<ManifestSolRate | null> {
  const now = nowMs();
  if (!options?.refresh) {
    const hit = readCache(solRateCache, now);
    if (hit) return hit;
    if (options?.allowNetwork === false) return solRateCache?.value ?? null;
  }
  if (options?.allowNetwork === false && !options?.refresh) {
    return solRateCache?.value ?? null;
  }
  const next = await fetchSolUsdRate(options?.tickers);
  if (next) {
    solRateCache = { value: next, at: nowMs(), ttl: SOL_RATE_TTL_MS };
    return next;
  }
  if (solRateCache && now - solRateCache.at < TICKERS_STALE_MS) {
    return solRateCache.value;
  }
  return null;
}

function bookMid(bid: unknown, ask: unknown, last?: unknown): number | null {
  const bidPx = asFinite(bid);
  const askPx = asFinite(ask);
  if (bidPx != null && askPx != null && bidPx > 0 && askPx > 0) return (bidPx + askPx) / 2;
  const lastPx = asFinite(last);
  return lastPx != null && lastPx > 0 ? lastPx : null;
}

async function fetchSolUsdRate(tickers?: ParsedTicker[]): Promise<ManifestSolRate | null> {
  const fromBinance = await fetchBinanceSolUsdt();
  if (fromBinance) return fromBinance;
  const fromBybit = await fetchBybitSolUsdt();
  if (fromBybit) return fromBybit;
  const fromOkx = await fetchOkxSolUsdt();
  if (fromOkx) return fromOkx;
  const fromDb = solRateFromScannerDb();
  if (fromDb) return fromDb;
  return solRateFromManifest(tickers);
}

async function fetchBinanceSolUsdt(): Promise<ManifestSolRate | null> {
  try {
    const { data } = await fetchJson<{ bidPrice?: unknown; askPrice?: unknown }>(
      "https://api.binance.com/api/v3/ticker/bookTicker?symbol=SOLUSDT",
      { timeoutMs: SOL_RATE_TIMEOUT_MS, retries: 0 },
    );
    const price = bookMid(data.bidPrice, data.askPrice);
    if (price == null) return null;
    return { price, source: "Binance SOLUSDT", fetchedAt: new Date().toISOString() };
  } catch (error) {
    console.warn("[manifest] Binance SOLUSDT gagal:", describeManifestError(error));
    return null;
  }
}

async function fetchBybitSolUsdt(): Promise<ManifestSolRate | null> {
  try {
    const { data } = await fetchJson<{
      retCode?: unknown;
      result?: { list?: Array<{ bid1Price?: unknown; ask1Price?: unknown; lastPrice?: unknown }> };
    }>("https://api.bybit.com/v5/market/tickers?category=spot&symbol=SOLUSDT", {
      timeoutMs: SOL_RATE_TIMEOUT_MS,
      retries: 0,
    });
    const row = data.result?.list?.[0];
    const price = row ? bookMid(row.bid1Price, row.ask1Price, row.lastPrice) : null;
    if (price == null) return null;
    return { price, source: "Bybit SOLUSDT", fetchedAt: new Date().toISOString() };
  } catch (error) {
    console.warn("[manifest] Bybit SOLUSDT gagal:", describeManifestError(error));
    return null;
  }
}

async function fetchOkxSolUsdt(): Promise<ManifestSolRate | null> {
  try {
    const { data } = await fetchJson<{
      code?: unknown;
      data?: Array<{ bidPx?: unknown; askPx?: unknown; last?: unknown }>;
    }>("https://www.okx.com/api/v5/market/ticker?instId=SOL-USDT", {
      timeoutMs: SOL_RATE_TIMEOUT_MS,
      retries: 0,
    });
    const row = Array.isArray(data.data) ? data.data[0] : undefined;
    const price = row ? bookMid(row.bidPx, row.askPx, row.last) : null;
    if (price == null) return null;
    return { price, source: "OKX SOL-USDT", fetchedAt: new Date().toISOString() };
  } catch (error) {
    console.warn("[manifest] OKX SOL-USDT gagal:", describeManifestError(error));
    return null;
  }
}

function solRateFromScannerDb(): ManifestSolRate | null {
  try {
    const rows = getLatestTickers();
    let best: { price: number; exchange: string; volume: number; usdt: boolean; quote: string } | null = null;
    for (const row of rows) {
      if ((row.base ?? "").trim().toUpperCase() !== "SOL") continue;
      const quote = (row.quote ?? "").trim().toUpperCase();
      if (quote !== "USDT" && quote !== "USD") continue;
      const price = midPrice(row.bid, row.ask) ?? (row.last != null && row.last > 0 ? row.last : null);
      if (price == null || price <= 0) continue;
      const volume = row.quote_volume_24h ?? 0;
      const usdt = quote === "USDT";
      if (!best || (usdt && !best.usdt) || (usdt === best.usdt && volume > best.volume)) {
        best = { price, exchange: row.exchange, volume, usdt, quote };
      }
    }
    if (!best) return null;
    return {
      price: best.price,
      source: `DB ${best.exchange} SOL/${best.quote}`,
      fetchedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.warn("[manifest] SOL/USDT dari DB gagal:", error instanceof Error ? error.message : error);
    return null;
  }
}

function solRateFromManifest(tickers?: ParsedTicker[]): ManifestSolRate | null {
  const list = tickers ?? readCache(tickersCache) ?? lastGoodTickers?.value ?? [];
  let best: { price: number; volume: number } | null = null;
  for (const ticker of list) {
    const solUsdc = ticker.baseMint === SOL_MINT && ticker.quoteMint === USDC_MINT;
    const usdcSol = ticker.baseMint === USDC_MINT && ticker.quoteMint === SOL_MINT;
    if (!solUsdc && !usdcSol) continue;
    const raw = marketPrice(ticker);
    if (raw == null || raw <= 0) continue;
    const price = solUsdc ? raw : 1 / raw;
    const volume = ticker.quoteVolume ?? ticker.baseVolume ?? 0;
    if (!best || volume > best.volume) best = { price, volume };
  }
  if (!best) return null;
  return {
    price: best.price,
    source: "Manifest SOL/USDC",
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Derive a USD rate for every mint that can be reached from USDC via
 * markets in the same /tickers snapshot (USDT, SOL, and other quotes).
 * USDC is $1, USDT is $1, and an official SOL/USDT mid is preferred when given.
 */
export function buildUsdRates(tickers: ParsedTicker[], solUsd?: number | null): Map<string, number> {
  const rates = new Map<string, number>();
  rates.set(USDC_MINT, 1);
  rates.set(USDT_MINT, 1);
  if (solUsd != null && solUsd > 0) rates.set(SOL_MINT, solUsd);
  const edges = tickers
    .map((ticker) => ({ ticker, price: marketPrice(ticker) }))
    .filter((row): row is { ticker: ParsedTicker; price: number } => row.price != null && row.price > 0);

  for (let pass = 0; pass < 5; pass += 1) {
    let added = 0;
    for (const { ticker, price } of edges) {
      const quoteUsd = rates.get(ticker.quoteMint);
      const baseUsd = rates.get(ticker.baseMint);
      if (quoteUsd != null && !rates.has(ticker.baseMint)) {
        rates.set(ticker.baseMint, price * quoteUsd);
        added += 1;
      } else if (baseUsd != null && !rates.has(ticker.quoteMint) && price > 0) {
        rates.set(ticker.quoteMint, baseUsd / price);
        added += 1;
      }
    }
    if (added === 0) break;
  }
  return rates;
}

function volumeUsd(ticker: ParsedTicker, quoteUsd: number | undefined, lastUsd: number | null): number | null {
  if (quoteUsd != null && ticker.quoteVolume != null && ticker.quoteVolume >= 0) {
    return ticker.quoteVolume * quoteUsd;
  }
  if (lastUsd != null && ticker.baseVolume != null && ticker.baseVolume >= 0) {
    return ticker.baseVolume * lastUsd;
  }
  return null;
}

type CexRef = {
  exchange: string;
  base: string;
  quote: string;
  rawSymbol: string;
  priceUsd: number;
  volume: number;
  contracts: ReturnType<typeof getLatestTickers>[number]["contracts"];
};

function buildCexIndex(): Map<string, CexRef> {
  const index = new Map<string, CexRef>();
  let rows: ReturnType<typeof getLatestTickers> = [];
  try {
    rows = getLatestTickers();
  } catch (error) {
    console.warn("[manifest] gagal baca ticker CEX dari DB:", error instanceof Error ? error.message : error);
    return index;
  }
  for (const row of rows) {
    const quote = (row.quote ?? "").trim().toUpperCase();
    if (quote !== "USDT" && quote !== "USD") continue;
    const symbol = (row.base ?? "").trim().toUpperCase();
    if (!symbol) continue;
    const price = midPrice(row.bid, row.ask) ?? (row.last != null && row.last > 0 ? row.last : null);
    if (price == null || price <= 0) continue;
    const volume = row.quote_volume_24h ?? 0;
    const current = index.get(symbol);
    const preferUsdt = quote === "USDT" && current?.quote !== "USDT";
    const betterVolume = current != null && quote === current.quote && volume > current.volume;
    if (!current || preferUsdt || betterVolume) {
      index.set(symbol, {
        exchange: row.exchange,
        base: row.base,
        quote,
        rawSymbol: row.raw_symbol,
        priceUsd: price,
        volume,
        contracts: row.contracts,
      });
    }
  }
  return index;
}

function pickTokenPriceUsd(markets: ManifestMarket[]): number | null {
  const usdc = markets
    .filter((market) => market.quoteMint === USDC_MINT && market.lastUsd != null && market.lastUsd > 0)
    .sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0));
  if (usdc[0]?.lastUsd) return usdc[0].lastUsd;
  const any = [...markets]
    .filter((market) => market.lastUsd != null && market.lastUsd > 0)
    .sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0));
  return any[0]?.lastUsd ?? null;
}

export function buildManifestGroups(
  tickers: ParsedTicker[],
  metadata: Map<string, [string, string]>,
  stockFilterApplied: boolean,
  solUsd?: number | null,
): { tokens: ManifestTokenGroup[]; keptMarkets: number; droppedStockMarkets: number } {
  const rates = buildUsdRates(tickers, solUsd);
  const cex = buildCexIndex();
  const mintSymbols = new Map<string, string>();

  for (const ticker of tickers) {
    const pair = metadata.get(ticker.tickerId);
    if (pair?.[0] && !mintSymbols.has(ticker.baseMint)) mintSymbols.set(ticker.baseMint, pair[0]);
    if (pair?.[1] && !mintSymbols.has(ticker.quoteMint)) mintSymbols.set(ticker.quoteMint, pair[1]);
  }
  for (const [mint, symbol] of Object.entries(KNOWN_MINTS)) {
    if (!mintSymbols.has(mint)) mintSymbols.set(mint, symbol);
  }

  let droppedStockMarkets = 0;
  const byBase = new Map<string, ManifestMarket[]>();

  for (const ticker of tickers) {
    const baseSymbol = mintSymbols.get(ticker.baseMint) ?? symbolForMint(ticker.baseMint, metadata, "base", ticker.tickerId);
    const quoteSymbol = mintSymbols.get(ticker.quoteMint) ?? symbolForMint(ticker.quoteMint, metadata, "quote", ticker.tickerId);
    if (stockFilterApplied) {
      const baseStock = isManifestTokenizedStock({ symbol: baseSymbol, name: baseSymbol, mint: ticker.baseMint });
      const quoteStock = isManifestTokenizedStock({ symbol: quoteSymbol, name: quoteSymbol, mint: ticker.quoteMint });
      if (baseStock || quoteStock) {
        droppedStockMarkets += 1;
        continue;
      }
    }
    const quoteUsd = rates.get(ticker.quoteMint) ?? null;
    const last = marketPrice(ticker);
    const lastUsd = last != null && quoteUsd != null ? last * quoteUsd : null;
    const bidUsd = ticker.bid != null && ticker.bid > 0 && quoteUsd != null ? ticker.bid * quoteUsd : null;
    const askUsd = ticker.ask != null && ticker.ask > 0 && quoteUsd != null ? ticker.ask * quoteUsd : null;
    const market: ManifestMarket = {
      tickerId: ticker.tickerId,
      baseMint: ticker.baseMint,
      quoteMint: ticker.quoteMint,
      baseSymbol,
      quoteSymbol,
      last: ticker.last,
      bid: ticker.bid,
      ask: ticker.ask,
      spreadPct: spreadPct(ticker.bid, ticker.ask),
      lastUsd,
      bidUsd,
      askUsd,
      quoteUsd,
      volume24hUsd: volumeUsd(ticker, quoteUsd ?? undefined, lastUsd),
      liquidityUsd: ticker.liquidityUsd,
      tradeUrl: `${MANIFEST_TRADE_URL}/${ticker.tickerId}`,
    };
    const list = byBase.get(ticker.baseMint) ?? [];
    list.push(market);
    byBase.set(ticker.baseMint, list);
  }

  const tokens: ManifestTokenGroup[] = [];
  for (const [baseMint, markets] of byBase) {
    markets.sort((a, b) => (b.volume24hUsd ?? -1) - (a.volume24hUsd ?? -1));
    const symbol = markets[0]?.baseSymbol ?? shortFallback(baseMint);
    const volume24hUsd = markets.reduce((sum, market) => sum + (market.volume24hUsd ?? 0), 0);
    const priceUsd = pickTokenPriceUsd(markets);
    const cexRef = cex.get(symbol.trim().toUpperCase());
    let cexGap: ManifestCexGap | null = null;
    if (priceUsd != null && priceUsd > 0 && cexRef && cexRef.priceUsd > 0) {
      cexGap = {
        symbol: symbol.trim().toUpperCase(),
        exchange: cexRef.exchange,
        quote: cexRef.quote,
        rawSymbol: cexRef.rawSymbol,
        spotUrl: getSpotUrl(cexRef.exchange, cexRef.base, cexRef.quote, cexRef.rawSymbol, cexRef.contracts),
        cexPriceUsd: cexRef.priceUsd,
        manifestPriceUsd: priceUsd,
        gapPct: ((priceUsd - cexRef.priceUsd) / cexRef.priceUsd) * 100,
        symbolMatchOnly: true,
      };
    }
    tokens.push({
      baseMint,
      symbol,
      name: null,
      marketCount: markets.length,
      volume24hUsd,
      priceUsd,
      cexGap,
      markets,
    });
  }

  tokens.sort((a, b) => b.volume24hUsd - a.volume24hUsd);
  return { tokens, keptMarkets: tokens.reduce((sum, token) => sum + token.marketCount, 0), droppedStockMarkets };
}

export async function loadManifestSnapshot(options?: { refreshSol?: boolean }): Promise<ManifestSnapshot> {
  const source = `${MANIFEST_STATS_BASE}/tickers`;
  try {
    const [{ tickers, cached, stale, warning }, meta] = await Promise.all([
      getManifestTickers(),
      getManifestMetadata(),
    ]);
    const metadata = meta.metadata;
    const stockFilterApplied = meta.ok && metadata.size > 0;
    const hadFreshTickers = tickersAreFresh(tickersCache) || tickersAreFresh(lastGoodTickers);
    const solRate = await getSolUsdRate({
      refresh: options?.refreshSol === true,
      tickers,
      allowNetwork: options?.refreshSol === true || !cached,
    });
    const { tokens, keptMarkets, droppedStockMarkets } = buildManifestGroups(
      tickers,
      metadata,
      stockFilterApplied,
      solRate?.price,
    );
    const warnings: string[] = [];
    if (warning) warnings.push(warning);
    if (!stockFilterApplied) {
      warnings.push("Metadata symbol Manifest tidak tersedia, filter token saham dilewati.");
    }
    const fetchedAt = lastGoodTickers
      ? new Date(lastGoodTickers.at).toISOString()
      : new Date().toISOString();
    return {
      ok: true,
      fetchedAt,
      cached,
      stale,
      refreshing: Boolean(refreshInFlight) || Boolean(stale && !hadFreshTickers),
      warning: warnings.length ? warnings.join(" ") : null,
      source,
      solRate,
      stats: {
        rawMarkets: tickers.length,
        keptMarkets,
        droppedStockMarkets,
        tokens: tokens.length,
        stockFilterApplied,
      },
      tokens,
    };
  } catch (error) {
    return {
      ok: false,
      error: describeManifestError(error),
      status: manifestErrorStatus(error),
      fetchedAt: new Date().toISOString(),
      source,
    };
  }
}

type OrderbookResponse = {
  ticker_id?: unknown;
  bids?: unknown;
  asks?: unknown;
};

function parseOrderbookLevels(levels: unknown, side: "bid" | "ask"): Array<{ price: number; volume: number }> {
  if (!Array.isArray(levels)) return [];
  const parsed: Array<{ price: number; volume: number }> = [];
  for (const level of levels) {
    let price: number | null = null;
    let volume: number | null = null;
    if (Array.isArray(level) && level.length >= 2) {
      price = asFinite(level[0]);
      volume = asFinite(level[1]);
    } else if (level && typeof level === "object") {
      const rec = level as { price?: unknown; volume?: unknown; size?: unknown };
      price = asFinite(rec.price);
      volume = asFinite(rec.volume) ?? asFinite(rec.size);
    }
    if (price != null && volume != null && price > 0 && volume > 0) {
      parsed.push({ price, volume });
    }
  }
  parsed.sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price));
  return parsed;
}

function levelsNotional(levels: unknown, side: "bid" | "ask", count: number): number {
  let total = 0;
  for (const level of parseOrderbookLevels(levels, side).slice(0, count)) {
    total += level.price * level.volume;
  }
  return total;
}

async function fetchOneOrderbook(tickerId: string, quoteUsd: number | undefined): Promise<ManifestDepthItem> {
  const { data } = await fetchJson<OrderbookResponse>(
    `${MANIFEST_STATS_BASE}/orderbook?ticker_id=${encodeURIComponent(tickerId)}&depth=${DEPTH_LEVELS}`,
    { timeoutMs: DEPTH_TIMEOUT_MS, retries: 0 },
  );
  const bidQuote = levelsNotional(data?.bids, "bid", 5);
  const askQuote = levelsNotional(data?.asks, "ask", 5);
  const rate = quoteUsd ?? null;
  return {
    tickerId,
    bidUsd: rate != null ? bidQuote * rate : null,
    askUsd: rate != null ? askQuote * rate : null,
    ok: true,
  };
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  const pending = [...items];
  const workers = Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    while (pending.length) {
      const item = pending.shift();
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(workers);
}


export async function fetchManifestOrderBook(tickerId: string): Promise<ManifestOrderBook> {
  const id = tickerId.trim();
  if (!isSolanaAddress(id)) {
    throw new Error("ticker_id Manifest tidak valid");
  }

  let quoteMint: string | null = null;
  let quoteUsd: number | null = null;
  let baseSymbol = shortFallback(id);
  let quoteSymbol = "QUOTE";
  try {
    const [{ tickers }, meta] = await Promise.all([getManifestTickers(), getManifestMetadata()]);
    const solRate = await getSolUsdRate({ tickers });
    const rates = buildUsdRates(tickers, solRate?.price);
    const ticker = tickers.find((row) => row.tickerId === id);
    if (ticker) {
      quoteMint = ticker.quoteMint;
      quoteUsd = rates.get(ticker.quoteMint) ?? null;
      baseSymbol = symbolForMint(ticker.baseMint, meta.metadata, "base", id);
      quoteSymbol = symbolForMint(ticker.quoteMint, meta.metadata, "quote", id);
    }
  } catch (error) {
    console.warn("[manifest] orderbook tanpa metadata/rate:", describeManifestError(error));
  }

  const { data } = await fetchJson<OrderbookResponse>(
    `${MANIFEST_STATS_BASE}/orderbook?ticker_id=${encodeURIComponent(id)}&depth=${BOOK_DEPTH_PARAM}`,
    { timeoutMs: BOOK_TIMEOUT_MS, retries: 0 },
  );

  return {
    tickerId: id,
    bids: parseOrderbookLevels(data?.bids, "bid").slice(0, MANIFEST_BOOK_LEVELS),
    asks: parseOrderbookLevels(data?.asks, "ask").slice(0, MANIFEST_BOOK_LEVELS),
    baseSymbol,
    quoteSymbol,
    quoteMint,
    quoteUsd,
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchManifestDepth(tickerIds: string[]): Promise<ManifestDepthItem[]> {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of tickerIds) {
    const id = raw.trim();
    if (!isSolanaAddress(id) || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
    if (unique.length >= DEPTH_MAX_MARKETS) break;
  }

  const now = nowMs();
  const items: ManifestDepthItem[] = [];
  const needed: string[] = [];
  for (const id of unique) {
    const hit = readCache(depthCache.get(id) ?? null, now);
    if (hit) items.push(hit);
    else needed.push(id);
  }
  if (needed.length === 0) return items;

  let rates = new Map<string, number>();
  const quoteByMarket = new Map<string, string>();
  try {
    const { tickers } = await getManifestTickers();
    const solRate = await getSolUsdRate({ tickers });
    rates = buildUsdRates(tickers, solRate?.price);
    for (const ticker of tickers) quoteByMarket.set(ticker.tickerId, ticker.quoteMint);
  } catch (error) {
    console.warn("[manifest] depth tanpa rate USD:", describeManifestError(error));
  }

  await runPool(needed, DEPTH_CONCURRENCY, async (tickerId) => {
    try {
      const quoteMint = quoteByMarket.get(tickerId);
      const result = await fetchOneOrderbook(tickerId, quoteMint ? rates.get(quoteMint) : undefined);
      depthCache.set(tickerId, { value: result, at: nowMs(), ttl: DEPTH_TTL_MS });
      items.push(result);
    } catch {
      const result: ManifestDepthItem = { tickerId, bidUsd: null, askUsd: null, ok: false };
      depthCache.set(tickerId, { value: result, at: nowMs(), ttl: DEPTH_ERROR_TTL_MS });
      items.push(result);
    }
  });

  const order = new Map(unique.map((id, index) => [id, index]));
  items.sort((a, b) => (order.get(a.tickerId) ?? 0) - (order.get(b.tickerId) ?? 0));
  return items;
}

/** Optional: fill missing symbols via /asset for a small number of unknown base mints. */
export async function fillMissingSymbols(
  tickers: ParsedTicker[],
  metadata: Map<string, [string, string]>,
  limit = 20,
): Promise<Map<string, [string, string]>> {
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const ticker of tickers) {
    if (metadata.has(ticker.tickerId)) continue;
    if (KNOWN_MINTS[ticker.baseMint]) continue;
    if (seen.has(ticker.baseMint)) continue;
    seen.add(ticker.baseMint);
    missing.push(ticker.baseMint);
    if (missing.length >= limit) break;
  }
  if (missing.length === 0) return metadata;
  const next = new Map(metadata);
  const results = await Promise.all(missing.map(async (mint) => [mint, await lookupAssetSymbol(mint)] as const));
  for (const ticker of tickers) {
    const symbol = results.find((row) => row[0] === ticker.baseMint)?.[1];
    if (!symbol) continue;
    if (!next.has(ticker.tickerId)) {
      const quote = KNOWN_MINTS[ticker.quoteMint] ?? shortFallback(ticker.quoteMint);
      next.set(ticker.tickerId, [symbol, quote]);
    }
  }
  return next;
}
