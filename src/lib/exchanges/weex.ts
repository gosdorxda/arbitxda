/**
 * Adapter WEEX — REST spot publik resmi V3.
 * Dokumentasi: https://www.weex.com/api-doc/products/spot/ (llms.txt: /api-doc/llms.txt)
 * Host: https://api-spot.weex.com
 * Simbol: GET /api/v3/exchangeInfo
 *   (status TRADING + enableTrade + enableDisplay; hanya quote USDT).
 * Ticker: GET /api/v3/market/ticker/24hr (last, bid/ask + qty, volume, quoteVolume, %)
 *         GET /api/v3/market/ticker/bookTicker (bid/ask + qty terbaru)
 * Depth:  GET /api/v3/market/depth?symbol=&limit=15|200 (hanya 15 / 200 yang diterima).
 * Depo/WD + kontrak: GET /api/v3/coins (publik, tanpa key; per network:
 *   depositEnable, withdrawEnable, contractAddress).
 * Saham tokenisasi (tidak ada flag resmi di API): ditandai isStock jika
 *   - base berakhiran "STOCK(S)" (RTXSTOCK, CATSTOCK, ...);
 *   - xStock / Ondo terkenal (AAPLX, TSLAON) via filter bersama;
 *   - token saham internal WEEX: koin tanpa jaringan on-chain + ticker ekuitas polos
 *     (AAPL, NFLX, SPY, ...) atau ticker+ON (IONQON, RKLBON, ...) + ambang harga (lihat weexLooksLikeStock).
 * Tidak perlu API key.
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
  TokenContract,
} from "../types";
import { isLeveragedToken, isTokenizedStock } from "./stock-filter";

const EXCHANGE_ID = "weex";
const BASE_URL = "https://api-spot.weex.com";
const ALLOWED_QUOTES = new Set(["USDT"]);
const DEPTH_LIMITS = [15, 200];
const schedule = createRateLimiter(200);

type WeexSymbol = {
  symbol?: string;
  baseAsset?: string;
  quoteAsset?: string;
  status?: string;
  enableTrade?: boolean;
  enableDisplay?: boolean;
};

type WeexExchangeInfo = { symbols?: WeexSymbol[] };

type WeexTicker = {
  symbol?: string;
  lastPrice?: string;
  bidPrice?: string;
  bidQty?: string;
  askPrice?: string;
  askQty?: string;
  volume?: string;
  quoteVolume?: string;
  priceChangePercent?: string;
  closeTime?: number | string;
};

type WeexBookTicker = {
  symbol?: string;
  bidPrice?: string;
  bidQty?: string;
  askPrice?: string;
  askQty?: string;
};

type WeexNetwork = {
  network?: string;
  name?: string;
  depositEnable?: boolean;
  withdrawEnable?: boolean;
  contractAddress?: string | null;
};

type WeexCoin = {
  coin?: string;
  name?: string;
  depositAllEnable?: boolean;
  withdrawAllEnable?: boolean;
  networkList?: WeexNetwork[] | null;
};

type WeexDepth = {
  bids?: Array<[string, string] | string[]>;
  asks?: Array<[string, string] | string[]>;
};

type AssetFunding = {
  hasNetworks: boolean;
  depositEnabled: number;
  withdrawEnabled: number;
  chainstatusRaw: string | null;
  contracts: TokenContract[];
  name: string | null;
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

function assertOk(data: unknown, rawText: string, endpoint: string) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  const body = data as { code?: number | string; msg?: string };
  if (body.code == null) return;
  const code = String(body.code);
  if (code === "0" || code === "200" || code === "00000") return;
  throw new ExchangeApiError(`WEEX ${endpoint}: ${body.msg || `kode ${code}`}`, 200, rawText.slice(0, 2000));
}

async function weexGet<T>(path: string, query?: Record<string, string | number>): Promise<ApiResponse<T>> {
  const qs = query
    ? `?${new URLSearchParams(Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)]))).toString()}`
    : "";
  const url = `${BASE_URL}${path}${qs}`;
  const result = await schedule(() => fetchJson<T>(url));
  assertOk(result.data, result.rawText, path);
  return { data: result.data, rawText: result.rawText, url };
}

function isWeexStockBase(base: string): boolean {
  // RTXSTOCK, CATSTOCK, LGSTOCKS, ... (bukan "STOCK" polos / STOCKER).
  return /^[A-Z0-9]+STOCKS?$/.test(base) && base !== "STOCK" && base !== "STOCKS";
}

const WEEX_CRYPTO_KEEP = new Set([
  "SOON", "ANON", "ALON", "DRAGON", "SOLOMON", "BATON", "MON", "AEON", "AUCTION", "ON",
  "AMP", "SOLV", "CVX", "TKO", "DIA", "CFG", "BEN", "DASH", "BDX", "MET",
]);

/**
 * WEEX menjual token saham internal tanpa jaringan on-chain (networkList kosong di /api/v3/coins)
 * dengan base = ticker saham polos (AAPL, TSLA, NFLX, ...) atau ticker+"ON" (Ondo: IONQON, RKLBON, ...).
 * Heuristik (hanya untuk koin tanpa jaringan & harga >= ambang, agar coin kripto murah
 * seperti DIA/CVX/AMP/SOLV yang namanya bentrok tidak ikut terbuang):
 *  - base dikenali filter bersama sebagai ticker ekuitas (dicek via `${base}ON`), harga >= 5 USDT; atau
 *  - base = 1-5 huruf + "ON", harga >= 1 USDT.
 */
function weexLooksLikeStock(base: string, hasNetworks: boolean, last: number | null): boolean {
  if (hasNetworks || WEEX_CRYPTO_KEEP.has(base)) return false;
  const price = last ?? 0;
  if (price >= 5 && isTokenizedStock({ base: `${base}ON` })) return true;
  if (price >= 5 && base.endsWith("X") && isTokenizedStock({ base: `${base.slice(0, -1)}ON` })) return true;
  if (price >= 1 && /^[A-Z]{1,5}ON$/.test(base)) return true;
  return false;
}

function cleanContract(value: string | null | undefined, network: string): string | null {
  let raw = (value ?? "").trim();
  if (!raw || raw.toLowerCase() === "null") return null;
  // Kadang berisi sisa URL explorer (mis. "0xabc...#transactions" atau ".../token/0xabc").
  raw = raw.split(/[#?]/)[0].trim();
  if (raw.includes("/")) raw = raw.split("/").filter(Boolean).pop() ?? "";
  if (!raw) return null;
  // Native coin kadang diisi nama chain (mis. "btc"), bukan alamat kontrak.
  if (raw.toUpperCase() === network.toUpperCase() || raw.length < 10) return null;
  return raw;
}

function summarizeCoins(coins: WeexCoin[]): Map<string, AssetFunding> {
  const out = new Map<string, AssetFunding>();
  for (const coin of coins) {
    const key = String(coin.coin ?? "").trim().toUpperCase();
    if (!key) continue;
    const networks = coin.networkList ?? [];
    let depositEnabled = coin.depositAllEnable ? 1 : 0;
    let withdrawEnabled = coin.withdrawAllEnable ? 1 : 0;
    const parts: string[] = [];
    const contracts: Array<{ chain: string; contract: string | null }> = [];
    for (const network of networks) {
      const chain = (network.network || "?").trim() || "?";
      const deposit = network.depositEnable === true;
      const withdraw = network.withdrawEnable === true;
      if (deposit) depositEnabled = 1;
      if (withdraw) withdrawEnabled = 1;
      parts.push(`${chain}: D${deposit ? "✓" : "✗"} W${withdraw ? "✓" : "✗"}`);
      contracts.push({ chain, contract: cleanContract(network.contractAddress, chain) });
    }
    if (networks.length > 0) {
      depositEnabled = parts.some((p) => p.includes("D✓")) ? 1 : 0;
      withdrawEnabled = parts.some((p) => p.includes("W✓")) ? 1 : 0;
    }
    out.set(key, {
      hasNetworks: networks.length > 0,
      depositEnabled,
      withdrawEnabled,
      chainstatusRaw: parts.length > 0 ? parts.join(", ") : null,
      contracts: normalizeContracts(contracts),
      name: (coin.name ?? "").trim() || null,
    });
  }
  return out;
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

function toNormalizedTicker(
  market: MarketInfo,
  ticker: WeexTicker | undefined,
  book: WeexBookTicker | undefined,
  fetchedAt: string,
): NormalizedTicker {
  const closeTime = toNum(ticker?.closeTime);
  const pct = toNum(ticker?.priceChangePercent);
  return {
    exchange: EXCHANGE_ID,
    rawSymbol: market.rawSymbol,
    base: market.base,
    quote: market.quote,
    last: toNum(ticker?.lastPrice),
    bid: positiveOrNull(book?.bidPrice) ?? positiveOrNull(ticker?.bidPrice),
    ask: positiveOrNull(book?.askPrice) ?? positiveOrNull(ticker?.askPrice),
    bidSize: positiveOrNull(book?.bidQty) ?? positiveOrNull(ticker?.bidQty),
    askSize: positiveOrNull(book?.askQty) ?? positiveOrNull(ticker?.askQty),
    baseVolume24h: toNum(ticker?.volume),
    quoteVolume24h: toNum(ticker?.quoteVolume),
    // priceChangePercent WEEX berupa pecahan (-0.006030 = -0.603%).
    change24hPct: pct != null ? pct * 100 : null,
    exchangeTimestamp: closeTime != null ? new Date(closeTime).toISOString() : null,
    fetchedAt,
  };
}

async function fetchTickers(): Promise<TickerFetchResult> {
  const rawResponses: RawResponse[] = [];
  const [infoRes, tickerRes, bookRes, coinsRes] = await Promise.all([
    weexGet<WeexExchangeInfo>("/api/v3/exchangeInfo"),
    weexGet<WeexTicker[]>("/api/v3/market/ticker/24hr"),
    weexGet<WeexBookTicker[]>("/api/v3/market/ticker/bookTicker").catch((error) => {
      console.warn("[weex] gagal ambil bookTicker, pakai bid/ask dari 24hr:", error instanceof Error ? error.message : error);
      return null;
    }),
    weexGet<WeexCoin[]>("/api/v3/coins").catch((error) => {
      console.warn("[weex] gagal ambil /api/v3/coins, depo/wd dilewati:", error instanceof Error ? error.message : error);
      return null;
    }),
  ]);
  // exchangeInfo ~1.8 MB: simpan cuplikan saja agar DB tidak bengkak.
  rawResponses.push({ endpoint: infoRes.url, rawJson: infoRes.rawText.slice(0, 200_000) });
  rawResponses.push({ endpoint: tickerRes.url, rawJson: tickerRes.rawText });
  if (bookRes) rawResponses.push({ endpoint: bookRes.url, rawJson: bookRes.rawText });
  if (coinsRes) rawResponses.push({ endpoint: coinsRes.url, rawJson: coinsRes.rawText.slice(0, 200_000) });

  const tickerMap = new Map<string, WeexTicker>();
  for (const row of Array.isArray(tickerRes.data) ? tickerRes.data : []) {
    const key = String(row.symbol ?? "").trim().toUpperCase();
    if (key) tickerMap.set(key, row);
  }
  const bookMap = new Map<string, WeexBookTicker>();
  for (const row of Array.isArray(bookRes?.data) ? bookRes.data : []) {
    const key = String(row.symbol ?? "").trim().toUpperCase();
    if (key) bookMap.set(key, row);
  }
  const funding = summarizeCoins(Array.isArray(coinsRes?.data) ? coinsRes.data : []);

  const markets: MarketInfo[] = [];
  let skippedQuote = 0;
  let skippedHidden = 0;
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
    if (status !== "TRADING" || row.enableTrade === false || row.enableDisplay === false || !tickerMap.has(rawSymbol)) {
      skippedHidden += 1;
      continue;
    }
    if (base.startsWith("TEST")) {
      skippedHidden += 1;
      continue;
    }
    const fund = funding.get(base);
    const displayName = fund?.name && fund.name.toUpperCase() !== base ? fund.name : null;
    const names = displayName ? [displayName] : undefined;
    const market: MarketInfo = {
      rawSymbol,
      base,
      quote,
      active: true,
      status: row.status ?? null,
      isStock:
        isWeexStockBase(base) ||
        isTokenizedStock({ base, rawSymbol, names }) ||
        weexLooksLikeStock(base, Boolean(fund?.hasNetworks), toNum(tickerMap.get(rawSymbol)?.lastPrice)),
      isLeveraged: isLeveragedToken({ base, rawSymbol, names }),
      displayName,
    };
    if (fund && fund.chainstatusRaw) {
      market.depositEnabled = fund.depositEnabled;
      market.withdrawEnabled = fund.withdrawEnabled;
      market.chainstatusRaw = fund.chainstatusRaw;
      market.contracts = fund.contracts;
    } else if (fund) {
      market.depositEnabled = fund.depositEnabled;
      market.withdrawEnabled = fund.withdrawEnabled;
    } else if (coinsRes) {
      market.depositEnabled = 0;
      market.withdrawEnabled = 0;
    }
    markets.push(market);
  }
  if (skippedQuote > 0) console.log(`[weex] lewati ${skippedQuote} pair bukan USDT`);
  if (skippedHidden > 0) console.log(`[weex] lewati ${skippedHidden} pair HALT/tersembunyi/tanpa ticker`);

  const fetchedAt = new Date().toISOString();
  const tickers: DerivedTicker[] = markets.map((market) =>
    withDerivedFields(toNormalizedTicker(market, tickerMap.get(market.rawSymbol), bookMap.get(market.rawSymbol), fetchedAt)),
  );
  return { tickers, markets, rawResponses };
}

async function fetchOrderBook(rawSymbol: string, count = 5): Promise<OrderBookFetchResult> {
  const symbol = rawSymbol.trim().toUpperCase();
  const want = Math.max(1, count);
  const limit = DEPTH_LIMITS.find((n) => n >= want) ?? 200;
  const result = await weexGet<WeexDepth>("/api/v3/market/depth", { symbol, limit });
  return {
    endpoint: result.url,
    rawJson: result.rawText,
    orderbook: {
      exchange: EXCHANGE_ID,
      rawSymbol: symbol,
      bids: toLevels(result.data.bids, want),
      asks: toLevels(result.data.asks, want),
      fetchedAt: new Date().toISOString(),
    },
  };
}

export const weexAdapter: ExchangeAdapter = {
  id: EXCHANGE_ID,
  name: "WEEX",
  fetchTickers,
  fetchOrderBook,
  spotUrl: (base, quote) =>
    base && quote ? `https://www.weex.com/spot/${base.toUpperCase()}-${quote.toUpperCase()}` : null,
};
