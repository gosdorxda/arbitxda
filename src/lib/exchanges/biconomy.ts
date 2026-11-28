/**
 * Adapter Biconomy — REST spot resmi V3 (publik, tanpa API key).
 * Dokumentasi: https://github.com/BiconomyOfficial/apidocs
 * Host: https://api.biconomy.com
 * Simbol: GET /api/v3/symbols (symbol BASE_QUOTE, baseAsset, quoteAsset, status;
 *   docs tidak merinci enum status; data live: 1 = aktif/trading, 0 = nonaktif).
 * Ticker massal: GET /api/v3/tickers (last, buy=bid, sell=ask, vol=volume 24 jam base,
 *   deal=volume 24 jam quote/USDT → dipakai sebagai Vol USD; change 24 jam).
 * Depth: GET /api/v3/depth?symbol=&limit= (default 100, max 200; bids/asks [price, amount]).
 * Depo/WD + alamat kontrak: TIDAK ADA di API resmi V3 (withdrawal/transfer masih "reserved"),
 *   jadi kolom Depo/WD dan kontrak dikosongkan.
 * V1/V2 dan Websocket di dokumentasi sengaja tidak dipakai.
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

const EXCHANGE_ID = "biconomy";
const BASE_URL = "https://api.biconomy.com";
const ALLOWED_QUOTES = new Set(["USDT"]);
const DEPTH_MAX = 200;
const schedule = createRateLimiter(200);

type Envelope<T> = { code?: number; message?: unknown; data?: T };

type BicoSymbol = {
  symbol?: string;
  baseAsset?: string;
  quoteAsset?: string;
  status?: number | string;
};

type BicoTicker = {
  symbol?: string;
  last?: string | number;
  high?: string | number;
  low?: string | number;
  vol?: string | number;
  deal?: string | number;
  change?: string | number;
  buy?: string | number;
  sell?: string | number;
};

type BicoDepth = {
  asks?: Array<[string, string] | string[] | number[]>;
  bids?: Array<[string, string] | string[] | number[]>;
};

type ApiResponse<T> = { data: T; rawText: string; url: string };

function toNum(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

function isActiveStatus(status: unknown): boolean {
  return Number(status) === 1;
}

async function bicoGet<T>(path: string, query?: Record<string, string | number>): Promise<ApiResponse<T>> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
  const href = url.toString();
  const result = await schedule(() => fetchJson<Envelope<T>>(href, { retries: 1 }));
  const envelope = result.data;
  if (envelope?.code !== 0) {
    const msg =
      typeof envelope?.message === "string"
        ? envelope.message
        : envelope?.message
          ? JSON.stringify(envelope.message)
          : "gagal";
    throw new ExchangeApiError(`Biconomy ${path}: ${msg}`, 200, result.rawText.slice(0, 2000));
  }
  if (envelope.data == null) {
    throw new ExchangeApiError(`Biconomy ${path}: respons tanpa data`, 200, result.rawText.slice(0, 2000));
  }
  return { data: envelope.data, rawText: result.rawText, url: href };
}

function toNormalizedTicker(market: MarketInfo, row: BicoTicker | undefined, fetchedAt: string): NormalizedTicker {
  return {
    exchange: EXCHANGE_ID,
    rawSymbol: market.rawSymbol,
    base: market.base,
    quote: market.quote,
    last: toNum(row?.last),
    bid: toNum(row?.buy),
    ask: toNum(row?.sell),
    bidSize: null,
    askSize: null,
    baseVolume24h: toNum(row?.vol),
    quoteVolume24h: toNum(row?.deal),
    change24hPct: toNum(row?.change),
    exchangeTimestamp: null,
    fetchedAt,
  };
}

function toLevels(
  rows: Array<[string, string] | string[] | number[]> | undefined,
  limit: number,
  side: "bid" | "ask",
): OrderBookLevel[] {
  const out: OrderBookLevel[] = [];
  for (const row of rows ?? []) {
    const price = toNum(row[0]);
    const volume = toNum(row[1]);
    if (price == null || volume == null) continue;
    out.push({ price, volume, timestamp: null });
  }
  out.sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price));
  return out.slice(0, limit);
}

async function fetchTickers(): Promise<TickerFetchResult> {
  const rawResponses: RawResponse[] = [];
  const [symbolRes, tickerRes] = await Promise.all([
    bicoGet<BicoSymbol[]>("/api/v3/symbols"),
    bicoGet<BicoTicker[]>("/api/v3/tickers"),
  ]);
  rawResponses.push({ endpoint: symbolRes.url, rawJson: symbolRes.rawText });
  rawResponses.push({ endpoint: tickerRes.url, rawJson: tickerRes.rawText });

  const tickerMap = new Map<string, BicoTicker>();
  for (const row of tickerRes.data ?? []) {
    const symbol = String(row.symbol ?? "").trim().toUpperCase();
    if (!symbol) continue;
    tickerMap.set(symbol, row);
  }

  const markets: MarketInfo[] = [];
  let skippedQuote = 0;
  let skippedStatus = 0;
  let skippedNoTicker = 0;
  for (const row of symbolRes.data ?? []) {
    const rawSymbol = String(row.symbol ?? "").trim().toUpperCase();
    const base = String(row.baseAsset ?? "").trim().toUpperCase();
    const quote = String(row.quoteAsset ?? "").trim().toUpperCase();
    if (!rawSymbol || !base || !quote) continue;
    if (!ALLOWED_QUOTES.has(quote)) {
      skippedQuote += 1;
      continue;
    }
    if (!isActiveStatus(row.status)) {
      skippedStatus += 1;
      continue;
    }
    if (!tickerMap.has(rawSymbol)) {
      skippedNoTicker += 1;
      continue;
    }
    markets.push({
      rawSymbol,
      base,
      quote,
      active: true,
      status: "trading",
      isStock: isTokenizedStock({ base, rawSymbol }),
      isLeveraged: isLeveragedToken({ base, rawSymbol }),
      displayName: null,
    });
  }
  if (skippedQuote > 0) console.log(`[biconomy] lewati ${skippedQuote} pair bukan USDT`);
  if (skippedStatus > 0) console.log(`[biconomy] lewati ${skippedStatus} pair status != 1`);
  if (skippedNoTicker > 0) console.log(`[biconomy] lewati ${skippedNoTicker} pair tanpa ticker`);

  const fetchedAt = new Date().toISOString();
  const tickers: DerivedTicker[] = markets.map((market) =>
    withDerivedFields(toNormalizedTicker(market, tickerMap.get(market.rawSymbol), fetchedAt)),
  );
  return { tickers, markets, rawResponses };
}

async function fetchOrderBook(rawSymbol: string, count = 5): Promise<OrderBookFetchResult> {
  const symbol = rawSymbol.trim().toUpperCase();
  const limit = Math.min(Math.max(1, count), DEPTH_MAX);
  const result = await bicoGet<BicoDepth>("/api/v3/depth", { symbol, limit });
  const book = result.data ?? {};
  return {
    endpoint: result.url,
    rawJson: result.rawText,
    orderbook: {
      exchange: EXCHANGE_ID,
      rawSymbol: symbol,
      bids: toLevels(book.bids, limit, "bid"),
      asks: toLevels(book.asks, limit, "ask"),
      fetchedAt: new Date().toISOString(),
    },
  };
}

export function biconomySpotUrl(base: string, quote: string): string | null {
  if (!base || !quote) return null;
  return `https://www.biconomy.com/exchange/${base.toUpperCase()}_${quote.toUpperCase()}`;
}

export const biconomyAdapter: ExchangeAdapter = {
  id: EXCHANGE_ID,
  name: "Biconomy",
  fetchTickers,
  fetchOrderBook,
  spotUrl: biconomySpotUrl,
};
