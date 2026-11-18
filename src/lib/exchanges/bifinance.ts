/**
 * Adapter BiFinance — REST spot resmi (repo resmi: https://github.com/Bifinance/Bifinance-Api).
 * Host produksi: https://www.bifinance.com/api (cadangan: https://api.bifinance.com/api).
 * Demo resmi memakai POST bertanda tangan, tapi ticker/depth produksi merespons tanpa key.
 * Ticker massal: POST /market/tickers (last, volume, ubah 24j, status, flag saham stockType).
 * Depth: POST /market/depth { coinMarket: "BTC/USDT" } (bid/ask/ukuran; ambil 5 level).
 * Tidak ada endpoint koin/rantai/kontrak di dokumen resmi; depo/wd dilewati.
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

const EXCHANGE_ID = "bifinance";
const PRIMARY_HOST = "https://www.bifinance.com/api";
const BACKUP_HOST = "https://api.bifinance.com/api";
const HOSTS = [PRIMARY_HOST, BACKUP_HOST];
const ALLOWED_QUOTES = new Set(["USDT", "USD"]);
const JSON_HEADERS = { "Content-Type": "application/json" };
const schedule = createRateLimiter(300);

let activeHost = PRIMARY_HOST;

type Envelope<T> = {
  code?: number | string;
  message?: string;
  success?: boolean;
  data?: T;
};

type TickerRow = {
  coinMarket?: string;
  lastPrice?: string | number;
  close?: string | number;
  amount?: string | number;
  turnover?: string | number;
  rangeAbility?: string | number;
  status?: number | string;
  onDealing?: number | string;
  stockType?: string | null;
  stockNum?: string | number | null;
};

type DepthLevel = { trustPrice?: string | number; lastNumber?: string | number };
type DepthData = { symbolKey?: string; bids?: DepthLevel[]; asks?: DepthLevel[] };

type PostOptions = { signal?: AbortSignal; throttle?: boolean; retries?: number };
type ApiResponse<T> = { data: Envelope<T>; rawText: string; url: string };

function toNum(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isOk(payload: Envelope<unknown>): boolean {
  return payload.code === 1 || payload.code === "1" || payload.success === true;
}

function isRetryableHostError(error: unknown): boolean {
  if (error instanceof ExchangeApiError) {
    const status = error.status;
    return status == null || status === 429 || status >= 500;
  }
  return true;
}

function parseMarket(coinMarket: string): { rawSymbol: string; base: string; quote: string } | null {
  const raw = coinMarket.trim();
  const parts = raw.split("/");
  if (parts.length !== 2) return null;
  const base = parts[0]!.trim().toUpperCase();
  const quote = parts[1]!.trim().toUpperCase();
  if (!base || !quote) return null;
  return { rawSymbol: `${base}/${quote}`, base, quote };
}

async function bifinancePost<T>(path: string, body: Record<string, unknown> = {}, options: PostOptions = {}): Promise<ApiResponse<T>> {
  const tryHosts = [activeHost, ...HOSTS.filter((host) => host !== activeHost)];
  let lastError: unknown;
  const payload = JSON.stringify(body);

  for (const host of tryHosts) {
    const url = `${host}${path}`;
    try {
      const run = () =>
        fetchJson<Envelope<T>>(url, {
          method: "POST",
          headers: JSON_HEADERS,
          body: payload,
          signal: options.signal,
          retries: options.retries,
        });
      const result = options.throttle === false ? await run() : await schedule(run);
      if (!isOk(result.data)) {
        throw new ExchangeApiError(
          `BiFinance ${path}: ${result.data.message ?? "gagal"} (code ${result.data.code})`,
          undefined,
          result.rawText.slice(0, 2000),
        );
      }
      activeHost = host;
      return { data: result.data, rawText: result.rawText, url };
    } catch (error) {
      lastError = error;
      const canFallback = host !== tryHosts[tryHosts.length - 1] && isRetryableHostError(error);
      if (canFallback) continue;
      throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new ExchangeApiError("BiFinance: semua host gagal");
}

function toLevels(rows: DepthLevel[] | undefined, limit: number): OrderBookLevel[] {
  const out: OrderBookLevel[] = [];
  for (const row of rows ?? []) {
    const price = toNum(row.trustPrice);
    const volume = toNum(row.lastNumber);
    if (price == null || volume == null) continue;
    out.push({ price, volume, timestamp: null });
    if (out.length >= limit) break;
  }
  return out;
}

function toNormalizedTicker(market: MarketInfo, row: TickerRow, fetchedAt: string): NormalizedTicker {
  const change = toNum(row.rangeAbility);
  return {
    exchange: EXCHANGE_ID,
    rawSymbol: market.rawSymbol,
    base: market.base,
    quote: market.quote,
    last: toNum(row.lastPrice) ?? toNum(row.close),
    bid: null,
    ask: null,
    bidSize: null,
    askSize: null,
    baseVolume24h: toNum(row.amount),
    quoteVolume24h: toNum(row.turnover),
    change24hPct: change == null ? null : change * 100,
    exchangeTimestamp: null,
    fetchedAt,
  };
}

async function fetchTickers(): Promise<TickerFetchResult> {
  const rawResponses: RawResponse[] = [];
  const tickerRes = await bifinancePost<TickerRow[]>("/market/tickers", {});
  rawResponses.push({ endpoint: tickerRes.url, rawJson: tickerRes.rawText });

  const markets: MarketInfo[] = [];
  const tickerBySymbol = new Map<string, TickerRow>();
  let skippedQuote = 0;
  let skippedInactive = 0;

  for (const row of tickerRes.data.data ?? []) {
    const parsed = parseMarket(String(row.coinMarket ?? ""));
    if (!parsed) continue;
    if (!ALLOWED_QUOTES.has(parsed.quote)) {
      skippedQuote += 1;
      continue;
    }
    const dealing = row.onDealing === 1 || row.onDealing === "1";
    const listed = row.status === 1 || row.status === "1" || row.status == null;
    if (!dealing || !listed) {
      skippedInactive += 1;
      continue;
    }
    const officialStock = Boolean(row.stockType && String(row.stockType).trim());
    markets.push({
      rawSymbol: parsed.rawSymbol,
      base: parsed.base,
      quote: parsed.quote,
      active: true,
      status: dealing ? "trading" : "inactive",
      isStock: officialStock || isTokenizedStock({ base: parsed.base }),
      isLeveraged: isLeveragedToken({ base: parsed.base }),
    });
    tickerBySymbol.set(parsed.rawSymbol, row);
  }

  if (skippedQuote > 0) console.log(`[bifinance] lewati ${skippedQuote} pair bukan USDT/USD`);
  if (skippedInactive > 0) {
    console.log(`[bifinance] lewati ${skippedInactive} pair USDT/USD yang tidak onDealing/status 1`);
  }

  const fetchedAt = new Date().toISOString();
  const tickers: DerivedTicker[] = markets.map((market) =>
    withDerivedFields(toNormalizedTicker(market, tickerBySymbol.get(market.rawSymbol) ?? {}, fetchedAt)),
  );
  return { tickers, markets, rawResponses };
}

async function fetchOrderBook(rawSymbol: string, count = 5): Promise<OrderBookFetchResult> {
  const symbol = rawSymbol.trim().toUpperCase();
  const limit = Math.max(1, count);
  const result = await bifinancePost<DepthData>("/market/depth", { coinMarket: symbol });
  const book = result.data.data ?? {};
  return {
    endpoint: result.url,
    rawJson: result.rawText,
    orderbook: {
      exchange: EXCHANGE_ID,
      rawSymbol: symbol,
      bids: toLevels(book.bids, limit),
      asks: toLevels(book.asks, limit),
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
  const result = await bifinancePost<DepthData>(
    "/market/depth",
    { coinMarket: symbol },
    { signal, throttle: false, retries: 0 },
  );
  const book = result.data.data ?? {};
  const bid = toLevels(book.bids, 1)[0];
  const ask = toLevels(book.asks, 1)[0];
  return {
    rawSymbol: symbol,
    bid: bid?.price ?? null,
    ask: ask?.price ?? null,
    bidSize: bid?.volume ?? null,
    askSize: ask?.volume ?? null,
  };
}

export const bifinanceAdapter: ExchangeAdapter = {
  id: EXCHANGE_ID,
  name: "BiFinance",
  fetchTickers,
  fetchOrderBook,
  spotUrl: (base, quote) => getSpotUrl(EXCHANGE_ID, base, quote),
  enrichConcurrency: 3,
  buildEnrichPlan,
  enrichBidAsk,
};
