/**
 * Adapter Ourbit — REST spot resmi V3 (gaya MEXC).
 * Dokumentasi: https://ourbitdevelop.github.io/apidocs/spot_v3_en/
 *   (endpoint lama /open/api/v2 di halaman docs utama sudah 404).
 * Host: https://api.ourbit.com
 * Simbol: GET /api/v3/exchangeInfo (status ENABLED; quote USDT/USD).
 *   Catatan: isSpotTradingAllowed=false di hampir semua pair hanya berarti order via API
 *   tidak dibuka; pasar tetap jalan di web, jadi tidak dipakai sebagai filter.
 *   Market prediksi (~~12345YESUSDT) tidak ada di exchangeInfo jadi otomatis terlewat.
 * Ticker massal: GET /api/v3/ticker/24hr (last, bid/ask + qty, volume, priceChangePercent=rasio)
 * Depth: GET /api/v3/depth?symbol=&limit=
 * Depo/WD + kontrak: GET /api/v3/capital/config/getall (SIGNED, izin SPOT_WITHDRAW_READ).
 *   Opsional: OURBIT_API_KEY + OURBIT_API_SECRET di .env. Tanpa key, depo/wd dilewati.
 */

import { createHmac } from "node:crypto";
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

const EXCHANGE_ID = "ourbit";
const BASE_URL = "https://api.ourbit.com";
const ALLOWED_QUOTES = new Set(["USDT", "USD"]);
const DEPTH_LIMITS = [5, 10, 20, 50, 100, 500, 1000];
const schedule = createRateLimiter(250);
/** Koin kripto asli yang kebetulan bersufiks B/ON dan presisi harga kecil. */
const CRYPTO_SUFFIX_KEEP = new Set(["BNB", "OKB", "TRB", "BGB", "ARB", "DGB", "SHIB", "FB", "UB", "YB", "LAB", "BSB", "BIRB", "GAIB", "B", "ON", "MON", "RON", "AEON", "BATON", "AUCTION"]);

/**
 * Ourbit tidak memberi nama/flag saham di exchangeInfo publik. Saham tokenisasi Ourbit memakai
 * sufiks B (Backed/xStock style, mis. NVDAB, RKLBB) atau ON (Ondo, mis. MAON, JDON) dan selalu
 * memakai quotePrecision 2–3 (harga ala saham). Koin kripto biasa memakai presisi 4+.
 * Dicek 13 Nov 2026: menangkap semua pair saham yang terlihat, tanpa menangkap BNB/OKB/TRB/ARB.
 */
function looksLikeOurbitStock(base: string, quotePrecision: unknown): boolean {
  if (CRYPTO_SUFFIX_KEEP.has(base)) return false;
  const matched = base.match(/^([A-Z]{2,6})(B|ON)$/);
  if (!matched) return false;
  const qp = toNum(quotePrecision);
  return qp != null && qp <= 3;
}

type OurbitSymbol = {
  symbol?: string;
  status?: string | number;
  baseAsset?: string;
  quoteAsset?: string;
  baseAssetDisplayAlias?: string;
  fullName?: string;
  quotePrecision?: number | string;
};

type OurbitExchangeInfo = { symbols?: OurbitSymbol[]; code?: number | string; msg?: string };

type OurbitTicker = {
  symbol?: string;
  lastPrice?: string | number;
  bidPrice?: string | number;
  bidQty?: string | number;
  askPrice?: string | number;
  askQty?: string | number;
  openPrice?: string | number;
  volume?: string | number;
  quoteVolume?: string | number;
  priceChangePercent?: string | number;
  closeTime?: string | number;
};

type OurbitDepth = {
  bids?: Array<[string, string] | string[]>;
  asks?: Array<[string, string] | string[]>;
  timestamp?: number;
  code?: number | string;
  msg?: string;
};

type OurbitNetwork = {
  network?: string;
  depositEnable?: boolean | number | string;
  withdrawEnable?: boolean | number | string;
  contract?: string | null;
  contractAddress?: string | null;
};

type OurbitCoin = { coin?: string; Name?: string; name?: string; networkList?: OurbitNetwork[] };

type AssetFunding = {
  depositEnabled: number;
  withdrawEnabled: number;
  chainstatusRaw: string;
  contracts: TokenContract[];
  name: string | null;
};

type ApiResponse<T> = { data: T; rawText: string; url: string };

function toNum(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

function isFlagEnabled(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || String(value).trim().toLowerCase() === "true";
}

function isTradingStatus(status: unknown): boolean {
  const s = String(status ?? "").trim().toUpperCase();
  return s === "1" || s === "ENABLED" || s === "TRADING";
}

function depthLimit(count?: number): number {
  const want = Math.max(1, count ?? 5);
  return DEPTH_LIMITS.find((n) => n >= want) ?? 1000;
}

function assertOk(data: unknown, rawText: string, path: string) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  const body = data as { code?: number | string; msg?: string; message?: string };
  if (body.code == null) return;
  const code = String(body.code);
  if (code !== "0" && code !== "200") {
    throw new ExchangeApiError(
      `Ourbit ${path}: ${body.msg || body.message || `kode ${code}`}`,
      200,
      rawText.slice(0, 2000),
    );
  }
}

async function ourbitGet<T>(path: string, query?: Record<string, string | number>): Promise<ApiResponse<T>> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
  const href = url.toString();
  const result = await schedule(() => fetchJson<T>(href, { retries: 1 }));
  assertOk(result.data, result.rawText, path);
  return { data: result.data, rawText: result.rawText, url: href };
}

function readCredentials(): { apiKey: string; apiSecret: string } | null {
  const apiKey = process.env.OURBIT_API_KEY?.trim() ?? "";
  const apiSecret = process.env.OURBIT_API_SECRET?.trim() ?? "";
  if (!apiKey || !apiSecret) return null;
  return { apiKey, apiSecret };
}

async function ourbitSignedGet<T>(path: string, creds: { apiKey: string; apiSecret: string }): Promise<ApiResponse<T>> {
  const query = `recvWindow=5000&timestamp=${Date.now()}`;
  const signature = createHmac("sha256", creds.apiSecret).update(query).digest("hex");
  const href = `${BASE_URL}${path}?${query}&signature=${signature}`;
  const result = await schedule(() =>
    fetchJson<T>(href, { retries: 1, headers: { "X-OURBIT-APIKEY": creds.apiKey } }),
  );
  assertOk(result.data, result.rawText, path);
  // Jangan simpan signature di log/raw endpoint.
  return { data: result.data, rawText: result.rawText, url: `${BASE_URL}${path}` };
}

function summarizeNetworks(coin: OurbitCoin): AssetFunding {
  const networks = coin.networkList ?? [];
  let depositEnabled = 0;
  let withdrawEnabled = 0;
  const parts: string[] = [];
  for (const network of networks) {
    const name = (network.network || "?").trim() || "?";
    const deposit = isFlagEnabled(network.depositEnable);
    const withdraw = isFlagEnabled(network.withdrawEnable);
    if (deposit) depositEnabled = 1;
    if (withdraw) withdrawEnabled = 1;
    parts.push(`${name}: D${deposit ? "✓" : "✗"} W${withdraw ? "✓" : "✗"}`);
  }
  return {
    depositEnabled,
    withdrawEnabled,
    chainstatusRaw: parts.join(", "),
    contracts: normalizeContracts(
      networks.map((network) => ({
        chain: (network.network || "?").trim() || "?",
        contract: network.contract ?? network.contractAddress,
      })),
    ),
    name: (coin.Name ?? coin.name ?? "").trim() || null,
  };
}

let loggedMissingKeys = false;

async function applySignedFunding(markets: MarketInfo[]): Promise<RawResponse | null> {
  const creds = readCredentials();
  if (!creds) {
    if (!loggedMissingKeys) {
      loggedMissingKeys = true;
      console.log("[ourbit] OURBIT_API_KEY/OURBIT_API_SECRET belum diisi, status depo/wd dilewati");
    }
    return null;
  }
  try {
    const result = await ourbitSignedGet<OurbitCoin[] | { data?: OurbitCoin[] }>(
      "/api/v3/capital/config/getall",
      creds,
    );
    const coins = Array.isArray(result.data)
      ? result.data
      : Array.isArray((result.data as { data?: OurbitCoin[] }).data)
        ? ((result.data as { data?: OurbitCoin[] }).data ?? [])
        : [];
    const fundingByAsset = new Map<string, AssetFunding>();
    for (const coin of coins) {
      const key = (coin.coin ?? "").trim().toUpperCase();
      if (key) fundingByAsset.set(key, summarizeNetworks(coin));
    }
    let matched = 0;
    for (const market of markets) {
      const funding = fundingByAsset.get(market.base);
      if (!funding) continue;
      market.depositEnabled = funding.depositEnabled;
      market.withdrawEnabled = funding.withdrawEnabled;
      market.chainstatusRaw = funding.chainstatusRaw;
      market.contracts = funding.contracts;
      if (funding.name && !market.displayName) market.displayName = funding.name;
      if (funding.name && isTokenizedStock({ base: market.base, names: [funding.name] })) market.isStock = true;
      matched += 1;
    }
    console.log(`[ourbit] status depo/wd terisi untuk ${matched}/${markets.length} pair`);
    return { endpoint: result.url, rawJson: result.rawText };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[ourbit] gagal ambil status depo/wd, dibiarkan kosong: ${message}`);
    return null;
  }
}

function toNormalizedTicker(market: MarketInfo, ticker: OurbitTicker | undefined, fetchedAt: string): NormalizedTicker {
  const open = toNum(ticker?.openPrice);
  const last = toNum(ticker?.lastPrice);
  const ratio = toNum(ticker?.priceChangePercent);
  const change =
    open != null && open !== 0 && last != null ? ((last - open) / open) * 100 : ratio != null ? ratio * 100 : null;
  const ts = toNum(ticker?.closeTime);
  return {
    exchange: EXCHANGE_ID,
    rawSymbol: market.rawSymbol,
    base: market.base,
    quote: market.quote,
    last,
    bid: toNum(ticker?.bidPrice),
    ask: toNum(ticker?.askPrice),
    bidSize: toNum(ticker?.bidQty),
    askSize: toNum(ticker?.askQty),
    baseVolume24h: toNum(ticker?.volume),
    quoteVolume24h: toNum(ticker?.quoteVolume),
    change24hPct: change,
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
  const [infoRes, tickerRes] = await Promise.all([
    ourbitGet<OurbitExchangeInfo>("/api/v3/exchangeInfo"),
    ourbitGet<OurbitTicker[] | OurbitTicker>("/api/v3/ticker/24hr"),
  ]);
  rawResponses.push({ endpoint: infoRes.url, rawJson: infoRes.rawText });
  rawResponses.push({ endpoint: tickerRes.url, rawJson: tickerRes.rawText });

  const tickerRows = Array.isArray(tickerRes.data) ? tickerRes.data : tickerRes.data ? [tickerRes.data] : [];
  const tickerMap = new Map<string, OurbitTicker>();
  for (const row of tickerRows) {
    const key = String(row.symbol ?? "").trim().toUpperCase();
    if (key) tickerMap.set(key, row);
  }

  const markets: MarketInfo[] = [];
  let skippedQuote = 0;
  let skippedStatus = 0;
  for (const row of infoRes.data.symbols ?? []) {
    const rawSymbol = String(row.symbol ?? "").trim().toUpperCase();
    const base = String(row.baseAsset ?? "").trim().toUpperCase();
    const quote = String(row.quoteAsset ?? "").trim().toUpperCase();
    if (!rawSymbol || !base || !quote) continue;
    if (!/^[A-Z0-9]+$/.test(rawSymbol)) continue; // event/prediction market (~~...)
    if (!ALLOWED_QUOTES.has(quote)) {
      skippedQuote += 1;
      continue;
    }
    if (!isTradingStatus(row.status)) {
      skippedStatus += 1;
      continue;
    }
    const displayName = (row.fullName ?? "").trim() || null;
    const names = displayName ? [displayName] : undefined;
    markets.push({
      rawSymbol,
      base,
      quote,
      active: true,
      status: String(row.status ?? "ENABLED"),
      isStock: looksLikeOurbitStock(base, row.quotePrecision) || isTokenizedStock({ base, rawSymbol, names }),
      isLeveraged: isLeveragedToken({ base, rawSymbol, names }),
      displayName,
    });
  }
  if (skippedQuote > 0) console.log(`[ourbit] lewati ${skippedQuote} pair bukan USDT/USD`);
  if (skippedStatus > 0) console.log(`[ourbit] lewati ${skippedStatus} pair status bukan ENABLED`);

  const fundingRaw = await applySignedFunding(markets);
  if (fundingRaw) rawResponses.push(fundingRaw);

  const fetchedAt = new Date().toISOString();
  const tickers: DerivedTicker[] = markets.map((market) =>
    withDerivedFields(toNormalizedTicker(market, tickerMap.get(market.rawSymbol), fetchedAt)),
  );
  return { tickers, markets, rawResponses };
}

async function fetchOrderBook(rawSymbol: string, count = 5): Promise<OrderBookFetchResult> {
  const symbol = rawSymbol.trim().toUpperCase();
  const limit = depthLimit(count);
  const result = await ourbitGet<OurbitDepth>("/api/v3/depth", { symbol, limit });
  const ts = toNum(result.data.timestamp);
  const want = Math.max(1, count);
  return {
    endpoint: result.url,
    rawJson: result.rawText,
    orderbook: {
      exchange: EXCHANGE_ID,
      rawSymbol: symbol,
      bids: toLevels(result.data.bids, want, ts),
      asks: toLevels(result.data.asks, want, ts),
      fetchedAt: new Date().toISOString(),
    },
  };
}

export function ourbitSpotUrl(base: string, quote: string): string | null {
  if (!base || !quote) return null;
  return `https://www.ourbit.com/exchange/${base.toUpperCase()}${quote.toUpperCase()}`;
}

export const ourbitAdapter: ExchangeAdapter = {
  id: EXCHANGE_ID,
  name: "Ourbit",
  fetchTickers,
  fetchOrderBook,
  spotUrl: ourbitSpotUrl,
};
