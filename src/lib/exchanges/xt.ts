/**
 * Adapter XT.com — REST spot resmi.
 * Dokumentasi: https://doc.xt.com/spot
 * Host: https://sapi.xt.com
 * Simbol: GET /v4/public/symbol (state ONLINE, tradingEnabled; tag resmi STOCKS).
 * Ticker massal: GET /v4/public/ticker (last, bid/ask/ukuran, volume, ubah 24j).
 * Depth: GET /v4/public/depth?symbol=btc_usdt&limit=5
 * Dompet publik: GET /v4/public/wallet/support/currency (rantai + kontrak).
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
import { getSpotUrl } from "./spot-urls";
import { isLeveragedToken, isTokenizedStock } from "./stock-filter";

const EXCHANGE_ID = "xt";
const BASE_URL = "https://sapi.xt.com";
const ALLOWED_QUOTES = new Set(["USDT", "USD"]);
const schedule = createRateLimiter(300);

type XtEnvelope<T> = { rc?: number; mc?: string; result?: T };

type XtSymbol = {
  symbol?: string;
  displayName?: string;
  type?: string;
  state?: string;
  tradingEnabled?: boolean;
  baseCurrency?: string;
  quoteCurrency?: string;
  tags?: string[];
  businessNameI18n?: { en?: string; cn?: string; hk?: string } | null;
};

type XtTicker = {
  s?: string;
  t?: number | string;
  cv?: string;
  cr?: string;
  c?: string;
  q?: string;
  v?: string;
  ap?: string;
  aq?: string;
  bp?: string;
  bq?: string;
};

type XtChain = {
  chain?: string;
  contract?: string;
  depositEnabled?: boolean;
  withdrawEnabled?: boolean;
};

type XtWallet = {
  currency?: string;
  supportChains?: XtChain[];
};

type XtDepth = {
  symbol?: string;
  timestamp?: number;
  bids?: unknown[];
  asks?: unknown[];
};

type XtResponse<T> = { data: XtEnvelope<T>; rawText: string; url: string };

function toNum(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function englishName(row: XtSymbol): string | null {
  const en = row.businessNameI18n?.en?.trim();
  if (en) return en;
  const display = row.displayName?.trim();
  return display || null;
}

function officialStock(tags: string[] | undefined): boolean {
  return (tags ?? []).some((tag) => String(tag).trim().toUpperCase() === "STOCKS");
}

async function xtGet<T>(path: string, query?: Record<string, string | number>): Promise<XtResponse<T>> {
  const qs = query
    ? `?${new URLSearchParams(
        Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])),
      ).toString()}`
    : "";
  const url = `${BASE_URL}${path}${qs}`;
  const result = await schedule(() => fetchJson<XtEnvelope<T>>(url));
  if (result.data.rc !== 0 && String(result.data.mc ?? "").toUpperCase() !== "SUCCESS") {
    throw new ExchangeApiError(
      `XT ${path}: ${result.data.mc ?? "gagal"} (rc ${result.data.rc})`,
      undefined,
      result.rawText.slice(0, 2000),
    );
  }
  return { data: result.data, rawText: result.rawText, url };
}

function parseLevel(row: unknown, timestamp: number | null): OrderBookLevel | null {
  if (!Array.isArray(row) || row.length < 2) return null;
  const price = toNum(row[0]);
  const volume = toNum(row[1]);
  if (price == null || volume == null) return null;
  return { price, volume, timestamp };
}

function summarizeWallet(row: XtWallet): {
  depositEnabled: number;
  withdrawEnabled: number;
  chainstatusRaw: string;
  contracts: TokenContract[];
} | null {
  const chains = row.supportChains ?? [];
  if (chains.length === 0) return null;
  let depositEnabled = 0;
  let withdrawEnabled = 0;
  const parts: string[] = [];
  const contractRows: Array<{ chain: string; contract?: string | null }> = [];
  for (const chain of chains) {
    const name = (chain.chain ?? "").trim() || "?";
    const deposit = Boolean(chain.depositEnabled);
    const withdraw = Boolean(chain.withdrawEnabled);
    if (deposit) depositEnabled = 1;
    if (withdraw) withdrawEnabled = 1;
    parts.push(`${name}: D${deposit ? "✓" : "✗"} W${withdraw ? "✓" : "✗"}`);
    contractRows.push({ chain: name, contract: chain.contract });
  }
  return {
    depositEnabled,
    withdrawEnabled,
    chainstatusRaw: parts.join(", "),
    contracts: normalizeContracts(contractRows),
  };
}

function toNormalizedTicker(market: MarketInfo, ticker: XtTicker | undefined, fetchedAt: string): NormalizedTicker {
  const cr = ticker ? toNum(ticker.cr) : null;
  const ts = ticker ? toNum(ticker.t) : null;
  return {
    exchange: EXCHANGE_ID,
    rawSymbol: market.rawSymbol,
    base: market.base,
    quote: market.quote,
    last: ticker ? toNum(ticker.c) : null,
    bid: ticker ? toNum(ticker.bp) : null,
    ask: ticker ? toNum(ticker.ap) : null,
    bidSize: ticker ? toNum(ticker.bq) : null,
    askSize: ticker ? toNum(ticker.aq) : null,
    baseVolume24h: ticker ? toNum(ticker.q) : null,
    quoteVolume24h: ticker ? toNum(ticker.v) : null,
    change24hPct: cr == null ? null : cr * 100,
    exchangeTimestamp: ts != null ? new Date(ts).toISOString() : null,
    fetchedAt,
  };
}

async function fetchTickers(): Promise<TickerFetchResult> {
  const rawResponses: RawResponse[] = [];
  const [symbolRes, tickerRes, walletRes] = await Promise.all([
    xtGet<{ symbols?: XtSymbol[] }>("/v4/public/symbol"),
    xtGet<XtTicker[]>("/v4/public/ticker"),
    xtGet<XtWallet[]>("/v4/public/wallet/support/currency").catch((error) => {
      console.warn(
        "[xt] gagal ambil /v4/public/wallet/support/currency, depo/wd dilewati:",
        error instanceof Error ? error.message : error,
      );
      return null;
    }),
  ]);

  rawResponses.push({ endpoint: symbolRes.url, rawJson: symbolRes.rawText });
  rawResponses.push({ endpoint: tickerRes.url, rawJson: tickerRes.rawText });
  if (walletRes) rawResponses.push({ endpoint: walletRes.url, rawJson: walletRes.rawText });

  const tickerMap = new Map<string, XtTicker>();
  for (const row of tickerRes.data.result ?? []) {
    const key = String(row.s ?? "").trim().toLowerCase();
    if (key) tickerMap.set(key, row);
  }

  const walletByCoin = new Map<string, ReturnType<typeof summarizeWallet>>();
  for (const row of walletRes?.data.result ?? []) {
    const key = String(row.currency ?? "").trim().toUpperCase();
    if (!key) continue;
    walletByCoin.set(key, summarizeWallet(row));
  }

  const markets: MarketInfo[] = [];
  let skippedQuote = 0;
  let skippedInactive = 0;
  for (const row of symbolRes.data.result?.symbols ?? []) {
    const rawSymbol = String(row.symbol ?? "").trim();
    const base = String(row.baseCurrency ?? "").trim().toUpperCase();
    const quote = String(row.quoteCurrency ?? "").trim().toUpperCase();
    if (!rawSymbol || !base || !quote) continue;
    if (!ALLOWED_QUOTES.has(quote)) {
      skippedQuote += 1;
      continue;
    }
    const online = String(row.state ?? "").toUpperCase() === "ONLINE";
    const trading = row.tradingEnabled !== false;
    if (!online || !trading) {
      skippedInactive += 1;
      continue;
    }
    const displayName = englishName(row);
    const names = displayName ? [displayName] : undefined;
    const market: MarketInfo = {
      rawSymbol,
      base,
      quote,
      active: true,
      status: row.state ?? "ONLINE",
      isStock: officialStock(row.tags) || isTokenizedStock({ base, names }),
      isLeveraged: isLeveragedToken({ base, names }),
      displayName,
    };
    const funding = walletByCoin.get(base);
    if (funding) {
      market.depositEnabled = funding.depositEnabled;
      market.withdrawEnabled = funding.withdrawEnabled;
      market.chainstatusRaw = funding.chainstatusRaw;
      market.contracts = funding.contracts;
    }
    markets.push(market);
  }

  if (skippedQuote > 0) console.log(`[xt] lewati ${skippedQuote} pair bukan USDT/USD`);
  if (skippedInactive > 0) {
    console.log(`[xt] lewati ${skippedInactive} pair USDT/USD yang tidak ONLINE/trading`);
  }

  const fetchedAt = new Date().toISOString();
  const tickers: DerivedTicker[] = markets.map((market) =>
    withDerivedFields(toNormalizedTicker(market, tickerMap.get(market.rawSymbol.toLowerCase()), fetchedAt)),
  );
  return { tickers, markets, rawResponses };
}

async function fetchOrderBook(rawSymbol: string, count = 5): Promise<OrderBookFetchResult> {
  const symbol = rawSymbol.trim().toLowerCase();
  const limit = Math.max(1, count);
  const result = await xtGet<XtDepth>("/v4/public/depth", { symbol, limit });
  const book = result.data.result ?? {};
  const ts = toNum(book.timestamp);
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

export const xtAdapter: ExchangeAdapter = {
  id: EXCHANGE_ID,
  name: "XT",
  fetchTickers,
  fetchOrderBook,
  spotUrl: (base, quote) => getSpotUrl(EXCHANGE_ID, base, quote),
};
