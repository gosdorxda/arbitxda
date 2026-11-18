/**
 * Adapter Pionex — REST spot resmi (publik, tanpa API key).
 * Dokumentasi: https://pionex-doc.gitbook.io/apidocs (Common > Market Data, Markets)
 * Host: https://api.pionex.com
 * Simbol: GET /api/v1/common/symbols (type SPOT; enable=false = order via API ditutup, pasar web tetap jalan)
 * Ticker massal: GET /api/v1/market/tickers?type=SPOT (open, close, volume=base, amount=quote)
 * Bid/ask massal: GET /api/v1/market/bookTickers?type=SPOT (default endpoint = PERP, jadi wajib type=SPOT)
 * Depth: GET /api/v1/market/depth?symbol=&limit=
 * Depo/WD + alamat kontrak: TIDAK ADA endpoint wallet/koin di API resmi Pionex (hanya balance & order).
 * Saham tokenisasi: Pionex memakai xStocks bersufiks X (AAPLX, TSLAX, IONQX, ...). Sebagian ditangkap
 *   filter bersama; sisanya lewat daftar eksplisit PIONEX_STOCK_BASES.
 */

import { withDerivedFields } from "../calc";
import { ExchangeApiError, fetchJson } from "../http";
import { createRateLimiter } from "../rate-limit";
import type {
  DerivedTicker,
  ExchangeAdapter,
  MarketInfo,
  NormalizedTicker,
  OrderBookFetchResult,
  OrderBookLevel,
  RawResponse,
  TickerFetchResult,
} from "../types";
import { isLeveragedToken, isTokenizedStock } from "./stock-filter";

const EXCHANGE_ID = "pionex";
const BASE_URL = "https://api.pionex.com";
const ALLOWED_QUOTES = new Set(["USDT", "USD"]);
/** xStocks di Pionex yang ticker sahamnya tidak ada di daftar ekuitas filter bersama (dicek 13 Nov 2026). */
const PIONEX_STOCK_BASES = new Set([
  "CCJX", "DXYZX", "IONQX", "MUUX", "NASAX", "NLRX", "RAMX", "SKUUX", "SMRX", "TSLLX", "UFOX", "NIOX",
]);
const schedule = createRateLimiter(200);

type Envelope<T> = { result?: boolean; code?: string; message?: string; data?: T; timestamp?: number };

type PionexSymbol = {
  symbol?: string;
  type?: string;
  baseCurrency?: string;
  quoteCurrency?: string;
  enable?: boolean;
};

type PionexTicker = {
  symbol?: string;
  time?: number;
  open?: string;
  close?: string;
  volume?: string;
  amount?: string;
};

type PionexBook = {
  symbol?: string;
  bidPrice?: string;
  bidSize?: string;
  askPrice?: string;
  askSize?: string;
  timestamp?: number;
};

type PionexDepth = {
  bids?: Array<[string, string] | string[]>;
  asks?: Array<[string, string] | string[]>;
  updateTime?: number;
};

type ApiResponse<T> = { data: Envelope<T>; rawText: string; url: string };

function toNum(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

async function pionexGet<T>(path: string, query?: Record<string, string | number>): Promise<ApiResponse<T>> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
  const href = url.toString();
  const result = await schedule(() => fetchJson<Envelope<T>>(href, { retries: 1 }));
  if (result.data?.result === false) {
    throw new ExchangeApiError(
      `Pionex ${path}: ${result.data.message ?? result.data.code ?? "gagal"}`,
      200,
      result.rawText.slice(0, 2000),
    );
  }
  return { data: result.data, rawText: result.rawText, url: href };
}

function toNormalizedTicker(
  market: MarketInfo,
  ticker: PionexTicker | undefined,
  book: PionexBook | undefined,
  fetchedAt: string,
): NormalizedTicker {
  const open = toNum(ticker?.open);
  const last = toNum(ticker?.close);
  const ts = toNum(book?.timestamp) ?? toNum(ticker?.time);
  return {
    exchange: EXCHANGE_ID,
    rawSymbol: market.rawSymbol,
    base: market.base,
    quote: market.quote,
    last,
    bid: toNum(book?.bidPrice),
    ask: toNum(book?.askPrice),
    bidSize: toNum(book?.bidSize),
    askSize: toNum(book?.askSize),
    baseVolume24h: toNum(ticker?.volume),
    quoteVolume24h: toNum(ticker?.amount),
    change24hPct: open != null && open !== 0 && last != null ? ((last - open) / open) * 100 : null,
    exchangeTimestamp: ts != null && ts > 0 ? new Date(ts).toISOString() : null,
    fetchedAt,
  };
}

function toLevels(rows: Array<[string, string] | string[]> | undefined, limit: number, ts: number | null): OrderBookLevel[] {
  const out: OrderBookLevel[] = [];
  for (const row of rows ?? []) {
    const price = toNum(row[0]);
    const volume = toNum(row[1]);
    if (price == null || volume == null) continue;
    out.push({ price, volume, timestamp: ts });
    if (out.length >= limit) break;
  }
  return out;
}

async function fetchTickers(): Promise<TickerFetchResult> {
  const rawResponses: RawResponse[] = [];
  const [symbolRes, tickerRes, bookRes] = await Promise.all([
    pionexGet<{ symbols?: PionexSymbol[] }>("/api/v1/common/symbols"),
    pionexGet<{ tickers?: PionexTicker[] }>("/api/v1/market/tickers", { type: "SPOT" }),
    pionexGet<{ tickers?: PionexBook[] }>("/api/v1/market/bookTickers", { type: "SPOT" }),
  ]);
  rawResponses.push({ endpoint: symbolRes.url, rawJson: symbolRes.rawText });
  rawResponses.push({ endpoint: tickerRes.url, rawJson: tickerRes.rawText });
  rawResponses.push({ endpoint: bookRes.url, rawJson: bookRes.rawText });

  const tickerMap = new Map<string, PionexTicker>();
  for (const row of tickerRes.data.data?.tickers ?? []) {
    const key = String(row.symbol ?? "").trim().toUpperCase();
    if (key) tickerMap.set(key, row);
  }
  const bookMap = new Map<string, PionexBook>();
  for (const row of bookRes.data.data?.tickers ?? []) {
    const key = String(row.symbol ?? "").trim().toUpperCase();
    if (key) bookMap.set(key, row);
  }

  const markets: MarketInfo[] = [];
  let skippedQuote = 0;
  let skippedNoData = 0;
  for (const row of symbolRes.data.data?.symbols ?? []) {
    if (row.type && row.type.toUpperCase() !== "SPOT") continue;
    const rawSymbol = String(row.symbol ?? "").trim().toUpperCase();
    const base = String(row.baseCurrency ?? "").trim().toUpperCase();
    const quote = String(row.quoteCurrency ?? "").trim().toUpperCase();
    if (!rawSymbol || !base || !quote) continue;
    if (!ALLOWED_QUOTES.has(quote)) {
      skippedQuote += 1;
      continue;
    }
    // Pair tanpa ticker & tanpa book = belum/tidak diperdagangkan (delist/pre-listing).
    if (!tickerMap.has(rawSymbol) && !bookMap.has(rawSymbol)) {
      skippedNoData += 1;
      continue;
    }
    markets.push({
      rawSymbol,
      base,
      quote,
      active: true,
      status: row.enable === false ? "api_disabled" : "trading",
      isStock: PIONEX_STOCK_BASES.has(base) || isTokenizedStock({ base, rawSymbol }),
      isLeveraged: isLeveragedToken({ base, rawSymbol }),
      displayName: null,
    });
  }
  if (skippedQuote > 0) console.log(`[pionex] lewati ${skippedQuote} pair bukan USDT/USD`);
  if (skippedNoData > 0) console.log(`[pionex] lewati ${skippedNoData} pair tanpa ticker/book`);

  const fetchedAt = new Date().toISOString();
  const tickers: DerivedTicker[] = markets.map((market) =>
    withDerivedFields(
      toNormalizedTicker(market, tickerMap.get(market.rawSymbol), bookMap.get(market.rawSymbol), fetchedAt),
    ),
  );
  return { tickers, markets, rawResponses };
}

async function fetchOrderBook(rawSymbol: string, count = 5): Promise<OrderBookFetchResult> {
  const symbol = rawSymbol.trim().toUpperCase();
  const limit = Math.min(Math.max(1, count), 1000);
  const result = await pionexGet<PionexDepth>("/api/v1/market/depth", { symbol, limit });
  const book = result.data.data ?? {};
  const ts = toNum(book.updateTime);
  return {
    endpoint: result.url,
    rawJson: result.rawText,
    orderbook: {
      exchange: EXCHANGE_ID,
      rawSymbol: symbol,
      bids: toLevels(book.bids, limit, ts),
      asks: toLevels(book.asks, limit, ts),
      fetchedAt: new Date().toISOString(),
    },
  };
}

export function pionexSpotUrl(base: string, quote: string): string | null {
  if (!base || !quote) return null;
  return `https://www.pionex.com/en/trade/${base.toUpperCase()}_${quote.toUpperCase()}/Manual`;
}

export const pionexAdapter: ExchangeAdapter = {
  id: EXCHANGE_ID,
  name: "Pionex",
  fetchTickers,
  fetchOrderBook,
  spotUrl: pionexSpotUrl,
};
