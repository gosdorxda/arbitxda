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

const BASE_URL = "https://api.mexc.com";
const EXCHANGE_ID = "mexc";
const schedule = createRateLimiter(300);
const ALLOWED_QUOTES = new Set(["USDT", "USD"]);
const LEV_LS_RE = /^[A-Z0-9]*\d[LS]$/i;
const STOCK_NAME_RE =
  /\b(x[\s-]?stocks?|tokenized stock|tokenised stock|tokenized equity|tokenised equity|tokenized etf|tokenised etf|ondo tokenized|stock token)\b/i;

type MexcSymbol = {
  symbol?: string;
  baseAsset?: string;
  quoteAsset?: string;
  status?: string | number;
  isSpotTradingAllowed?: boolean;
  fullName?: string;
  conceptPlates?: string[];
};

type MexcExchangeInfo = {
  symbols?: MexcSymbol[];
  code?: number | string;
  msg?: string;
};

type MexcTicker = {
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
};

type MexcDepth = {
  asks?: Array<[string, string] | string[]>;
  bids?: Array<[string, string] | string[]>;
  timestamp?: number;
};

type MexcNetwork = {
  network?: string;
  depositEnable?: boolean | number | string;
  withdrawEnable?: boolean | number | string;
  contract?: string | null;
  contractAddress?: string | null;
};

type MexcCoin = {
  coin?: string;
  name?: string;
  networkList?: MexcNetwork[];
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

function isFlagEnabled(value: boolean | number | string | undefined): boolean {
  return value === true || value === 1 || value === "1" || String(value).trim().toLowerCase() === "true";
}

function isTradingStatus(status: string | number | undefined): boolean {
  const s = String(status ?? "").trim().toUpperCase();
  return s === "1" || s === "ENABLED" || s === "TRADING";
}

function isOfficialStock(item: MexcSymbol, displayName?: string | null): boolean {
  const plates = (item.conceptPlates ?? []).map((plate) => String(plate).trim().toLowerCase());
  if (plates.includes("tokenized stocks")) return true;
  return Boolean(displayName && STOCK_NAME_RE.test(displayName));
}

function logStep(step: string, ms: number, rawText?: string) {
  if (rawText != null) {
    const kb = (Buffer.byteLength(rawText, "utf8") / 1024).toFixed(1);
    console.log(`[mexc] ${step} ${ms}ms (${kb} KB)`);
  } else {
    console.log(`[mexc] ${step} ${ms}ms`);
  }
}

function assertMexcOk(data: unknown, rawText: string, endpoint: string) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  const body = data as { code?: number | string; msg?: string; message?: string };
  if (body.code == null) return;
  const code = String(body.code);
  if (code !== "0" && code !== "200") {
    throw new ExchangeApiError(
      `MEXC ${endpoint}: ${body.msg || body.message || `kode ${code}`}`,
      200,
      rawText.slice(0, 2000),
    );
  }
}

async function mexcGet<T>(
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
  assertMexcOk(data, rawText, endpoint);
  return { data, rawText, url: href };
}

function readMexcCredentials(): { apiKey: string; apiSecret: string } | null {
  const apiKey = process.env.MEXC_API_KEY?.trim() ?? "";
  const apiSecret = process.env.MEXC_API_SECRET?.trim() ?? "";
  if (!apiKey || !apiSecret) return null;
  return { apiKey, apiSecret };
}

function signQuery(secret: string, params: Record<string, string | number>): { query: string; signature: string } {
  const query = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  const signature = createHmac("sha256", secret).update(query).digest("hex");
  return { query, signature };
}

let loggedMissingKeys = false;

async function mexcSignedGet<T>(endpoint: string, creds: { apiKey: string; apiSecret: string }): Promise<{ data: T; rawText: string; url: string }> {
  const params: Record<string, string | number> = { recvWindow: 5000, timestamp: Date.now() };
  const { query, signature } = signQuery(creds.apiSecret, params);
  const href = `${BASE_URL}${endpoint}?${query}&signature=${signature}`;
  const { data, rawText } = await schedule(() =>
    fetchJson<T>(href, {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      retries: 1,
      headers: { "X-MEXC-APIKEY": creds.apiKey },
    }),
  );
  assertMexcOk(data, rawText, endpoint);
  return { data, rawText, url: href };
}

function summarizeNetworks(coin: MexcCoin): AssetFunding {
  const networks = coin.networkList ?? [];
  let depositEnabled = 0;
  let withdrawEnabled = 0;
  const parts: string[] = [];
  for (const network of networks) {
    const name = (network.network || "?").trim() || "?";
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
        chain: (network.network || "?").trim() || "?",
        contract: network.contractAddress ?? network.contract,
      })),
    ),
    name: (coin.name ?? "").trim() || null,
  };
}

async function applySignedCapitalFunding(
  markets: MarketInfo[],
): Promise<{ endpoint: string; rawJson: string } | null> {
  const creds = readMexcCredentials();
  if (!creds) {
    if (!loggedMissingKeys) {
      loggedMissingKeys = true;
      console.log("[mexc] MEXC_API_KEY/MEXC_API_SECRET belum diisi, status depo/wd dilewati");
    }
    return null;
  }
  try {
    const started = Date.now();
    const result = await mexcSignedGet<MexcCoin[] | { data?: MexcCoin[] }>("/api/v3/capital/config/getall", creds);
    logStep("Capital", Date.now() - started, result.rawText);
    const coins = Array.isArray(result.data)
      ? result.data
      : Array.isArray((result.data as { data?: MexcCoin[] }).data)
        ? ((result.data as { data?: MexcCoin[] }).data ?? [])
        : [];
    const fundingByAsset = new Map<string, AssetFunding>();
    for (const coin of coins) {
      const key = (coin.coin ?? "").trim().toUpperCase();
      if (key) fundingByAsset.set(key, summarizeNetworks(coin));
    }
    let matched = 0;
    for (const market of markets) {
      const funding = fundingByAsset.get(market.base.toUpperCase());
      if (!funding) continue;
      market.depositEnabled = funding.depositEnabled;
      market.withdrawEnabled = funding.withdrawEnabled;
      market.chainstatusRaw = funding.chainstatusRaw;
      market.contracts = funding.contracts;
      if (funding.name && !market.displayName) market.displayName = funding.name;
      matched += 1;
    }
    console.log(`[mexc] status depo/wd terisi untuk ${matched}/${markets.length} pair`);
    return { endpoint: result.url, rawJson: result.rawText };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[mexc] Gagal mengambil status depo/wd, dibiarkan kosong: ${message}`);
    return null;
  }
}

function resolveMarket(item: MexcSymbol): MarketInfo | null {
  const rawSymbol = (item.symbol ?? "").trim();
  const base = (item.baseAsset ?? "").trim().toUpperCase();
  const quote = (item.quoteAsset ?? "").trim().toUpperCase();
  if (!rawSymbol || !base || !quote) return null;
  if (!ALLOWED_QUOTES.has(quote)) return null;
  if (!isTradingStatus(item.status) || item.isSpotTradingAllowed === false) return null;
  const displayName = (item.fullName ?? "").trim() || null;
  return {
    rawSymbol,
    base,
    quote,
    active: true,
    status: String(item.status ?? "1"),
    isStock: isOfficialStock(item, displayName),
    isLeveraged: LEV_LS_RE.test(base),
    displayName,
  };
}

function toNormalizedTicker(
  market: MarketInfo,
  ticker: MexcTicker | undefined,
  fetchedAt: string,
): NormalizedTicker {
  const change = toNumber(ticker?.priceChangePercent);
  const ts = toNumber(ticker?.closeTime);
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
    // priceChangePercent API adalah rasio (contoh -0.006 = -0.60%).
    change24hPct: change != null ? change * 100 : null,
    exchangeTimestamp: ts != null && ts > 0 ? new Date(ts).toISOString() : null,
    fetchedAt,
  };
}

async function fetchTickers(): Promise<TickerFetchResult> {
  const infoStarted = Date.now();
  const infoRes = await mexcGet<MexcExchangeInfo>("/api/v3/exchangeInfo");
  logStep("ExchangeInfo", Date.now() - infoStarted, infoRes.rawText);
  const rawResponses = [{ endpoint: infoRes.url, rawJson: infoRes.rawText }];
  const allSymbols = Array.isArray(infoRes.data.symbols) ? infoRes.data.symbols : [];
  const usdCount = allSymbols.filter((item) => ALLOWED_QUOTES.has((item.quoteAsset ?? "").trim().toUpperCase())).length;
  const markets = allSymbols
    .map((item) => resolveMarket(item))
    .filter((market): market is MarketInfo => market != null);
  const skipped = usdCount - markets.length;
  if (skipped > 0) {
    console.log(`[mexc] lewati ${skipped} pair USDT/USD yang bukan status trading`);
  }

  const tickerStarted = Date.now();
  const tickerRes = await mexcGet<MexcTicker[] | MexcTicker>("/api/v3/ticker/24hr");
  logStep("Tickers", Date.now() - tickerStarted, tickerRes.rawText);
  rawResponses.push({ endpoint: tickerRes.url, rawJson: tickerRes.rawText });
  const tickerRows = Array.isArray(tickerRes.data) ? tickerRes.data : tickerRes.data ? [tickerRes.data] : [];
  const tickerMap = new Map(
    tickerRows.filter((row) => row.symbol).map((row) => [row.symbol as string, row]),
  );

  const fetchedAt = new Date().toISOString();
  const tickers = markets.map((market) =>
    withDerivedFields(toNormalizedTicker(market, tickerMap.get(market.rawSymbol), fetchedAt)),
  );

  const capitalRaw = await applySignedCapitalFunding(markets);
  if (capitalRaw) rawResponses.push(capitalRaw);
  return { tickers, markets, rawResponses };
}

async function fetchOrderBook(rawSymbol: string, count = 5): Promise<OrderBookFetchResult> {
  const started = Date.now();
  const result = await mexcGet<MexcDepth>("/api/v3/depth", { symbol: rawSymbol, limit: count });
  logStep("Orderbook", Date.now() - started, result.rawText);
  const book = result.data ?? {};
  const ts = toNumber(book.timestamp);
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

export const mexcAdapter: ExchangeAdapter = {
  id: EXCHANGE_ID,
  name: "MEXC",
  fetchTickers,
  fetchOrderBook,
  spotUrl: (base, quote) => getSpotUrl(EXCHANGE_ID, base, quote),
};
