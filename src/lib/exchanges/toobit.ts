/**
 * Adapter Toobit — REST spot resmi (tanpa API key).
 * Dokumentasi: https://api-docs.toobit.com/api/spot-market-data.html
 *   (dokumen lama: https://toobit-docs.github.io/apidocs/spot/v1/en/)
 * Host: https://api.toobit.com
 * Simbol + status depo/WD: GET /api/v1/exchangeInfo
 *   - symbols[]: status TRADING / API_TRADE_FORBIDDEN (masih bisa trading di web, hanya API order diblok)
 *   - coins[]: allowDeposit/allowWithdraw per koin + chainTypes[] per jaringan (publik, tanpa key).
 *     Toobit tidak memberikan alamat kontrak di API publik maupun wallet API.
 * Ticker massal: GET /quote/v1/ticker/24hr (c, o, v=base, qv=quote, pcp=rasio)
 * Bid/ask massal: GET /quote/v1/ticker/bookTicker (b, bq, a, aq)
 * Depth: GET /quote/v1/depth?symbol=&limit=
 * Token saham (xStock / Ondo Tokenized) dideteksi dari coinFullName oleh filter bersama.
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

const EXCHANGE_ID = "toobit";
const BASE_URL = "https://api.toobit.com";
const ALLOWED_QUOTES = new Set(["USDT", "USD"]);
/** Status yang pasarnya tetap jalan di web (API_TRADE_FORBIDDEN = hanya order via API yang diblok). */
const LIVE_STATUSES = new Set(["TRADING", "API_TRADE_FORBIDDEN"]);
const schedule = createRateLimiter(250);

type ToobitSymbol = {
  symbol?: string;
  status?: string;
  baseAsset?: string;
  baseAssetName?: string;
  quoteAsset?: string;
};

type ToobitChain = {
  chainType?: string;
  allowDeposit?: boolean;
  allowWithdraw?: boolean;
};

type ToobitCoin = {
  coinId?: string;
  coinName?: string;
  coinFullName?: string;
  allowDeposit?: boolean;
  allowWithdraw?: boolean;
  chainTypes?: ToobitChain[];
  isVirtual?: boolean;
};

type ToobitExchangeInfo = {
  symbols?: ToobitSymbol[];
  coins?: ToobitCoin[];
  code?: number | string;
  msg?: string;
};

type ToobitTicker = {
  t?: number | string;
  s?: string;
  c?: string;
  o?: string;
  v?: string;
  qv?: string;
  pcp?: string;
};

type ToobitBook = {
  s?: string;
  b?: string;
  bq?: string;
  a?: string;
  aq?: string;
  t?: number | string;
};

type ToobitDepth = {
  t?: number;
  b?: Array<[string, string] | string[]>;
  a?: Array<[string, string] | string[]>;
  code?: number | string;
  msg?: string;
};

type ApiResponse<T> = { data: T; rawText: string; url: string };

type CoinFunding = {
  depositEnabled: number;
  withdrawEnabled: number;
  chainstatusRaw: string;
  displayName: string | null;
};

function toNum(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

function assertOk(data: unknown, rawText: string, path: string) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  const body = data as { code?: number | string; msg?: string };
  if (body.code == null) return;
  const code = String(body.code);
  if (code !== "0" && code !== "200") {
    throw new ExchangeApiError(`Toobit ${path}: ${body.msg ?? "gagal"} (code ${code})`, 200, rawText.slice(0, 2000));
  }
}

async function toobitGet<T>(path: string, query?: Record<string, string | number>): Promise<ApiResponse<T>> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
  const href = url.toString();
  const result = await schedule(() => fetchJson<T>(href, { retries: 1 }));
  assertOk(result.data, result.rawText, path);
  return { data: result.data, rawText: result.rawText, url: href };
}

function summarizeCoin(coin: ToobitCoin): CoinFunding {
  const chains = coin.chainTypes ?? [];
  const coinDeposit = coin.allowDeposit !== false;
  const coinWithdraw = coin.allowWithdraw !== false;
  let depositEnabled = 0;
  let withdrawEnabled = 0;
  const parts: string[] = [];
  for (const chain of chains) {
    const name = (chain.chainType ?? "").trim() || "?";
    const deposit = coinDeposit && chain.allowDeposit === true;
    const withdraw = coinWithdraw && chain.allowWithdraw === true;
    if (deposit) depositEnabled = 1;
    if (withdraw) withdrawEnabled = 1;
    parts.push(`${name}: D${deposit ? "✓" : "✗"} W${withdraw ? "✓" : "✗"}`);
  }
  if (chains.length === 0) {
    // Koin tanpa daftar jaringan: pakai flag level koin.
    depositEnabled = coinDeposit && coin.allowDeposit === true ? 1 : 0;
    withdrawEnabled = coinWithdraw && coin.allowWithdraw === true ? 1 : 0;
  }
  const displayName = (coin.coinFullName ?? "").trim() || null;
  return { depositEnabled, withdrawEnabled, chainstatusRaw: parts.join(", "), displayName };
}

function changePct(ticker: ToobitTicker | undefined): number | null {
  if (!ticker) return null;
  const open = toNum(ticker.o);
  const close = toNum(ticker.c);
  if (open != null && open !== 0 && close != null) return ((close - open) / open) * 100;
  const ratio = toNum(ticker.pcp);
  // pcp dari API berupa rasio (contoh -0.0458 = -4.58%).
  return ratio != null ? ratio * 100 : null;
}

function toNormalizedTicker(
  market: MarketInfo,
  ticker: ToobitTicker | undefined,
  book: ToobitBook | undefined,
  fetchedAt: string,
): NormalizedTicker {
  const ts = toNum(book?.t) ?? toNum(ticker?.t);
  return {
    exchange: EXCHANGE_ID,
    rawSymbol: market.rawSymbol,
    base: market.base,
    quote: market.quote,
    last: toNum(ticker?.c),
    bid: toNum(book?.b),
    ask: toNum(book?.a),
    bidSize: toNum(book?.bq),
    askSize: toNum(book?.aq),
    baseVolume24h: toNum(ticker?.v),
    quoteVolume24h: toNum(ticker?.qv),
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
  const [infoRes, tickerRes, bookRes] = await Promise.all([
    toobitGet<ToobitExchangeInfo>("/api/v1/exchangeInfo"),
    toobitGet<ToobitTicker[]>("/quote/v1/ticker/24hr"),
    toobitGet<ToobitBook[]>("/quote/v1/ticker/bookTicker"),
  ]);
  rawResponses.push({ endpoint: infoRes.url, rawJson: infoRes.rawText });
  rawResponses.push({ endpoint: tickerRes.url, rawJson: tickerRes.rawText });
  rawResponses.push({ endpoint: bookRes.url, rawJson: bookRes.rawText });

  const tickerMap = new Map<string, ToobitTicker>();
  for (const row of Array.isArray(tickerRes.data) ? tickerRes.data : []) {
    const key = String(row.s ?? "").trim().toUpperCase();
    if (key) tickerMap.set(key, row);
  }
  const bookMap = new Map<string, ToobitBook>();
  for (const row of Array.isArray(bookRes.data) ? bookRes.data : []) {
    const key = String(row.s ?? "").trim().toUpperCase();
    if (key) bookMap.set(key, row);
  }
  const fundingByCoin = new Map<string, CoinFunding>();
  for (const coin of infoRes.data.coins ?? []) {
    const key = String(coin.coinId ?? coin.coinName ?? "").trim().toUpperCase();
    if (key) fundingByCoin.set(key, summarizeCoin(coin));
  }

  const markets: MarketInfo[] = [];
  let skippedQuote = 0;
  let skippedStatus = 0;
  for (const row of infoRes.data.symbols ?? []) {
    const rawSymbol = String(row.symbol ?? "").trim().toUpperCase();
    const base = String(row.baseAsset ?? "").trim().toUpperCase();
    const quote = String(row.quoteAsset ?? "").trim().toUpperCase();
    if (!rawSymbol || !base || !quote) continue;
    if (!ALLOWED_QUOTES.has(quote)) {
      skippedQuote += 1;
      continue;
    }
    const status = String(row.status ?? "").trim().toUpperCase();
    if (!LIVE_STATUSES.has(status)) {
      skippedStatus += 1;
      continue;
    }
    const funding = fundingByCoin.get(base);
    const displayName = funding?.displayName ?? null;
    const names = displayName ? [displayName] : undefined;
    const market: MarketInfo = {
      rawSymbol,
      base,
      quote,
      active: true,
      status,
      isStock: isTokenizedStock({ base, rawSymbol, names }),
      isLeveraged: isLeveragedToken({ base, rawSymbol, names }),
      displayName,
    };
    if (funding) {
      market.depositEnabled = funding.depositEnabled;
      market.withdrawEnabled = funding.withdrawEnabled;
      if (funding.chainstatusRaw) market.chainstatusRaw = funding.chainstatusRaw;
    }
    markets.push(market);
  }
  if (skippedQuote > 0) console.log(`[toobit] lewati ${skippedQuote} pair bukan USDT/USD`);
  if (skippedStatus > 0) console.log(`[toobit] lewati ${skippedStatus} pair status bukan TRADING`);

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
  const limit = Math.min(Math.max(1, count), 100);
  const result = await toobitGet<ToobitDepth>("/quote/v1/depth", { symbol, limit });
  const ts = toNum(result.data.t);
  return {
    endpoint: result.url,
    rawJson: result.rawText,
    orderbook: {
      exchange: EXCHANGE_ID,
      rawSymbol: symbol,
      bids: toLevels(result.data.b, limit, ts),
      asks: toLevels(result.data.a, limit, ts),
      fetchedAt: new Date().toISOString(),
    },
  };
}

export function toobitSpotUrl(base: string, quote: string): string | null {
  if (!base || !quote) return null;
  return `https://www.toobit.com/en-US/spot/${base.toUpperCase()}_${quote.toUpperCase()}`;
}

export const toobitAdapter: ExchangeAdapter = {
  id: EXCHANGE_ID,
  name: "Toobit",
  fetchTickers,
  fetchOrderBook,
  spotUrl: toobitSpotUrl,
};
