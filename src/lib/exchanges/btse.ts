/**
 * Adapter BTSE — REST resmi "Markets v1" (publik) + Wallet v1.
 * Dokumentasi: https://docs.btse.com/ (Markets v1, Wallet v1.0)
 *   Spec: https://docs.btse.com/specs/markets-rest.openapi.yaml
 * Host: https://api.btse.com
 * Simbol: GET /public-api/market/v1/markets?types=["Spot"] (active, baseCurrency, tradeCurrency, displayName)
 * Ticker massal: GET /public-api/market/v1/ticker/24hr?types=["Spot"]
 *   (lastPrice, openPrice, amount=volume base, volume=volume quote, bid/ask + qty).
 * Depth: GET /public-api/market/v1/orderbook?symbol=&depth= (1-50; asks dari API urut turun, disortir ulang)
 * Koin harga kecil memakai prefiks K_/M_/B_ (contoh K_SATS-USDT = harga per 1.000 SATS).
 *   Adapter menormalkan ke base asli (SATS) dengan membagi harga & mengalikan ukuran.
 * Depo/WD: GET /public-api/wallet/v1/crypto/networks?crypto=
 *   Publik: hanya daftar jaringan, depositEnable/withdrawEnable SELALU true (default, menurut docs),
 *   jadi tidak dipakai. Dengan BTSE_API_KEY + BTSE_API_SECRET (izin Read) di .env, status asli per
 *   jaringan diambil via header request-api/request-nonce/request-sign (HMAC-SHA384).
 *   BTSE tidak menyediakan alamat kontrak di API.
 * Saham tokenisasi (mis. QQQON) dibuang oleh filter bersama; tidak ada token leverage.
 */

import { createHmac } from "node:crypto";
import { withDerivedFields } from "../calc";
import { ExchangeApiError, fetchJson } from "../http";
import { createRateLimiter } from "../rate-limit";
import type {
  DerivedTicker,
  EnrichDepositResult,
  EnrichNetworkStatus,
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

const EXCHANGE_ID = "btse";
const BASE_URL = "https://api.btse.com";
const MARKET_PATH = "/public-api/market/v1";
const NETWORKS_PATH = "/public-api/wallet/v1/crypto/networks";
const ALLOWED_QUOTES = new Set(["USDT", "USD"]);
const PREFIX_MULTIPLIER: Record<string, number> = { K: 1_000, M: 1_000_000, B: 1_000_000_000 };
const schedule = createRateLimiter(200);

/** rawSymbol -> pengali unit (K_=1000, dst.), diisi saat fetchTickers. */
const multiplierBySymbol = new Map<string, number>();
/** base|quote -> rawSymbol asli (untuk URL spot koin berprefiks K_/M_/B_). */
const rawSymbolByPair = new Map<string, string>();

type Envelope<T> = { success?: boolean; code?: number | string; msg?: string; data?: T };

type BtseMarket = {
  symbol?: string;
  type?: string;
  category?: string;
  tradeCurrency?: string;
  baseCurrency?: string;
  quoteCurrency?: string;
  displayName?: string;
  active?: boolean;
};

type BtseTicker = {
  symbol?: string;
  lastPrice?: string;
  openPrice?: string;
  amount?: string;
  volume?: string;
  closeTime?: number;
  priceChangePercent?: string;
  bidPrice?: string;
  bidQty?: string;
  askPrice?: string;
  askQty?: string;
};

type BtseDepth = {
  timestamp?: number;
  bids?: Array<[string, string] | string[]>;
  asks?: Array<[string, string] | string[]>;
};

type BtseNetwork = {
  network?: string;
  name?: string;
  depositEnable?: boolean;
  withdrawEnable?: boolean;
};

type ApiResponse<T> = { data: Envelope<T>; rawText: string; url: string };

function toNum(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

function scale(value: number | null, factor: number, mode: "div" | "mul"): number | null {
  if (value == null || factor === 1) return value;
  return mode === "div" ? value / factor : value * factor;
}

function readCredentials(): { apiKey: string; apiSecret: string } | null {
  const apiKey = process.env.BTSE_API_KEY?.trim() ?? "";
  const apiSecret = process.env.BTSE_API_SECRET?.trim() ?? "";
  if (!apiKey || !apiSecret) return null;
  return { apiKey, apiSecret };
}

async function btseGet<T>(
  path: string,
  query?: Record<string, string | number>,
  options: { signal?: AbortSignal; signed?: boolean; retries?: number } = {},
): Promise<ApiResponse<T>> {
  const qs = query
    ? Object.entries(query)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&")
    : "";
  const href = `${BASE_URL}${path}${qs ? `?${qs}` : ""}`;
  const headers: Record<string, string> = {};
  if (options.signed) {
    const creds = readCredentials();
    if (creds) {
      const nonce = String(Date.now());
      // Signature: HMAC-SHA384(secret, urlpath + nonce + body); query string tidak ikut ditandatangani.
      headers["request-api"] = creds.apiKey;
      headers["request-nonce"] = nonce;
      headers["request-sign"] = createHmac("sha384", creds.apiSecret).update(`${path}${nonce}`).digest("hex");
    }
  }
  const result = await schedule(() =>
    fetchJson<Envelope<T>>(href, { retries: options.retries ?? 1, signal: options.signal, headers }),
  );
  const body = result.data;
  if (body && body.success === false) {
    throw new ExchangeApiError(`BTSE ${path}: ${body.msg ?? "gagal"} (code ${body.code})`, 200, result.rawText.slice(0, 2000));
  }
  return { data: body, rawText: result.rawText, url: href };
}

function prefixMultiplier(tradeCurrency: string, baseCurrency: string): number {
  const matched = tradeCurrency.match(/^([KMB])_(.+)$/);
  if (!matched) return 1;
  if (matched[2] !== baseCurrency) return 1;
  return PREFIX_MULTIPLIER[matched[1]] ?? 1;
}

function toNormalizedTicker(market: MarketInfo, ticker: BtseTicker | undefined, fetchedAt: string): NormalizedTicker {
  const factor = multiplierBySymbol.get(market.rawSymbol) ?? 1;
  const last = scale(toNum(ticker?.lastPrice), factor, "div");
  const open = scale(toNum(ticker?.openPrice), factor, "div");
  const ratio = toNum(ticker?.priceChangePercent);
  const change =
    open != null && open !== 0 && last != null ? ((last - open) / open) * 100 : ratio != null ? ratio * 100 : null;
  const closeTime = toNum(ticker?.closeTime);
  const tsMs = closeTime != null && closeTime > 0 ? (closeTime < 1e12 ? closeTime * 1000 : closeTime) : null;
  return {
    exchange: EXCHANGE_ID,
    rawSymbol: market.rawSymbol,
    base: market.base,
    quote: market.quote,
    last,
    bid: scale(toNum(ticker?.bidPrice), factor, "div"),
    ask: scale(toNum(ticker?.askPrice), factor, "div"),
    bidSize: scale(toNum(ticker?.bidQty), factor, "mul"),
    askSize: scale(toNum(ticker?.askQty), factor, "mul"),
    baseVolume24h: scale(toNum(ticker?.amount), factor, "mul"),
    quoteVolume24h: toNum(ticker?.volume),
    change24hPct: change,
    exchangeTimestamp: tsMs != null ? new Date(tsMs).toISOString() : null,
    fetchedAt,
  };
}

function toLevels(
  rows: Array<[string, string] | string[]> | undefined,
  limit: number,
  ts: number | null,
  factor: number,
  side: "bid" | "ask",
): OrderBookLevel[] {
  const out: OrderBookLevel[] = [];
  for (const row of rows ?? []) {
    const price = scale(toNum(row[0]), factor, "div");
    const volume = scale(toNum(row[1]), factor, "mul");
    if (price == null || volume == null) continue;
    out.push({ price, volume, timestamp: ts });
  }
  out.sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price));
  return out.slice(0, limit);
}

async function fetchTickers(): Promise<TickerFetchResult> {
  const rawResponses: RawResponse[] = [];
  const types = JSON.stringify(["Spot"]);
  const [marketRes, tickerRes] = await Promise.all([
    btseGet<{ symbols?: BtseMarket[] }>(`${MARKET_PATH}/markets`, { types }),
    btseGet<BtseTicker[]>(`${MARKET_PATH}/ticker/24hr`, { types }),
  ]);
  rawResponses.push({ endpoint: marketRes.url, rawJson: marketRes.rawText });
  rawResponses.push({ endpoint: tickerRes.url, rawJson: tickerRes.rawText });

  const tickerMap = new Map<string, BtseTicker>();
  for (const row of tickerRes.data.data ?? []) {
    const key = String(row.symbol ?? "").trim().toUpperCase();
    if (key) tickerMap.set(key, row);
  }

  const markets: MarketInfo[] = [];
  let skippedQuote = 0;
  let skippedInactive = 0;
  for (const row of marketRes.data.data?.symbols ?? []) {
    if (row.type && row.type !== "Spot") continue;
    const rawSymbol = String(row.symbol ?? "").trim().toUpperCase();
    const base = String(row.baseCurrency ?? "").trim().toUpperCase();
    const quote = String(row.quoteCurrency ?? "").trim().toUpperCase();
    const trade = String(row.tradeCurrency ?? base).trim().toUpperCase();
    if (!rawSymbol || !base || !quote) continue;
    if (!ALLOWED_QUOTES.has(quote)) {
      skippedQuote += 1;
      continue;
    }
    if (row.active === false) {
      skippedInactive += 1;
      continue;
    }
    multiplierBySymbol.set(rawSymbol, prefixMultiplier(trade, base));
    rawSymbolByPair.set(`${base}|${quote}`, rawSymbol);
    const displayName = (row.displayName ?? "").trim() || null;
    const names = displayName ? [displayName] : undefined;
    const category = String(row.category ?? "CRYPTO").trim().toUpperCase();
    markets.push({
      rawSymbol,
      base,
      quote,
      active: true,
      status: "active",
      isStock: category !== "CRYPTO" || isTokenizedStock({ base, rawSymbol, names }),
      isLeveraged: isLeveragedToken({ base, rawSymbol, names }),
      displayName,
    });
  }
  if (skippedQuote > 0) console.log(`[btse] lewati ${skippedQuote} pair bukan USDT/USD`);
  if (skippedInactive > 0) console.log(`[btse] lewati ${skippedInactive} pair tidak aktif`);

  const fetchedAt = new Date().toISOString();
  const tickers: DerivedTicker[] = markets.map((market) =>
    withDerivedFields(toNormalizedTicker(market, tickerMap.get(market.rawSymbol), fetchedAt)),
  );
  return { tickers, markets, rawResponses };
}

async function fetchOrderBook(rawSymbol: string, count = 5): Promise<OrderBookFetchResult> {
  const symbol = rawSymbol.trim().toUpperCase();
  const depth = Math.min(Math.max(1, count), 50);
  const result = await btseGet<BtseDepth>(`${MARKET_PATH}/orderbook`, { symbol, depth });
  const book = result.data.data ?? {};
  const ts = toNum(book.timestamp);
  const factor = multiplierBySymbol.get(symbol) ?? (/^[KMB]_/.test(symbol) ? PREFIX_MULTIPLIER[symbol[0]] : 1);
  return {
    endpoint: result.url,
    rawJson: result.rawText,
    orderbook: {
      exchange: EXCHANGE_ID,
      rawSymbol: symbol,
      bids: toLevels(book.bids, depth, ts, factor, "bid"),
      asks: toLevels(book.asks, depth, ts, factor, "ask"),
      fetchedAt: new Date().toISOString(),
    },
  };
}

function buildEnrichPlan(input: { tickers: DerivedTicker[]; markets: MarketInfo[] }): EnrichPlan {
  // Tanpa key, endpoint jaringan publik selalu mengembalikan depositEnable/withdrawEnable=true
  // (default), jadi tidak ada gunanya diantrikan.
  if (!readCredentials()) return { bidAsk: [], deposits: [] };
  const volumeByBase = new Map<string, number>();
  for (const ticker of input.tickers) {
    const prev = volumeByBase.get(ticker.base) ?? 0;
    volumeByBase.set(ticker.base, Math.max(prev, ticker.quoteVolume24h ?? 0));
  }
  return {
    bidAsk: [],
    deposits: [...volumeByBase.entries()].map(([base, quoteVolume24h]) => ({ base, quoteVolume24h })),
  };
}

async function enrichDeposit(base: string, signal: AbortSignal): Promise<EnrichDepositResult> {
  const crypto = base.trim().toUpperCase();
  const result = await btseGet<BtseNetwork[]>(NETWORKS_PATH, { crypto }, { signal, signed: true, retries: 0 });
  const rows = result.data.data ?? [];
  const networks: EnrichNetworkStatus[] = rows.map((row) => ({
    name: (row.network ?? row.name ?? "?").trim() || "?",
    deposit: typeof row.depositEnable === "boolean" ? row.depositEnable : null,
    withdraw: typeof row.withdrawEnable === "boolean" ? row.withdrawEnable : null,
  }));
  const anyDeposit = networks.some((n) => n.deposit === true);
  return {
    base: crypto,
    depositEnabled: networks.length > 0 ? (anyDeposit ? 1 : 0) : null,
    networks,
    contracts: undefined,
  };
}

export function btseSpotUrl(base: string, quote: string): string | null {
  if (!base || !quote) return null;
  const b = base.toUpperCase();
  const q = quote.toUpperCase();
  const raw = rawSymbolByPair.get(`${b}|${q}`) ?? `${b}-${q}`;
  return `https://www.btse.com/en/trading/${raw}`;
}

export const btseAdapter: ExchangeAdapter = {
  id: EXCHANGE_ID,
  name: "BTSE",
  fetchTickers,
  fetchOrderBook,
  spotUrl: btseSpotUrl,
  enrichConcurrency: 4,
  buildEnrichPlan,
  enrichDeposit,
};
