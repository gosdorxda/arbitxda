/**
 * Adapter Binance Alpha — REST publik resmi (tanpa API key).
 * Dokumentasi: https://developers.binance.com/docs/alpha/market-data
 * Base: https://www.binance.com
 * Fetch utama: GET /bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list
 *   + GET /bapi/defi/v1/public/alpha-trade/get-exchange-info
 * Hanya simbol USDT berstatus TRADING. USDC dan quote "U" diabaikan.
 * last + volume 24 jam (USD) dari token list; bid/ask dikosongkan (tidak ada endpoint massal).
 * Skip: stockState, offline, fullyDelisted, plus filter saham/leverage yang sudah ada.
 * Volume 0 tetap disimpan. Depo/WD tidak ada di API publik resmi, jadi kosong.
 * rawSymbol: ALPHA_<id>USDT. base/tampilan: symbol token (bisa bentrok ticker CEX).
 * Order book: GET /bapi/defi/v1/public/alpha-trade/fullDepth?symbol=&limit=
 * Trade URL: https://www.binance.com/en/alpha/{chainName}/{contractAddress}
 * Websocket di dokumentasi sengaja tidak dipakai.
 */

import { withDerivedFields } from "../calc";
import { normalizeContracts } from "../contracts";
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

const EXCHANGE_ID = "binance-alpha";
const BASE_URL = "https://www.binance.com";
const TOKEN_LIST_PATH = "/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list";
const EXCHANGE_INFO_PATH = "/bapi/defi/v1/public/alpha-trade/get-exchange-info";
const DEPTH_PATH = "/bapi/defi/v1/public/alpha-trade/fullDepth";
const ALLOWED_QUOTES = new Set(["USDT"]);
const DEPTH_LIMITS = [5, 10, 20, 50, 100, 500, 1000] as const;
const schedule = createRateLimiter(200);

type Envelope<T> = {
  code?: string | number;
  message?: string | null;
  messageDetail?: string | null;
  success?: boolean;
  data?: T;
};

type AlphaToken = {
  alphaId?: string;
  symbol?: string;
  name?: string;
  price?: string | number | null;
  volume24h?: string | number | null;
  percentChange24h?: string | number | null;
  chainName?: string;
  chainId?: string;
  contractAddress?: string;
  stockState?: boolean;
  offline?: boolean;
  fullyDelisted?: boolean;
};

type AlphaSymbol = {
  symbol?: string;
  status?: string;
  baseAsset?: string;
  quoteAsset?: string;
};

type AlphaExchangeInfo = {
  timezone?: string;
  assets?: Array<{ asset?: string }>;
  symbols?: AlphaSymbol[];
};

type AlphaDepth = {
  lastUpdateId?: number;
  symbol?: string;
  bids?: Array<[string, string] | string[]>;
  asks?: Array<[string, string] | string[]>;
  E?: number;
  T?: number;
};

type ApiResponse<T> = { data: T; rawText: string; url: string };

function toNum(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim().replace(/%/g, "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function isTruthyFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function snapDepthLimit(count: number): number {
  const want = Math.min(Math.max(1, count), 1000);
  return DEPTH_LIMITS.find((limit) => limit >= want) ?? 1000;
}

function unwrap<T>(url: string, payload: Envelope<T>, rawText: string): T {
  const code = payload.code == null ? "" : String(payload.code);
  if (payload.success === false || (code && code !== "000000")) {
    const detail = payload.message || payload.messageDetail || "gagal";
    throw new ExchangeApiError(`Binance Alpha ${code || "error"}: ${detail}`, undefined, rawText.slice(0, 2000));
  }
  if (payload.data == null) {
    throw new ExchangeApiError(`Binance Alpha: respons tanpa data dari ${url}`, undefined, rawText.slice(0, 2000));
  }
  return payload.data;
}

async function alphaGet<T>(path: string, query?: Record<string, string | number>): Promise<ApiResponse<T>> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
  const href = url.toString();
  const result = await schedule(() => fetchJson<Envelope<T>>(href, { retries: 1 }));
  return { data: unwrap(href, result.data, result.rawText), rawText: result.rawText, url: href };
}

function toLevels(
  rows: Array<[string, string] | string[]> | undefined,
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

function toNormalizedTicker(
  market: MarketInfo,
  token: AlphaToken | undefined,
  fetchedAt: string,
): NormalizedTicker {
  const last = toNum(token?.price);
  const quoteVolume24h = toNum(token?.volume24h);
  const baseVolume24h =
    last != null && last > 0 && quoteVolume24h != null ? quoteVolume24h / last : null;
  return {
    exchange: EXCHANGE_ID,
    rawSymbol: market.rawSymbol,
    base: market.base,
    quote: market.quote,
    last,
    bid: null,
    ask: null,
    bidSize: null,
    askSize: null,
    baseVolume24h,
    quoteVolume24h,
    change24hPct: toNum(token?.percentChange24h),
    exchangeTimestamp: null,
    fetchedAt,
  };
}

async function fetchTickers(): Promise<TickerFetchResult> {
  const rawResponses: RawResponse[] = [];
  const [tokenRes, infoRes] = await Promise.all([
    alphaGet<AlphaToken[]>(TOKEN_LIST_PATH),
    alphaGet<AlphaExchangeInfo>(EXCHANGE_INFO_PATH),
  ]);
  rawResponses.push({ endpoint: tokenRes.url, rawJson: tokenRes.rawText });
  rawResponses.push({ endpoint: infoRes.url, rawJson: infoRes.rawText });

  const tokens = new Map<string, AlphaToken>();
  for (const row of Array.isArray(tokenRes.data) ? tokenRes.data : []) {
    const id = String(row.alphaId ?? "").trim();
    if (id) tokens.set(id, row);
  }

  const markets: MarketInfo[] = [];
  const tokenBySymbol = new Map<string, AlphaToken>();
  let skippedQuote = 0;
  let skippedStatus = 0;
  let skippedStockState = 0;
  let skippedOffline = 0;
  let skippedDelisted = 0;
  let skippedNoToken = 0;

  for (const row of infoRes.data.symbols ?? []) {
    const rawSymbol = String(row.symbol ?? "").trim();
    const baseAsset = String(row.baseAsset ?? "").trim();
    const quote = String(row.quoteAsset ?? "").trim().toUpperCase();
    const status = String(row.status ?? "").trim().toUpperCase();
    if (!rawSymbol || !baseAsset || !quote) continue;
    if (!ALLOWED_QUOTES.has(quote)) {
      skippedQuote += 1;
      continue;
    }
    if (status !== "TRADING") {
      skippedStatus += 1;
      continue;
    }
    const token = tokens.get(baseAsset);
    if (!token) {
      skippedNoToken += 1;
      continue;
    }
    if (isTruthyFlag(token.stockState)) {
      skippedStockState += 1;
      continue;
    }
    if (isTruthyFlag(token.offline)) {
      skippedOffline += 1;
      continue;
    }
    if (isTruthyFlag(token.fullyDelisted)) {
      skippedDelisted += 1;
      continue;
    }
    const base = String(token.symbol ?? "").trim().toUpperCase();
    if (!base) {
      skippedNoToken += 1;
      continue;
    }
    const displayName = token.name?.trim() || null;
    const names = [displayName, token.symbol].filter((item): item is string => Boolean(item));
    tokenBySymbol.set(rawSymbol, token);
    markets.push({
      rawSymbol,
      base,
      quote,
      active: true,
      status: "TRADING",
      isStock: isTokenizedStock({ base, rawSymbol, names }),
      isLeveraged: isLeveragedToken({ base, rawSymbol, names }),
      displayName,
      contracts: normalizeContracts([
        { chain: token.chainName?.trim() || token.chainId?.trim() || "?", contract: token.contractAddress },
      ]),
    });
  }

  if (skippedQuote > 0) console.log(`[binance-alpha] lewati ${skippedQuote} pair bukan USDT`);
  if (skippedStatus > 0) console.log(`[binance-alpha] lewati ${skippedStatus} pair bukan TRADING`);
  if (skippedStockState > 0) console.log(`[binance-alpha] lewati ${skippedStockState} token stockState`);
  if (skippedOffline > 0) console.log(`[binance-alpha] lewati ${skippedOffline} token offline`);
  if (skippedDelisted > 0) console.log(`[binance-alpha] lewati ${skippedDelisted} token fullyDelisted`);
  if (skippedNoToken > 0) console.log(`[binance-alpha] lewati ${skippedNoToken} pair tanpa data token list`);

  const fetchedAt = new Date().toISOString();
  const tickers: DerivedTicker[] = markets.map((market) =>
    withDerivedFields(toNormalizedTicker(market, tokenBySymbol.get(market.rawSymbol), fetchedAt)),
  );
  return { tickers, markets, rawResponses };
}

async function fetchOrderBook(rawSymbol: string, count = 5): Promise<OrderBookFetchResult> {
  const market = rawSymbol.trim();
  const limit = snapDepthLimit(count);
  const result = await alphaGet<AlphaDepth>(DEPTH_PATH, { symbol: market, limit });
  return {
    endpoint: result.url,
    rawJson: result.rawText,
    orderbook: {
      exchange: EXCHANGE_ID,
      rawSymbol: market,
      bids: toLevels(result.data.bids, count, "bid"),
      asks: toLevels(result.data.asks, count, "ask"),
      fetchedAt: new Date().toISOString(),
    },
  };
}

export function binanceAlphaSpotUrl(
  _base: string,
  _quote: string,
  _rawSymbol?: string | null,
  contracts?: { chain: string; contract: string }[] | null,
): string | null {
  const row = (contracts ?? []).find((item) => item.chain && item.contract);
  if (!row) return null;
  return `https://www.binance.com/en/alpha/${encodeURIComponent(row.chain)}/${encodeURIComponent(row.contract)}`;
}

export const binanceAlphaAdapter: ExchangeAdapter = {
  id: EXCHANGE_ID,
  name: "Binance Alpha",
  fetchTickers,
  fetchOrderBook,
  spotUrl: (base, quote) => binanceAlphaSpotUrl(base, quote),
};
