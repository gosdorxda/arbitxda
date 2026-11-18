/**
 * Adapter Crypto.com Exchange — REST spot resmi v1.
 * Dokumentasi: https://exchange-docs.crypto.com/exchange/v1/rest-ws/index.html
 * Host: https://api.crypto.com/exchange/v1
 * Simbol: GET /public/get-instruments (inst_type=CCY_PAIR, tradable; quote USD saja).
 * Ticker massal: GET /public/get-tickers (last, bid/ask, volume, ubah 24j; tanpa ukuran bid/ask).
 * Depth: GET /public/get-book?instrument_name=BTC_USD&depth=5
 * Depo/wd signed: POST /private/get-currency-networks (CRYPTOCOM_API_KEY/SECRET; dilewati jika kosong).
 * Tidak ada alamat kontrak di skema resmi network_list.
 * Flag saham resmi: product_type EQUITY / EQUITY_IND / PRE_IPO (jika muncul).
 */

import { createHmac } from "node:crypto";
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
import { getSpotUrl } from "./spot-urls";
import { isLeveragedToken, isTokenizedStock } from "./stock-filter";

const EXCHANGE_ID = "cryptocom";
const BASE_URL = "https://api.crypto.com/exchange/v1";
const JSON_HEADERS = { "Content-Type": "application/json" };
const schedule = createRateLimiter(300);
const OFFICIAL_STOCK_TYPES = new Set(["EQUITY", "EQUITY_IND", "PRE_IPO"]);

type Envelope<T> = { id?: number; method?: string; code?: number | string; msg?: string; message?: string; result?: T };

type Instrument = {
  symbol?: string;
  inst_type?: string;
  display_name?: string;
  base_ccy?: string;
  quote_ccy?: string;
  tradable?: boolean;
  product_type?: string | null;
};

type TickerRow = {
  i?: string;
  a?: string;
  b?: string;
  k?: string;
  v?: string;
  vv?: string;
  c?: string;
  t?: number;
};

type BookLevel = [string | number, string | number, ...unknown[]];
type BookData = { bids?: BookLevel[]; asks?: BookLevel[]; instrument_name?: string };
type BookResult = { depth?: number; data?: BookData[] };

type NetworkRow = {
  network_id?: string;
  deposit_enabled?: boolean;
  withdraw_enabled?: boolean;
  contract_address?: string | null;
};
type CurrencyNetworks = {
  full_name?: string;
  network_list?: NetworkRow[];
};
type NetworksResult = {
  update_time?: number;
  currency_map?: Record<string, CurrencyNetworks>;
};

type ApiResponse<T> = { data: Envelope<T>; rawText: string; url: string };

function toNum(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isOk(payload: Envelope<unknown>): boolean {
  return payload.code === 0 || payload.code === "0";
}

function fail(path: string, payload: Envelope<unknown>, rawText?: string): never {
  throw new ExchangeApiError(
    `Crypto.com ${path}: ${payload.msg ?? payload.message ?? "gagal"} (code ${payload.code})`,
    undefined,
    rawText?.slice(0, 2000),
  );
}

async function cryptocomGet<T>(path: string, query?: Record<string, string | number>): Promise<ApiResponse<T>> {
  const qs = query
    ? `?${new URLSearchParams(
        Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])),
      ).toString()}`
    : "";
  const url = `${BASE_URL}${path}${qs}`;
  const result = await schedule(() => fetchJson<Envelope<T>>(url, { headers: JSON_HEADERS }));
  if (!isOk(result.data)) fail(path, result.data, result.rawText);
  return { data: result.data, rawText: result.rawText, url };
}

function readCredentials(): { apiKey: string; apiSecret: string } | null {
  const apiKey = process.env.CRYPTOCOM_API_KEY?.trim() ?? "";
  const apiSecret = process.env.CRYPTOCOM_API_SECRET?.trim() ?? "";
  if (!apiKey || !apiSecret) return null;
  return { apiKey, apiSecret };
}

function paramsString(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(paramsString).join("");
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${key}${paramsString((value as Record<string, unknown>)[key])}`)
      .join("");
  }
  return String(value);
}

function signRequest(method: string, id: number, apiKey: string, apiSecret: string, params: Record<string, unknown>, nonce: number): string {
  const payload = `${method}${id}${apiKey}${paramsString(params)}${nonce}`;
  return createHmac("sha256", apiSecret).update(payload).digest("hex");
}

async function cryptocomSignedPost<T>(method: string, creds: { apiKey: string; apiSecret: string }, params: Record<string, unknown> = {}): Promise<ApiResponse<T>> {
  const id = Date.now();
  const nonce = Date.now();
  const body = {
    id,
    method,
    params,
    api_key: creds.apiKey,
    sig: signRequest(method, id, creds.apiKey, creds.apiSecret, params, nonce),
    nonce,
  };
  const url = `${BASE_URL}/${method}`;
  const result = await schedule(() =>
    fetchJson<Envelope<T>>(url, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    }),
  );
  if (!isOk(result.data)) fail(method, result.data, result.rawText);
  return { data: result.data, rawText: result.rawText, url };
}

function officialStock(productType: string | null | undefined): boolean {
  return OFFICIAL_STOCK_TYPES.has(String(productType ?? "").trim().toUpperCase());
}

function changePct(value: unknown): number | null {
  const n = toNum(value);
  return n == null ? null : n * 100;
}

function parseLevel(row: unknown, timestamp: number | null): OrderBookLevel | null {
  if (!Array.isArray(row) || row.length < 2) return null;
  const price = toNum(row[0]);
  const volume = toNum(row[1]);
  if (price == null || volume == null) return null;
  return { price, volume, timestamp };
}

function summarizeNetworks(currency: CurrencyNetworks): {
  depositEnabled: number;
  withdrawEnabled: number;
  chainstatusRaw: string;
} | null {
  const networks = currency.network_list ?? [];
  if (networks.length === 0) return null;
  let depositEnabled = 0;
  let withdrawEnabled = 0;
  const parts: string[] = [];
  for (const net of networks) {
    const name = (net.network_id ?? "").trim() || "?";
    const deposit = Boolean(net.deposit_enabled);
    const withdraw = Boolean(net.withdraw_enabled);
    if (deposit) depositEnabled = 1;
    if (withdraw) withdrawEnabled = 1;
    parts.push(`${name}: D${deposit ? "✓" : "✗"} W${withdraw ? "✓" : "✗"}`);
  }
  return { depositEnabled, withdrawEnabled, chainstatusRaw: parts.join(", ") };
}

function toNormalizedTicker(market: MarketInfo, ticker: TickerRow | undefined, fetchedAt: string): NormalizedTicker {
  const ts = ticker ? toNum(ticker.t) : null;
  return {
    exchange: EXCHANGE_ID,
    rawSymbol: market.rawSymbol,
    base: market.base,
    quote: market.quote,
    last: ticker ? toNum(ticker.a) : null,
    bid: ticker ? toNum(ticker.b) : null,
    ask: ticker ? toNum(ticker.k) : null,
    bidSize: null,
    askSize: null,
    baseVolume24h: ticker ? toNum(ticker.v) : null,
    quoteVolume24h: ticker ? toNum(ticker.vv) : null,
    change24hPct: ticker ? changePct(ticker.c) : null,
    exchangeTimestamp: ts != null ? new Date(ts).toISOString() : null,
    fetchedAt,
  };
}

async function applySignedFunding(markets: MarketInfo[]): Promise<RawResponse | null> {
  const creds = readCredentials();
  if (!creds) {
    console.log("[cryptocom] CRYPTOCOM_API_KEY/CRYPTOCOM_API_SECRET belum diisi, status depo/wd dilewati");
    return null;
  }
  try {
    const result = await cryptocomSignedPost<NetworksResult>("private/get-currency-networks", creds, {});
    const map = result.data.result?.currency_map ?? {};
    for (const market of markets) {
      const info = map[market.base] ?? map[market.base.toUpperCase()] ?? map[market.base.toLowerCase()];
      if (!info) continue;
      const funding = summarizeNetworks(info);
      if (!funding) continue;
      market.depositEnabled = funding.depositEnabled;
      market.withdrawEnabled = funding.withdrawEnabled;
      market.chainstatusRaw = funding.chainstatusRaw;
      if (info.full_name && !market.displayName) market.displayName = info.full_name;
    }
    return { endpoint: result.url, rawJson: result.rawText };
  } catch (error) {
    console.warn(
      "[cryptocom] gagal ambil private/get-currency-networks, depo/wd dilewati:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

async function fetchTickers(): Promise<TickerFetchResult> {
  const rawResponses: RawResponse[] = [];
  const [instrumentRes, tickerRes] = await Promise.all([
    cryptocomGet<{ data?: Instrument[] }>("/public/get-instruments"),
    cryptocomGet<{ data?: TickerRow[] }>("/public/get-tickers"),
  ]);
  rawResponses.push({ endpoint: instrumentRes.url, rawJson: instrumentRes.rawText });
  rawResponses.push({ endpoint: tickerRes.url, rawJson: tickerRes.rawText });

  const tickerMap = new Map<string, TickerRow>();
  for (const row of tickerRes.data.result?.data ?? []) {
    const key = String(row.i ?? "").trim().toUpperCase();
    if (key) tickerMap.set(key, row);
  }

  const markets: MarketInfo[] = [];
  let skippedUsdt = 0;
  let skippedOtherQuote = 0;
  let skippedNonSpot = 0;
  let skippedInactive = 0;

  for (const row of instrumentRes.data.result?.data ?? []) {
    const instType = String(row.inst_type ?? "").trim().toUpperCase();
    if (instType !== "CCY_PAIR") {
      skippedNonSpot += 1;
      continue;
    }
    const rawSymbol = String(row.symbol ?? "").trim().toUpperCase();
    const base = String(row.base_ccy ?? "").trim().toUpperCase();
    const quote = String(row.quote_ccy ?? "").trim().toUpperCase();
    if (!rawSymbol || !base || !quote) continue;
    if (quote === "USDT") {
      skippedUsdt += 1;
      continue;
    }
    if (quote !== "USD") {
      skippedOtherQuote += 1;
      continue;
    }
    if (row.tradable === false) {
      skippedInactive += 1;
      continue;
    }
    const displayName = row.display_name?.trim() || null;
    const names = displayName ? [displayName] : undefined;
    markets.push({
      rawSymbol,
      base,
      quote,
      active: true,
      status: "trading",
      isStock: officialStock(row.product_type) || isTokenizedStock({ base, names }),
      isLeveraged: isLeveragedToken({ base, names }),
      displayName,
    });
  }

  console.log(`[cryptocom] lewati ${skippedUsdt} pair spot quote USDT (hanya USD yang diambil)`);
  if (skippedOtherQuote > 0) console.log(`[cryptocom] lewati ${skippedOtherQuote} pair spot quote selain USD/USDT`);
  if (skippedNonSpot > 0) console.log(`[cryptocom] lewati ${skippedNonSpot} instrumen non-spot (perp/futures/dll)`);
  if (skippedInactive > 0) console.log(`[cryptocom] lewati ${skippedInactive} pair USD yang tidak tradable`);

  const fundingRaw = await applySignedFunding(markets);
  if (fundingRaw) rawResponses.push(fundingRaw);

  const fetchedAt = new Date().toISOString();
  const tickers: DerivedTicker[] = markets.map((market) =>
    withDerivedFields(toNormalizedTicker(market, tickerMap.get(market.rawSymbol.toUpperCase()), fetchedAt)),
  );
  return { tickers, markets, rawResponses };
}

async function fetchOrderBook(rawSymbol: string, count = 5): Promise<OrderBookFetchResult> {
  const symbol = rawSymbol.trim().toUpperCase();
  const limit = Math.max(1, count);
  const result = await cryptocomGet<BookResult>("/public/get-book", { instrument_name: symbol, depth: limit });
  const book = result.data.result?.data?.[0] ?? {};
  const toLevels = (rows: BookLevel[] | undefined) =>
    (rows ?? [])
      .slice(0, limit)
      .map((row) => parseLevel(row, null))
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

export const cryptocomAdapter: ExchangeAdapter = {
  id: EXCHANGE_ID,
  name: "Crypto.com",
  fetchTickers,
  fetchOrderBook,
  spotUrl: (base, quote) => getSpotUrl(EXCHANGE_ID, base, quote),
};
