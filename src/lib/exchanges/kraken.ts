import { withDerivedFields } from "../calc";
import { DEFAULT_TIMEOUT_MS, ExchangeApiError, fetchJson } from "../http";
import { createRateLimiter, sleep } from "../rate-limit";
import type {
  ExchangeAdapter,
  MarketInfo,
  NormalizedTicker,
  OrderBookFetchResult,
  TickerFetchResult,
} from "../types";
import { getSpotUrl } from "./spot-urls";

const BASE_URL = "https://api.kraken.com";
const EXCHANGE_ID = "kraken";

// Kraken public REST: jaga interval aman biar tidak kena rate limit.
const schedule = createRateLimiter(400);

type KrakenAssetPair = {
  altname?: string;
  wsname?: string;
  base: string;
  quote: string;
  status?: string;
  aclass_base?: string;
};

type KrakenPairsResponse = {
  error: string[];
  result?: Record<string, KrakenAssetPair>;
};

type KrakenTicker = {
  a?: string[];
  b?: string[];
  c?: string[];
  v?: string[];
  p?: string[];
  t?: number[];
  l?: string[];
  h?: string[];
  o?: string;
};

type KrakenTickerResponse = {
  error: string[];
  result?: Record<string, KrakenTicker>;
};

type KrakenDepth = {
  asks?: Array<[string, string, number]>;
  bids?: Array<[string, string, number]>;
};

type KrakenDepthResponse = {
  error: string[];
  result?: Record<string, KrakenDepth>;
};

type KrakenAsset = {
  altname?: string;
  status?: string;
};

type KrakenAssetsResponse = {
  error: string[];
  result?: Record<string, KrakenAsset>;
};

type AssetFunding = {
  depositEnabled: number | null;
  withdrawEnabled: number | null;
  chainstatusRaw: string | null;
};

/**
 * Alias aset klasik Kraken.
 * XXBT/XBT -> BTC, XXDG/XDG -> DOGE. Sisanya memakai wsname (ETH, LTC, EUR, dst).
 */
const ASSET_ALIASES: Record<string, string> = {
  XBT: "BTC",
  XXBT: "BTC",
  XDG: "DOGE",
  XXDG: "DOGE",
};

function normalizeAsset(code: string): string {
  const upper = code.trim().toUpperCase();
  return ASSET_ALIASES[upper] ?? upper;
}

function mapAssetStatus(status?: string | null): AssetFunding {
  const raw = status?.trim() || null;
  switch ((raw ?? "").toLowerCase()) {
    case "enabled":
      return { depositEnabled: 1, withdrawEnabled: 1, chainstatusRaw: raw };
    case "deposit_only":
      return { depositEnabled: 1, withdrawEnabled: 0, chainstatusRaw: raw };
    case "withdrawal_only":
      return { depositEnabled: 0, withdrawEnabled: 1, chainstatusRaw: raw };
    case "funding_temporarily_disabled":
      return { depositEnabled: 0, withdrawEnabled: 0, chainstatusRaw: raw };
    default:
      return { depositEnabled: null, withdrawEnabled: null, chainstatusRaw: raw };
  }
}

function indexAssetFunding(assets: Record<string, KrakenAsset>): Map<string, AssetFunding> {
  const index = new Map<string, AssetFunding>();
  const remember = (key: string | undefined, funding: AssetFunding) => {
    if (!key) return;
    index.set(key.trim().toUpperCase(), funding);
    index.set(normalizeAsset(key), funding);
  };
  for (const [key, asset] of Object.entries(assets)) {
    const funding = mapAssetStatus(asset.status);
    remember(key, funding);
    remember(asset.altname, funding);
  }
  return index;
}

function parseWsname(wsname?: string): { base: string; quote: string } | null {
  if (!wsname || !wsname.includes("/")) return null;
  const [base, quote] = wsname.split("/");
  if (!base || !quote) return null;
  return { base: normalizeAsset(base), quote: normalizeAsset(quote) };
}

function isUsdQuote(pair: KrakenAssetPair): boolean {
  const quote = (pair.quote || "").toUpperCase();
  return quote === "ZUSD" || quote === "USD";
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function assertKrakenOk(error: string[] | undefined, rawText: string, endpoint: string) {
  if (error && error.length > 0) {
    throw new ExchangeApiError(`Kraken ${endpoint}: ${error.join("; ")}`, 200, rawText.slice(0, 2000));
  }
}

function logStep(step: string, ms: number, rawText?: string) {
  if (rawText != null) {
    const kb = (Buffer.byteLength(rawText, "utf8") / 1024).toFixed(1);
    console.log(`[kraken] ${step} ${ms}ms (${kb} KB)`);
  } else {
    console.log(`[kraken] ${step} ${ms}ms`);
  }
}

async function krakenGet<T extends { error: string[] }>(
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
  const doFetch = () => schedule(() => fetchJson<T>(href, { timeoutMs: DEFAULT_TIMEOUT_MS, retries: 1 }));

  // Satu retry tambahan khusus pesan rate limit dari Kraken (bukan retry jaringan).
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { data, rawText } = await doFetch();
    const errors = data.error ?? [];
    const rateLimited = errors.some((msg) => /rate limit/i.test(msg));
    if (rateLimited && attempt < 1) {
      lastError = new ExchangeApiError(`Kraken rate limit: ${errors.join("; ")}`, 429, rawText.slice(0, 2000));
      await sleep(2000);
      continue;
    }
    assertKrakenOk(errors, rawText, endpoint);
    return { data, rawText, url: href };
  }

  throw lastError ?? new ExchangeApiError(`Gagal memanggil ${endpoint}`);
}

function resolveMarket(
  pairKey: string,
  pair: KrakenAssetPair,
): MarketInfo {
  const parsed = parseWsname(pair.wsname);
  const base = parsed?.base ?? normalizeAsset(pair.base);
  const quote = parsed?.quote ?? normalizeAsset(pair.quote);
  const status = pair.status ?? "online";
  return {
    rawSymbol: pairKey,
    base,
    quote,
    active: status === "online",
    status,
    isStock: (pair.aclass_base ?? "").toLowerCase() === "tokenized_asset",
  };
}

function pickTicker(
  tickers: Record<string, KrakenTicker>,
  pairKey: string,
  altname?: string,
): KrakenTicker | undefined {
  return tickers[pairKey] ?? (altname ? tickers[altname] : undefined);
}

function toNormalizedTicker(
  pairKey: string,
  market: MarketInfo,
  ticker: KrakenTicker | undefined,
  fetchedAt: string,
): NormalizedTicker {
  const last = toNumber(ticker?.c?.[0]);
  const bid = toNumber(ticker?.b?.[0]);
  const ask = toNumber(ticker?.a?.[0]);
  const bidSize = toNumber(ticker?.b?.[2] ?? ticker?.b?.[1]);
  const askSize = toNumber(ticker?.a?.[2] ?? ticker?.a?.[1]);
  const baseVolume24h = toNumber(ticker?.v?.[1]);
  const vwap24h = toNumber(ticker?.p?.[1]);
  const quoteVolume24h =
    baseVolume24h != null && vwap24h != null
      ? baseVolume24h * vwap24h
      : baseVolume24h != null && last != null
        ? baseVolume24h * last
        : null;
  const open = toNumber(ticker?.o);
  const change24hPct =
    last != null && open != null && open !== 0 ? ((last - open) / open) * 100 : null;

  return {
    exchange: EXCHANGE_ID,
    rawSymbol: pairKey,
    base: market.base,
    quote: market.quote,
    last,
    bid,
    ask,
    bidSize,
    askSize,
    baseVolume24h,
    quoteVolume24h,
    change24hPct,
    exchangeTimestamp: null,
    fetchedAt,
  };
}

async function fetchTickers(): Promise<TickerFetchResult> {
  // Ambil semua pair, lalu saring USD di sisi kita. Ticker tanpa param pair
  // mengembalikan seluruh pasar dalam 1 request, jadi tidak perlu batch + rate limit.
  const pairsStarted = Date.now();
  const pairsRes = await krakenGet<KrakenPairsResponse>("/0/public/AssetPairs");
  logStep("AssetPairs", Date.now() - pairsStarted, pairsRes.rawText);
  const rawResponses = [{ endpoint: pairsRes.url, rawJson: pairsRes.rawText }];
  const allPairs = pairsRes.data.result ?? {};

  const usdEntries = Object.entries(allPairs).filter(([, pair]) => isUsdQuote(pair));
  // cancel_only = pasar sudah ST/delisting di Kraken; jangan simpan ke DB.
  const keptEntries = usdEntries.filter(([, pair]) => (pair.status ?? "").toLowerCase() !== "cancel_only");
  const skippedCancelOnly = usdEntries.length - keptEntries.length;
  if (skippedCancelOnly > 0) {
    console.log(`[kraken] lewati ${skippedCancelOnly} pair cancel_only`);
  }
  const markets = keptEntries.map(([key, pair]) => resolveMarket(key, pair));
  const marketByKey = new Map(keptEntries.map(([key, pair], idx) => [key, { pair, market: markets[idx] }]));

  try {
    const assetsStarted = Date.now();
    const assetsRes = await krakenGet<KrakenAssetsResponse>("/0/public/Assets");
    logStep("Assets", Date.now() - assetsStarted, assetsRes.rawText);
    rawResponses.push({ endpoint: assetsRes.url, rawJson: assetsRes.rawText });
    const fundingByAsset = indexAssetFunding(assetsRes.data.result ?? {});
    let matched = 0;
    for (const market of markets) {
      const funding = fundingByAsset.get(market.base) ?? fundingByAsset.get(market.base.toUpperCase());
      if (!funding) continue;
      market.depositEnabled = funding.depositEnabled;
      market.withdrawEnabled = funding.withdrawEnabled;
      market.chainstatusRaw = funding.chainstatusRaw;
      matched += 1;
    }
    console.log(`[kraken] status depo/wd terisi untuk ${matched}/${markets.length} pair`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[kraken] Assets gagal, status depo/wd dibiarkan kosong: ${message}`);
  }

  const tickerStarted = Date.now();
  const tickerRes = await krakenGet<KrakenTickerResponse>("/0/public/Ticker");
  logStep("Ticker", Date.now() - tickerStarted, tickerRes.rawText);
  rawResponses.push({ endpoint: tickerRes.url, rawJson: tickerRes.rawText });
  const tickerMap = tickerRes.data.result ?? {};

  const fetchedAt = new Date().toISOString();
  const tickers = keptEntries.map(([key, pair]) => {
    const market = marketByKey.get(key)!.market;
    const rawTicker = pickTicker(tickerMap, key, pair.altname);
    return withDerivedFields(toNormalizedTicker(key, market, rawTicker, fetchedAt));
  });

  return { tickers, markets, rawResponses };
}

async function fetchOrderBook(rawSymbol: string, count = 5): Promise<OrderBookFetchResult> {
  const started = Date.now();
  const result = await krakenGet<KrakenDepthResponse>("/0/public/Depth", {
    pair: rawSymbol,
    count,
  });
  logStep(`Depth ${rawSymbol}`, Date.now() - started, result.rawText);
  const books = result.data.result ?? {};
  const book = books[rawSymbol] ?? books[Object.keys(books)[0] ?? ""];
  if (!book) {
    throw new ExchangeApiError(`Kraken Depth: orderbook untuk ${rawSymbol} tidak ditemukan`, 200, result.rawText.slice(0, 2000));
  }

  const toLevels = (rows: Array<[string, string, number]> | undefined) =>
    (rows ?? []).slice(0, count).map(([price, volume, timestamp]) => ({
      price: Number(price),
      volume: Number(volume),
      timestamp: timestamp ?? null,
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

export const krakenAdapter: ExchangeAdapter = {
  id: EXCHANGE_ID,
  name: "Kraken",
  fetchTickers,
  fetchOrderBook,
  spotUrl: (base, quote) => getSpotUrl(EXCHANGE_ID, base, quote),
};
