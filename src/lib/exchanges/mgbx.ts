/**
 * Adapter MGBX — REST spot resmi (publik, tanpa API key).
 * Dokumentasi: https://apidoc.mgbx.com/en/api/api/rest/
 * Host: https://open.mgbx.com
 * Simbol: GET /spot/v1/p/symbol/configs (tanpa field status; semua pair dianggap tradable).
 * Ticker massal: GET /spot/v1/p/quotation/tickers
 *   (c=last, o=open, a=volume base, v=turnover quote, r=rasio perubahan). Tidak ada bid/ask.
 * Depth: GET /spot/v1/p/quotation/depth?symbol=&level= (1-50)
 *   -> dipakai juga untuk enrich bid/ask + ukuran per pair (antrian di enrich-service).
 * Depo/WD + alamat kontrak: TIDAK ADA endpoint resmi (publik maupun signed) di API MGBX.
 * Saham tokenisasi: MGBX memakai ticker saham polos (AMD, NVDA, TSLA, QQQ, ...) tanpa flag/nama,
 *   jadi dibuang lewat daftar eksplisit MGBX_STOCK_BASES + filter bersama.
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
import { isLeveragedToken, isTokenizedStock } from "./stock-filter";

const EXCHANGE_ID = "mgbx";
const BASE_URL = "https://open.mgbx.com";
const ALLOWED_QUOTES = new Set(["USDT", "USD"]);
/**
 * Pair saham/ETF tokenisasi di MGBX (dicek 13 Nov 2026: harga 5–860 USDT, sama dengan saham AS).
 * Tidak ada flag resmi, jadi daftar ini wajib diperbarui jika MGBX menambah saham baru.
 */
const MGBX_STOCK_BASES = new Set([
  "AAOI", "AMD", "ARM", "AVGO", "BABA", "CBRS", "CRCL", "DRAM", "EWY", "GLW", "GOOGL", "HOOD", "IBM",
  "INTC", "LITE", "META", "MRVL", "MSFT", "MSTR", "MU", "NBIS", "NOK", "NVDA", "PLTR", "QCOM", "QQQ",
  "SKHY", "SNDK", "SOXL", "SPCX", "SPY", "TSLA", "WDC",
]);
const schedule = createRateLimiter(200);

type Envelope<T> = { code?: number | string; msg?: string; data?: T };

type MgbxConfig = {
  symbol?: string;
  baseAsset?: string;
  quoteAsset?: string;
};

type MgbxTicker = {
  t?: number;
  s?: string;
  c?: string;
  o?: string;
  a?: string;
  v?: string;
  r?: string;
};

type MgbxDepth = {
  t?: number;
  s?: string;
  b?: Array<[string, string] | string[]>;
  a?: Array<[string, string] | string[]>;
};

type ApiResponse<T> = { data: Envelope<T>; rawText: string; url: string };

function toNum(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

async function mgbxGet<T>(
  path: string,
  query?: Record<string, string | number>,
  options: { signal?: AbortSignal; throttle?: boolean; retries?: number } = {},
): Promise<ApiResponse<T>> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
  const href = url.toString();
  const run = () => fetchJson<Envelope<T>>(href, { retries: options.retries ?? 1, signal: options.signal });
  const result = options.throttle === false ? await run() : await schedule(run);
  const code = result.data?.code;
  if (code != null && String(code) !== "0") {
    throw new ExchangeApiError(
      `MGBX ${path}: ${result.data.msg ?? "gagal"} (code ${code})`,
      200,
      result.rawText.slice(0, 2000),
    );
  }
  return { data: result.data, rawText: result.rawText, url: href };
}

function changePct(ticker: MgbxTicker | undefined): number | null {
  if (!ticker) return null;
  const open = toNum(ticker.o);
  const close = toNum(ticker.c);
  if (open != null && open !== 0 && close != null) return ((close - open) / open) * 100;
  const ratio = toNum(ticker.r);
  return ratio != null ? ratio * 100 : null;
}

function toNormalizedTicker(market: MarketInfo, ticker: MgbxTicker | undefined, fetchedAt: string): NormalizedTicker {
  const ts = toNum(ticker?.t);
  return {
    exchange: EXCHANGE_ID,
    rawSymbol: market.rawSymbol,
    base: market.base,
    quote: market.quote,
    last: toNum(ticker?.c),
    bid: null,
    ask: null,
    bidSize: null,
    askSize: null,
    baseVolume24h: toNum(ticker?.a),
    quoteVolume24h: toNum(ticker?.v),
    change24hPct: changePct(ticker),
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
  const [configRes, tickerRes] = await Promise.all([
    mgbxGet<MgbxConfig[]>("/spot/v1/p/symbol/configs"),
    mgbxGet<MgbxTicker[]>("/spot/v1/p/quotation/tickers"),
  ]);
  rawResponses.push({ endpoint: configRes.url, rawJson: configRes.rawText });
  rawResponses.push({ endpoint: tickerRes.url, rawJson: tickerRes.rawText });

  const tickerMap = new Map<string, MgbxTicker>();
  for (const row of tickerRes.data.data ?? []) {
    const key = String(row.s ?? "").trim().toUpperCase();
    if (key) tickerMap.set(key, row);
  }

  const markets: MarketInfo[] = [];
  let skippedQuote = 0;
  for (const row of configRes.data.data ?? []) {
    const rawSymbol = String(row.symbol ?? "").trim().toUpperCase();
    const base = String(row.baseAsset ?? "").trim().toUpperCase();
    const quote = String(row.quoteAsset ?? "").trim().toUpperCase();
    if (!rawSymbol || !base || !quote) continue;
    if (!ALLOWED_QUOTES.has(quote)) {
      skippedQuote += 1;
      continue;
    }
    markets.push({
      rawSymbol,
      base,
      quote,
      active: true,
      status: tickerMap.has(rawSymbol) ? "trading" : "no-ticker",
      isStock: MGBX_STOCK_BASES.has(base) || isTokenizedStock({ base, rawSymbol }),
      isLeveraged: isLeveragedToken({ base, rawSymbol }),
      displayName: null,
    });
  }
  if (skippedQuote > 0) console.log(`[mgbx] lewati ${skippedQuote} pair bukan USDT/USD`);

  const fetchedAt = new Date().toISOString();
  const tickers: DerivedTicker[] = markets.map((market) =>
    withDerivedFields(toNormalizedTicker(market, tickerMap.get(market.rawSymbol), fetchedAt)),
  );
  return { tickers, markets, rawResponses };
}

async function fetchOrderBook(rawSymbol: string, count = 5): Promise<OrderBookFetchResult> {
  const symbol = rawSymbol.trim().toUpperCase();
  const level = Math.min(Math.max(1, count), 50);
  const result = await mgbxGet<MgbxDepth>("/spot/v1/p/quotation/depth", { symbol, level });
  const book = result.data.data ?? {};
  const ts = toNum(book.t);
  return {
    endpoint: result.url,
    rawJson: result.rawText,
    orderbook: {
      exchange: EXCHANGE_ID,
      rawSymbol: symbol,
      bids: toLevels(book.b, level, ts),
      asks: toLevels(book.a, level, ts),
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
  const result = await mgbxGet<MgbxDepth>(
    "/spot/v1/p/quotation/depth",
    { symbol, level: 1 },
    { signal, throttle: false, retries: 0 },
  );
  const book = result.data.data ?? {};
  const bid = toLevels(book.b, 1, null)[0];
  const ask = toLevels(book.a, 1, null)[0];
  return {
    rawSymbol: symbol,
    bid: bid?.price ?? null,
    ask: ask?.price ?? null,
    bidSize: bid?.volume ?? null,
    askSize: ask?.volume ?? null,
  };
}

export function mgbxSpotUrl(base: string, quote: string): string | null {
  if (!base || !quote) return null;
  return `https://www.mgbx.com/en/spot/trade/${base.toLowerCase()}_${quote.toLowerCase()}`;
}

export const mgbxAdapter: ExchangeAdapter = {
  id: EXCHANGE_ID,
  name: "MGBX",
  fetchTickers,
  fetchOrderBook,
  spotUrl: mgbxSpotUrl,
  enrichConcurrency: 3,
  buildEnrichPlan,
  enrichBidAsk,
};
