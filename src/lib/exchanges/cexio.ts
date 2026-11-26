/**
 * Adapter CEX.IO — REST spot resmi (publik, tanpa API key).
 * Dokumentasi: https://trade.cex.io/docs/  (Spot Trading Public REST, update 2026-10-26)
 * Host: https://trade.cex.io/api/spot/rest-public
 * Semua method publik memakai POST + JSON body.
 * Pasar: POST /get_pairs_info (array {base, quote, ...}; tanpa field status — pair yang dikembalikan dianggap didukung).
 * Ticker massal: POST /get_ticker (map "BTC-USD" → bestBid, bestAsk, last, volume=base 24 jam,
 *   volumeUSD=notional USD 24 jam, priceChangePercentage).
 * Depth: POST /get_order_book { pair: "BTC-USD" } (bids/asks [price, amount]; potong top 5 di klien).
 * Depo/WD + kontrak: POST /get_processing_info (blockchains.*.deposit/withdrawal "enabled", contract).
 *   Status Spot↔Wallet (get_currencies_info.walletDeposit/Withdrawal) tidak dipakai, karena itu bukan on-chain.
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
  TokenContract,
} from "../types";
import { isLeveragedToken, isTokenizedStock } from "./stock-filter";

const EXCHANGE_ID = "cexio";
const BASE_URL = "https://trade.cex.io/api/spot/rest-public";
const ALLOWED_QUOTES = new Set(["USDT", "USD"]);
const schedule = createRateLimiter(200);

type CexEnvelope<T> = { ok?: string; error?: unknown; data?: T; statusCode?: number };

type CexPair = { base?: string; quote?: string };

type CexTicker = {
  bestBid?: string | number;
  bestAsk?: string | number;
  last?: string | number;
  volume?: string | number;
  volumeUSD?: string | number;
  priceChangePercentage?: string | number;
};

type CexBook = {
  timestamp?: number;
  currency1?: string;
  currency2?: string;
  bids?: Array<[string, string] | string[] | number[]>;
  asks?: Array<[string, string] | string[] | number[]>;
};

type CexChain = {
  type?: string;
  deposit?: string;
  withdrawal?: string;
  contract?: string | null;
};

type CexCurrencyProcessing = {
  name?: string;
  blockchains?: Record<string, CexChain | undefined> | null;
};

type ApiResponse<T> = { data: T; rawText: string; url: string };

function toNum(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

function isEnabledFlag(value: unknown): boolean {
  return String(value ?? "").trim().toLowerCase() === "enabled";
}

async function cexPost<T>(path: string, body: Record<string, unknown> = {}): Promise<ApiResponse<T>> {
  const url = `${BASE_URL}${path}`;
  const result = await schedule(() =>
    fetchJson<CexEnvelope<T>>(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      retries: 1,
    }),
  );
  const envelope = result.data;
  const innerError =
    envelope && typeof envelope === "object" && envelope.data && typeof envelope.data === "object" && "error" in (envelope.data as object)
      ? (envelope.data as { error?: unknown }).error
      : envelope?.error;
  if (envelope?.ok !== "ok" || innerError) {
    const msg =
      typeof innerError === "string"
        ? innerError
        : innerError
          ? JSON.stringify(innerError)
          : "gagal";
    throw new ExchangeApiError(`CEX.IO ${path}: ${msg}`, result.data?.statusCode, result.rawText.slice(0, 2000));
  }
  if (envelope.data == null) {
    throw new ExchangeApiError(`CEX.IO ${path}: respons tanpa data`, 200, result.rawText.slice(0, 2000));
  }
  return { data: envelope.data, rawText: result.rawText, url };
}

function pairSymbol(base: string, quote: string): string {
  return `${base}-${quote}`;
}

function toNormalizedTicker(market: MarketInfo, row: CexTicker | undefined, fetchedAt: string): NormalizedTicker {
  return {
    exchange: EXCHANGE_ID,
    rawSymbol: market.rawSymbol,
    base: market.base,
    quote: market.quote,
    last: toNum(row?.last),
    bid: toNum(row?.bestBid),
    ask: toNum(row?.bestAsk),
    bidSize: null,
    askSize: null,
    baseVolume24h: toNum(row?.volume),
    quoteVolume24h: toNum(row?.volumeUSD),
    change24hPct: toNum(row?.priceChangePercentage),
    exchangeTimestamp: null,
    fetchedAt,
  };
}

function toLevels(
  rows: Array<[string, string] | string[] | number[]> | undefined,
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

function fundingFromProcessing(info: CexCurrencyProcessing): {
  depositEnabled: number;
  withdrawEnabled: number;
  chainstatusRaw: string | null;
  contracts: TokenContract[];
  displayName: string | null;
} {
  const chains = info.blockchains ?? {};
  let depositEnabled = 0;
  let withdrawEnabled = 0;
  const parts: string[] = [];
  const contractRows: Array<{ chain: string; contract: string | null }> = [];
  for (const [chainName, chain] of Object.entries(chains)) {
    if (!chain) continue;
    const label = (chainName || chain.type || "?").trim() || "?";
    const deposit = isEnabledFlag(chain.deposit);
    const withdraw = isEnabledFlag(chain.withdrawal);
    if (deposit) depositEnabled = 1;
    if (withdraw) withdrawEnabled = 1;
    parts.push(`${label}: D${deposit ? "✓" : "✗"} W${withdraw ? "✓" : "✗"}`);
    contractRows.push({ chain: label, contract: typeof chain.contract === "string" ? chain.contract : null });
  }
  return {
    depositEnabled,
    withdrawEnabled,
    chainstatusRaw: parts.length > 0 ? parts.join(", ") : null,
    contracts: normalizeContracts(contractRows),
    displayName: (info.name ?? "").trim() || null,
  };
}

async function fetchTickers(): Promise<TickerFetchResult> {
  const rawResponses: RawResponse[] = [];
  const [pairRes, tickerRes, processingRes] = await Promise.all([
    cexPost<CexPair[]>("/get_pairs_info"),
    cexPost<Record<string, CexTicker>>("/get_ticker"),
    cexPost<Record<string, CexCurrencyProcessing>>("/get_processing_info"),
  ]);
  rawResponses.push({ endpoint: pairRes.url, rawJson: pairRes.rawText });
  rawResponses.push({ endpoint: tickerRes.url, rawJson: tickerRes.rawText });
  rawResponses.push({ endpoint: processingRes.url, rawJson: processingRes.rawText });

  const tickerMap = new Map<string, CexTicker>();
  for (const [pair, row] of Object.entries(tickerRes.data ?? {})) {
    if (row) tickerMap.set(pair.trim().toUpperCase(), row);
  }
  const fundingByAsset = new Map<string, ReturnType<typeof fundingFromProcessing>>();
  for (const [asset, info] of Object.entries(processingRes.data ?? {})) {
    const key = asset.trim().toUpperCase();
    if (key && info) fundingByAsset.set(key, fundingFromProcessing(info));
  }

  const pairs = Array.isArray(pairRes.data) ? pairRes.data : [];
  const markets: MarketInfo[] = [];
  let skippedQuote = 0;
  for (const row of pairs) {
    const base = String(row.base ?? "").trim().toUpperCase();
    const quote = String(row.quote ?? "").trim().toUpperCase();
    if (!base || !quote) continue;
    if (!ALLOWED_QUOTES.has(quote)) {
      skippedQuote += 1;
      continue;
    }
    const rawSymbol = pairSymbol(base, quote);
    const market: MarketInfo = {
      rawSymbol,
      base,
      quote,
      active: true,
      status: "trading",
      isStock: isTokenizedStock({ base, rawSymbol }),
      isLeveraged: isLeveragedToken({ base, rawSymbol }),
      displayName: null,
    };
    const funding = fundingByAsset.get(base);
    if (funding) {
      market.depositEnabled = funding.depositEnabled;
      market.withdrawEnabled = funding.withdrawEnabled;
      market.chainstatusRaw = funding.chainstatusRaw;
      market.contracts = funding.contracts;
      market.displayName = funding.displayName;
    }
    markets.push(market);
  }
  if (skippedQuote > 0) console.log(`[cexio] lewati ${skippedQuote} pair bukan USDT/USD`);

  const fetchedAt = new Date().toISOString();
  const tickers: DerivedTicker[] = markets.map((market) =>
    withDerivedFields(toNormalizedTicker(market, tickerMap.get(market.rawSymbol), fetchedAt)),
  );
  return { tickers, markets, rawResponses };
}

async function fetchOrderBook(rawSymbol: string, count = 5): Promise<OrderBookFetchResult> {
  const pair = rawSymbol.trim().toUpperCase();
  const limit = Math.min(Math.max(1, count), 100);
  const result = await cexPost<CexBook>("/get_order_book", { pair });
  const book = result.data ?? {};
  const fetchedAt =
    typeof book.timestamp === "number" && Number.isFinite(book.timestamp)
      ? new Date(book.timestamp).toISOString()
      : new Date().toISOString();
  return {
    endpoint: result.url,
    rawJson: result.rawText,
    orderbook: {
      exchange: EXCHANGE_ID,
      rawSymbol: pair,
      bids: toLevels(book.bids, limit, "bid"),
      asks: toLevels(book.asks, limit, "ask"),
      fetchedAt,
    },
  };
}

export function cexioSpotUrl(base: string, quote: string): string | null {
  if (!base || !quote) return null;
  return `https://trade.cex.io/spot/${base.toUpperCase()}-${quote.toUpperCase()}`;
}

export const cexioAdapter: ExchangeAdapter = {
  id: EXCHANGE_ID,
  name: "CEX.IO",
  fetchTickers,
  fetchOrderBook,
  spotUrl: cexioSpotUrl,
};
