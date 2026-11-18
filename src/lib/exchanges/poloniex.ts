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

const BASE_URL = "https://api.poloniex.com";
const EXCHANGE_ID = "poloniex";
const schedule = createRateLimiter(300);
const ALLOWED_QUOTES = new Set(["USDT", "USD"]);

const STOCK_NAME_RE =
  /\b(x[\s-]?stocks?|tokenized stock|tokenised stock|tokenized equity|tokenised equity|tokenized etf|tokenised etf|ondo tokenized|stock token)\b/i;
const LEV_NAME_RE = /(\d+\s*x\s*(long|short)|leveraged token|leverage token)\b/i;
const LEV_LS_RE = /^[A-Z0-9]*\d[LS]$/i;

type PoloMarket = {
  symbol?: string;
  baseCurrencyName?: string;
  quoteCurrencyName?: string;
  displayName?: string;
  state?: string;
};

type PoloTicker = {
  symbol?: string;
  close?: string | number;
  bid?: string | number;
  bidQuantity?: string | number;
  ask?: string | number;
  askQuantity?: string | number;
  quantity?: string | number;
  amount?: string | number;
  dailyChange?: string | number;
  ts?: string | number;
};

type PoloOrderBook = {
  asks?: Array<string | number> | Array<[string, string] | string[]>;
  bids?: Array<string | number> | Array<[string, string] | string[]>;
  time?: number;
  ts?: number;
};

type PoloNetwork = {
  name?: string;
  blockchain?: string;
  withdrawalEnable?: boolean;
  depositEnable?: boolean;
  contractAddress?: string | null;
};

type PoloCurrency = {
  coin?: string;
  name?: string;
  delisted?: boolean;
  networkList?: PoloNetwork[];
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

function isNameStock(...names: Array<string | null | undefined>): boolean {
  const blob = names.filter(Boolean).join(" ");
  return blob.length > 0 && STOCK_NAME_RE.test(blob);
}

function isLeveraged(base: string, ...names: Array<string | null | undefined>): boolean {
  const blob = names.filter(Boolean).join(" ");
  if (blob && LEV_NAME_RE.test(blob)) return true;
  return LEV_LS_RE.test(base.trim());
}

function assertPoloOk(data: unknown, rawText: string, endpoint: string) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  const body = data as { code?: string | number; message?: string; msg?: string };
  if (body.code != null && String(body.code) !== "0" && String(body.code) !== "200") {
    throw new ExchangeApiError(
      `Poloniex ${endpoint}: ${body.message || body.msg || `kode ${body.code}`}`,
      200,
      rawText.slice(0, 2000),
    );
  }
}

function logStep(step: string, ms: number, rawText?: string) {
  if (rawText != null) {
    const kb = (Buffer.byteLength(rawText, "utf8") / 1024).toFixed(1);
    console.log(`[poloniex] ${step} ${ms}ms (${kb} KB)`);
  } else {
    console.log(`[poloniex] ${step} ${ms}ms`);
  }
}

async function poloGet<T>(
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
  assertPoloOk(data, rawText, endpoint);
  return { data, rawText, url: href };
}

function summarizeNetworks(currency: PoloCurrency): AssetFunding {
  const networks = currency.networkList ?? [];
  let depositEnabled = 0;
  let withdrawEnabled = 0;
  const parts: string[] = [];
  for (const network of networks) {
    const name = (network.blockchain || network.name || "?").trim() || "?";
    const deposit = Boolean(network.depositEnable);
    const withdraw = Boolean(network.withdrawalEnable);
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
        chain: (network.blockchain || network.name || "?").trim() || "?",
        contract: network.contractAddress,
      })),
    ),
    name: (currency.name ?? "").trim() || null,
  };
}

let loggedCurrencyFailure = false;

async function applyPublicCurrencyFunding(
  markets: MarketInfo[],
): Promise<{ endpoint: string; rawJson: string } | null> {
  try {
    const started = Date.now();
    const result = await poloGet<PoloCurrency[]>("/v2/currencies");
    logStep("Currencies", Date.now() - started, result.rawText);
    const fundingByAsset = new Map<string, AssetFunding>();
    for (const currency of Array.isArray(result.data) ? result.data : []) {
      const key = (currency.coin ?? "").trim().toUpperCase();
      if (key) fundingByAsset.set(key, summarizeNetworks(currency));
    }
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
        if (!market.isStock && isNameStock(market.displayName, funding.name)) market.isStock = true;
        if (!market.isLeveraged && isLeveraged(market.base, market.displayName, funding.name)) {
          market.isLeveraged = true;
        }
      }
      matched += 1;
    }
    console.log(`[poloniex] status depo/wd terisi untuk ${matched}/${markets.length} pair`);
    return { endpoint: result.url, rawJson: result.rawText };
  } catch (error) {
    if (!loggedCurrencyFailure) {
      loggedCurrencyFailure = true;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[poloniex] Gagal mengambil status depo/wd, dibiarkan kosong: ${message}`);
    }
    return null;
  }
}

function resolveMarket(item: PoloMarket): MarketInfo | null {
  const rawSymbol = (item.symbol ?? "").trim();
  const base = (item.baseCurrencyName ?? "").trim().toUpperCase();
  const quote = (item.quoteCurrencyName ?? "").trim().toUpperCase();
  if (!rawSymbol || !base || !quote) return null;
  if (!ALLOWED_QUOTES.has(quote)) return null;
  const status = (item.state ?? "").trim() || "unknown";
  if (status.toUpperCase() !== "NORMAL") return null;
  const displayName = (item.displayName ?? "").trim() || null;
  return {
    rawSymbol,
    base,
    quote,
    active: true,
    status,
    isStock: isNameStock(displayName),
    isLeveraged: isLeveraged(base, displayName),
    displayName,
  };
}

function toNormalizedTicker(
  market: MarketInfo,
  ticker: PoloTicker | undefined,
  fetchedAt: string,
): NormalizedTicker {
  const change = toNumber(ticker?.dailyChange);
  const ts = toNumber(ticker?.ts);
  return {
    exchange: EXCHANGE_ID,
    rawSymbol: market.rawSymbol,
    base: market.base,
    quote: market.quote,
    last: toNumber(ticker?.close),
    bid: toNumber(ticker?.bid),
    ask: toNumber(ticker?.ask),
    bidSize: toNumber(ticker?.bidQuantity),
    askSize: toNumber(ticker?.askQuantity),
    baseVolume24h: toNumber(ticker?.quantity),
    quoteVolume24h: toNumber(ticker?.amount),
    // dailyChange API adalah rasio (contoh -0.0015 = -0.15%).
    change24hPct: change != null ? change * 100 : null,
    exchangeTimestamp: ts != null ? new Date(ts).toISOString() : null,
    fetchedAt,
  };
}

async function fetchTickers(): Promise<TickerFetchResult> {
  const marketsStarted = Date.now();
  const marketsRes = await poloGet<PoloMarket[]>("/markets");
  logStep("Markets", Date.now() - marketsStarted, marketsRes.rawText);
  const rawResponses = [{ endpoint: marketsRes.url, rawJson: marketsRes.rawText }];
  const allMarkets = Array.isArray(marketsRes.data) ? marketsRes.data : [];
  const usdCount = allMarkets.filter((item) =>
    ALLOWED_QUOTES.has((item.quoteCurrencyName ?? "").trim().toUpperCase()),
  ).length;
  const markets = allMarkets
    .map((item) => resolveMarket(item))
    .filter((market): market is MarketInfo => market != null);
  const skipped = usdCount - markets.length;
  if (skipped > 0) {
    console.log(`[poloniex] lewati ${skipped} pair USDT/USD yang bukan status NORMAL`);
  }

  const tickerStarted = Date.now();
  const tickerRes = await poloGet<PoloTicker[]>("/markets/ticker24h");
  logStep("Tickers", Date.now() - tickerStarted, tickerRes.rawText);
  rawResponses.push({ endpoint: tickerRes.url, rawJson: tickerRes.rawText });
  const tickerMap = new Map(
    (Array.isArray(tickerRes.data) ? tickerRes.data : [])
      .filter((row) => row.symbol)
      .map((row) => [row.symbol as string, row]),
  );

  const fetchedAt = new Date().toISOString();
  const tickers = markets.map((market) =>
    withDerivedFields(toNormalizedTicker(market, tickerMap.get(market.rawSymbol), fetchedAt)),
  );

  const currencyRaw = await applyPublicCurrencyFunding(markets);
  if (currencyRaw) rawResponses.push(currencyRaw);
  return { tickers, markets, rawResponses };
}

function toLevels(
  rows: PoloOrderBook["asks"],
  count: number,
  ts: number | null,
): Array<{ price: number; volume: number; timestamp: number | null }> {
  if (!rows || rows.length === 0) return [];
  const first = rows[0];
  if (Array.isArray(first)) {
    return (rows as Array<[string, string] | string[]>)
      .slice(0, count)
      .map((row) => ({ price: Number(row[0]), volume: Number(row[1]), timestamp: ts }));
  }
  const flat = rows as Array<string | number>;
  const levels: Array<{ price: number; volume: number; timestamp: number | null }> = [];
  for (let i = 0; i + 1 < flat.length && levels.length < count; i += 2) {
    levels.push({ price: Number(flat[i]), volume: Number(flat[i + 1]), timestamp: ts });
  }
  return levels;
}

async function fetchOrderBook(rawSymbol: string, count = 5): Promise<OrderBookFetchResult> {
  const started = Date.now();
  const result = await poloGet<PoloOrderBook>(`/markets/${encodeURIComponent(rawSymbol)}/orderBook`, {
    limit: count,
  });
  logStep("Orderbook", Date.now() - started, result.rawText);
  const book = result.data ?? {};
  const ts = toNumber(book.ts) ?? toNumber(book.time);
  return {
    endpoint: result.url,
    rawJson: result.rawText,
    orderbook: {
      exchange: EXCHANGE_ID,
      rawSymbol,
      bids: toLevels(book.bids, count, ts),
      asks: toLevels(book.asks, count, ts),
      fetchedAt: new Date().toISOString(),
    },
  };
}

export const poloniexAdapter: ExchangeAdapter = {
  id: EXCHANGE_ID,
  name: "Poloniex",
  fetchTickers,
  fetchOrderBook,
  spotUrl: (base, quote) => getSpotUrl(EXCHANGE_ID, base, quote),
};
