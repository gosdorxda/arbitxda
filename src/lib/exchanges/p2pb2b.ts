/**
 * Adapter P2PB2B (P2B) — REST spot resmi (publik, tanpa API key).
 * Dokumentasi: https://github.com/P2pb2b-team/p2pb2b-api-docs/blob/master/api-doc.md
 * Host: https://api.p2pb2b.com
 * Simbol: GET /api/v2/public/markets (name BASE_QUOTE, stock=base, money=quote)
 * Ticker massal: GET /api/v2/public/tickers (cache ~30 dtk; bid, ask, last, change=% 24 jam,
 *   vol = volume 24 jam dalam stock/base, deal = volume 24 jam dalam money/quote → dipakai sebagai Vol USD).
 * Depth: GET /api/v2/public/depth/result?market=&limit=
 * Depo/WD + alamat kontrak: TIDAK ADA endpoint aset/jaringan di API resmi P2B (publik maupun signed),
 *   jadi kolom Depo/WD kosong.
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

const EXCHANGE_ID = "p2pb2b";
const BASE_URL = "https://api.p2pb2b.com";
const ALLOWED_QUOTES = new Set(["USDT", "USD"]);
const schedule = createRateLimiter(200);

type Envelope<T> = { success?: boolean; errorCode?: string | number; message?: unknown; result?: T };

type P2bMarket = { name?: string; stock?: string; money?: string };

type P2bTicker = {
  at?: number;
  ticker?: {
    bid?: string;
    ask?: string;
    low?: string;
    high?: string;
    last?: string;
    vol?: string;
    deal?: string;
    change?: string;
  };
};

type P2bDepth = { asks?: Array<[string, string] | string[]>; bids?: Array<[string, string] | string[]> };

type ApiResponse<T> = { data: Envelope<T>; rawText: string; url: string };

function toNum(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

async function p2bGet<T>(path: string, query?: Record<string, string | number>): Promise<ApiResponse<T>> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
  const href = url.toString();
  const result = await schedule(() => fetchJson<Envelope<T>>(href, { retries: 1 }));
  if (result.data?.success === false) {
    const msg = typeof result.data.message === "string" ? result.data.message : JSON.stringify(result.data.message);
    throw new ExchangeApiError(`P2PB2B ${path}: ${msg || result.data.errorCode || "gagal"}`, 200, result.rawText.slice(0, 2000));
  }
  return { data: result.data, rawText: result.rawText, url: href };
}

function toNormalizedTicker(market: MarketInfo, row: P2bTicker | undefined, fetchedAt: string): NormalizedTicker {
  const t = row?.ticker;
  const at = toNum(row?.at);
  return {
    exchange: EXCHANGE_ID,
    rawSymbol: market.rawSymbol,
    base: market.base,
    quote: market.quote,
    last: toNum(t?.last),
    bid: toNum(t?.bid),
    ask: toNum(t?.ask),
    bidSize: null,
    askSize: null,
    baseVolume24h: toNum(t?.vol),
    quoteVolume24h: toNum(t?.deal),
    change24hPct: toNum(t?.change),
    exchangeTimestamp: at != null && at > 0 ? new Date(at * 1000).toISOString() : null,
    fetchedAt,
  };
}

function toLevels(rows: Array<[string, string] | string[]> | undefined, limit: number, side: "bid" | "ask"): OrderBookLevel[] {
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
  const [marketRes, tickerRes] = await Promise.all([
    p2bGet<P2bMarket[]>("/api/v2/public/markets"),
    p2bGet<Record<string, P2bTicker>>("/api/v2/public/tickers"),
  ]);
  rawResponses.push({ endpoint: marketRes.url, rawJson: marketRes.rawText });
  rawResponses.push({ endpoint: tickerRes.url, rawJson: tickerRes.rawText });

  const tickerMap = new Map<string, P2bTicker>();
  for (const [name, row] of Object.entries(tickerRes.data.result ?? {})) {
    tickerMap.set(name.trim().toUpperCase(), row);
  }

  const markets: MarketInfo[] = [];
  let skippedQuote = 0;
  let skippedNoTicker = 0;
  for (const row of marketRes.data.result ?? []) {
    const rawSymbol = String(row.name ?? "").trim().toUpperCase();
    const base = String(row.stock ?? "").trim().toUpperCase();
    const quote = String(row.money ?? "").trim().toUpperCase();
    if (!rawSymbol || !base || !quote) continue;
    if (!ALLOWED_QUOTES.has(quote)) {
      skippedQuote += 1;
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
  if (skippedQuote > 0) console.log(`[p2pb2b] lewati ${skippedQuote} pair bukan USDT/USD`);
  if (skippedNoTicker > 0) console.log(`[p2pb2b] lewati ${skippedNoTicker} pair tanpa ticker`);

  const fetchedAt = new Date().toISOString();
  const tickers: DerivedTicker[] = markets.map((market) =>
    withDerivedFields(toNormalizedTicker(market, tickerMap.get(market.rawSymbol), fetchedAt)),
  );
  return { tickers, markets, rawResponses };
}

async function fetchOrderBook(rawSymbol: string, count = 5): Promise<OrderBookFetchResult> {
  const market = rawSymbol.trim().toUpperCase();
  const limit = Math.min(Math.max(1, count), 1000);
  const result = await p2bGet<P2bDepth>("/api/v2/public/depth/result", { market, limit });
  const book = result.data.result ?? {};
  return {
    endpoint: result.url,
    rawJson: result.rawText,
    orderbook: {
      exchange: EXCHANGE_ID,
      rawSymbol: market,
      bids: toLevels(book.bids, limit, "bid"),
      asks: toLevels(book.asks, limit, "ask"),
      fetchedAt: new Date().toISOString(),
    },
  };
}

export function p2pb2bSpotUrl(base: string, quote: string): string | null {
  if (!base || !quote) return null;
  return `https://p2pb2b.com/trade/${base.toUpperCase()}_${quote.toUpperCase()}/`;
}

export const p2pb2bAdapter: ExchangeAdapter = {
  id: EXCHANGE_ID,
  name: "P2PB2B",
  fetchTickers,
  fetchOrderBook,
  spotUrl: p2pb2bSpotUrl,
};
