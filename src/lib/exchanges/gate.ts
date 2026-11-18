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

const BASE_URL = "https://api.gateio.ws/api/v4";
const EXCHANGE_ID = "gate";
const schedule = createRateLimiter(300);

const ALLOWED_QUOTES = new Set(["USDT", "USD"]);

/** Nama resmi Gate untuk xStock / Ondo tokenized (tidak ada field isStock khusus). */
const STOCK_NAME_RE =
  /\b(x[\s-]?stocks?|tokenized stock|tokenised stock|tokenized equity|tokenised equity|tokenized etf|tokenised etf|ondo tokenized|stock token)\b/i;

type GateErrorBody = {
  label?: string;
  message?: string;
};

type GatePair = {
  id?: string;
  base?: string;
  quote?: string;
  base_name?: string;
  trade_status?: string;
};

type GateTicker = {
  currency_pair?: string;
  last?: string | number;
  lowest_ask?: string | number;
  lowest_size?: string | number;
  highest_bid?: string | number;
  highest_size?: string | number;
  change_percentage?: string | number;
  base_volume?: string | number;
  quote_volume?: string | number;
};

type GateOrderBook = {
  asks?: Array<[string, string] | string[]>;
  bids?: Array<[string, string] | string[]>;
  current?: number | string;
  update?: number | string;
};

type GateChain = {
  name?: string;
  addr?: string | null;
  deposit_disabled?: boolean | number | string;
  withdraw_disabled?: boolean | number | string;
};

type GateCurrency = {
  currency?: string;
  name?: string;
  deposit_disabled?: boolean | number | string;
  withdraw_disabled?: boolean | number | string;
  chains?: GateChain[];
};

type AssetFunding = {
  depositEnabled: number;
  withdrawEnabled: number;
  chainstatusRaw: string;
  contracts: TokenContract[];
  name: string | null;
};

function toNumber(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

/** Flag disabled: true / "true" / 1 artinya dinonaktifkan. */
function isDisabled(value: boolean | number | string | undefined): boolean {
  if (value == null || value === false || value === 0 || value === "") return false;
  if (value === true || value === 1 || value === "1") return true;
  return String(value).trim().toLowerCase() === "true";
}

function isGateStockName(...names: Array<string | null | undefined>): boolean {
  const blob = names.filter(Boolean).join(" ");
  return blob.length > 0 && STOCK_NAME_RE.test(blob);
}

/** Nama resmi Gate "BTC3xLong" / "ETH3xShort", atau base 3L/3S/5L. type pair selalu "normal". */
function isGateLeveraged(base: string, ...names: Array<string | null | undefined>): boolean {
  const blob = names.filter(Boolean).join(" ");
  if (blob && /(\d+\s*x\s*(long|short)|leveraged token|leverage token)\b/i.test(blob)) return true;
  return /^[A-Z0-9]*\d[LS]$/i.test(base.trim());
}

function toIsoTimestamp(value: string | number | null | undefined): string | null {
  const n = toNumber(value);
  if (n == null || n <= 0) return null;
  let ms = n;
  if (ms > 1e14) ms = Math.round(ms / 1000);
  else if (ms < 1e12) ms *= 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function assertGateOk(data: unknown, rawText: string, endpoint: string) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  const body = data as GateErrorBody;
  if (body.label) {
    throw new ExchangeApiError(
      `Gate ${endpoint}: ${body.message || body.label}`,
      200,
      rawText.slice(0, 2000),
    );
  }
}

function logStep(step: string, ms: number, rawText?: string) {
  if (rawText != null) {
    const kb = (Buffer.byteLength(rawText, "utf8") / 1024).toFixed(1);
    console.log(`[gate] ${step} ${ms}ms (${kb} KB)`);
  } else {
    console.log(`[gate] ${step} ${ms}ms`);
  }
}

async function gateGet<T>(
  endpoint: string,
  query?: Record<string, string | number>,
): Promise<{ data: T; rawText: string; url: string }> {
  const url = new URL(`${BASE_URL}${endpoint}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }
  }
  const href = url.toString();
  const { data, rawText } = await schedule(() =>
    fetchJson<T>(href, { timeoutMs: DEFAULT_TIMEOUT_MS, retries: 1 }),
  );
  assertGateOk(data, rawText, endpoint);
  return { data, rawText, url: href };
}

function summarizeChains(currency: GateCurrency): AssetFunding {
  const chains = currency.chains ?? [];
  const sources = chains.length > 0 ? chains : [
    {
      name: "default",
      addr: null,
      deposit_disabled: currency.deposit_disabled,
      withdraw_disabled: currency.withdraw_disabled,
    },
  ];
  let depositEnabled = 0;
  let withdrawEnabled = 0;
  const parts: string[] = [];
  for (const chain of sources) {
    const name = (chain.name || "?").trim() || "?";
    const deposit = !isDisabled(chain.deposit_disabled);
    const withdraw = !isDisabled(chain.withdraw_disabled);
    if (deposit) depositEnabled = 1;
    if (withdraw) withdrawEnabled = 1;
    parts.push(`${name}: D${deposit ? "✓" : "✗"} W${withdraw ? "✓" : "✗"}`);
  }
  return {
    depositEnabled,
    withdrawEnabled,
    chainstatusRaw: parts.join(", "),
    contracts: normalizeContracts(
      (currency.chains ?? []).map((chain) => ({
        chain: (chain.name || "?").trim() || "?",
        contract: chain.addr,
      })),
    ),
    name: (currency.name ?? "").trim() || null,
  };
}

function indexCurrencyFunding(currencies: GateCurrency[]): Map<string, AssetFunding> {
  const index = new Map<string, AssetFunding>();
  for (const currency of currencies) {
    const key = (currency.currency ?? "").trim().toUpperCase();
    if (!key) continue;
    index.set(key, summarizeChains(currency));
  }
  return index;
}

let loggedCurrencyFailure = false;

async function applyPublicCurrencyFunding(
  markets: MarketInfo[],
): Promise<{ endpoint: string; rawJson: string } | null> {
  try {
    const started = Date.now();
    const result = await gateGet<GateCurrency[]>("/spot/currencies");
    logStep("Currencies", Date.now() - started, result.rawText);
    const fundingByAsset = indexCurrencyFunding(Array.isArray(result.data) ? result.data : []);
    let matched = 0;
    for (const market of markets) {
      const funding = fundingByAsset.get(market.base.toUpperCase());
      if (!funding) continue;
      market.depositEnabled = funding.depositEnabled;
      market.withdrawEnabled = funding.withdrawEnabled;
      market.chainstatusRaw = funding.chainstatusRaw;
      market.contracts = funding.contracts;
      if (funding.name) {
        if (!market.displayName) market.displayName = funding.name;
        if (!market.isStock && isGateStockName(market.displayName, funding.name)) {
          market.isStock = true;
        }
        if (!market.isLeveraged && isGateLeveraged(market.base, market.displayName, funding.name)) {
          market.isLeveraged = true;
        }
      }
      matched += 1;
    }
    console.log(`[gate] status depo/wd terisi untuk ${matched}/${markets.length} pair`);
    return { endpoint: result.url, rawJson: result.rawText };
  } catch (error) {
    if (!loggedCurrencyFailure) {
      loggedCurrencyFailure = true;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[gate] Gagal mengambil status depo/wd, dibiarkan kosong: ${message}`);
    }
    return null;
  }
}

function resolveMarket(pair: GatePair): MarketInfo | null {
  const rawSymbol = (pair.id ?? "").trim();
  const base = (pair.base ?? "").trim();
  const quote = (pair.quote ?? "").trim().toUpperCase();
  if (!rawSymbol || !base || !quote) return null;
  if (!ALLOWED_QUOTES.has(quote)) return null;
  const status = (pair.trade_status ?? "").trim() || "unknown";
  if (status.toLowerCase() !== "tradable") return null;
  const displayName = (pair.base_name ?? "").trim() || null;
  return {
    rawSymbol,
    base,
    quote,
    active: true,
    status,
    isStock: isGateStockName(displayName),
    isLeveraged: isGateLeveraged(base, displayName),
    displayName,
  };
}

function toNormalizedTicker(
  market: MarketInfo,
  ticker: GateTicker | undefined,
  fetchedAt: string,
): NormalizedTicker {
  return {
    exchange: EXCHANGE_ID,
    rawSymbol: market.rawSymbol,
    base: market.base,
    quote: market.quote,
    last: toNumber(ticker?.last),
    bid: toNumber(ticker?.highest_bid),
    ask: toNumber(ticker?.lowest_ask),
    bidSize: toNumber(ticker?.highest_size),
    askSize: toNumber(ticker?.lowest_size),
    baseVolume24h: toNumber(ticker?.base_volume),
    quoteVolume24h: toNumber(ticker?.quote_volume),
    change24hPct: toNumber(ticker?.change_percentage),
    exchangeTimestamp: null,
    fetchedAt,
  };
}

async function fetchTickers(): Promise<TickerFetchResult> {
  const pairsStarted = Date.now();
  const pairsRes = await gateGet<GatePair[]>("/spot/currency_pairs");
  logStep("Currency pairs", Date.now() - pairsStarted, pairsRes.rawText);
  const rawResponses = [{ endpoint: pairsRes.url, rawJson: pairsRes.rawText }];
  const allPairs = Array.isArray(pairsRes.data) ? pairsRes.data : [];

  const usdCount = allPairs.filter((item) => ALLOWED_QUOTES.has((item.quote ?? "").trim().toUpperCase())).length;
  const markets = allPairs
    .map((item) => resolveMarket(item))
    .filter((market): market is MarketInfo => market != null);
  const skipped = usdCount - markets.length;
  if (skipped > 0) {
    console.log(`[gate] lewati ${skipped} pair USDT/USD yang bukan status tradable`);
  }

  const tickerStarted = Date.now();
  const tickerRes = await gateGet<GateTicker[]>("/spot/tickers");
  logStep("Tickers", Date.now() - tickerStarted, tickerRes.rawText);
  rawResponses.push({ endpoint: tickerRes.url, rawJson: tickerRes.rawText });
  const tickerMap = new Map(
    (Array.isArray(tickerRes.data) ? tickerRes.data : [])
      .filter((row) => row.currency_pair)
      .map((row) => [row.currency_pair as string, row]),
  );

  const fetchedAt = new Date().toISOString();
  const tickers = markets.map((market) =>
    withDerivedFields(toNormalizedTicker(market, tickerMap.get(market.rawSymbol), fetchedAt)),
  );

  const currencyRaw = await applyPublicCurrencyFunding(markets);
  if (currencyRaw) rawResponses.push(currencyRaw);

  return { tickers, markets, rawResponses };
}

async function fetchOrderBook(rawSymbol: string, count = 5): Promise<OrderBookFetchResult> {
  const started = Date.now();
  const result = await gateGet<GateOrderBook>("/spot/order_book", {
    currency_pair: rawSymbol,
    limit: count,
  });
  logStep("Orderbook", Date.now() - started, result.rawText);
  const book = result.data ?? {};
  const ts = toNumber(book.current) ?? toNumber(book.update);

  const toLevels = (rows: Array<[string, string] | string[]> | undefined) =>
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
      bids: toLevels(book.bids),
      asks: toLevels(book.asks),
      fetchedAt: new Date().toISOString(),
    },
  };
}

export const gateAdapter: ExchangeAdapter = {
  id: EXCHANGE_ID,
  name: "Gate",
  fetchTickers,
  fetchOrderBook,
  spotUrl: (base, quote) => getSpotUrl(EXCHANGE_ID, base, quote),
};
