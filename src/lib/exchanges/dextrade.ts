/**
 * Adapter Dex-Trade — REST spot resmi (publik, tanpa API key).
 * Dokumentasi: https://docs.dex-trade.com/ (Public API)
 * Host: https://api.dex-trade.com
 * Simbol: GET /v1/public/symbols (pair, base, quote). Nama pair case-sensitive (mis. RtimeUSDT),
 *   jadi rawSymbol disimpan apa adanya; base dinormalkan ke huruf besar untuk pencocokan.
 * Ticker: GET /v1/public/ticker?pair= — TIDAK ada ticker massal, jadi dipanggil per pair.
 *   last, high, low, volume_24H, percent_change (nama field di API memakai huruf Kirilik "с":
 *   "percent_сhange"; keduanya dibaca). open/close selalu 0 di API, tidak dipakai.
 *   volume_24H = volume BASE 24 jam (dicek: KIAUSDT 31,9 jt @ 0,00012 ≈ $3,8 rb; FRTCUSDT 3,4e11 @ 1,5e-7
 *   ≈ $50 rb — kalau dianggap quote angkanya mustahil). Vol USD = volume_24H × last (perkiraan).
 * Bid/ask: GET /v1/public/book?pair= (buy/sell, rate + volume) — per pair juga.
 * Depo/WD + alamat kontrak: TIDAK ADA endpoint status koin/jaringan di API resmi (hanya balance,
 *   get-address, withdraw untuk akun sendiri), jadi kolom Depo/WD kosong.
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

const EXCHANGE_ID = "dextrade";
const BASE_URL = "https://api.dex-trade.com";
const ALLOWED_QUOTES = new Set(["USDT", "USD"]);
const schedule = createRateLimiter(150);

type Envelope<T> = { status?: boolean; error?: string; data?: T };

type DexSymbol = { id?: number; pair?: string; base?: string; quote?: string };

type DexTicker = {
  pair?: string;
  last?: string | number;
  high?: string | number;
  low?: string | number;
  volume_24H?: string | number;
  percent_change?: string | number;
  [key: string]: unknown;
};

type DexLevel = { volume?: number | string; rate?: number | string; count?: number };
type DexBook = { buy?: DexLevel[]; sell?: DexLevel[]; sequenceId?: number };

type ApiResponse<T> = { data: Envelope<T>; rawText: string; url: string };

function toNum(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

async function dexGet<T>(path: string, query?: Record<string, string | number>): Promise<ApiResponse<T>> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
  const href = url.toString();
  const result = await schedule(() => fetchJson<Envelope<T>>(href, { retries: 1 }));
  if (result.data?.status === false) {
    throw new ExchangeApiError(`Dex-Trade ${path}: ${result.data.error ?? "gagal"}`, 200, result.rawText.slice(0, 2000));
  }
  return { data: result.data, rawText: result.rawText, url: href };
}

function percentChange(ticker: DexTicker | undefined): number | null {
  if (!ticker) return null;
  const direct = toNum(ticker.percent_change);
  if (direct != null) return direct;
  for (const [key, value] of Object.entries(ticker)) {
    if (/^percent_.hange$/i.test(key)) return toNum(value);
  }
  return null;
}

function levels(rows: DexLevel[] | undefined, side: "bid" | "ask"): OrderBookLevel[] {
  const out: OrderBookLevel[] = [];
  for (const row of rows ?? []) {
    const price = toNum(row.rate);
    const volume = toNum(row.volume);
    if (price == null || volume == null || price <= 0) continue;
    out.push({ price, volume, timestamp: null });
  }
  out.sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price));
  return out;
}

function toNormalizedTicker(
  market: MarketInfo,
  ticker: DexTicker | undefined,
  book: DexBook | undefined,
  fetchedAt: string,
): NormalizedTicker {
  const last = toNum(ticker?.last);
  const baseVolume = toNum(ticker?.volume_24H);
  const bids = levels(book?.buy, "bid");
  const asks = levels(book?.sell, "ask");
  return {
    exchange: EXCHANGE_ID,
    rawSymbol: market.rawSymbol,
    base: market.base,
    quote: market.quote,
    last,
    bid: bids[0]?.price ?? null,
    ask: asks[0]?.price ?? null,
    bidSize: bids[0]?.volume ?? null,
    askSize: asks[0]?.volume ?? null,
    baseVolume24h: baseVolume,
    quoteVolume24h: baseVolume != null && last != null ? baseVolume * last : null,
    change24hPct: percentChange(ticker),
    exchangeTimestamp: null,
    fetchedAt,
  };
}

async function fetchTickers(): Promise<TickerFetchResult> {
  const rawResponses: RawResponse[] = [];
  const symbolRes = await dexGet<DexSymbol[]>("/v1/public/symbols");
  rawResponses.push({ endpoint: symbolRes.url, rawJson: symbolRes.rawText });

  const markets: MarketInfo[] = [];
  let skippedQuote = 0;
  for (const row of symbolRes.data.data ?? []) {
    const rawSymbol = String(row.pair ?? "").trim();
    const base = String(row.base ?? "").trim().toUpperCase();
    const quote = String(row.quote ?? "").trim().toUpperCase();
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
      status: "trading",
      isStock: isTokenizedStock({ base, rawSymbol }),
      isLeveraged: isLeveragedToken({ base, rawSymbol }),
      displayName: null,
    });
  }
  if (skippedQuote > 0) console.log(`[dextrade] lewati ${skippedQuote} pair bukan USDT/USD`);

  const tickerMap = new Map<string, DexTicker>();
  const bookMap = new Map<string, DexBook>();
  let failed = 0;
  await Promise.all(
    markets.map(async (market) => {
      const [tickerRes, bookRes] = await Promise.allSettled([
        dexGet<DexTicker>("/v1/public/ticker", { pair: market.rawSymbol }),
        dexGet<DexBook>("/v1/public/book", { pair: market.rawSymbol }),
      ]);
      if (tickerRes.status === "fulfilled" && tickerRes.value.data.data) {
        tickerMap.set(market.rawSymbol, tickerRes.value.data.data);
        rawResponses.push({ endpoint: tickerRes.value.url, rawJson: tickerRes.value.rawText });
      } else {
        failed += 1;
      }
      if (bookRes.status === "fulfilled" && bookRes.value.data.data) {
        bookMap.set(market.rawSymbol, bookRes.value.data.data);
      }
    }),
  );
  if (markets.length > 0 && tickerMap.size === 0) {
    throw new Error("Dex-Trade: semua request ticker gagal");
  }
  if (failed > 0) console.warn(`[dextrade] ${failed} ticker gagal diambil`);

  const fetchedAt = new Date().toISOString();
  const kept = markets.filter((market) => tickerMap.has(market.rawSymbol));
  const tickers: DerivedTicker[] = kept.map((market) =>
    withDerivedFields(
      toNormalizedTicker(market, tickerMap.get(market.rawSymbol), bookMap.get(market.rawSymbol), fetchedAt),
    ),
  );
  return { tickers, markets: kept, rawResponses };
}

async function fetchOrderBook(rawSymbol: string, count = 5): Promise<OrderBookFetchResult> {
  const pair = rawSymbol.trim();
  const limit = Math.max(1, count);
  const result = await dexGet<DexBook>("/v1/public/book", { pair });
  const book = result.data.data ?? {};
  return {
    endpoint: result.url,
    rawJson: result.rawText,
    orderbook: {
      exchange: EXCHANGE_ID,
      rawSymbol: pair,
      bids: levels(book.buy, "bid").slice(0, limit),
      asks: levels(book.sell, "ask").slice(0, limit),
      fetchedAt: new Date().toISOString(),
    },
  };
}

export function dextradeSpotUrl(base: string, quote: string, rawSymbol?: string | null): string | null {
  if (!base || !quote) return null;
  const pair = rawSymbol?.trim() || `${base.toUpperCase()}${quote.toUpperCase()}`;
  return `https://dex-trade.com/spot/trading/${encodeURIComponent(pair)}`;
}

export const dextradeAdapter: ExchangeAdapter = {
  id: EXCHANGE_ID,
  name: "Dex-Trade",
  fetchTickers,
  fetchOrderBook,
  spotUrl: dextradeSpotUrl,
};
