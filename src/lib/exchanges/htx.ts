import { withDerivedFields } from "../calc";
import { normalizeContracts } from "../contracts";
import { DEFAULT_TIMEOUT_MS, ExchangeApiError, fetchJson } from "../http";
import { createRateLimiter } from "../rate-limit";
import type {
  ExchangeAdapter,
  MarketInfo,
  TokenContract,
  NormalizedTicker,
  OrderBookFetchResult,
  TickerFetchResult,
} from "../types";
import { getSpotUrl } from "./spot-urls";

const BASE_URL = "https://api.huobi.pro";
const EXCHANGE_ID = "htx";
const schedule = createRateLimiter(300);
const ALLOWED_QUOTES = new Set(["USDT", "USD"]);
const LEV_LS_RE = /^[A-Z0-9]*\d[LS]$/i;

type HtxSymbol = {
  sc?: string;
  bc?: string;
  qc?: string;
  bcdn?: string;
  qcdn?: string;
  state?: string;
  tags?: string;
  cfn?: string | null;
  dn?: string;
  te?: boolean;
};

type HtxTicker = {
  symbol?: string;
  open?: string | number;
  close?: string | number;
  bid?: string | number;
  bidSize?: string | number;
  ask?: string | number;
  askSize?: string | number;
  amount?: string | number;
  vol?: string | number;
};

type HtxDepth = {
  status?: string;
  ts?: number;
  tick?: {
    ts?: number;
    asks?: Array<[number, number] | number[]>;
    bids?: Array<[number, number] | number[]>;
  };
};

type HtxChain = {
  chain?: string;
  displayName?: string;
  contractAddress?: string | null;
  depositStatus?: string;
  withdrawStatus?: string;
};

type HtxCurrency = {
  currency?: string;
  instStatus?: string;
  chains?: HtxChain[];
};

type AssetFunding = {
  depositEnabled: number;
  withdrawEnabled: number;
  chainstatusRaw: string;
  contracts: TokenContract[];
};

function toNumber(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

function parseTags(raw: string | null | undefined): Set<string> {
  return new Set(
    String(raw ?? "")
      .split(",")
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean),
  );
}

function isHtxStock(tags: Set<string>): boolean {
  return tags.has("stock");
}

function isHtxLeveraged(base: string, tags: Set<string>): boolean {
  return tags.has("etp") || LEV_LS_RE.test(base);
}

function assertHtxOk(data: unknown, rawText: string, endpoint: string) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  const body = data as { status?: string; code?: number | string; "err-msg"?: string; message?: string };
  if (body.status && body.status !== "ok") {
    throw new ExchangeApiError(
      `HTX ${endpoint}: ${body["err-msg"] || body.message || body.status}`,
      200,
      rawText.slice(0, 2000),
    );
  }
  if (body.code != null && String(body.code) !== "200" && String(body.code) !== "0") {
    throw new ExchangeApiError(
      `HTX ${endpoint}: ${body.message || body["err-msg"] || `kode ${body.code}`}`,
      200,
      rawText.slice(0, 2000),
    );
  }
}

function logStep(step: string, ms: number, rawText?: string) {
  if (rawText != null) {
    const kb = (Buffer.byteLength(rawText, "utf8") / 1024).toFixed(1);
    console.log(`[htx] ${step} ${ms}ms (${kb} KB)`);
  } else {
    console.log(`[htx] ${step} ${ms}ms`);
  }
}

async function htxGet<T>(
  endpoint: string,
  query?: Record<string, string | number>,
): Promise<{ data: T; rawText: string; url: string }> {
  const url = new URL(`${BASE_URL}${endpoint}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  }
  const href = url.toString();
  const { data, rawText } = await schedule(() =>
    fetchJson<T>(href, { timeoutMs: DEFAULT_TIMEOUT_MS, retries: 1 }),
  );
  assertHtxOk(data, rawText, endpoint);
  return { data, rawText, url: href };
}

function isAllowed(status: string | undefined): boolean {
  return String(status ?? "").trim().toLowerCase() === "allowed";
}

function summarizeChains(currency: HtxCurrency): AssetFunding {
  const chains = currency.chains ?? [];
  let depositEnabled = 0;
  let withdrawEnabled = 0;
  const parts: string[] = [];
  for (const chain of chains) {
    const name = (chain.displayName || chain.chain || "?").trim() || "?";
    const deposit = isAllowed(chain.depositStatus);
    const withdraw = isAllowed(chain.withdrawStatus);
    if (deposit) depositEnabled = 1;
    if (withdraw) withdrawEnabled = 1;
    parts.push(`${name}: D${deposit ? "✓" : "✗"} W${withdraw ? "✓" : "✗"}`);
  }
  return {
    depositEnabled,
    withdrawEnabled,
    chainstatusRaw: parts.join(", "),
    contracts: normalizeContracts(
      chains.map((chain) => ({
        chain: (chain.displayName || chain.chain || "?").trim() || "?",
        contract: chain.contractAddress,
      })),
    ),
  };
}

let loggedCurrencyFailure = false;

async function applyPublicCurrencyFunding(
  markets: MarketInfo[],
): Promise<{ endpoint: string; rawJson: string } | null> {
  try {
    const started = Date.now();
    const result = await htxGet<{ code?: number; data?: HtxCurrency[] }>("/v2/reference/currencies");
    logStep("Currencies", Date.now() - started, result.rawText);
    const fundingByAsset = new Map<string, AssetFunding>();
    for (const currency of result.data.data ?? []) {
      const key = (currency.currency ?? "").trim().toUpperCase();
      if (key) fundingByAsset.set(key, summarizeChains(currency));
    }
    let matched = 0;
    for (const market of markets) {
      const funding = fundingByAsset.get(market.base.toUpperCase());
      if (!funding) continue;
      market.depositEnabled = funding.depositEnabled;
      market.withdrawEnabled = funding.withdrawEnabled;
      market.chainstatusRaw = funding.chainstatusRaw;
      market.contracts = funding.contracts;
      matched += 1;
    }
    console.log(`[htx] status depo/wd terisi untuk ${matched}/${markets.length} pair`);
    return { endpoint: result.url, rawJson: result.rawText };
  } catch (error) {
    if (!loggedCurrencyFailure) {
      loggedCurrencyFailure = true;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[htx] Gagal mengambil status depo/wd, dibiarkan kosong: ${message}`);
    }
    return null;
  }
}

function resolveMarket(item: HtxSymbol): MarketInfo | null {
  const rawSymbol = (item.sc ?? "").trim();
  const base = (item.bc ?? "").trim().toUpperCase();
  const quote = (item.qcdn ?? item.qc ?? "").trim().toUpperCase();
  if (!rawSymbol || !base || !quote) return null;
  if (!ALLOWED_QUOTES.has(quote)) return null;
  const status = (item.state ?? "").trim() || "unknown";
  if (status.toLowerCase() !== "online") return null;
  const tags = parseTags(item.tags);
  const displayName = (item.cfn ?? item.dn ?? item.bcdn ?? "").trim() || null;
  return {
    rawSymbol,
    base,
    quote,
    active: true,
    status,
    isStock: isHtxStock(tags),
    isLeveraged: isHtxLeveraged(base, tags),
    displayName,
  };
}

function toNormalizedTicker(
  market: MarketInfo,
  ticker: HtxTicker | undefined,
  fetchedAt: string,
  batchTs: number | null,
): NormalizedTicker {
  const open = toNumber(ticker?.open);
  const last = toNumber(ticker?.close);
  const change =
    open != null && last != null && open !== 0 ? ((last - open) / open) * 100 : null;
  return {
    exchange: EXCHANGE_ID,
    rawSymbol: market.rawSymbol,
    base: market.base,
    quote: market.quote,
    last,
    bid: toNumber(ticker?.bid),
    ask: toNumber(ticker?.ask),
    bidSize: toNumber(ticker?.bidSize),
    askSize: toNumber(ticker?.askSize),
    baseVolume24h: toNumber(ticker?.amount),
    quoteVolume24h: toNumber(ticker?.vol),
    change24hPct: change,
    exchangeTimestamp: batchTs != null ? new Date(batchTs).toISOString() : null,
    fetchedAt,
  };
}

async function fetchTickers(): Promise<TickerFetchResult> {
  const symbolsStarted = Date.now();
  const symbolsRes = await htxGet<{ status?: string; data?: HtxSymbol[] }>("/v2/settings/common/symbols");
  logStep("Symbols", Date.now() - symbolsStarted, symbolsRes.rawText);
  const rawResponses = [{ endpoint: symbolsRes.url, rawJson: symbolsRes.rawText }];
  const allSymbols = Array.isArray(symbolsRes.data.data) ? symbolsRes.data.data : [];
  const usdCount = allSymbols.filter((item) =>
    ALLOWED_QUOTES.has((item.qcdn ?? item.qc ?? "").trim().toUpperCase()),
  ).length;
  const markets = allSymbols
    .map((item) => resolveMarket(item))
    .filter((market): market is MarketInfo => market != null);
  const skipped = usdCount - markets.length;
  if (skipped > 0) {
    console.log(`[htx] lewati ${skipped} pair USDT/USD yang bukan status online`);
  }

  const tickerStarted = Date.now();
  const tickerRes = await htxGet<{ status?: string; ts?: number; data?: HtxTicker[] }>("/market/tickers");
  logStep("Tickers", Date.now() - tickerStarted, tickerRes.rawText);
  rawResponses.push({ endpoint: tickerRes.url, rawJson: tickerRes.rawText });
  const tickerMap = new Map(
    (tickerRes.data.data ?? [])
      .filter((row) => row.symbol)
      .map((row) => [String(row.symbol).toLowerCase(), row]),
  );
  const batchTs = toNumber(tickerRes.data.ts);

  const fetchedAt = new Date().toISOString();
  const tickers = markets.map((market) =>
    withDerivedFields(
      toNormalizedTicker(market, tickerMap.get(market.rawSymbol.toLowerCase()), fetchedAt, batchTs),
    ),
  );

  const currencyRaw = await applyPublicCurrencyFunding(markets);
  if (currencyRaw) rawResponses.push(currencyRaw);
  return { tickers, markets, rawResponses };
}

async function fetchOrderBook(rawSymbol: string, count = 5): Promise<OrderBookFetchResult> {
  const started = Date.now();
  const result = await htxGet<HtxDepth>("/market/depth", {
    symbol: rawSymbol.toLowerCase(),
    type: "step0",
    depth: count,
  });
  logStep("Orderbook", Date.now() - started, result.rawText);
  const tick = result.data.tick ?? {};
  const ts = toNumber(tick.ts) ?? toNumber(result.data.ts);
  const toLevels = (rows: Array<[number, number] | number[]> | undefined) =>
    (rows ?? []).slice(0, count).map((row) => ({
      price: Number(row[0]),
      volume: Number(row[1]),
      timestamp: ts,
    }));
  return {
    endpoint: result.url,
    rawJson: result.rawText,
    orderbook: {
      exchange: EXCHANGE_ID,
      rawSymbol,
      bids: toLevels(tick.bids),
      asks: toLevels(tick.asks),
      fetchedAt: new Date().toISOString(),
    },
  };
}

export const htxAdapter: ExchangeAdapter = {
  id: EXCHANGE_ID,
  name: "HTX",
  fetchTickers,
  fetchOrderBook,
  spotUrl: (base, quote) => getSpotUrl(EXCHANGE_ID, base, quote),
};
