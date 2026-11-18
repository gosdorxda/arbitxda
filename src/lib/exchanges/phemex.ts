/**
 * Adapter Phemex — REST spot publik resmi.
 * Dokumentasi: https://phemex-docs.github.io/ (Spot API)
 * Host: https://api.phemex.com
 * Produk & koin: GET /public/products (type "Spot", status "Listed", quote USDT;
 *   currencies[].valueScale + name untuk skala volume & deteksi saham "Ondo Tokenized"/"xStock").
 * Ticker: GET /md/spot/ticker/24hr/all (lastEp/bidEp/askEp/openEp skala 1e8 (priceScale),
 *   volumeEv skala valueScale base, turnoverEv skala valueScale quote).
 *   Ticker tidak memuat ukuran bid/ask -> diisi lewat enrichBidAsk (order book).
 * Depth: GET /md/orderbook?symbol=sBTCUSDT (priceEp 1e8, sizeEv = valueScale base).
 * Depo/WD:
 *   - Tanpa key: GET /exchange/public/cfg/chain-settings?currency=  (daftar chain resmi;
 *     tidak ada flag depo/wd -> status null, chain permanentlyClosed = D✗ W✗).
 *   - Opsional key (PHEMEX_API_KEY + PHEMEX_API_SECRET, izin read-only):
 *     GET /phemex-deposit/wallets/api/chainCfg?currency=   (status Active/Suspend + contractAddress)
 *     GET /phemex-withdraw/wallets/api/asset/info?currency= (status per chain + contractAddress)
 *     Signature: HMAC-SHA256(path + query + expiry) header x-phemex-access-token /
 *     x-phemex-request-expiry / x-phemex-request-signature.
 */

import { createHmac } from "node:crypto";
import { withDerivedFields } from "../calc";
import { normalizeContracts } from "../contracts";
import { ExchangeApiError, fetchJson } from "../http";
import { createRateLimiter } from "../rate-limit";
import type {
  DerivedTicker,
  EnrichBidAskResult,
  EnrichDepositResult,
  EnrichNetworkStatus,
  EnrichPlan,
  ExchangeAdapter,
  MarketInfo,
  NormalizedTicker,
  OrderBookFetchResult,
  OrderBookLevel,
  RawResponse,
  TickerFetchResult,
} from "../types";
import { isLeveragedToken, isTokenizedStock } from "./stock-filter";

const EXCHANGE_ID = "phemex";
const BASE_URL = "https://api.phemex.com";
const ALLOWED_QUOTES = new Set(["USDT"]);
const PRICE_SCALE_DEFAULT = 8;
const schedule = createRateLimiter(150);

type PhemexCurrency = { currency?: string; name?: string; valueScale?: number; status?: string };
type PhemexProduct = {
  symbol?: string;
  type?: string;
  baseCurrency?: string;
  quoteCurrency?: string;
  status?: string;
  priceScale?: number;
};
type PhemexProducts = { code?: number; msg?: string; data?: { currencies?: PhemexCurrency[]; products?: PhemexProduct[] } };

type PhemexTicker = {
  symbol?: string;
  lastEp?: number;
  bidEp?: number;
  askEp?: number;
  openEp?: number;
  volumeEv?: number;
  turnoverEv?: number;
  timestamp?: number;
};
type PhemexMd<T> = { error?: unknown; id?: number; result?: T };
type PhemexBook = { book?: { asks?: Array<[number, number]>; bids?: Array<[number, number]> }; symbol?: string; timestamp?: number };

type PhemexChainSetting = {
  chainName?: string;
  displayName?: string;
  displayNetwork?: string;
  inUse?: boolean;
  permanentlyClosed?: number;
};
type PhemexEnvelope<T> = { code?: number | string; msg?: string; data?: T };
type PhemexDepositChain = { chainName?: string; status?: string; contractAddress?: string | null };
type PhemexWithdrawInfo = { chainInfos?: Array<{ chainName?: string; status?: string; contractAddress?: string | null }> };

type Scales = { priceScale: number; baseScale: number; quoteScale: number };

const scalesBySymbol = new Map<string, Scales>();

function toNum(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

function scaled(value: unknown, scale: number): number | null {
  const n = toNum(value);
  return n == null ? null : n / 10 ** scale;
}

function positive(n: number | null): number | null {
  return n != null && n > 0 ? n : null;
}

async function phemexGet<T>(path: string, query?: Record<string, string | number>, signal?: AbortSignal, throttle = true) {
  const qs = query
    ? new URLSearchParams(Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)]))).toString()
    : "";
  const url = `${BASE_URL}${path}${qs ? `?${qs}` : ""}`;
  const run = () => fetchJson<T>(url, { signal, retries: throttle ? 1 : 0 });
  const result = throttle ? await schedule(run) : await run();
  return { data: result.data, rawText: result.rawText, url };
}

function assertCode(body: { code?: number | string; msg?: string }, rawText: string, endpoint: string) {
  if (body.code == null) return;
  if (String(body.code) === "0") return;
  throw new ExchangeApiError(`Phemex ${endpoint}: ${body.msg || `kode ${body.code}`}`, 200, rawText.slice(0, 2000));
}

function assertMd(body: PhemexMd<unknown>, rawText: string, endpoint: string) {
  if (body.error == null && body.result != null) return;
  throw new ExchangeApiError(`Phemex ${endpoint}: ${JSON.stringify(body.error ?? "result kosong")}`, 200, rawText.slice(0, 2000));
}

function readCredentials(): { apiKey: string; apiSecret: string } | null {
  const apiKey = process.env.PHEMEX_API_KEY?.trim() ?? "";
  const apiSecret = process.env.PHEMEX_API_SECRET?.trim() ?? "";
  return apiKey && apiSecret ? { apiKey, apiSecret } : null;
}

async function phemexSignedGet<T>(
  path: string,
  query: Record<string, string>,
  creds: { apiKey: string; apiSecret: string },
  signal: AbortSignal,
) {
  const qs = new URLSearchParams(query).toString();
  const expiry = Math.floor(Date.now() / 1000) + 60;
  const signature = createHmac("sha256", creds.apiSecret).update(`${path}${qs}${expiry}`).digest("hex");
  const url = `${BASE_URL}${path}${qs ? `?${qs}` : ""}`;
  const result = await fetchJson<PhemexEnvelope<T>>(url, {
    signal,
    retries: 0,
    headers: {
      "x-phemex-access-token": creds.apiKey,
      "x-phemex-request-expiry": String(expiry),
      "x-phemex-request-signature": signature,
    },
  });
  assertCode(result.data, result.rawText, path);
  return result.data.data;
}

function toLevels(rows: Array<[number, number]> | undefined, scales: Scales, limit: number): OrderBookLevel[] {
  const out: OrderBookLevel[] = [];
  for (const row of rows ?? []) {
    const price = scaled(row?.[0], scales.priceScale);
    const volume = scaled(row?.[1], scales.baseScale);
    if (price == null || volume == null) continue;
    out.push({ price, volume, timestamp: null });
    if (out.length >= limit) break;
  }
  return out;
}

function scalesFor(rawSymbol: string): Scales {
  return scalesBySymbol.get(rawSymbol) ?? { priceScale: PRICE_SCALE_DEFAULT, baseScale: 8, quoteScale: 8 };
}

function toNormalizedTicker(market: MarketInfo, ticker: PhemexTicker | undefined, fetchedAt: string): NormalizedTicker {
  const s = scalesFor(market.rawSymbol);
  const last = scaled(ticker?.lastEp, s.priceScale);
  const open = scaled(ticker?.openEp, s.priceScale);
  const ts = toNum(ticker?.timestamp);
  return {
    exchange: EXCHANGE_ID,
    rawSymbol: market.rawSymbol,
    base: market.base,
    quote: market.quote,
    last: positive(last),
    bid: positive(scaled(ticker?.bidEp, s.priceScale)),
    ask: positive(scaled(ticker?.askEp, s.priceScale)),
    bidSize: null,
    askSize: null,
    baseVolume24h: scaled(ticker?.volumeEv, s.baseScale),
    quoteVolume24h: scaled(ticker?.turnoverEv, s.quoteScale),
    change24hPct: last != null && open != null && open > 0 ? ((last - open) / open) * 100 : null,
    // timestamp Phemex dalam nanodetik.
    exchangeTimestamp: ts != null ? new Date(Math.floor(ts / 1e6)).toISOString() : null,
    fetchedAt,
  };
}

async function fetchTickers(): Promise<TickerFetchResult> {
  const rawResponses: RawResponse[] = [];
  const [productsRes, tickerRes] = await Promise.all([
    phemexGet<PhemexProducts>("/public/products"),
    phemexGet<PhemexMd<PhemexTicker[]>>("/md/spot/ticker/24hr/all"),
  ]);
  assertCode(productsRes.data, productsRes.rawText, "/public/products");
  assertMd(tickerRes.data, tickerRes.rawText, "/md/spot/ticker/24hr/all");
  // /public/products ~2.5 MB (termasuk risk limit perpetual) — tidak disimpan utuh.
  rawResponses.push({ endpoint: productsRes.url, rawJson: productsRes.rawText.slice(0, 100_000) });
  rawResponses.push({ endpoint: tickerRes.url, rawJson: tickerRes.rawText });

  const currencies = new Map<string, PhemexCurrency>();
  for (const c of productsRes.data.data?.currencies ?? []) {
    const key = String(c.currency ?? "").trim().toUpperCase();
    if (key) currencies.set(key, c);
  }
  const tickerMap = new Map<string, PhemexTicker>();
  for (const t of tickerRes.data.result ?? []) {
    if (t.symbol) tickerMap.set(t.symbol, t);
  }

  const markets: MarketInfo[] = [];
  let skippedQuote = 0;
  for (const p of productsRes.data.data?.products ?? []) {
    if (p.type !== "Spot") continue;
    if (String(p.status ?? "") !== "Listed") continue;
    const rawSymbol = String(p.symbol ?? "").trim();
    const base = String(p.baseCurrency ?? "").trim().toUpperCase();
    const quote = String(p.quoteCurrency ?? "").trim().toUpperCase();
    if (!rawSymbol || !base || !quote) continue;
    if (!ALLOWED_QUOTES.has(quote)) {
      skippedQuote += 1;
      continue;
    }
    if (!tickerMap.has(rawSymbol)) continue;
    const baseCur = currencies.get(base);
    const quoteCur = currencies.get(quote);
    scalesBySymbol.set(rawSymbol, {
      priceScale: toNum(p.priceScale) ?? PRICE_SCALE_DEFAULT,
      baseScale: toNum(baseCur?.valueScale) ?? 8,
      quoteScale: toNum(quoteCur?.valueScale) ?? 8,
    });
    const displayName = (baseCur?.name ?? "").trim() || null;
    const names = displayName ? [displayName] : undefined;
    markets.push({
      rawSymbol,
      base,
      quote,
      active: true,
      status: p.status ?? null,
      isStock: isTokenizedStock({ base, rawSymbol, names }),
      isLeveraged: isLeveragedToken({ base, rawSymbol, names }),
      displayName,
    });
  }
  if (skippedQuote > 0) console.log(`[phemex] lewati ${skippedQuote} pair bukan USDT`);

  const fetchedAt = new Date().toISOString();
  const tickers: DerivedTicker[] = markets.map((m) => withDerivedFields(toNormalizedTicker(m, tickerMap.get(m.rawSymbol), fetchedAt)));
  return { tickers, markets, rawResponses };
}

async function loadBook(rawSymbol: string, signal?: AbortSignal, throttle = true) {
  const result = await phemexGet<PhemexMd<PhemexBook>>("/md/orderbook", { symbol: rawSymbol }, signal, throttle);
  assertMd(result.data, result.rawText, "/md/orderbook");
  return result;
}

async function fetchOrderBook(rawSymbol: string, count = 5): Promise<OrderBookFetchResult> {
  const symbol = rawSymbol.trim();
  const limit = Math.max(1, count);
  const result = await loadBook(symbol);
  const s = scalesFor(symbol);
  const book = result.data.result?.book;
  return {
    endpoint: result.url,
    rawJson: result.rawText,
    orderbook: {
      exchange: EXCHANGE_ID,
      rawSymbol: symbol,
      bids: toLevels(book?.bids, s, limit),
      asks: toLevels(book?.asks, s, limit),
      fetchedAt: new Date().toISOString(),
    },
  };
}

function buildEnrichPlan(input: { tickers: DerivedTicker[]; markets: MarketInfo[] }): EnrichPlan {
  const bidAsk = input.tickers.map((t) => ({ rawSymbol: t.rawSymbol, quoteVolume24h: t.quoteVolume24h }));
  const volumeByBase = new Map<string, number>();
  for (const t of input.tickers) {
    const key = t.base.toUpperCase();
    volumeByBase.set(key, Math.max(volumeByBase.get(key) ?? 0, t.quoteVolume24h ?? 0));
  }
  return {
    bidAsk,
    deposits: [...volumeByBase.entries()].map(([base, quoteVolume24h]) => ({ base, quoteVolume24h })),
  };
}

async function enrichBidAsk(rawSymbol: string, signal: AbortSignal): Promise<EnrichBidAskResult> {
  const result = await loadBook(rawSymbol, signal, false);
  const s = scalesFor(rawSymbol);
  const bid = toLevels(result.data.result?.book?.bids, s, 1)[0];
  const ask = toLevels(result.data.result?.book?.asks, s, 1)[0];
  return { rawSymbol, bid: bid?.price ?? null, ask: ask?.price ?? null, bidSize: bid?.volume ?? null, askSize: ask?.volume ?? null };
}

function isActiveStatus(status: string | undefined): boolean {
  return String(status ?? "").trim().toLowerCase() === "active";
}

let loggedMissingKeys = false;

async function enrichDeposit(base: string, signal: AbortSignal): Promise<EnrichDepositResult> {
  const currency = base.toUpperCase();
  const creds = readCredentials();
  if (creds) {
    const [deposit, withdraw] = await Promise.all([
      phemexSignedGet<PhemexDepositChain[]>("/phemex-deposit/wallets/api/chainCfg", { currency }, creds, signal),
      phemexSignedGet<PhemexWithdrawInfo>("/phemex-withdraw/wallets/api/asset/info", { currency }, creds, signal).catch(
        () => null,
      ),
    ]);
    const byChain = new Map<string, EnrichNetworkStatus>();
    const contracts: Array<{ chain: string; contract: string | null | undefined }> = [];
    for (const row of deposit ?? []) {
      const name = (row.chainName ?? "?").trim() || "?";
      byChain.set(name, { name, deposit: isActiveStatus(row.status), withdraw: null });
      contracts.push({ chain: name, contract: row.contractAddress });
    }
    for (const row of withdraw?.chainInfos ?? []) {
      const name = (row.chainName ?? "?").trim() || "?";
      const entry = byChain.get(name) ?? { name, deposit: null, withdraw: null };
      entry.withdraw = isActiveStatus(row.status);
      byChain.set(name, entry);
      contracts.push({ chain: name, contract: row.contractAddress });
    }
    const networks = [...byChain.values()];
    const depositEnabled = networks.length === 0 ? null : networks.some((n) => n.deposit === true) ? 1 : 0;
    return { base, depositEnabled, networks, contracts: networks.length > 0 ? normalizeContracts(contracts) : undefined };
  }

  if (!loggedMissingKeys) {
    loggedMissingKeys = true;
    console.log("[phemex] PHEMEX_API_KEY/PHEMEX_API_SECRET belum diisi, hanya daftar chain publik (tanpa status depo/wd & kontrak)");
  }
  const result = await phemexGet<PhemexEnvelope<Record<string, PhemexChainSetting[]>>>(
    "/exchange/public/cfg/chain-settings",
    { currency },
    signal,
    false,
  );
  assertCode(result.data, result.rawText, "/exchange/public/cfg/chain-settings");
  const rows = result.data.data?.[currency] ?? [];
  const byName = new Map<string, EnrichNetworkStatus>();
  for (const row of rows) {
    const closed = Number(row.permanentlyClosed ?? 0) === 1 || row.inUse === false;
    const display = (row.displayNetwork ?? "").trim();
    const chain = (row.chainName ?? "").trim();
    let name = display || chain || "?";
    // displayNetwork bisa dobel (mis. MATIC lama & POL), pakai chainName sebagai pembeda.
    if (byName.has(name) && chain && chain !== name) name = chain;
    const prev = byName.get(name);
    // Jika ada entri chain sama yang masih aktif, jangan timpa dengan status tutup.
    if (prev && prev.deposit === null) continue;
    byName.set(name, { name, deposit: closed ? false : null, withdraw: closed ? false : null });
  }
  const networks = [...byName.values()];
  return { base, depositEnabled: null, networks };
}

export const phemexAdapter: ExchangeAdapter = {
  id: EXCHANGE_ID,
  name: "Phemex",
  fetchTickers,
  fetchOrderBook,
  spotUrl: (base, quote) =>
    base && quote ? `https://phemex.com/spot/trade/${base.toUpperCase()}${quote.toUpperCase()}` : null,
  enrichConcurrency: 3,
  buildEnrichPlan,
  enrichBidAsk,
  enrichDeposit,
};
