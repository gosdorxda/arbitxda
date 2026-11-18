/**
 * Adapter AsterDEX — REST spot resmi V3.
 * Dokumentasi: https://github.com/asterdex/api-docs (V3 Recommended)
 *   dan https://asterdex.github.io/aster-api-website/spot-v3/
 * Host market data: https://sapi.asterdex.com
 * Simbol: GET /api/v3/exchangeInfo (status TRADING; hanya quote USDT).
 *   Simbol TEST* dilewati (internal testing, per dokumentasi resmi).
 *   Event/prediction market di ticker/24hr tidak ada di exchangeInfo, jadi otomatis terlewat.
 * Ticker: GET /api/v3/ticker/24hr + GET /api/v3/ticker/bookTicker
 *   (last, ubah 24j, volume, bid/ask + ukuran, status pasar).
 * Depth: GET /api/v3/depth?symbol=&limit=
 * Depo/WD + kontrak publik (tanpa API key):
 *   GET https://www.asterdex.com/bapi/futures/v1/public/future/aster/deposit/assets
 *   GET https://www.asterdex.com/bapi/futures/v1/public/future/aster/withdraw/assets
 *   (chainIds 1/56/42161/101, networks EVM,SOLANA, accountType=spot).
 *   Solana memakai tokenMint, bukan contractAddress bersama.
 * Saham tokenisasi: flag resmi isStock pada withdraw-assets.
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

const EXCHANGE_ID = "asterdex";
const BASE_URL = "https://sapi.asterdex.com";
const FUNDING_BASE = "https://www.asterdex.com/bapi/futures/v1/public/future/aster";
const FUNDING_QUERY = "chainIds=1,56,42161,101&networks=EVM,SOLANA&accountType=spot";
const ALLOWED_QUOTES = new Set(["USDT"]);
const DEPTH_LIMITS = [5, 10, 20, 50, 100, 500, 1000];
const KNOWN_STOCK_BASES = new Set(["CRCLB", "MSTRB", "NVDAB", "SKHYB", "SPCXB"]);
const CHAIN_LABELS: Record<number, string> = {
  1: "ETH",
  56: "BSC",
  42161: "ARB",
  101: "SOL",
  131: "SUI",
};
const schedule = createRateLimiter(300);

type AsterSymbol = {
  symbol?: string;
  baseAsset?: string;
  quoteAsset?: string;
  status?: string;
  symbolType?: number | string;
};

type AsterExchangeInfo = {
  symbols?: AsterSymbol[];
  code?: number | string;
  msg?: string;
};

type AsterTicker = {
  symbol?: string;
  lastPrice?: string | number;
  bidPrice?: string | number;
  bidQty?: string | number;
  askPrice?: string | number;
  askQty?: string | number;
  volume?: string | number;
  quoteVolume?: string | number;
  priceChangePercent?: string | number;
  closeTime?: string | number;
  baseAsset?: string;
  quoteAsset?: string;
};

type AsterBookTicker = {
  symbol?: string;
  bidPrice?: string | number;
  bidQty?: string | number;
  askPrice?: string | number;
  askQty?: string | number;
  time?: number;
};

type AsterDepth = {
  lastUpdateId?: number;
  symbol?: string;
  T?: number;
  E?: number;
  bids?: Array<[string, string] | string[]>;
  asks?: Array<[string, string] | string[]>;
  code?: number | string;
  msg?: string;
};

type AssetRow = {
  name?: string;
  displayName?: string;
  contractAddress?: string | null;
  tokenMint?: string | null;
  network?: string;
  chainId?: number | string;
  isNative?: boolean;
  isStock?: boolean;
};

type FundingEnvelope = {
  code?: string | number;
  message?: string | null;
  success?: boolean;
  data?: AssetRow[];
};

type AssetFunding = {
  depositEnabled: number;
  withdrawEnabled: number;
  chainstatusRaw: string;
  contracts: TokenContract[];
  displayName: string | null;
  isStock: boolean;
};

type ApiResponse<T> = { data: T; rawText: string; url: string };

function toNum(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

function isPositive(value: unknown): boolean {
  const n = toNum(value);
  return n != null && n > 0;
}

function isTestSymbol(base: string, symbol: string): boolean {
  return base.startsWith("TEST") || symbol.startsWith("TEST");
}

function isTradingStatus(status: string | undefined): boolean {
  return String(status ?? "").trim().toUpperCase() === "TRADING";
}

function depthLimit(count?: number): number {
  const want = Math.max(1, count ?? 5);
  return DEPTH_LIMITS.find((n) => n >= want) ?? 1000;
}

function chainLabel(chainId: number | undefined, network?: string): string {
  if (chainId != null && CHAIN_LABELS[chainId]) return CHAIN_LABELS[chainId];
  const net = (network ?? "").trim().toUpperCase();
  if (net === "SOLANA" || net === "SOL") return "SOL";
  if (net) return net;
  return chainId != null ? String(chainId) : "?";
}

function parseChainId(value: number | string | undefined): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function contractForRow(row: AssetRow): string | null {
  const chainId = parseChainId(row.chainId);
  if (chainId === 101) {
    const mint = (row.tokenMint ?? "").trim();
    return mint || null;
  }
  const address = (row.contractAddress ?? "").trim();
  return address || null;
}

function asTickerList(data: AsterTicker[] | AsterTicker | undefined): AsterTicker[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") return [data];
  return [];
}

function asBookList(data: AsterBookTicker[] | AsterBookTicker | undefined): AsterBookTicker[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") return [data];
  return [];
}

function assertSpotOk(data: unknown, rawText: string, endpoint: string) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  const body = data as { code?: number | string; msg?: string; message?: string };
  if (body.code == null) return;
  const code = String(body.code);
  if (code === "0" || code === "200") return;
  throw new ExchangeApiError(
    `AsterDEX ${endpoint}: ${body.msg || body.message || `kode ${code}`}`,
    200,
    rawText.slice(0, 2000),
  );
}

function assertFundingOk(data: FundingEnvelope, rawText: string, endpoint: string) {
  const code = data.code == null ? "" : String(data.code);
  if (data.success === false || (code && code !== "000000" && code !== "0")) {
    throw new ExchangeApiError(
      `AsterDEX ${endpoint}: ${data.message || `kode ${code || "gagal"}`}`,
      200,
      rawText.slice(0, 2000),
    );
  }
}

async function asterGet<T>(path: string, query?: Record<string, string | number>): Promise<ApiResponse<T>> {
  const qs = query
    ? `?${new URLSearchParams(
        Object.fromEntries(Object.entries(query).map(([key, value]) => [key, String(value)])),
      ).toString()}`
    : "";
  const url = `${BASE_URL}${path}${qs}`;
  const result = await schedule(() => fetchJson<T>(url));
  assertSpotOk(result.data, result.rawText, path);
  return { data: result.data, rawText: result.rawText, url };
}

async function fundingGet(kind: "deposit" | "withdraw"): Promise<ApiResponse<FundingEnvelope>> {
  const url = `${FUNDING_BASE}/${kind}/assets?${FUNDING_QUERY}`;
  const result = await schedule(() => fetchJson<FundingEnvelope>(url));
  assertFundingOk(result.data, result.rawText, `${kind}/assets`);
  return { data: result.data, rawText: result.rawText, url };
}

function summarizeFunding(depositRows: AssetRow[], withdrawRows: AssetRow[]): Map<string, AssetFunding> {
  type Acc = {
    depositChains: Set<string>;
    withdrawChains: Set<string>;
    contracts: Array<{ chain: string; contract: string | null }>;
    displayName: string | null;
    isStock: boolean;
  };
  const byAsset = new Map<string, Acc>();

  const ensure = (name: string): Acc => {
    const key = name.trim().toUpperCase();
    let acc = byAsset.get(key);
    if (!acc) {
      acc = {
        depositChains: new Set(),
        withdrawChains: new Set(),
        contracts: [],
        displayName: null,
        isStock: false,
      };
      byAsset.set(key, acc);
    }
    return acc;
  };

  const ingest = (rows: AssetRow[], kind: "deposit" | "withdraw") => {
    for (const row of rows) {
      const name = String(row.name ?? "").trim().toUpperCase();
      if (!name) continue;
      const acc = ensure(name);
      const chain = chainLabel(parseChainId(row.chainId), row.network);
      if (kind === "deposit") acc.depositChains.add(chain);
      else acc.withdrawChains.add(chain);
      if (row.isStock) acc.isStock = true;
      const display = (row.displayName ?? row.name ?? "").trim();
      if (display && !acc.displayName) acc.displayName = display;
      const contract = contractForRow(row);
      if (contract) acc.contracts.push({ chain, contract });
    }
  };

  ingest(depositRows, "deposit");
  ingest(withdrawRows, "withdraw");

  const out = new Map<string, AssetFunding>();
  for (const [asset, acc] of byAsset) {
    const chains = [...new Set([...acc.depositChains, ...acc.withdrawChains])].sort();
    const parts = chains.map((chain) => {
      const deposit = acc.depositChains.has(chain);
      const withdraw = acc.withdrawChains.has(chain);
      return `${chain}: D${deposit ? "✓" : "✗"} W${withdraw ? "✓" : "✗"}`;
    });
    out.set(asset, {
      depositEnabled: acc.depositChains.size > 0 ? 1 : 0,
      withdrawEnabled: acc.withdrawChains.size > 0 ? 1 : 0,
      chainstatusRaw: parts.join(", "),
      contracts: normalizeContracts(acc.contracts),
      displayName: acc.displayName,
      isStock: acc.isStock || KNOWN_STOCK_BASES.has(asset),
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
  ticker: AsterTicker | undefined,
  book: AsterBookTicker | undefined,
  fetchedAt: string,
): NormalizedTicker {
  const closeTime = toNum(ticker?.closeTime);
  const bid = isPositive(book?.bidPrice) ? toNum(book?.bidPrice) : toNum(ticker?.bidPrice);
  const ask = isPositive(book?.askPrice) ? toNum(book?.askPrice) : toNum(ticker?.askPrice);
  const bidSize = isPositive(book?.bidQty) ? toNum(book?.bidQty) : toNum(ticker?.bidQty);
  const askSize = isPositive(book?.askQty) ? toNum(book?.askQty) : toNum(ticker?.askQty);
  return {
    exchange: EXCHANGE_ID,
    rawSymbol: market.rawSymbol,
    base: market.base,
    quote: market.quote,
    last: toNum(ticker?.lastPrice),
    bid: isPositive(bid) ? bid : null,
    ask: isPositive(ask) ? ask : null,
    bidSize: isPositive(bidSize) ? bidSize : null,
    askSize: isPositive(askSize) ? askSize : null,
    baseVolume24h: toNum(ticker?.volume),
    quoteVolume24h: toNum(ticker?.quoteVolume),
    change24hPct: toNum(ticker?.priceChangePercent),
    exchangeTimestamp: closeTime != null ? new Date(closeTime).toISOString() : null,
    fetchedAt,
  };
}

async function fetchTickers(): Promise<TickerFetchResult> {
  const rawResponses: RawResponse[] = [];
  const [infoRes, tickerRes, bookRes, depositRes, withdrawRes] = await Promise.all([
    asterGet<AsterExchangeInfo>("/api/v3/exchangeInfo"),
    asterGet<AsterTicker[] | AsterTicker>("/api/v3/ticker/24hr"),
    asterGet<AsterBookTicker[] | AsterBookTicker>("/api/v3/ticker/bookTicker"),
    fundingGet("deposit").catch((error) => {
      console.warn(
        "[asterdex] gagal ambil deposit/assets, depo/kontrak dilewati:",
        error instanceof Error ? error.message : error,
      );
      return null;
    }),
    fundingGet("withdraw").catch((error) => {
      console.warn(
        "[asterdex] gagal ambil withdraw/assets, wd/saham resmi dilewati:",
        error instanceof Error ? error.message : error,
      );
      return null;
    }),
  ]);

  rawResponses.push({ endpoint: infoRes.url, rawJson: infoRes.rawText });
  rawResponses.push({ endpoint: tickerRes.url, rawJson: tickerRes.rawText });
  rawResponses.push({ endpoint: bookRes.url, rawJson: bookRes.rawText });
  if (depositRes) rawResponses.push({ endpoint: depositRes.url, rawJson: depositRes.rawText });
  if (withdrawRes) rawResponses.push({ endpoint: withdrawRes.url, rawJson: withdrawRes.rawText });

  const tickerMap = new Map<string, AsterTicker>();
  for (const row of asTickerList(tickerRes.data)) {
    const key = String(row.symbol ?? "").trim().toUpperCase();
    if (key) tickerMap.set(key, row);
  }

  const bookMap = new Map<string, AsterBookTicker>();
  for (const row of asBookList(bookRes.data)) {
    const key = String(row.symbol ?? "").trim().toUpperCase();
    if (key) bookMap.set(key, row);
  }

  const fundingByAsset = summarizeFunding(depositRes?.data.data ?? [], withdrawRes?.data.data ?? []);
  const fundingLoaded = Boolean(depositRes || withdrawRes);

  const markets: MarketInfo[] = [];
  let skippedQuote = 0;
  let skippedTest = 0;
  for (const row of infoRes.data.symbols ?? []) {
    const rawSymbol = String(row.symbol ?? "").trim().toUpperCase();
    const base = String(row.baseAsset ?? "").trim().toUpperCase();
    const quote = String(row.quoteAsset ?? "").trim().toUpperCase();
    if (!rawSymbol || !base || !quote) continue;
    if (isTestSymbol(base, rawSymbol)) {
      skippedTest += 1;
      continue;
    }
    if (!ALLOWED_QUOTES.has(quote)) {
      skippedQuote += 1;
      continue;
    }
    const funding = fundingByAsset.get(base);
    const displayName = funding?.displayName ?? null;
    const market: MarketInfo = {
      rawSymbol,
      base,
      quote,
      active: isTradingStatus(row.status),
      status: row.status ? String(row.status).trim() : null,
      isStock: Boolean(funding?.isStock) || KNOWN_STOCK_BASES.has(base) || isTokenizedStock({ base, names: displayName ? [displayName] : undefined }),
      isLeveraged: isLeveragedToken({ base, names: displayName ? [displayName] : undefined }),
      displayName,
    };
    if (funding) {
      market.depositEnabled = funding.depositEnabled;
      market.withdrawEnabled = funding.withdrawEnabled;
      market.chainstatusRaw = funding.chainstatusRaw;
      market.contracts = funding.contracts;
    } else if (fundingLoaded) {
      market.depositEnabled = 0;
      market.withdrawEnabled = 0;
    }
    markets.push(market);
  }

  if (skippedQuote > 0) console.log(`[asterdex] lewati ${skippedQuote} pair bukan USDT`);
  if (skippedTest > 0) console.log(`[asterdex] lewati ${skippedTest} pair TEST (internal testing)`);

  const fetchedAt = new Date().toISOString();
  const tickers: DerivedTicker[] = markets.map((market) =>
    withDerivedFields(
      toNormalizedTicker(market, tickerMap.get(market.rawSymbol), bookMap.get(market.rawSymbol), fetchedAt),
    ),
  );
  return { tickers, markets, rawResponses };
}

async function fetchOrderBook(rawSymbol: string, count = 5): Promise<OrderBookFetchResult> {
  const symbol = rawSymbol.trim().toUpperCase();
  const limit = depthLimit(count);
  const result = await asterGet<AsterDepth>("/api/v3/depth", { symbol, limit });
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

export const asterdexAdapter: ExchangeAdapter = {
  id: EXCHANGE_ID,
  name: "AsterDEX",
  fetchTickers,
  fetchOrderBook,
  spotUrl: (base, quote) => getSpotUrl(EXCHANGE_ID, base, quote),
};
