/**
 * Adapter CoinW — REST spot publik resmi.
 * Dokumentasi: https://www.coinw.com/api-doc/en/spot-trading/market/
 * Host: https://api.coinw.com
 * Simbol: GET /api/v1/public?command=returnSymbol (state 1 = aktif; hanya quote USDT).
 * Ticker: GET /api/v1/public?command=returnTicker
 *   (last, highestBid, lowestAsk, percentChange [pecahan, -0.0451 = -4.51%],
 *    baseVolume [CATATAN: menurut dokumentasi resmi = volume 24j dalam QUOTE currency], isFrozen).
 *   Ticker tidak memuat ukuran bid/ask & volume base -> bid/ask size diisi lewat enrichBidAsk
 *   (order book 5 level), volume base diperkirakan quoteVolume / last.
 * Depth: GET /api/v1/public?command=returnOrderBook&symbol=BTC_USDT&size=5|20
 * Depo/WD: GET /api/v1/public?command=returnCurrencies (publik, tanpa key).
 *   Status recharge/withDraw hanya level koin (bukan per chain, sesuai dokumentasi resmi);
 *   daftar chain dipisah '@'. Endpoint publik tidak memberi alamat kontrak.
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
import { isLeveragedToken, isTokenizedStock } from "./stock-filter";

const EXCHANGE_ID = "coinw";
const BASE_URL = "https://api.coinw.com";
const ALLOWED_QUOTES = new Set(["USDT"]);
const schedule = createRateLimiter(100);

type CoinwEnvelope<T> = {
  code?: string | number;
  msg?: string;
  success?: boolean;
  failed?: boolean;
  data?: T;
};

type CoinwSymbol = {
  currencyPair?: string;
  currencyBase?: string;
  currencyQuote?: string;
  state?: number | string;
};

type CoinwTicker = {
  id?: number | string;
  last?: string;
  lowestAsk?: string;
  highestBid?: string;
  percentChange?: string;
  isFrozen?: number | string;
  high24hr?: string;
  low24hr?: string;
  baseVolume?: string;
};

type CoinwCurrency = {
  symbol?: string;
  symbolId?: string;
  withDraw?: string | number;
  recharge?: string | number;
  chain?: string;
};

type CoinwBook = {
  asks?: Array<[string, string] | string[]>;
  bids?: Array<[string, string] | string[]>;
  pair?: string;
};

type ApiResponse<T> = { data: T; rawText: string; url: string };

function toNum(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

function positiveOrNull(value: unknown): number | null {
  const n = toNum(value);
  return n != null && n > 0 ? n : null;
}

function isFlag(value: unknown): boolean {
  return String(value ?? "").trim() === "1";
}

async function coinwGet<T>(
  command: string,
  extra?: Record<string, string | number>,
  options: { signal?: AbortSignal; throttle?: boolean; retries?: number } = {},
): Promise<ApiResponse<T>> {
  const params = new URLSearchParams({ command });
  for (const [key, value] of Object.entries(extra ?? {})) params.set(key, String(value));
  const url = `${BASE_URL}/api/v1/public?${params.toString()}`;
  const run = () => fetchJson<CoinwEnvelope<T>>(url, { signal: options.signal, retries: options.retries });
  const result = options.throttle === false ? await run() : await schedule(run);
  const body = result.data;
  const code = body.code == null ? "" : String(body.code);
  if (body.failed === true || (code && code !== "200" && code !== "0") || body.data == null) {
    throw new ExchangeApiError(
      `CoinW ${command}: ${body.msg || `kode ${code || "gagal"}`}`,
      200,
      result.rawText.slice(0, 2000),
    );
  }
  return { data: body.data, rawText: result.rawText, url };
}

function toLevels(rows: Array<[string, string] | string[]> | undefined, limit: number): OrderBookLevel[] {
  const out: OrderBookLevel[] = [];
  for (const row of rows ?? []) {
    const price = toNum(row?.[0]);
    const volume = toNum(row?.[1]);
    if (price == null || volume == null) continue;
    out.push({ price, volume, timestamp: null });
    if (out.length >= limit) break;
  }
  return out;
}

function splitChains(raw: string | undefined): string[] {
  return [...new Set((raw ?? "").split("@").map((c) => c.trim()).filter(Boolean))];
}

function toNormalizedTicker(market: MarketInfo, ticker: CoinwTicker | undefined, fetchedAt: string): NormalizedTicker {
  const last = toNum(ticker?.last);
  const quoteVolume = toNum(ticker?.baseVolume);
  const pct = toNum(ticker?.percentChange);
  return {
    exchange: EXCHANGE_ID,
    rawSymbol: market.rawSymbol,
    base: market.base,
    quote: market.quote,
    last,
    bid: positiveOrNull(ticker?.highestBid),
    ask: positiveOrNull(ticker?.lowestAsk),
    bidSize: null,
    askSize: null,
    baseVolume24h: quoteVolume != null && last != null && last > 0 ? quoteVolume / last : null,
    quoteVolume24h: quoteVolume,
    change24hPct: pct != null ? pct * 100 : null,
    exchangeTimestamp: null,
    fetchedAt,
  };
}

async function fetchTickers(): Promise<TickerFetchResult> {
  const rawResponses: RawResponse[] = [];
  const [symbolRes, tickerRes, currencyRes] = await Promise.all([
    coinwGet<CoinwSymbol[]>("returnSymbol"),
    coinwGet<Record<string, CoinwTicker>>("returnTicker"),
    coinwGet<Record<string, CoinwCurrency>>("returnCurrencies").catch((error) => {
      console.warn(
        "[coinw] gagal ambil returnCurrencies, status depo/wd dilewati:",
        error instanceof Error ? error.message : error,
      );
      return null;
    }),
  ]);
  rawResponses.push({ endpoint: symbolRes.url, rawJson: symbolRes.rawText });
  rawResponses.push({ endpoint: tickerRes.url, rawJson: tickerRes.rawText });
  if (currencyRes) rawResponses.push({ endpoint: currencyRes.url, rawJson: currencyRes.rawText });

  const currencies = new Map<string, CoinwCurrency>();
  for (const [key, row] of Object.entries((currencyRes?.data ?? {}) as Record<string, CoinwCurrency>)) {
    const name = String(row.symbol ?? key).trim().toUpperCase();
    if (name) currencies.set(name, row);
  }

  const markets: MarketInfo[] = [];
  let skippedQuote = 0;
  for (const row of Array.isArray(symbolRes.data) ? symbolRes.data : []) {
    const rawSymbol = String(row.currencyPair ?? "").trim().toUpperCase();
    const base = String(row.currencyBase ?? "").trim().toUpperCase();
    const quote = String(row.currencyQuote ?? "").trim().toUpperCase();
    if (!rawSymbol || !base || !quote) continue;
    if (!ALLOWED_QUOTES.has(quote)) {
      skippedQuote += 1;
      continue;
    }
    const ticker = tickerRes.data[rawSymbol];
    if (!ticker) continue;
    const frozen = isFlag(ticker.isFrozen);
    const active = String(row.state ?? "") === "1" && !frozen;
    const market: MarketInfo = {
      rawSymbol,
      base,
      quote,
      active,
      status: frozen ? "frozen" : active ? "trading" : `state ${row.state ?? "?"}`,
      isStock: isTokenizedStock({ base, rawSymbol }),
      isLeveraged: isLeveragedToken({ base, rawSymbol }),
      displayName: null,
    };
    const currency = currencies.get(base);
    if (currency) {
      const deposit = isFlag(currency.recharge);
      const withdraw = isFlag(currency.withDraw);
      market.depositEnabled = deposit ? 1 : 0;
      market.withdrawEnabled = withdraw ? 1 : 0;
      const chains = splitChains(currency.chain);
      market.chainstatusRaw = (chains.length > 0 ? chains : ["?"])
        .map((chain) => `${chain}: D${deposit ? "✓" : "✗"} W${withdraw ? "✓" : "✗"}`)
        .join(", ");
    } else if (currencyRes) {
      market.depositEnabled = 0;
      market.withdrawEnabled = 0;
    }
    markets.push(market);
  }
  if (skippedQuote > 0) console.log(`[coinw] lewati ${skippedQuote} pair bukan USDT`);

  const fetchedAt = new Date().toISOString();
  const tickers: DerivedTicker[] = markets.map((market) =>
    withDerivedFields(toNormalizedTicker(market, tickerRes.data[market.rawSymbol], fetchedAt)),
  );
  return { tickers, markets, rawResponses };
}

async function fetchOrderBook(rawSymbol: string, count = 5): Promise<OrderBookFetchResult> {
  const symbol = rawSymbol.trim().toUpperCase();
  const size = count <= 5 ? 5 : 20;
  const result = await coinwGet<CoinwBook>("returnOrderBook", { symbol, size });
  const limit = Math.max(1, count);
  return {
    endpoint: result.url,
    rawJson: result.rawText,
    orderbook: {
      exchange: EXCHANGE_ID,
      rawSymbol: symbol,
      bids: toLevels(result.data.bids, limit),
      asks: toLevels(result.data.asks, limit),
      fetchedAt: new Date().toISOString(),
    },
  };
}

function buildEnrichPlan(input: { tickers: DerivedTicker[]; markets: MarketInfo[] }): EnrichPlan {
  return {
    bidAsk: input.tickers.map((ticker) => ({ rawSymbol: ticker.rawSymbol, quoteVolume24h: ticker.quoteVolume24h })),
    deposits: [],
  };
}

async function enrichBidAsk(rawSymbol: string, signal: AbortSignal): Promise<EnrichBidAskResult> {
  const result = await coinwGet<CoinwBook>(
    "returnOrderBook",
    { symbol: rawSymbol, size: 5 },
    { signal, throttle: false, retries: 0 },
  );
  const bid = toLevels(result.data.bids, 1)[0];
  const ask = toLevels(result.data.asks, 1)[0];
  return {
    rawSymbol,
    bid: bid?.price ?? null,
    ask: ask?.price ?? null,
    bidSize: bid?.volume ?? null,
    askSize: ask?.volume ?? null,
  };
}

export const coinwAdapter: ExchangeAdapter = {
  id: EXCHANGE_ID,
  name: "CoinW",
  fetchTickers,
  fetchOrderBook,
  spotUrl: (base, quote) =>
    base && quote ? `https://www.coinw.com/spot/${base.toLowerCase()}${quote.toLowerCase()}` : null,
  enrichConcurrency: 4,
  buildEnrichPlan,
  enrichBidAsk,
};
