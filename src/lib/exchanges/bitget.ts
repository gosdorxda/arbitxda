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

const BASE_URL = "https://api.bitget.com";
const EXCHANGE_ID = "bitget";
const schedule = createRateLimiter(300);

const ALLOWED_QUOTES = new Set(["USDT", "USD"]);

type BitgetResponse<T> = {
  code?: string | number;
  msg?: string;
  requestTime?: number;
  data?: T;
};

type BitgetSymbol = {
  symbol?: string;
  baseCoin?: string;
  quoteCoin?: string;
  status?: string;
  isReality?: string | boolean | number;
  instrumentType?: string;
  symbolType?: string;
  fullName?: string;
};

type BitgetTicker = {
  symbol?: string;
  lastPr?: string | number;
  bidPr?: string | number;
  askPr?: string | number;
  bidSz?: string | number;
  askSz?: string | number;
  baseVolume?: string | number;
  usdtVolume?: string | number;
  quoteVolume?: string | number;
  change24h?: string | number;
  ts?: string | number;
};

type BitgetOrderbook = {
  asks?: Array<[string, string] | string[]>;
  bids?: Array<[string, string] | string[]>;
  ts?: string | number;
};

type BitgetChain = {
  chain?: string;
  rechargeable?: boolean | number | string;
  withdrawable?: boolean | number | string;
  contractAddress?: string | null;
};

type BitgetCoin = {
  coin?: string;
  coinId?: string;
  chains?: BitgetChain[];
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
  if (value == null) return false;
  if (value === true || value === 1 || value === "1") return true;
  return String(value).trim().toLowerCase() === "true";
}

function assertBitgetOk(data: { code?: string | number; msg?: string }, rawText: string, endpoint: string) {
  const code = data.code == null ? "" : String(data.code);
  if (code && code !== "00000" && code !== "0") {
    throw new ExchangeApiError(
      `Bitget ${endpoint}: ${data.msg || `kode ${code}`}`,
      200,
      rawText.slice(0, 2000),
    );
  }
}

function logStep(step: string, ms: number, rawText?: string) {
  if (rawText != null) {
    const kb = (Buffer.byteLength(rawText, "utf8") / 1024).toFixed(1);
    console.log(`[bitget] ${step} ${ms}ms (${kb} KB)`);
  } else {
    console.log(`[bitget] ${step} ${ms}ms`);
  }
}

let loggedCoinFailure = false;

async function bitgetGet<T>(
  endpoint: string,
  query?: Record<string, string | number>,
): Promise<{ data: BitgetResponse<T>; rawText: string; url: string }> {
  const url = new URL(`${BASE_URL}${endpoint}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }
  }
  const href = url.toString();
  const { data, rawText } = await schedule(() =>
    fetchJson<BitgetResponse<T>>(href, { timeoutMs: DEFAULT_TIMEOUT_MS, retries: 1 }),
  );
  assertBitgetOk(data, rawText, endpoint);
  return { data, rawText, url: href };
}

function summarizeChains(chains: BitgetChain[]): AssetFunding {
  let depositEnabled = 0;
  let withdrawEnabled = 0;
  const parts: string[] = [];
  for (const chain of chains) {
    const name = (chain.chain || "?").trim() || "?";
    const deposit = isFlagEnabled(chain.rechargeable);
    const withdraw = isFlagEnabled(chain.withdrawable);
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
        chain: (chain.chain || "?").trim() || "?",
        contract: chain.contractAddress,
      })),
    ),
  };
}

function indexCoinFunding(coins: BitgetCoin[]): Map<string, AssetFunding> {
  const index = new Map<string, AssetFunding>();
  for (const coin of coins) {
    const key = (coin.coin ?? "").trim().toUpperCase();
    if (!key) continue;
    const chains = coin.chains ?? [];
    if (chains.length === 0) continue;
    index.set(key, summarizeChains(chains));
  }
  return index;
}

async function applyPublicCoinFunding(
  markets: MarketInfo[],
): Promise<{ endpoint: string; rawJson: string } | null> {
  try {
    const started = Date.now();
    const result = await bitgetGet<BitgetCoin[]>("/api/v2/spot/public/coins");
    logStep("Coins", Date.now() - started, result.rawText);
    const fundingByAsset = indexCoinFunding(result.data.data ?? []);
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
    console.log(`[bitget] status depo/wd terisi untuk ${matched}/${markets.length} pair`);
    return { endpoint: result.url, rawJson: result.rawText };
  } catch (error) {
    if (!loggedCoinFailure) {
      loggedCoinFailure = true;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[bitget] Gagal mengambil status depo/wd, dibiarkan kosong: ${message}`);
    }
    return null;
  }
}

function flagText(value: string | boolean | number | null | undefined): string {
  if (value === true || value === 1) return "yes";
  if (value === false || value === 0 || value == null) return "";
  return String(value).trim().toLowerCase();
}

/** Flag resmi Bitget: isReality, instrumentType, atau symbolType (nilai bisa "yes"/"YES"/true). */
function isBitgetStockFlag(item: BitgetSymbol): boolean {
  const reality = flagText(item.isReality);
  if (reality === "yes" || reality === "true" || reality === "1") return true;
  const instrumentType = flagText(item.instrumentType);
  if (instrumentType === "stock" || instrumentType === "etf") return true;
  const symbolType = flagText(item.symbolType);
  return symbolType === "stock" || symbolType === "etf";
}

function hasOfficialStockFields(item: BitgetSymbol): boolean {
  return (
    item.isReality != null && String(item.isReality).trim() !== ""
    || Boolean(item.instrumentType && String(item.instrumentType).trim())
    || Boolean(item.symbolType && String(item.symbolType).trim())
  );
}

function resolveMarket(item: BitgetSymbol): MarketInfo | null {
  const symbol = (item.symbol ?? "").trim();
  const base = (item.baseCoin ?? "").trim();
  const quote = (item.quoteCoin ?? "").trim().toUpperCase();
  if (!symbol || !base || !quote) return null;
  if (!ALLOWED_QUOTES.has(quote)) return null;
  const status = (item.status ?? "").trim() || "unknown";
  if (status.toLowerCase() !== "online") return null;
  return {
    rawSymbol: symbol,
    base,
    quote,
    active: true,
    status,
    isStock: isBitgetStockFlag(item),
    displayName: item.fullName ?? null,
  };
}

function toNormalizedTicker(
  market: MarketInfo,
  ticker: BitgetTicker | undefined,
  fetchedAt: string,
): NormalizedTicker {
  const pct = toNumber(ticker?.change24h);
  const ts = toNumber(ticker?.ts);
  return {
    exchange: EXCHANGE_ID,
    rawSymbol: market.rawSymbol,
    base: market.base,
    quote: market.quote,
    last: toNumber(ticker?.lastPr),
    bid: toNumber(ticker?.bidPr),
    ask: toNumber(ticker?.askPr),
    bidSize: toNumber(ticker?.bidSz),
    askSize: toNumber(ticker?.askSz),
    baseVolume24h: toNumber(ticker?.baseVolume),
    quoteVolume24h: toNumber(ticker?.usdtVolume) ?? toNumber(ticker?.quoteVolume),
    change24hPct: pct != null ? pct * 100 : null,
    exchangeTimestamp: ts != null ? new Date(ts).toISOString() : null,
    fetchedAt,
  };
}

async function loadSpotInstruments(): Promise<{
  items: BitgetSymbol[];
  rawResponses: Array<{ endpoint: string; rawJson: string }>;
  usedOfficialFlags: boolean;
}> {
  const rawResponses: Array<{ endpoint: string; rawJson: string }> = [];
  const started = Date.now();
  try {
    // v3 instruments punya flag resmi isReality / instrumentType / symbolType / fullName.
    const res = await bitgetGet<BitgetSymbol[]>("/api/v3/market/instruments", { category: "SPOT" });
    logStep("Instruments", Date.now() - started, res.rawText);
    rawResponses.push({ endpoint: res.url, rawJson: res.rawText });
    const items = res.data.data ?? [];
    const flagged = items.filter(hasOfficialStockFields).length;
    if (items.length > 0 && flagged === 0) {
      console.warn(
        `[bitget] PERINGATAN: v3 instruments (${items.length}) tidak punya flag isReality/instrumentType/symbolType — andalkan filter cadangan`,
      );
      return { items, rawResponses, usedOfficialFlags: false };
    }
    return { items, rawResponses, usedOfficialFlags: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[bitget] PERINGATAN: gagal ambil v3 instruments (${reason}); fallback ke v2 symbols`);
  }

  const v2Started = Date.now();
  const symbolsRes = await bitgetGet<BitgetSymbol[]>("/api/v2/spot/public/symbols");
  logStep("Symbols v2 fallback", Date.now() - v2Started, symbolsRes.rawText);
  rawResponses.push({ endpoint: symbolsRes.url, rawJson: symbolsRes.rawText });
  const items = symbolsRes.data.data ?? [];

  // v2 symbols tidak punya isReality; coba tempel nama/metadata dari coins.
  try {
    const coinStarted = Date.now();
    const coinsRes = await bitgetGet<Array<BitgetCoin & { fullName?: string; coinName?: string; transfer?: string }>>(
      "/api/v2/spot/public/coins",
    );
    logStep("Coins v2 fallback", Date.now() - coinStarted, coinsRes.rawText);
    rawResponses.push({ endpoint: coinsRes.url, rawJson: coinsRes.rawText });
    const nameByCoin = new Map<string, string>();
    for (const coin of coinsRes.data.data ?? []) {
      const key = (coin.coin ?? "").trim();
      const name = (coin.fullName ?? coin.coinName ?? "").trim();
      if (key && name) nameByCoin.set(key, name);
    }
    if (nameByCoin.size > 0) {
      for (const item of items) {
        if (!item.fullName) {
          const name = nameByCoin.get((item.baseCoin ?? "").trim());
          if (name) item.fullName = name;
        }
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[bitget] PERINGATAN: fallback coins v2 juga gagal (${reason}); andalkan pola rToken / filter bersama`);
  }

  return { items, rawResponses, usedOfficialFlags: false };
}

async function fetchTickers(): Promise<TickerFetchResult> {
  const loaded = await loadSpotInstruments();
  const rawResponses = loaded.rawResponses;
  const allSymbols = loaded.items;
  if (!loaded.usedOfficialFlags) {
    console.warn(
      `[bitget] PERINGATAN: tanpa flag resmi v3, token saham disaring lewat pola/nama — cek log jika masih lolos`,
    );
  }

  const usdCount = allSymbols.filter((item) => ALLOWED_QUOTES.has((item.quoteCoin ?? "").trim().toUpperCase())).length;
  const markets = allSymbols
    .map((item) => resolveMarket(item))
    .filter((market): market is MarketInfo => market != null);
  const skipped = usdCount - markets.length;
  if (skipped > 0) {
    console.log(`[bitget] lewati ${skipped} pair USDT/USD yang bukan status online`);
  }

  const tickerStarted = Date.now();
  const tickerRes = await bitgetGet<BitgetTicker[]>("/api/v2/spot/market/tickers");
  logStep("Tickers", Date.now() - tickerStarted, tickerRes.rawText);
  rawResponses.push({ endpoint: tickerRes.url, rawJson: tickerRes.rawText });
  const tickerMap = new Map(
    (tickerRes.data.data ?? []).filter((row) => row.symbol).map((row) => [row.symbol as string, row]),
  );

  const fetchedAt = new Date().toISOString();
  const tickers = markets.map((market) =>
    withDerivedFields(toNormalizedTicker(market, tickerMap.get(market.rawSymbol), fetchedAt)),
  );

  const coinRaw = await applyPublicCoinFunding(markets);
  if (coinRaw) rawResponses.push(coinRaw);

  return { tickers, markets, rawResponses };
}

async function fetchOrderBook(rawSymbol: string, count = 5): Promise<OrderBookFetchResult> {
  const started = Date.now();
  const result = await bitgetGet<BitgetOrderbook>("/api/v2/spot/market/orderbook", {
    symbol: rawSymbol,
    limit: count,
  });
  logStep(`Orderbook ${rawSymbol}`, Date.now() - started, result.rawText);
  const book = result.data.data;
  if (!book || (!book.bids && !book.asks)) {
    throw new ExchangeApiError(
      `Bitget Orderbook: orderbook untuk ${rawSymbol} tidak ditemukan`,
      200,
      result.rawText.slice(0, 2000),
    );
  }

  const toLevels = (rows: Array<[string, string] | string[]> | undefined) =>
    (rows ?? []).slice(0, count).map((row) => ({
      price: Number(row[0]),
      volume: Number(row[1]),
      timestamp: toNumber(book.ts),
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

export const bitgetAdapter: ExchangeAdapter = {
  id: EXCHANGE_ID,
  name: "Bitget",
  fetchTickers,
  fetchOrderBook,
  spotUrl: (base, quote) => getSpotUrl(EXCHANGE_ID, base, quote),
};
