/**
 * Adapter Hotcoin — REST spot resmi.
 * Dokumentasi: https://hotcoinex.github.io/en/spot/market.html
 * Host: https://api.hotcoinfin.com
 * Simbol: GET /v1/common/symbols (state enable/online; flag saham resmi assetCategory=us_stock).
 * Ticker massal: GET /v1/market/ticker (last, bid/ask, volume, ubah 24j; tanpa ukuran bid/ask).
 * Depth: GET /v1/depth?symbol=btc_usdt (ambil 5 level).
 * Mata uang publik: GET /v1/common/currencies (deposit/withdraw per rantai, tanpa alamat kontrak).
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

const EXCHANGE_ID = "hotcoin";
const BASE_URL = "https://api.hotcoinfin.com";
const ALLOWED_QUOTES = new Set(["USDT", "USD"]);
const schedule = createRateLimiter(300);

type SymbolRow = {
  symbol?: string;
  baseCurrency?: string;
  quoteCurrency?: string;
  state?: string;
  assetCategory?: string;
  underlying?: string;
};

type TickerRow = {
  symbol?: string;
  last?: string;
  buy?: string;
  sell?: string;
  vol?: string;
  amount?: string;
  change?: string;
  ts?: number;
};

type NetworkRow = {
  chain?: string | null;
  network?: string | null;
  depositEnable?: boolean;
  withdrawEnable?: boolean;
};

type CurrencyRow = NetworkRow & {
  currency?: string;
  nameEn?: string | null;
  networkList?: NetworkRow[] | null;
};

type SymbolsPayload = { code?: number | string; msg?: string; data?: SymbolRow[] };
type TickerPayload = { status?: string; ticker?: TickerRow[]; timestamp?: number };
type CurrencyPayload = { code?: number | string; msg?: string; data?: CurrencyRow[] };
type DepthPayload = {
  code?: number | string;
  msg?: string;
  time?: number;
  data?: { depth?: { date?: number; bids?: unknown[]; asks?: unknown[] } };
};

type ApiResponse<T> = { data: T; rawText: string; url: string };

function toNum(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isEnabled(state: string | undefined): boolean {
  const value = String(state ?? "").trim().toLowerCase();
  return value === "enable" || value === "online";
}

function officialStock(category: string | undefined): boolean {
  return String(category ?? "").trim().toLowerCase() === "us_stock";
}

async function hotcoinGet<T>(path: string, query?: Record<string, string | number>, options?: { signal?: AbortSignal; throttle?: boolean; retries?: number }): Promise<ApiResponse<T>> {
  const qs = query
    ? `?${new URLSearchParams(
        Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])),
      ).toString()}`
    : "";
  const url = `${BASE_URL}${path}${qs}`;
  const run = () => fetchJson<T>(url, { signal: options?.signal, retries: options?.retries });
  const result = options?.throttle === false ? await run() : await schedule(run);
  return { data: result.data, rawText: result.rawText, url };
}

function assertCodeOk(path: string, payload: { code?: number | string; msg?: string }, rawText: string) {
  if (payload.code !== 200 && payload.code !== "200") {
    throw new ExchangeApiError(
      `Hotcoin ${path}: ${payload.msg ?? "gagal"} (code ${payload.code})`,
      undefined,
      rawText.slice(0, 2000),
    );
  }
}

function parseLevel(row: unknown, timestamp: number | null): OrderBookLevel | null {
  if (!Array.isArray(row) || row.length < 2) return null;
  const price = toNum(row[0]);
  const volume = toNum(row[1]);
  if (price == null || volume == null) return null;
  return { price, volume, timestamp };
}

function chainName(row: NetworkRow): string {
  return (row.network ?? row.chain ?? "").trim() || "?";
}

function summarizeCurrency(row: CurrencyRow): {
  depositEnabled: number;
  withdrawEnabled: number;
  chainstatusRaw: string;
} {
  const networks = (row.networkList ?? []).filter((net) => net && (net.network || net.chain));
  const source = networks.length > 0 ? networks : [row];
  let depositEnabled = 0;
  let withdrawEnabled = 0;
  const parts: string[] = [];
  for (const net of source) {
    const deposit = Boolean(net.depositEnable);
    const withdraw = Boolean(net.withdrawEnable);
    if (deposit) depositEnabled = 1;
    if (withdraw) withdrawEnabled = 1;
    parts.push(`${chainName(net)}: D${deposit ? "✓" : "✗"} W${withdraw ? "✓" : "✗"}`);
  }
  return { depositEnabled, withdrawEnabled, chainstatusRaw: parts.join(", ") };
}

function toNormalizedTicker(market: MarketInfo, ticker: TickerRow | undefined, fetchedAt: string): NormalizedTicker {
  const ts = ticker ? toNum(ticker.ts) : null;
  return {
    exchange: EXCHANGE_ID,
    rawSymbol: market.rawSymbol,
    base: market.base,
    quote: market.quote,
    last: ticker ? toNum(ticker.last) : null,
    bid: ticker ? toNum(ticker.buy) : null,
    ask: ticker ? toNum(ticker.sell) : null,
    bidSize: null,
    askSize: null,
    baseVolume24h: ticker ? toNum(ticker.vol) : null,
    quoteVolume24h: ticker ? toNum(ticker.amount) : null,
    change24hPct: ticker ? toNum(ticker.change) : null,
    exchangeTimestamp: ts != null ? new Date(ts).toISOString() : null,
    fetchedAt,
  };
}

async function fetchTickers(): Promise<TickerFetchResult> {
  const rawResponses: RawResponse[] = [];
  const [symbolRes, tickerRes, currencyRes] = await Promise.all([
    hotcoinGet<SymbolsPayload>("/v1/common/symbols"),
    hotcoinGet<TickerPayload>("/v1/market/ticker"),
    hotcoinGet<CurrencyPayload>("/v1/common/currencies").catch((error) => {
      console.warn(
        "[hotcoin] gagal ambil /v1/common/currencies, depo/wd dilewati:",
        error instanceof Error ? error.message : error,
      );
      return null;
    }),
  ]);

  assertCodeOk("/v1/common/symbols", symbolRes.data, symbolRes.rawText);
  rawResponses.push({ endpoint: symbolRes.url, rawJson: symbolRes.rawText });
  rawResponses.push({ endpoint: tickerRes.url, rawJson: tickerRes.rawText });
  if (currencyRes) {
    if (currencyRes.data.code === 200 || currencyRes.data.code === "200") {
      rawResponses.push({ endpoint: currencyRes.url, rawJson: currencyRes.rawText });
    } else {
      console.warn(`[hotcoin] /v1/common/currencies code ${currencyRes.data.code}, depo/wd dilewati`);
    }
  }

  const tickerMap = new Map<string, TickerRow>();
  for (const row of tickerRes.data.ticker ?? []) {
    const key = String(row.symbol ?? "").trim().toLowerCase();
    if (key) tickerMap.set(key, row);
  }

  const fundingByCoin = new Map<string, ReturnType<typeof summarizeCurrency>>();
  const nameByCoin = new Map<string, string>();
  if (currencyRes && (currencyRes.data.code === 200 || currencyRes.data.code === "200")) {
    for (const row of currencyRes.data.data ?? []) {
      const key = String(row.currency ?? "").trim().toUpperCase();
      if (!key) continue;
      fundingByCoin.set(key, summarizeCurrency(row));
      const name = row.nameEn?.trim();
      if (name) nameByCoin.set(key, name);
    }
  }

  const markets: MarketInfo[] = [];
  let skippedQuote = 0;
  let skippedInactive = 0;
  for (const row of symbolRes.data.data ?? []) {
    const rawSymbol = String(row.symbol ?? "").trim().toLowerCase();
    const base = String(row.baseCurrency ?? "").trim().toUpperCase();
    const quote = String(row.quoteCurrency ?? "").trim().toUpperCase();
    if (!rawSymbol || !base || !quote) continue;
    if (!ALLOWED_QUOTES.has(quote)) {
      skippedQuote += 1;
      continue;
    }
    if (!isEnabled(row.state)) {
      skippedInactive += 1;
      continue;
    }
    const displayName = nameByCoin.get(base) ?? (row.underlying ? String(row.underlying).trim() : null);
    const names = displayName ? [displayName] : undefined;
    const market: MarketInfo = {
      rawSymbol,
      base,
      quote,
      active: true,
      status: row.state ?? "enable",
      isStock: officialStock(row.assetCategory) || isTokenizedStock({ base, names }),
      isLeveraged: isLeveragedToken({ base, names }),
      displayName,
    };
    const funding = fundingByCoin.get(base);
    if (funding) {
      market.depositEnabled = funding.depositEnabled;
      market.withdrawEnabled = funding.withdrawEnabled;
      market.chainstatusRaw = funding.chainstatusRaw;
    }
    markets.push(market);
  }

  if (skippedQuote > 0) console.log(`[hotcoin] lewati ${skippedQuote} pair bukan USDT/USD`);
  if (skippedInactive > 0) console.log(`[hotcoin] lewati ${skippedInactive} pair USDT/USD yang tidak enable/online`);

  const fetchedAt = new Date().toISOString();
  const tickers: DerivedTicker[] = markets.map((market) =>
    withDerivedFields(toNormalizedTicker(market, tickerMap.get(market.rawSymbol.toLowerCase()), fetchedAt)),
  );
  return { tickers, markets, rawResponses };
}

function depthTimestamp(date: unknown, fallbackMs: number | null): number | null {
  const n = toNum(date) ?? fallbackMs;
  if (n == null) return null;
  return n < 1e12 ? n * 1000 : n;
}

async function fetchOrderBook(rawSymbol: string, count = 5): Promise<OrderBookFetchResult> {
  const symbol = rawSymbol.trim().toLowerCase();
  const limit = Math.max(1, count);
  const result = await hotcoinGet<DepthPayload>("/v1/depth", { symbol });
  assertCodeOk("/v1/depth", result.data, result.rawText);
  const book = result.data.data?.depth ?? {};
  const ts = depthTimestamp(book.date, toNum(result.data.time));
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
  const symbol = rawSymbol.trim().toLowerCase();
  const result = await hotcoinGet<DepthPayload>("/v1/depth", { symbol }, { signal, throttle: false, retries: 0 });
  assertCodeOk("/v1/depth", result.data, result.rawText);
  const book = result.data.data?.depth ?? {};
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

export const hotcoinAdapter: ExchangeAdapter = {
  id: EXCHANGE_ID,
  name: "Hotcoin",
  fetchTickers,
  fetchOrderBook,
  spotUrl: (base, quote) => getSpotUrl(EXCHANGE_ID, base, quote),
  enrichConcurrency: 3,
  buildEnrichPlan,
  enrichBidAsk,
};
