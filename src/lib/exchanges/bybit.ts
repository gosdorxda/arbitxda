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

// Host resmi mainnet: api.bybit.com; api.bytick.com adalah endpoint resmi setara.
const BASE_URL = "https://api.bybit.com";
const EXCHANGE_ID = "bybit";
const schedule = createRateLimiter(300);
const RECV_WINDOW = "5000";

const ALLOWED_QUOTES = new Set(["USDT", "USD"]);

type BybitListResponse<T> = {
  retCode?: number;
  retMsg?: string;
  result?: { list?: T[]; category?: string };
  time?: number;
};

type BybitInstrument = {
  symbol?: string;
  status?: string;
  baseCoin?: string;
  quoteCoin?: string;
  symbolType?: string;
};

type BybitTicker = {
  symbol?: string;
  lastPrice?: string | number;
  bid1Price?: string | number;
  ask1Price?: string | number;
  bid1Size?: string | number;
  ask1Size?: string | number;
  volume24h?: string | number;
  turnover24h?: string | number;
  price24hPcnt?: string | number;
};

type BybitOrderbook = {
  s?: string;
  b?: Array<[string, string]>;
  a?: Array<[string, string]>;
  ts?: number;
};

type BybitChain = {
  chain?: string;
  chainType?: string;
  chainDeposit?: string | number;
  chainWithdraw?: string | number;
  contractAddress?: string | null;
};

type BybitCoin = {
  name?: string;
  coin?: string;
  chains?: BybitChain[];
};

type BybitCoinInfoResponse = {
  retCode?: number;
  retMsg?: string;
  result?: { rows?: BybitCoin[] };
  time?: number;
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

function isFlagEnabled(value: boolean | number | string | undefined): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function assertBybitOk(data: { retCode?: number; retMsg?: string }, rawText: string, endpoint: string) {
  if (data.retCode != null && Number(data.retCode) !== 0) {
    throw new ExchangeApiError(
      `Bybit ${endpoint}: ${data.retMsg || `kode ${data.retCode}`}`,
      200,
      rawText.slice(0, 2000),
    );
  }
}

function logStep(step: string, ms: number, rawText?: string) {
  if (rawText != null) {
    const kb = (Buffer.byteLength(rawText, "utf8") / 1024).toFixed(1);
    console.log(`[bybit] ${step} ${ms}ms (${kb} KB)`);
  } else {
    console.log(`[bybit] ${step} ${ms}ms`);
  }
}

let loggedMissingKeys = false;
let loggedCoinInfoFailure = false;

function readBybitCredentials(): { apiKey: string; apiSecret: string } | null {
  const apiKey = process.env.BYBIT_API_KEY?.trim() ?? "";
  const apiSecret = process.env.BYBIT_API_SECRET?.trim() ?? "";
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

async function bybitGet<T extends { retCode?: number; retMsg?: string }>(
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
  assertBybitOk(data, rawText, endpoint);
  return { data, rawText, url: href };
}

async function bybitSignedGet<T extends { retCode?: number; retMsg?: string }>(
  endpoint: string,
  creds: { apiKey: string; apiSecret: string },
  query?: Record<string, string | number>,
): Promise<{ data: T; rawText: string; url: string }> {
  const timestamp = String(Date.now());
  const search = new URLSearchParams();
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      search.set(key, String(value));
    }
  }
  const queryString = search.toString();
  const payload = `${timestamp}${creds.apiKey}${RECV_WINDOW}${queryString}`;
  const signature = createHmac("sha256", creds.apiSecret).update(payload).digest("hex");
  const href = queryString ? `${BASE_URL}${endpoint}?${queryString}` : `${BASE_URL}${endpoint}`;
  const { data, rawText } = await schedule(() =>
    fetchJson<T>(href, {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      retries: 1,
      headers: {
        "X-BAPI-API-KEY": creds.apiKey,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-SIGN": signature,
        "X-BAPI-RECV-WINDOW": RECV_WINDOW,
        "X-BAPI-SIGN-TYPE": "2",
      },
    }),
  );
  assertBybitOk(data, rawText, endpoint);
  return { data, rawText, url: `${BASE_URL}${endpoint}` };
}

function summarizeChains(chains: BybitChain[]): AssetFunding {
  let depositEnabled = 0;
  let withdrawEnabled = 0;
  const parts: string[] = [];
  for (const chain of chains) {
    const name = (chain.chainType || chain.chain || "?").trim() || "?";
    const deposit = isFlagEnabled(chain.chainDeposit);
    const withdraw = isFlagEnabled(chain.chainWithdraw);
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
        chain: (chain.chainType || chain.chain || "?").trim() || "?",
        contract: chain.contractAddress,
      })),
    ),
  };
}

function indexCoinFunding(coins: BybitCoin[]): Map<string, AssetFunding> {
  const index = new Map<string, AssetFunding>();
  const remember = (key: string | undefined, funding: AssetFunding) => {
    if (!key) return;
    index.set(key.trim().toUpperCase(), funding);
  };
  for (const coin of coins) {
    const chains = coin.chains ?? [];
    if (chains.length === 0) continue;
    const funding = summarizeChains(chains);
    remember(coin.coin, funding);
    if (coin.name && coin.name !== coin.coin) remember(coin.name, funding);
  }
  return index;
}

async function applyCoinFunding(markets: MarketInfo[]): Promise<{ endpoint: string; rawJson: string } | null> {
  const creds = readBybitCredentials();
  if (!creds) {
    if (!loggedMissingKeys) {
      loggedMissingKeys = true;
      console.log("[bybit] BYBIT_API_KEY/BYBIT_API_SECRET belum diisi, status depo/wd dilewati");
    }
    return null;
  }
  try {
    const started = Date.now();
    const result = await bybitSignedGet<BybitCoinInfoResponse>("/v5/asset/coin/query-info", creds);
    logStep("CoinInfo", Date.now() - started, result.rawText);
    const fundingByAsset = indexCoinFunding(result.data.result?.rows ?? []);
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
    console.log(`[bybit] status depo/wd terisi untuk ${matched}/${markets.length} pair`);
    return { endpoint: `${BASE_URL}/v5/asset/coin/query-info`, rawJson: result.rawText };
  } catch (error) {
    if (!loggedCoinInfoFailure) {
      loggedCoinInfoFailure = true;
      const message = sanitizeLog(
        error instanceof Error ? error.message : String(error),
        creds.apiKey,
        creds.apiSecret,
      );
      console.log(`[bybit] Gagal mengambil status depo/wd, dibiarkan kosong: ${message}`);
    }
    return null;
  }
}

function resolveMarket(item: BybitInstrument): MarketInfo | null {
  const symbol = (item.symbol ?? "").trim();
  const base = (item.baseCoin ?? "").trim();
  const quote = (item.quoteCoin ?? "").trim().toUpperCase();
  if (!symbol || !base || !quote) return null;
  if (!ALLOWED_QUOTES.has(quote)) return null;
  const status = (item.status ?? "").trim() || "unknown";
  if (status.toLowerCase() !== "trading") return null;
  const symbolType = (item.symbolType ?? "").trim().toLowerCase();
  const isStock = symbolType === "xstocks" || symbolType === "mstocks" || symbolType === "stock";
  return {
    rawSymbol: symbol,
    base,
    quote,
    active: true,
    status,
    isStock,
  };
}

function toNormalizedTicker(
  market: MarketInfo,
  ticker: BybitTicker | undefined,
  fetchedAt: string,
  exchangeTimestamp: string | null,
): NormalizedTicker {
  const pct = toNumber(ticker?.price24hPcnt);
  return {
    exchange: EXCHANGE_ID,
    rawSymbol: market.rawSymbol,
    base: market.base,
    quote: market.quote,
    last: toNumber(ticker?.lastPrice),
    bid: toNumber(ticker?.bid1Price),
    ask: toNumber(ticker?.ask1Price),
    bidSize: toNumber(ticker?.bid1Size),
    askSize: toNumber(ticker?.ask1Size),
    baseVolume24h: toNumber(ticker?.volume24h),
    quoteVolume24h: toNumber(ticker?.turnover24h),
    change24hPct: pct != null ? pct * 100 : null,
    exchangeTimestamp,
    fetchedAt,
  };
}

async function fetchTickers(): Promise<TickerFetchResult> {
  const instStarted = Date.now();
  const instRes = await bybitGet<BybitListResponse<BybitInstrument>>("/v5/market/instruments-info", {
    category: "spot",
  });
  logStep("Instruments", Date.now() - instStarted, instRes.rawText);
  const rawResponses = [{ endpoint: instRes.url, rawJson: instRes.rawText }];
  const allInstruments = instRes.data.result?.list ?? [];

  const usdCount = allInstruments.filter((item) => ALLOWED_QUOTES.has((item.quoteCoin ?? "").trim().toUpperCase())).length;
  const markets = allInstruments
    .map((item) => resolveMarket(item))
    .filter((market): market is MarketInfo => market != null);
  const skipped = usdCount - markets.length;
  if (skipped > 0) {
    console.log(`[bybit] lewati ${skipped} pair USDT/USD yang bukan status Trading`);
  }

  const tickerStarted = Date.now();
  const tickerRes = await bybitGet<BybitListResponse<BybitTicker>>("/v5/market/tickers", {
    category: "spot",
  });
  logStep("Tickers", Date.now() - tickerStarted, tickerRes.rawText);
  rawResponses.push({ endpoint: tickerRes.url, rawJson: tickerRes.rawText });
  const tickerMap = new Map(
    (tickerRes.data.result?.list ?? []).filter((row) => row.symbol).map((row) => [row.symbol as string, row]),
  );

  const fetchedAt = new Date().toISOString();
  const timeMs = tickerRes.data.time;
  const exchangeTimestamp =
    timeMs != null && Number.isFinite(Number(timeMs)) ? new Date(Number(timeMs)).toISOString() : null;
  const tickers = markets.map((market) =>
    withDerivedFields(toNormalizedTicker(market, tickerMap.get(market.rawSymbol), fetchedAt, exchangeTimestamp)),
  );

  const coinRaw = await applyCoinFunding(markets);
  if (coinRaw) rawResponses.push(coinRaw);

  return { tickers, markets, rawResponses };
}

async function fetchOrderBook(rawSymbol: string, count = 5): Promise<OrderBookFetchResult> {
  const started = Date.now();
  const result = await bybitGet<{ retCode?: number; retMsg?: string; result?: BybitOrderbook }>(
    "/v5/market/orderbook",
    { category: "spot", symbol: rawSymbol, limit: count },
  );
  logStep(`Orderbook ${rawSymbol}`, Date.now() - started, result.rawText);
  const book = result.data.result;
  if (!book || (!book.b && !book.a)) {
    throw new ExchangeApiError(
      `Bybit Orderbook: orderbook untuk ${rawSymbol} tidak ditemukan`,
      200,
      result.rawText.slice(0, 2000),
    );
  }

  const toLevels = (rows: Array<[string, string]> | undefined) =>
    (rows ?? []).slice(0, count).map(([price, volume]) => ({
      price: Number(price),
      volume: Number(volume),
      timestamp: book.ts ?? null,
    }));

  return {
    endpoint: result.url,
    rawJson: result.rawText,
    orderbook: {
      exchange: EXCHANGE_ID,
      rawSymbol,
      bids: toLevels(book.b),
      asks: toLevels(book.a),
      fetchedAt: new Date().toISOString(),
    },
  };
}

export const bybitAdapter: ExchangeAdapter = {
  id: EXCHANGE_ID,
  name: "Bybit",
  fetchTickers,
  fetchOrderBook,
  spotUrl: (base, quote) => getSpotUrl(EXCHANGE_ID, base, quote),
};
