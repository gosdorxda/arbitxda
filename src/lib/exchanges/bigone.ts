/**
 * Adapter BigONE — REST spot resmi.
 * Dokumentasi: https://open.big.one/docs/guides/spot/ dan https://github.com/bigone-eng/openapi-specs
 * Host: https://api.big.one/api/v3 (cadangan: https://big.one/api/v3).
 * Simbol: GET /asset_pairs (tanpa field status; semua pair yang dikembalikan dianggap tradable).
 * Ticker massal: GET /asset_pairs/tickers (last, bid/ask/ukuran, volume dasar, open/close).
 * Depth: GET /asset_pairs/{name}/depth?limit=5
 * Aset publik: GET /assets (binding_gateways: deposit/withdraw per rantai, tanpa alamat kontrak).
 * Tidak ada flag saham/leverage resmi; filter bersama otomatis.
 * Tidak perlu API key.
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
import { getSpotUrl } from "./spot-urls";
import { isLeveragedToken, isTokenizedStock } from "./stock-filter";

const EXCHANGE_ID = "bigone";
const PRIMARY_HOST = "https://api.big.one/api/v3";
const BACKUP_HOST = "https://big.one/api/v3";
const HOSTS = [PRIMARY_HOST, BACKUP_HOST];
const ALLOWED_QUOTES = new Set(["USDT", "USD"]);
const schedule = createRateLimiter(300);

let activeHost = PRIMARY_HOST;

type Envelope<T> = { code?: number | string; message?: string; data?: T };

type AssetRef = { symbol?: string; name?: string };
type PairRow = {
  name?: string;
  base_asset?: AssetRef;
  quote_asset?: AssetRef;
};

type BookSide = { price?: string; quantity?: string; order_count?: number };
type TickerRow = {
  asset_pair_name?: string;
  bid?: BookSide | null;
  ask?: BookSide | null;
  open?: string;
  close?: string;
  volume?: string;
  daily_change?: string;
};

type Gateway = {
  gateway_name?: string;
  is_deposit_enabled?: boolean;
  is_withdrawal_enabled?: boolean;
};

type AssetRow = {
  symbol?: string;
  name?: string;
  binding_gateways?: Gateway[] | null;
};

type DepthData = {
  asset_pair_name?: string;
  bids?: BookSide[];
  asks?: BookSide[];
};

type ApiResponse<T> = { data: Envelope<T>; rawText: string; url: string };

function toNum(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isRetryableHostError(error: unknown): boolean {
  if (error instanceof ExchangeApiError) {
    const status = error.status;
    return status == null || status === 429 || status >= 500;
  }
  return true;
}

async function bigoneGet<T>(path: string, query?: Record<string, string | number>): Promise<ApiResponse<T>> {
  const qs = query
    ? `?${new URLSearchParams(
        Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])),
      ).toString()}`
    : "";
  const relative = `${path}${qs}`;
  const tryHosts = [activeHost, ...HOSTS.filter((host) => host !== activeHost)];
  let lastError: unknown;

  for (const host of tryHosts) {
    const url = `${host}${relative}`;
    try {
      const result = await schedule(() => fetchJson<Envelope<T>>(url));
      if (result.data.code !== 0 && result.data.code !== "0") {
        throw new ExchangeApiError(
          `BigONE ${path}: ${result.data.message ?? "gagal"} (code ${result.data.code})`,
          undefined,
          result.rawText.slice(0, 2000),
        );
      }
      activeHost = host;
      return { data: result.data, rawText: result.rawText, url };
    } catch (error) {
      lastError = error;
      const canFallback = host !== tryHosts[tryHosts.length - 1] && isRetryableHostError(error);
      if (canFallback) continue;
      throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new ExchangeApiError("BigONE: semua host gagal");
}

function changePct(ticker: TickerRow | undefined): number | null {
  if (!ticker) return null;
  const open = toNum(ticker.open);
  const close = toNum(ticker.close);
  if (open != null && open !== 0 && close != null) return ((close - open) / open) * 100;
  return null;
}

function summarizeGateways(row: AssetRow): {
  depositEnabled: number;
  withdrawEnabled: number;
  chainstatusRaw: string;
} | null {
  const gates = row.binding_gateways ?? [];
  if (gates.length === 0) return null;
  let depositEnabled = 0;
  let withdrawEnabled = 0;
  const parts: string[] = [];
  for (const gate of gates) {
    const name = (gate.gateway_name ?? "").trim() || "?";
    const deposit = Boolean(gate.is_deposit_enabled);
    const withdraw = Boolean(gate.is_withdrawal_enabled);
    if (deposit) depositEnabled = 1;
    if (withdraw) withdrawEnabled = 1;
    parts.push(`${name}: D${deposit ? "✓" : "✗"} W${withdraw ? "✓" : "✗"}`);
  }
  return { depositEnabled, withdrawEnabled, chainstatusRaw: parts.join(", ") };
}

function toLevels(rows: BookSide[] | undefined, limit: number): OrderBookLevel[] {
  const out: OrderBookLevel[] = [];
  for (const row of rows ?? []) {
    const price = toNum(row.price);
    const volume = toNum(row.quantity);
    if (price == null || volume == null) continue;
    out.push({ price, volume, timestamp: null });
    if (out.length >= limit) break;
  }
  return out;
}

function toNormalizedTicker(market: MarketInfo, ticker: TickerRow | undefined, fetchedAt: string): NormalizedTicker {
  const last = ticker ? toNum(ticker.close) : null;
  const baseVolume = ticker ? toNum(ticker.volume) : null;
  return {
    exchange: EXCHANGE_ID,
    rawSymbol: market.rawSymbol,
    base: market.base,
    quote: market.quote,
    last,
    bid: ticker?.bid ? toNum(ticker.bid.price) : null,
    ask: ticker?.ask ? toNum(ticker.ask.price) : null,
    bidSize: ticker?.bid ? toNum(ticker.bid.quantity) : null,
    askSize: ticker?.ask ? toNum(ticker.ask.quantity) : null,
    baseVolume24h: baseVolume,
    // BigONE tidak kasih volume quote: volume koin × last price.
    quoteVolume24h: baseVolume != null && last != null ? baseVolume * last : null,
    change24hPct: changePct(ticker),
    exchangeTimestamp: null,
    fetchedAt,
  };
}

async function fetchTickers(): Promise<TickerFetchResult> {
  const rawResponses: RawResponse[] = [];
  const [pairRes, tickerRes, assetRes] = await Promise.all([
    bigoneGet<PairRow[]>("/asset_pairs"),
    bigoneGet<TickerRow[]>("/asset_pairs/tickers"),
    bigoneGet<AssetRow[]>("/assets").catch((error) => {
      console.warn(
        "[bigone] gagal ambil /assets, depo/wd dilewati:",
        error instanceof Error ? error.message : error,
      );
      return null;
    }),
  ]);

  rawResponses.push({ endpoint: pairRes.url, rawJson: pairRes.rawText });
  rawResponses.push({ endpoint: tickerRes.url, rawJson: tickerRes.rawText });
  if (assetRes) rawResponses.push({ endpoint: assetRes.url, rawJson: assetRes.rawText });

  const tickerMap = new Map<string, TickerRow>();
  for (const row of tickerRes.data.data ?? []) {
    const key = String(row.asset_pair_name ?? "").trim().toUpperCase();
    if (key) tickerMap.set(key, row);
  }

  const fundingByCoin = new Map<string, ReturnType<typeof summarizeGateways>>();
  const nameByCoin = new Map<string, string>();
  for (const row of assetRes?.data.data ?? []) {
    const key = String(row.symbol ?? "").trim().toUpperCase();
    if (!key) continue;
    fundingByCoin.set(key, summarizeGateways(row));
    const name = row.name?.trim();
    if (name) nameByCoin.set(key, name);
  }

  const markets: MarketInfo[] = [];
  let skippedQuote = 0;
  for (const row of pairRes.data.data ?? []) {
    const rawSymbol = String(row.name ?? "").trim().toUpperCase();
    const base = String(row.base_asset?.symbol ?? "").trim().toUpperCase();
    const quote = String(row.quote_asset?.symbol ?? "").trim().toUpperCase();
    if (!rawSymbol || !base || !quote) continue;
    if (!ALLOWED_QUOTES.has(quote)) {
      skippedQuote += 1;
      continue;
    }
    const displayName = nameByCoin.get(base) ?? row.base_asset?.name?.trim() ?? null;
    const names = displayName ? [displayName] : undefined;
    const market: MarketInfo = {
      rawSymbol,
      base,
      quote,
      active: true,
      status: "trading",
      isStock: isTokenizedStock({ base, names }),
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

  if (skippedQuote > 0) console.log(`[bigone] lewati ${skippedQuote} pair bukan USDT/USD`);

  const fetchedAt = new Date().toISOString();
  const tickers: DerivedTicker[] = markets.map((market) =>
    withDerivedFields(toNormalizedTicker(market, tickerMap.get(market.rawSymbol.toUpperCase()), fetchedAt)),
  );
  return { tickers, markets, rawResponses };
}

async function fetchOrderBook(rawSymbol: string, count = 5): Promise<OrderBookFetchResult> {
  const symbol = rawSymbol.trim().toUpperCase();
  const limit = Math.max(1, count);
  const result = await bigoneGet<DepthData>(`/asset_pairs/${encodeURIComponent(symbol)}/depth`, { limit });
  const book = result.data.data ?? {};
  return {
    endpoint: result.url,
    rawJson: result.rawText,
    orderbook: {
      exchange: EXCHANGE_ID,
      rawSymbol: symbol,
      bids: toLevels(book.bids, limit),
      asks: toLevels(book.asks, limit),
      fetchedAt: new Date().toISOString(),
    },
  };
}

export const bigoneAdapter: ExchangeAdapter = {
  id: EXCHANGE_ID,
  name: "BigONE",
  fetchTickers,
  fetchOrderBook,
  spotUrl: (base, quote) => getSpotUrl(EXCHANGE_ID, base, quote),
};
