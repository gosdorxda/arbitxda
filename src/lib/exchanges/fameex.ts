/**
 * Adapter FameEX — REST spot resmi.
 * Dokumentasi: https://fameexdocs.github.io/docs-v1/en/index.html
 * Host utama: https://openapi.fameex.com (cadangan resmi: https://openapi.fameex.net).
 * Simbol: GET /sapi/v1/symbols (tanpa field status/tipe; tradable dari ticker isFrozen).
 * Ticker massal resmi: GET /v2/public/ticker (last, volume, isFrozen; tanpa bid/ask/ubah 24j).
 * Depth: GET /sapi/v1/depth?symbol=BTCUSDT&limit=5 (dipakai orderbook + enrich bid/ask/ukuran).
 * Aset publik: GET /v2/public/assets (can_deposit/can_withdraw per koin, tanpa rantai/kontrak).
 * Tidak ada flag saham/leverage resmi; filter bersama otomatis.
 * Tidak perlu API key.
 */

import { withDerivedFields } from "../calc";
import { ExchangeApiError, fetchJson } from "../http";
import { createRateLimiter } from "../rate-limit";
import type {
  DerivedTicker,
  EnrichBidAskResult,
  EnrichPlan,
  ExchangeAdapter,
  MarketInfo,
  NormalizedTicker,
  OrderBookFetchResult,
  OrderBookLevel,
  RawResponse,
  TickerFetchResult,
} from "../types";
import { getSpotUrl } from "./spot-urls";
import { isLeveragedToken, isTokenizedStock } from "./stock-filter";

const EXCHANGE_ID = "fameex";
const PRIMARY_HOST = "https://openapi.fameex.com";
const BACKUP_HOST = "https://openapi.fameex.net";
const HOSTS = [PRIMARY_HOST, BACKUP_HOST];
const ALLOWED_QUOTES = new Set(["USDT", "USD"]);
const FAMEEX_HEADERS = { "Content-Type": "application/json" };

const schedule = createRateLimiter(300);

let activeHost = PRIMARY_HOST;

type FameexEnvelope = {
  code?: number | string;
  msg?: string;
  message?: string;
};

type SymbolRow = {
  symbol?: string;
  baseAsset?: string;
  quoteAsset?: string;
};

type V2Ticker = {
  base_id?: string;
  quote_id?: string;
  base_volume?: string;
  quote_volume?: string;
  last_price?: string;
  isFrozen?: number | string;
};

type AssetRow = {
  name?: string;
  can_deposit?: boolean;
  can_withdraw?: boolean;
};

type SymbolsPayload = FameexEnvelope & { data?: { symbols?: SymbolRow[] } };
type TickerPayload = FameexEnvelope & { data?: Record<string, V2Ticker> };
type AssetsPayload = FameexEnvelope & { data?: Record<string, AssetRow> };
type DepthPayload = FameexEnvelope & {
  data?: { time?: number; bids?: unknown[]; asks?: unknown[] };
};

type FameexResponse<T> = { data: T; rawText: string; url: string };

type GetOptions = {
  signal?: AbortSignal;
  throttle?: boolean;
  retries?: number;
};

function toNum(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isApiOk(payload: FameexEnvelope | null | undefined): boolean {
  return payload?.code === 0 || payload?.code === "0";
}

function isRetryableHostError(error: unknown): boolean {
  if (error instanceof ExchangeApiError) {
    const status = error.status;
    return status == null || status === 429 || status >= 500;
  }
  return true;
}

function apiError(path: string, payload: FameexEnvelope, rawText?: string): never {
  throw new ExchangeApiError(
    `FameEX ${path}: ${payload.msg ?? payload.message ?? "gagal"} (code ${payload.code})`,
    undefined,
    rawText?.slice(0, 2000),
  );
}

async function fameexGet<T extends FameexEnvelope>(
  path: string,
  query?: Record<string, string | number>,
  options: GetOptions = {},
): Promise<FameexResponse<T>> {
  const qs = query
    ? `?${new URLSearchParams(
        Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])),
      ).toString()}`
    : "";
  const relative = `${path}${qs}`;
  const tryHosts = [activeHost, ...HOSTS.filter((host) => host !== activeHost)];
  let lastError: unknown;

  for (const host of tryHosts) {
    const url = `${host}${relative}`;
    try {
      const run = () =>
        fetchJson<T>(url, {
          headers: FAMEEX_HEADERS,
          signal: options.signal,
          retries: options.retries,
        });
      const result = options.throttle === false ? await run() : await schedule(run);
      if (!isApiOk(result.data)) apiError(relative, result.data, result.rawText);
      activeHost = host;
      return { data: result.data, rawText: result.rawText, url };
    } catch (error) {
      lastError = error;
      const canFallback = host !== tryHosts[tryHosts.length - 1] && isRetryableHostError(error);
      if (canFallback) continue;
      throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new ExchangeApiError("FameEX: semua host gagal");
}

function tickerMapKey(base: string, quote: string): string {
  return `${base}_${quote}`;
}

function isFrozenFlag(value: unknown): boolean {
  return value === 1 || value === "1" || value === true;
}

function parseLevel(row: unknown, timestamp: number | null): OrderBookLevel | null {
  if (!Array.isArray(row) || row.length < 2) return null;
  const price = toNum(row[0]);
  const volume = toNum(row[1]);
  if (price == null || volume == null) return null;
  return { price, volume, timestamp };
}

function applyAssetFunding(market: MarketInfo, asset: AssetRow | undefined) {
  if (!asset) return;
  market.depositEnabled = asset.can_deposit ? 1 : 0;
  market.withdrawEnabled = asset.can_withdraw ? 1 : 0;
  market.chainstatusRaw = `FameEX: D${asset.can_deposit ? "✓" : "✗"} W${asset.can_withdraw ? "✓" : "✗"}`;
}

function toNormalizedTicker(
  market: MarketInfo,
  ticker: V2Ticker | undefined,
  fetchedAt: string,
): NormalizedTicker {
  return {
    exchange: EXCHANGE_ID,
    rawSymbol: market.rawSymbol,
    base: market.base,
    quote: market.quote,
    last: ticker ? toNum(ticker.last_price) : null,
    bid: null,
    ask: null,
    bidSize: null,
    askSize: null,
    baseVolume24h: ticker ? toNum(ticker.base_volume) : null,
    quoteVolume24h: ticker ? toNum(ticker.quote_volume) : null,
    change24hPct: null,
    exchangeTimestamp: null,
    fetchedAt,
  };
}

async function fetchTickers(): Promise<TickerFetchResult> {
  const rawResponses: RawResponse[] = [];
  const [symbolsRes, tickerRes, assetsRes] = await Promise.all([
    fameexGet<SymbolsPayload>("/sapi/v1/symbols"),
    fameexGet<TickerPayload>("/v2/public/ticker"),
    fameexGet<AssetsPayload>("/v2/public/assets").catch((error) => {
      console.warn(
        "[fameex] gagal ambil /v2/public/assets, depo/wd dilewati:",
        error instanceof Error ? error.message : error,
      );
      return null;
    }),
  ]);

  rawResponses.push({ endpoint: symbolsRes.url, rawJson: symbolsRes.rawText });
  rawResponses.push({ endpoint: tickerRes.url, rawJson: tickerRes.rawText });
  if (assetsRes) rawResponses.push({ endpoint: assetsRes.url, rawJson: assetsRes.rawText });

  const symbols = symbolsRes.data.data?.symbols ?? [];
  const rawTickers = tickerRes.data.data ?? {};
  const tickersByKey = new Map<string, V2Ticker>();
  for (const [key, row] of Object.entries(rawTickers)) {
    if (!row || typeof row !== "object") continue;
    tickersByKey.set(key.trim().toUpperCase(), row);
    const base = String(row.base_id ?? "").trim().toUpperCase();
    const quote = String(row.quote_id ?? "").trim().toUpperCase();
    if (base && quote) tickersByKey.set(tickerMapKey(base, quote), row);
  }

  const assetsByCoin = new Map<string, AssetRow>();
  for (const [coin, row] of Object.entries(assetsRes?.data.data ?? {})) {
    if (!row || typeof row !== "object") continue;
    const key = coin.trim().toUpperCase();
    if (key) assetsByCoin.set(key, row);
  }

  const markets: MarketInfo[] = [];
  let skippedQuote = 0;
  let skippedFrozen = 0;
  for (const row of symbols) {
    const rawSymbol = String(row.symbol ?? "").trim().toUpperCase();
    const base = String(row.baseAsset ?? "").trim().toUpperCase();
    const quote = String(row.quoteAsset ?? "").trim().toUpperCase();
    if (!rawSymbol || !base || !quote) continue;
    if (!ALLOWED_QUOTES.has(quote)) {
      skippedQuote += 1;
      continue;
    }
    const ticker =
      tickersByKey.get(tickerMapKey(base, quote)) ?? tickersByKey.get(rawSymbol) ?? undefined;
    if (ticker && isFrozenFlag(ticker.isFrozen)) {
      skippedFrozen += 1;
      continue;
    }
    const displayName = assetsByCoin.get(base)?.name?.trim() || null;
    const market: MarketInfo = {
      rawSymbol,
      base,
      quote,
      active: true,
      status: "trading",
      isStock: isTokenizedStock({ base, names: displayName ? [displayName] : undefined }),
      isLeveraged: isLeveragedToken({ base, names: displayName ? [displayName] : undefined }),
      displayName,
    };
    applyAssetFunding(market, assetsByCoin.get(base));
    markets.push(market);
  }

  if (skippedQuote > 0) {
    console.log(`[fameex] lewati ${skippedQuote} pair bukan USDT/USD`);
  }
  if (skippedFrozen > 0) {
    console.log(`[fameex] lewati ${skippedFrozen} pair beku (isFrozen=1)`);
  }

  const fetchedAt = new Date().toISOString();
  const tickers: DerivedTicker[] = markets.map((market) => {
    const ticker =
      tickersByKey.get(tickerMapKey(market.base, market.quote)) ??
      tickersByKey.get(market.rawSymbol);
    return withDerivedFields(toNormalizedTicker(market, ticker, fetchedAt));
  });

  return { tickers, markets, rawResponses };
}

async function fetchOrderBook(rawSymbol: string, count = 5): Promise<OrderBookFetchResult> {
  const symbol = rawSymbol.trim().toUpperCase();
  const limit = Math.max(1, count);
  const result = await fameexGet<DepthPayload>("/sapi/v1/depth", { symbol, limit });
  const book = result.data.data ?? {};
  const ts = toNum(book.time);
  const toLevels = (rows: unknown[] | undefined) =>
    (rows ?? [])
      .slice(0, limit)
      .map((row) => parseLevel(row, ts))
      .filter((row): row is OrderBookLevel => row != null);

  return {
    endpoint: result.url,
    rawJson: result.rawText,
    orderbook: {
      exchange: EXCHANGE_ID,
      rawSymbol: symbol,
      bids: toLevels(book.bids),
      asks: toLevels(book.asks),
      fetchedAt: new Date().toISOString(),
    },
  };
}

function buildEnrichPlan(input: { tickers: DerivedTicker[]; markets: MarketInfo[] }): EnrichPlan {
  return {
    bidAsk: input.tickers.map((ticker) => ({
      rawSymbol: ticker.rawSymbol,
      quoteVolume24h: ticker.quoteVolume24h,
    })),
    deposits: [],
  };
}

async function enrichBidAsk(rawSymbol: string, signal: AbortSignal): Promise<EnrichBidAskResult> {
  const symbol = rawSymbol.trim().toUpperCase();
  const result = await fameexGet<DepthPayload>(
    "/sapi/v1/depth",
    { symbol, limit: 5 },
    { signal, throttle: false, retries: 0 },
  );
  const book = result.data.data ?? {};
  const bid = parseLevel(book.bids?.[0], null);
  const ask = parseLevel(book.asks?.[0], null);
  return {
    rawSymbol: symbol,
    bid: bid?.price ?? null,
    ask: ask?.price ?? null,
    bidSize: bid?.volume ?? null,
    askSize: ask?.volume ?? null,
  };
}

export const fameexAdapter: ExchangeAdapter = {
  id: EXCHANGE_ID,
  name: "FameEX",
  fetchTickers,
  fetchOrderBook,
  spotUrl: (base, quote) => getSpotUrl(EXCHANGE_ID, base, quote),
  enrichConcurrency: 3,
  buildEnrichPlan,
  enrichBidAsk,
};
