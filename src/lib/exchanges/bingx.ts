import { createHmac } from "node:crypto";
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

const BASE_URL = "https://open-api.bingx.com";
const EXCHANGE_ID = "bingx";
const schedule = createRateLimiter(300);

type BingXSymbol = {
  symbol: string;
  status?: number;
  apiStateBuy?: boolean;
  apiStateSell?: boolean;
  displayName?: string;
};

type BingXSymbolsResponse = {
  code?: number;
  msg?: string;
  data?: { symbols?: BingXSymbol[] };
};

type BingXTicker = {
  symbol: string;
  lastPrice?: string | number;
  bidPrice?: string | number;
  askPrice?: string | number;
  bidQty?: string | number;
  askQty?: string | number;
  volume?: string | number;
  quoteVolume?: string | number;
  priceChangePercent?: string | number;
  openPrice?: string | number;
  closeTime?: number;
};

type BingXTickerResponse = {
  code?: number;
  msg?: string;
  data?: BingXTicker[];
};

type BingXDepthResponse = {
  code?: number;
  msg?: string;
  data?: {
    bids?: Array<[string, string]>;
    asks?: Array<[string, string]>;
  };
};

type BingXNetwork = {
  network?: string;
  name?: string;
  displayName?: string;
  depositEnable?: boolean | number | string;
  withdrawEnable?: boolean | number | string;
  contractAddress?: string | null;
  contract?: string | null;
};

type BingXCoin = {
  coin?: string;
  name?: string;
  networkList?: BingXNetwork[];
};

type BingXWalletsResponse = {
  code?: number;
  msg?: string;
  data?: BingXCoin[];
};

type AssetFunding = {
  depositEnabled: number;
  withdrawEnabled: number;
  chainstatusRaw: string;
  contracts: TokenContract[];
};

const ALLOWED_QUOTES = new Set(["USDT", "USD"]);
const SKIP_STATUSES = new Set([0, 25, 30]); // offline, suspended, delisted

const STATUS_BY_CODE: Record<number, { status: string; active: boolean }> = {
  0: { status: "offline", active: false },
  1: { status: "online", active: true },
  5: { status: "pre_open", active: false },
  10: { status: "accessed", active: false },
  25: { status: "suspended", active: false },
  29: { status: "pre_delisted", active: false },
  30: { status: "delisted", active: false },
};

function parseSymbol(symbol: string): { base: string; quote: string } | null {
  const upper = symbol.trim().toUpperCase();
  for (const quote of ["USDT", "USDC", "USD"]) {
    const suffix = `-${quote}`;
    if (upper.endsWith(suffix)) {
      const base = symbol.trim().slice(0, -suffix.length);
      if (!base) return null;
      return { base, quote };
    }
  }
  return null;
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).replace(/%/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function assertBingxOk(data: { code?: number; msg?: string }, rawText: string, endpoint: string) {
  if (data.code != null && Number(data.code) !== 0) {
    throw new ExchangeApiError(
      `BingX ${endpoint}: ${data.msg || `kode ${data.code}`}`,
      200,
      rawText.slice(0, 2000),
    );
  }
}

function logStep(step: string, ms: number, rawText?: string) {
  if (rawText != null) {
    const kb = (Buffer.byteLength(rawText, "utf8") / 1024).toFixed(1);
    console.log(`[bingx] ${step} ${ms}ms (${kb} KB)`);
  } else {
    console.log(`[bingx] ${step} ${ms}ms`);
  }
}

let loggedMissingWalletKeys = false;
let loggedWalletFailure = false;

function readBingxCredentials(): { apiKey: string; apiSecret: string } | null {
  const apiKey = process.env.BINGX_API_KEY?.trim() ?? "";
  const apiSecret = process.env.BINGX_API_SECRET?.trim() ?? "";
  if (!apiKey || !apiSecret) return null;
  return { apiKey, apiSecret };
}

function sanitizeLog(message: string, apiKey?: string, apiSecret?: string): string {
  let text = message;
  for (const secret of [apiSecret, apiKey]) {
    if (secret && secret.length >= 4) text = text.split(secret).join("[redacted]");
  }
  return text;
}

function isFlagEnabled(value: boolean | number | string | undefined): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function signQuery(secret: string, params: Record<string, string | number>): { query: string; signature: string } {
  const query = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  const signature = createHmac("sha256", secret).update(query).digest("hex");
  return { query, signature };
}

function summarizeNetworks(networks: BingXNetwork[]): AssetFunding {
  let depositEnabled = 0;
  let withdrawEnabled = 0;
  const parts: string[] = [];
  for (const network of networks) {
    const name = (network.network || network.displayName || network.name || "?").trim() || "?";
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
        chain: (network.network || network.displayName || network.name || "?").trim() || "?",
        contract: network.contractAddress || network.contract,
      })),
    ),
  };
}

function indexWalletFunding(coins: BingXCoin[]): Map<string, AssetFunding> {
  const index = new Map<string, AssetFunding>();
  const remember = (key: string | undefined, funding: AssetFunding) => {
    if (!key) return;
    index.set(key.trim().toUpperCase(), funding);
  };
  for (const coin of coins) {
    const networks = coin.networkList ?? [];
    if (networks.length === 0) continue;
    const funding = summarizeNetworks(networks);
    remember(coin.coin, funding);
    if (coin.name && coin.name !== coin.coin) remember(coin.name, funding);
  }
  return index;
}

async function bingxSignedGet<T extends { code?: number; msg?: string }>(
  endpoint: string,
  creds: { apiKey: string; apiSecret: string },
  extraQuery?: Record<string, string | number>,
): Promise<{ data: T; rawText: string }> {
  const params: Record<string, string | number> = {
    recvWindow: 5000,
    timestamp: Date.now(),
    ...extraQuery,
  };
  const { query, signature } = signQuery(creds.apiSecret, params);
  const href = `${BASE_URL}${endpoint}?${query}&signature=${signature}`;
  const { data, rawText } = await schedule(() =>
    fetchJson<T>(href, {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      retries: 1,
      headers: { "X-BX-APIKEY": creds.apiKey },
    }),
  );
  assertBingxOk(data, rawText, endpoint);
  return { data, rawText };
}

async function applyWalletFunding(markets: MarketInfo[]): Promise<{ endpoint: string; rawJson: string } | null> {
  const creds = readBingxCredentials();
  if (!creds) {
    if (!loggedMissingWalletKeys) {
      loggedMissingWalletKeys = true;
      console.log("[bingx] BINGX_API_KEY/BINGX_API_SECRET belum diisi, status depo/wd dilewati");
    }
    return null;
  }
  try {
    const started = Date.now();
    const result = await bingxSignedGet<BingXWalletsResponse>("/openApi/wallets/v1/capital/config/getall", creds);
    logStep("Wallets", Date.now() - started, result.rawText);
    const fundingByAsset = indexWalletFunding(result.data.data ?? []);
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
    console.log(`[bingx] status depo/wd terisi untuk ${matched}/${markets.length} pair`);
    return { endpoint: `${BASE_URL}/openApi/wallets/v1/capital/config/getall`, rawJson: result.rawText };
  } catch (error) {
    if (!loggedWalletFailure) {
      loggedWalletFailure = true;
      const message = sanitizeLog(error instanceof Error ? error.message : String(error), creds.apiKey, creds.apiSecret);
      console.log(`[bingx] Gagal mengambil status depo/wd, dibiarkan kosong: ${message}`);
    }
    return null;
  }
}

async function bingxGet<T extends { code?: number; msg?: string }>(
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
  assertBingxOk(data, rawText, endpoint);
  return { data, rawText, url: href };
}

function resolveMarket(item: BingXSymbol): MarketInfo | null {
  const parsed = parseSymbol(item.symbol);
  if (!parsed || !ALLOWED_QUOTES.has(parsed.quote)) return null;
  const code = Number(item.status);
  if (SKIP_STATUSES.has(code)) return null;
  const mapped = STATUS_BY_CODE[code] ?? { status: String(item.status ?? ""), active: false };
  return {
    rawSymbol: item.symbol,
    base: parsed.base,
    quote: parsed.quote,
    active: mapped.active,
    status: mapped.status || null,
    isStock: parsed.base.toUpperCase().startsWith("NCSK"),
    displayName: item.displayName ?? null,
  };
}

function toNormalizedTicker(
  market: MarketInfo,
  ticker: BingXTicker | undefined,
  fetchedAt: string,
): NormalizedTicker {
  const closeTime = ticker?.closeTime;
  return {
    exchange: EXCHANGE_ID,
    rawSymbol: market.rawSymbol,
    base: market.base,
    quote: market.quote,
    last: toNumber(ticker?.lastPrice),
    bid: toNumber(ticker?.bidPrice),
    ask: toNumber(ticker?.askPrice),
    bidSize: toNumber(ticker?.bidQty),
    askSize: toNumber(ticker?.askQty),
    baseVolume24h: toNumber(ticker?.volume),
    quoteVolume24h: toNumber(ticker?.quoteVolume),
    change24hPct: toNumber(ticker?.priceChangePercent),
    exchangeTimestamp:
      closeTime != null && Number.isFinite(Number(closeTime))
        ? new Date(Number(closeTime)).toISOString()
        : null,
    fetchedAt,
  };
}

async function fetchTickers(): Promise<TickerFetchResult> {
  const symbolsStarted = Date.now();
  const symbolsRes = await bingxGet<BingXSymbolsResponse>("/openApi/spot/v1/common/symbols");
  logStep("Symbols", Date.now() - symbolsStarted, symbolsRes.rawText);
  const rawResponses = [{ endpoint: symbolsRes.url, rawJson: symbolsRes.rawText }];
  const allSymbols = symbolsRes.data.data?.symbols ?? [];

  const usdCount = allSymbols.filter((item) => {
    const parsed = parseSymbol(item.symbol);
    return parsed != null && ALLOWED_QUOTES.has(parsed.quote);
  }).length;
  const markets = allSymbols
    .map((item) => resolveMarket(item))
    .filter((market): market is MarketInfo => market != null);
  const skipped = usdCount - markets.length;
  if (skipped > 0) {
    console.log(`[bingx] lewati ${skipped} pair offline/suspended/delisted`);
  }

  const tickerStarted = Date.now();
  const tickerRes = await bingxGet<BingXTickerResponse>("/openApi/spot/v1/ticker/24hr", {
    timestamp: Date.now(),
  });
  logStep("Ticker", Date.now() - tickerStarted, tickerRes.rawText);
  rawResponses.push({ endpoint: tickerRes.url, rawJson: tickerRes.rawText });
  const tickerMap = new Map((tickerRes.data.data ?? []).map((row) => [row.symbol, row]));

  const fetchedAt = new Date().toISOString();
  const tickers = markets.map((market) =>
    withDerivedFields(toNormalizedTicker(market, tickerMap.get(market.rawSymbol), fetchedAt)),
  );

  const walletRaw = await applyWalletFunding(markets);
  if (walletRaw) rawResponses.push(walletRaw);

  return { tickers, markets, rawResponses };
}

async function fetchOrderBook(rawSymbol: string, count = 5): Promise<OrderBookFetchResult> {
  const started = Date.now();
  const result = await bingxGet<BingXDepthResponse>("/openApi/spot/v1/market/depth", {
    symbol: rawSymbol,
    limit: count,
  });
  logStep(`Depth ${rawSymbol}`, Date.now() - started, result.rawText);
  const book = result.data.data;
  if (!book) {
    throw new ExchangeApiError(
      `BingX Depth: orderbook untuk ${rawSymbol} tidak ditemukan`,
      200,
      result.rawText.slice(0, 2000),
    );
  }

  const toLevels = (rows: Array<[string, string]> | undefined) =>
    (rows ?? []).slice(0, count).map(([price, volume]) => ({
      price: Number(price),
      volume: Number(volume),
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

export const bingxAdapter: ExchangeAdapter = {
  id: EXCHANGE_ID,
  name: "BingX",
  fetchTickers,
  fetchOrderBook,
  spotUrl: (base, quote) => getSpotUrl(EXCHANGE_ID, base, quote),
};
