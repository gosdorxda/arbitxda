import { withDerivedFields } from "../calc";
import { normalizeContracts } from "../contracts";
import { DEFAULT_TIMEOUT_MS, ExchangeApiError, fetchJson } from "../http";
import { createRateLimiter } from "../rate-limit";
import type {
  DerivedTicker,
  EnrichBidAskResult,
  EnrichDepositResult,
  EnrichPlan,
  ExchangeAdapter,
  MarketInfo,
  NormalizedTicker,
  OrderBookFetchResult,
  TickerFetchResult,
} from "../types";
import { getSpotUrl } from "./spot-urls";

const BASE_URL = "https://api.lbkex.com";
const EXCHANGE_ID = "lbank";
const schedule = createRateLimiter(300);

const ALLOWED_QUOTES = new Set(["USDT", "USD"]);

type LBankResponse<T> = {
  result?: string | boolean;
  msg?: string;
  error_code?: number;
  data?: T;
  ts?: number;
};

type LBankTickerInner = {
  high?: string | number;
  low?: string | number;
  vol?: string | number;
  turnover?: string | number;
  latest?: string | number;
  change?: string | number;
};

type LBankTickerRow = {
  symbol?: string;
  ticker?: LBankTickerInner;
  timestamp?: number;
};

type LBankDepth = {
  asks?: Array<[string, string] | string[]>;
  bids?: Array<[string, string] | string[]>;
  timestamp?: number;
};

type LBankWithdrawConfig = {
  assetCode?: string;
  chain?: string | null;
  canWithDraw?: boolean | number | string;
};

type LBankBookTicker = {
  symbol?: string;
  askPrice?: string | number;
  askQty?: string | number;
  bidPrice?: string | number;
  bidQty?: string | number;
};

type LBankAssetConfig = {
  assetCode?: string;
  chainName?: string | null;
  canDeposit?: boolean | number | string;
  canDraw?: boolean | number | string;
  contractInfo?: string | null;
};

type LbankGetOptions = {
  signal?: AbortSignal;
  throttle?: boolean;
  retries?: number;
  timeoutMs?: number;
};

type AssetFunding = {
  depositEnabled: number | null;
  withdrawEnabled: number;
  chainstatusRaw: string;
};

function toNumber(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).replace(/%/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function isFlagEnabled(value: boolean | number | string | undefined): boolean {
  return value === true || value === 1 || value === "1" || value === "true" || value === "True";
}

function isLbankOk(data: LBankResponse<unknown>): boolean {
  if (data.error_code != null && Number(data.error_code) !== 0) return false;
  if (data.result == null) return true;
  return data.result === true || data.result === "true" || data.result === "True";
}

function assertLbankOk(data: LBankResponse<unknown>, rawText: string, endpoint: string) {
  if (isLbankOk(data)) return;
  throw new ExchangeApiError(
    `LBank ${endpoint}: ${data.msg || (data.error_code != null ? `kode ${data.error_code}` : "gagal")}`,
    200,
    rawText.slice(0, 2000),
  );
}

function logStep(step: string, ms: number, rawText?: string) {
  if (rawText != null) {
    const kb = (Buffer.byteLength(rawText, "utf8") / 1024).toFixed(1);
    console.log(`[lbank] ${step} ${ms}ms (${kb} KB)`);
  } else {
    console.log(`[lbank] ${step} ${ms}ms`);
  }
}

function parseSymbol(symbol: string): { base: string; quote: string } | null {
  const raw = symbol.trim();
  const sep = raw.lastIndexOf("_");
  if (sep <= 0 || sep === raw.length - 1) return null;
  const base = raw.slice(0, sep).toUpperCase();
  const quote = raw.slice(sep + 1).toUpperCase();
  if (!base || !quote) return null;
  return { base, quote };
}

function formatChainName(chain: string): string {
  const trimmed = chain.trim();
  if (!trimmed || trimmed === "?") return "?";
  return trimmed.toUpperCase();
}

async function lbankGet<T>(
  endpoint: string,
  query?: Record<string, string | number>,
  options: LbankGetOptions = {},
): Promise<{ data: LBankResponse<T>; rawText: string; url: string }> {
  const url = new URL(`${BASE_URL}${endpoint}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }
  }
  const href = url.toString();
  const run = () =>
    fetchJson<LBankResponse<T>>(href, {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      retries: options.retries ?? 1,
      signal: options.signal,
    });
  const { data, rawText } = options.throttle === false ? await run() : await schedule(run);
  assertLbankOk(data, rawText, endpoint);
  return { data, rawText, url: href };
}

function summarizeNetworks(rows: LBankWithdrawConfig[]): AssetFunding {
  let withdrawEnabled = 0;
  const parts: string[] = [];
  const withChain = rows.filter((row) => (row.chain ?? "").trim());
  const source = withChain.length > 0 ? withChain : rows;
  for (const row of source) {
    const name = formatChainName((row.chain ?? "").trim() || "?");
    const withdraw = isFlagEnabled(row.canWithDraw);
    if (withdraw) withdrawEnabled = 1;
    parts.push(`${name}: W${withdraw ? "✓" : "✗"}`);
  }
  return {
    depositEnabled: null,
    withdrawEnabled,
    chainstatusRaw: parts.join(", "),
  };
}

function indexWithdrawFunding(rows: LBankWithdrawConfig[]): Map<string, AssetFunding> {
  const byAsset = new Map<string, LBankWithdrawConfig[]>();
  for (const row of rows) {
    const code = row.assetCode?.trim();
    if (!code) continue;
    const key = code.toUpperCase();
    const list = byAsset.get(key);
    if (list) list.push(row);
    else byAsset.set(key, [row]);
  }
  const index = new Map<string, AssetFunding>();
  for (const [asset, list] of byAsset) {
    index.set(asset, summarizeNetworks(list));
  }
  return index;
}

let loggedWithdrawFailure = false;

async function applyWithdrawFunding(markets: MarketInfo[]): Promise<{ endpoint: string; rawJson: string } | null> {
  try {
    const started = Date.now();
    const result = await lbankGet<LBankWithdrawConfig[]>("/v2/withdrawConfigs.do");
    logStep("WithdrawConfigs", Date.now() - started, result.rawText);
    const fundingByAsset = indexWithdrawFunding(result.data.data ?? []);
    let matched = 0;
    for (const market of markets) {
      const funding = fundingByAsset.get(market.base.toUpperCase());
      if (!funding) continue;
      market.depositEnabled = funding.depositEnabled;
      market.withdrawEnabled = funding.withdrawEnabled;
      market.chainstatusRaw = funding.chainstatusRaw;
      matched += 1;
    }
    console.log(`[lbank] status wd terisi untuk ${matched}/${markets.length} pair (deposito tidak tersedia di endpoint publik bulk)`);
    return { endpoint: result.url, rawJson: result.rawText };
  } catch (error) {
    if (!loggedWithdrawFailure) {
      loggedWithdrawFailure = true;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[lbank] Gagal mengambil status depo/wd, dibiarkan kosong: ${message}`);
    }
    return null;
  }
}

function toNormalizedTicker(
  market: MarketInfo,
  ticker: LBankTickerRow | undefined,
  fetchedAt: string,
): NormalizedTicker {
  const inner = ticker?.ticker;
  const ts = ticker?.timestamp;
  return {
    exchange: EXCHANGE_ID,
    rawSymbol: market.rawSymbol,
    base: market.base,
    quote: market.quote,
    last: toNumber(inner?.latest),
    bid: null,
    ask: null,
    bidSize: null,
    askSize: null,
    baseVolume24h: toNumber(inner?.vol),
    quoteVolume24h: toNumber(inner?.turnover),
    change24hPct: toNumber(inner?.change),
    exchangeTimestamp: ts != null && Number.isFinite(Number(ts)) ? new Date(Number(ts)).toISOString() : null,
    fetchedAt,
  };
}

async function fetchTickers(): Promise<TickerFetchResult> {
  const pairsStarted = Date.now();
  const pairsRes = await lbankGet<string[]>("/v2/currencyPairs.do");
  logStep("CurrencyPairs", Date.now() - pairsStarted, pairsRes.rawText);
  const rawResponses = [{ endpoint: pairsRes.url, rawJson: pairsRes.rawText }];

  const tickerStarted = Date.now();
  const tickerRes = await lbankGet<LBankTickerRow[]>("/v2/ticker/24hr.do", { symbol: "all" });
  logStep("Ticker24h", Date.now() - tickerStarted, tickerRes.rawText);
  rawResponses.push({ endpoint: tickerRes.url, rawJson: tickerRes.rawText });

  const allowedPairs = new Set(
    (pairsRes.data.data ?? []).filter((symbol) => {
      const parsed = parseSymbol(symbol);
      return parsed != null && ALLOWED_QUOTES.has(parsed.quote);
    }),
  );

  const tickerMap = new Map<string, LBankTickerRow>();
  for (const row of tickerRes.data.data ?? []) {
    if (!row.symbol) continue;
    tickerMap.set(row.symbol, row);
  }

  const marketSymbols = new Set<string>();
  for (const symbol of allowedPairs) {
    if (tickerMap.has(symbol)) marketSymbols.add(symbol);
  }
  for (const symbol of tickerMap.keys()) {
    const parsed = parseSymbol(symbol);
    if (parsed && ALLOWED_QUOTES.has(parsed.quote)) marketSymbols.add(symbol);
  }

  const skippedNoTicker = [...allowedPairs].filter((symbol) => !tickerMap.has(symbol)).length;
  if (skippedNoTicker > 0) {
    console.log(`[lbank] lewati ${skippedNoTicker} pair tanpa ticker 24jam (dianggap tidak trading)`);
  }

  const markets: MarketInfo[] = [];
  for (const symbol of marketSymbols) {
    const parsed = parseSymbol(symbol);
    if (!parsed) continue;
    markets.push({
      rawSymbol: symbol,
      base: parsed.base,
      quote: parsed.quote,
      active: true,
      status: "online",
    });
  }
  markets.sort((a, b) => a.rawSymbol.localeCompare(b.rawSymbol));

  const fetchedAt = new Date().toISOString();
  const tickers = markets.map((market) =>
    withDerivedFields(toNormalizedTicker(market, tickerMap.get(market.rawSymbol), fetchedAt)),
  );

  const withdrawRaw = await applyWithdrawFunding(markets);
  if (withdrawRaw) rawResponses.push(withdrawRaw);

  return { tickers, markets, rawResponses };
}

async function fetchOrderBook(rawSymbol: string, count = 5): Promise<OrderBookFetchResult> {
  const started = Date.now();
  const result = await lbankGet<LBankDepth>("/v2/depth.do", {
    symbol: rawSymbol,
    size: count,
  });
  logStep(`Depth ${rawSymbol}`, Date.now() - started, result.rawText);
  const book = result.data.data;
  if (!book) {
    throw new ExchangeApiError(
      `LBank Depth: orderbook untuk ${rawSymbol} tidak ditemukan`,
      200,
      result.rawText.slice(0, 2000),
    );
  }

  const toLevels = (rows: Array<[string, string] | string[]> | undefined) =>
    (rows ?? []).slice(0, count).map((row) => ({
      price: Number(row[0]),
      volume: Number(row[1]),
      timestamp: null,
    }));

  return {
    endpoint: result.url,
    rawJson: result.rawText,
    orderbook: {
      exchange: EXCHANGE_ID,
      rawSymbol,
      bids: toLevels(book.bids),
      asks: toLevels(book.asks),
      fetchedAt: new Date().toISOString(),
    },
  };
}

function buildEnrichPlan(input: { tickers: DerivedTicker[]; markets: MarketInfo[] }): EnrichPlan {
  const bidAsk = input.tickers.map((ticker) => ({
    rawSymbol: ticker.rawSymbol,
    quoteVolume24h: ticker.quoteVolume24h,
  }));
  const volumeByBase = new Map<string, number>();
  for (const ticker of input.tickers) {
    const key = ticker.base.toUpperCase();
    volumeByBase.set(key, Math.max(volumeByBase.get(key) ?? 0, ticker.quoteVolume24h ?? 0));
  }
  const deposits = [...volumeByBase.entries()].map(([base, quoteVolume24h]) => ({
    base,
    quoteVolume24h,
  }));
  return { bidAsk, deposits };
}

async function enrichBidAsk(rawSymbol: string, signal: AbortSignal): Promise<EnrichBidAskResult> {
  const result = await lbankGet<LBankBookTicker>(
    "/v2/supplement/ticker/bookTicker.do",
    { symbol: rawSymbol },
    { signal, throttle: false, retries: 0 },
  );
  const row = result.data.data;
  if (!row) {
    throw new ExchangeApiError(
      `LBank bookTicker: data untuk ${rawSymbol} kosong`,
      200,
      result.rawText.slice(0, 2000),
    );
  }
  return {
    rawSymbol,
    bid: toNumber(row.bidPrice),
    ask: toNumber(row.askPrice),
    bidSize: toNumber(row.bidQty),
    askSize: toNumber(row.askQty),
  };
}

async function enrichDeposit(base: string, signal: AbortSignal): Promise<EnrichDepositResult> {
  const result = await lbankGet<LBankAssetConfig[]>(
    "/v2/assetConfigs.do",
    { assetCode: base.toLowerCase() },
    { signal, throttle: false, retries: 0 },
  );
  const rows = result.data.data ?? [];
  const withChain = rows.filter((row) => (row.chainName ?? "").trim());
  const source = withChain.length > 0 ? withChain : rows;
  let depositEnabled: number | null = source.length > 0 ? 0 : null;
  const networks = source.map((row) => {
    const deposit = isFlagEnabled(row.canDeposit);
    const withdraw = row.canDraw == null ? null : isFlagEnabled(row.canDraw);
    if (deposit) depositEnabled = 1;
    return {
      name: formatChainName((row.chainName ?? "").trim() || "?"),
      deposit,
      withdraw,
    };
  });
  const contracts = source.length > 0
    ? normalizeContracts(
        source.map((row) => ({
          chain: formatChainName((row.chainName ?? "").trim() || "?"),
          contract: row.contractInfo,
        })),
      )
    : undefined;
  return { base, depositEnabled, networks, contracts };
}

export const lbankAdapter: ExchangeAdapter = {
  id: EXCHANGE_ID,
  name: "LBank",
  fetchTickers,
  fetchOrderBook,
  spotUrl: (base, quote) => getSpotUrl(EXCHANGE_ID, base, quote),
  enrichConcurrency: 3,
  buildEnrichPlan,
  enrichBidAsk,
  enrichDeposit,
};
