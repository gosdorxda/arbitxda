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

const BASE_URL = "https://openapi.bitrue.com";
const EXCHANGE_ID = "bitrue";
const schedule = createRateLimiter(300);
const ALLOWED_QUOTES = new Set(["USDT", "USD"]);

const STOCK_NAME_RE =
  /\b(x[\s-]?stocks?|tokenized stock|tokenised stock|tokenized equity|tokenised equity|tokenized etf|tokenised etf|ondo tokenized|stock token)\b/i;
const LEV_NAME_RE = /(\d+\s*x\s*(long|short)|leveraged token|leverage token)\b/i;
const LEV_LS_RE = /^[A-Z0-9]*\d[LS]$/i;

type BitrueSymbol = {
  symbol?: string;
  baseAsset?: string;
  quoteAsset?: string;
  status?: string;
};

type BitrueTicker = {
  symbol?: string;
  lastPrice?: string | number;
  bidPrice?: string | number;
  askPrice?: string | number;
  bidQty?: string | number;
  askQty?: string | number;
  volume?: string | number;
  quoteVolume?: string | number;
  priceChangePercent?: string | number;
};

type BitrueDepth = {
  asks?: Array<[string, string] | string[]>;
  bids?: Array<[string, string] | string[]>;
  lastUpdateId?: number;
};

type BitrueChain = {
  chain?: string;
  enableDeposit?: boolean;
  enableWithdraw?: boolean;
};

type BitrueCoin = {
  coin?: string;
  coinFulName?: string;
  chains?: string[];
  chainDetail?: BitrueChain[];
};

type BitrueExchangeInfo = {
  symbols?: BitrueSymbol[];
  coins?: BitrueCoin[];
  code?: string | number;
  msg?: string;
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

function assertBitrueOk(data: unknown, rawText: string, endpoint: string) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  const body = data as { code?: string | number; msg?: string; message?: string };
  if (body.code == null) return;
  const code = String(body.code);
  // Binance-style: 0 / 200 sukses; Bitrue exchangeInfo tidak selalu punya code.
  if (code !== "0" && code !== "200") {
    throw new ExchangeApiError(
      `Bitrue ${endpoint}: ${body.msg || body.message || `kode ${code}`}`,
      200,
      rawText.slice(0, 2000),
    );
  }
}

function logStep(step: string, ms: number, rawText?: string) {
  if (rawText != null) {
    const kb = (Buffer.byteLength(rawText, "utf8") / 1024).toFixed(1);
    console.log(`[bitrue] ${step} ${ms}ms (${kb} KB)`);
  } else {
    console.log(`[bitrue] ${step} ${ms}ms`);
  }
}

async function bitrueGet<T>(
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
  assertBitrueOk(data, rawText, endpoint);
  return { data, rawText, url: href };
}

function summarizeChains(coin: BitrueCoin): AssetFunding {
  const details = coin.chainDetail ?? [];
  const chains = details.length > 0 ? details : (coin.chains ?? []).map((chain) => ({ chain }));
  let depositEnabled = 0;
  let withdrawEnabled = 0;
  const parts: string[] = [];
  for (const detail of chains) {
    const name = (detail.chain || "?").trim() || "?";
    const deposit = "enableDeposit" in detail ? Boolean(detail.enableDeposit) : false;
    const withdraw = "enableWithdraw" in detail ? Boolean(detail.enableWithdraw) : false;
    if (deposit) depositEnabled = 1;
    if (withdraw) withdrawEnabled = 1;
    parts.push(`${name}: D${deposit ? "✓" : "✗"} W${withdraw ? "✓" : "✗"}`);
  }
  return {
    depositEnabled,
    withdrawEnabled,
    chainstatusRaw: parts.join(", "),
    // endpoint publik tidak menyertakan alamat kontrak.
    contracts: normalizeContracts(details.map((detail) => ({ chain: (detail.chain || "?").trim() || "?", contract: null }))),
    name: (coin.coinFulName ?? "").trim() || null,
  };
}

function applyCoinsFunding(markets: MarketInfo[], coins: BitrueCoin[]) {
  const fundingByAsset = new Map<string, AssetFunding>();
  for (const coin of coins) {
    const key = (coin.coin ?? "").trim().toUpperCase();
    if (key) fundingByAsset.set(key, summarizeChains(coin));
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
  console.log(`[bitrue] status depo/wd terisi untuk ${matched}/${markets.length} pair`);
}

function resolveMarket(item: BitrueSymbol, nameByCoin?: Map<string, string>): MarketInfo | null {
  const rawSymbol = (item.symbol ?? "").trim();
  const base = (item.baseAsset ?? "").trim().toUpperCase();
  const quote = (item.quoteAsset ?? "").trim().toUpperCase();
  if (!rawSymbol || !base || !quote) return null;
  if (!ALLOWED_QUOTES.has(quote)) return null;
  const status = (item.status ?? "").trim() || "unknown";
  if (status.toUpperCase() !== "TRADING") return null;
  const displayName = nameByCoin?.get(base) ?? null;
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
  ticker: BitrueTicker | undefined,
  fetchedAt: string,
): NormalizedTicker {
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
    exchangeTimestamp: null,
    fetchedAt,
  };
}

async function fetchTickers(): Promise<TickerFetchResult> {
  const infoStarted = Date.now();
  const infoRes = await bitrueGet<BitrueExchangeInfo>("/api/v1/exchangeInfo");
  logStep("ExchangeInfo", Date.now() - infoStarted, infoRes.rawText);
  const rawResponses = [{ endpoint: infoRes.url, rawJson: infoRes.rawText }];
  const info = infoRes.data ?? {};
  const allSymbols = Array.isArray(info.symbols) ? info.symbols : [];
  const coins = Array.isArray(info.coins) ? info.coins : [];
  const nameByCoin = new Map<string, string>();
  for (const coin of coins) {
    const key = (coin.coin ?? "").trim().toUpperCase();
    const name = (coin.coinFulName ?? "").trim();
    if (key && name) nameByCoin.set(key, name);
  }

  const usdCount = allSymbols.filter((item) =>
    ALLOWED_QUOTES.has((item.quoteAsset ?? "").trim().toUpperCase()),
  ).length;
  const markets = allSymbols
    .map((item) => resolveMarket(item, nameByCoin))
    .filter((market): market is MarketInfo => market != null);
  const skipped = usdCount - markets.length;
  if (skipped > 0) {
    console.log(`[bitrue] lewati ${skipped} pair USDT/USD yang bukan status TRADING`);
  }
  if (coins.length > 0) applyCoinsFunding(markets, coins);

  const tickerStarted = Date.now();
  const tickerRes = await bitrueGet<BitrueTicker[]>("/api/v1/ticker/24hr");
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
  return { tickers, markets, rawResponses };
}

async function fetchOrderBook(rawSymbol: string, count = 5): Promise<OrderBookFetchResult> {
  const started = Date.now();
  const result = await bitrueGet<BitrueDepth>("/api/v1/depth", { symbol: rawSymbol, limit: count });
  logStep("Orderbook", Date.now() - started, result.rawText);
  const book = result.data ?? {};
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

export const bitrueAdapter: ExchangeAdapter = {
  id: EXCHANGE_ID,
  name: "Bitrue",
  fetchTickers,
  fetchOrderBook,
  spotUrl: (base, quote) => getSpotUrl(EXCHANGE_ID, base, quote),
};
