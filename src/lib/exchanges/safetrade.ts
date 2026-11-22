/**
 * Adapter SafeTrade — REST spot resmi (publik, tanpa API key).
 * Dokumentasi: https://safetrade.com/api  (OpenAPI: /api/v2/trade/public/swagger.json)
 * Host: https://safe.trade/api/v2 (cadangan: https://safetrade.com/api/v2).
 * Cloudflare memblokir Node fetch, jadi request memakai curl; host yang tembus diingat.
 * Pasar: GET /trade/public/markets (id seperti btcusdt, state, base_unit, quote_unit).
 * Ticker massal: GET /trade/public/tickers (last, volume=quote 24 jam, amount=base 24 jam; tanpa bid/ask).
 * Fetch utama tidak memanggil depth per pair (bid/ask dikosongkan) supaya selesai dalam beberapa detik.
 * Depth on-demand: GET /trade/public/markets/{id}/depth?limit= lewat modal order book.
 * Depo/WD + kontrak: GET /trade/public/currencies (networks.deposit_enabled / withdraw_enabled,
 *   options.erc20_contract_address jika ada).
 * Websocket di dokumentasi sengaja tidak dipakai.
 */

import { spawn } from "node:child_process";
import { platform } from "node:os";
import { withDerivedFields } from "../calc";
import { normalizeContracts } from "../contracts";
import { DEFAULT_TIMEOUT_MS, ExchangeApiError } from "../http";
import { createRateLimiter, sleep } from "../rate-limit";
import type {
  DerivedTicker,
  ExchangeAdapter,
  MarketInfo,
  NormalizedTicker,
  OrderBookFetchResult,
  OrderBookLevel,
  RawResponse,
  TickerFetchResult,
  TokenContract,
} from "../types";
import { isLeveragedToken, isTokenizedStock } from "./stock-filter";

const EXCHANGE_ID = "safetrade";
const PRIMARY_HOST = "https://safe.trade/api/v2";
const BACKUP_HOST = "https://safetrade.com/api/v2";
const HOSTS = [PRIMARY_HOST, BACKUP_HOST];
const ALLOWED_QUOTES = new Set(["USDT", "USD"]);
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BASE_MS = 2000;
const schedule = createRateLimiter(200);

let activeHost = PRIMARY_HOST;
const unreachableHosts = new Set<string>();
let rateLimitedUntil = 0;
const CURL_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const CONNECT_TIMEOUT_SEC = 5;
const STATUS_MARK = "__HTTPSTATUS__:";

/**
 * Cloudflare memblokir Node fetch (403) di SafeTrade, sementara curl ke host
 * yang sama lolos. safe.trade kadang tidak tembus dari beberapa jaringan
 * (timeout), jadi host yang berhasil diingat.
 */
function curlBinary(): string {
  return platform() === "win32" ? "curl.exe" : "curl";
}

function looksLikeJson(body: string): boolean {
  const text = body.trim();
  return text.startsWith("{") || text.startsWith("[");
}

function isCloudflareBlock(status: number, body: string): boolean {
  if (status !== 403 && status !== 503 && status !== 200) return false;
  return /cloudflare|cf-error|attention required|you have been blocked|cf-challenge|just a moment/i.test(body);
}

function isUsableHttpStatus(status: number): boolean {
  return Number.isFinite(status) && status >= 100 && status <= 599;
}

function runCurl(url: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const args = [
      "-sS",
      "-L",
      "--connect-timeout",
      String(CONNECT_TIMEOUT_SEC),
      "--max-time",
      String(Math.max(CONNECT_TIMEOUT_SEC + 1, Math.ceil(timeoutMs / 1000))),
      "-A",
      CURL_UA,
      "-H",
      "Accept: application/json",
      "--compressed",
      "-w",
      `\n${STATUS_MARK}%{http_code}`,
      url,
    ];
    const child = spawn(curlBinary(), args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(new ExchangeApiError(`SafeTrade curl tidak bisa dijalankan: ${error.message}`, undefined, stderr.slice(0, 500)));
    });
    child.on("close", (code) => {
      const idx = stdout.lastIndexOf(`\n${STATUS_MARK}`);
      const markAt = idx >= 0 ? idx : stdout.lastIndexOf(STATUS_MARK);
      let status = 0;
      let body = stdout;
      if (markAt >= 0) {
        body = idx >= 0 ? stdout.slice(0, idx) : stdout.slice(0, markAt);
        status = Number(stdout.slice(markAt + (idx >= 0 ? `\n${STATUS_MARK}`.length : STATUS_MARK.length)).trim());
      }
      // curl --connect-timeout ke safe.trade menulis status 000 + body kosong (exit 28).
      // Itu bukan respons HTTP sukses; jangan di-parse sebagai JSON.
      if (code !== 0 && !isUsableHttpStatus(status)) {
        const detail = (stderr || `curl exit ${code}`).trim().slice(0, 500);
        reject(new ExchangeApiError(`SafeTrade curl gagal ke ${url}: ${detail || "timeout/koneksi"}`));
        return;
      }
      if (isUsableHttpStatus(status)) {
        resolve({ status, body });
        return;
      }
      const detail = (stderr || stdout || `exit ${code}`).trim().slice(0, 500);
      reject(new ExchangeApiError(`SafeTrade curl gagal ke ${url}: ${detail || "tanpa keluaran"}`));
    });
  });
}

type SafeMarket = {
  id?: string;
  symbol?: string;
  name?: string;
  base_unit?: string;
  quote_unit?: string;
  state?: string;
};

type SafeTicker = {
  id?: string;
  name?: string;
  base_unit?: string;
  quote_unit?: string;
  last?: string | number;
  volume?: string | number;
  amount?: string | number;
  price_change_percent?: string;
  high?: string | number;
  low?: string | number;
  open?: string | number;
  avg_price?: string | number;
};

type SafeDepth = {
  asks?: Array<[string, string] | string[]>;
  bids?: Array<[string, string] | string[]>;
  sequence?: number;
};

type SafeNetwork = {
  blockchain_key?: string;
  protocol?: string;
  protocol_name?: string;
  deposit_enabled?: boolean;
  withdraw_enabled?: boolean;
  status?: string;
  options?: Record<string, unknown> | null;
};

type SafeCurrency = {
  id?: string;
  name?: string;
  status?: string;
  networks?: SafeNetwork[] | null;
};

type AssetFunding = {
  depositEnabled: number;
  withdrawEnabled: number;
  chainstatusRaw: string;
  contracts: TokenContract[];
};

type ApiResponse<T> = { data: T; rawText: string; url: string };

function toNum(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim().replace(/%/g, "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function isRetryableHostError(error: unknown): boolean {
  if (error instanceof ExchangeApiError) {
    const status = error.status;
    const body = error.body ?? "";
    if (status == null || status === 0 || status === 403 || status === 408 || status === 429 || status >= 500) {
      return true;
    }
    if (!looksLikeJson(body) || isCloudflareBlock(status, body)) return true;
    if (/bukan JSON|curl gagal|timeout|koneksi/i.test(error.message)) return true;
  }
  return true;
}

function isUnreachableHostError(error: unknown): boolean {
  if (error instanceof ExchangeApiError) {
    if (error.status == null || error.status === 0) return true;
    if (/timeout|timed out|koneksi|curl gagal/i.test(error.message) && !isUsableHttpStatus(error.status ?? 0)) {
      return true;
    }
  }
  return error instanceof Error && /timeout|timed out after|Could not resolve|Connection timed out/i.test(error.message);
}

function isRateLimitedError(error: unknown): boolean {
  return error instanceof ExchangeApiError && error.status === 429;
}

async function waitIfRateLimited(): Promise<void> {
  const wait = rateLimitedUntil - Date.now();
  if (wait > 0) await sleep(wait);
}

function noteRateLimited(waitMs: number): void {
  rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + waitMs);
}

function markUnreachable(host: string, reason: string): void {
  if (unreachableHosts.has(host)) return;
  unreachableHosts.add(host);
  if (activeHost === host) {
    const fallback = HOSTS.find((candidate) => !unreachableHosts.has(candidate));
    if (fallback) activeHost = fallback;
  }
  console.log(`[safetrade] ${host} ditandai unreachable (${reason.slice(0, 120)})`);
}

async function parseJsonBody<T>(path: string, host: string, status: number, body: string): Promise<T> {
  if (!looksLikeJson(body)) {
    throw new ExchangeApiError(`SafeTrade ${path}: respons bukan JSON dari ${host}`, status, body.slice(0, 2000));
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new ExchangeApiError(`SafeTrade ${path}: respons bukan JSON dari ${host}`, status, body.slice(0, 2000));
  }
}

async function safeGet<T>(path: string, query?: Record<string, string | number>): Promise<ApiResponse<T>> {
  const qs = query
    ? `?${new URLSearchParams(Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)]))).toString()}`
    : "";
  const relative = `${path}${qs}`;
  const attempted = new Set<string>();
  let lastError: unknown;

  while (attempted.size < HOSTS.length) {
    const host = [activeHost, ...HOSTS].find((candidate) => !attempted.has(candidate) && !unreachableHosts.has(candidate));
    if (!host) break;
    const url = `${host}${relative}`;
    let rateLimitTries = 0;
    let giveUpHost = false;
    while (!giveUpHost) {
      try {
        await waitIfRateLimited();
        const result = await schedule(() => runCurl(url, DEFAULT_TIMEOUT_MS));
        if (!isUsableHttpStatus(result.status) || result.status >= 400) {
          throw new ExchangeApiError(
            `HTTP ${result.status} dari ${url}`,
            result.status,
            result.body.slice(0, 2000),
          );
        }
        const data = await parseJsonBody<T>(path, host, result.status, result.body);
        activeHost = host;
        return { data, rawText: result.body, url };
      } catch (error) {
        lastError = error;
        if (isUnreachableHostError(error)) {
          const why = error instanceof Error ? error.message : String(error);
          markUnreachable(host, why);
          giveUpHost = true;
          break;
        }
        if (isRateLimitedError(error) && rateLimitTries < RATE_LIMIT_RETRIES) {
          rateLimitTries += 1;
          const waitMs = RATE_LIMIT_BASE_MS * rateLimitTries;
          noteRateLimited(waitMs);
          console.log(`[safetrade] ${host} HTTP 429 pada ${path}, retry ${rateLimitTries}/${RATE_LIMIT_RETRIES} dalam ${waitMs}ms`);
          await waitIfRateLimited();
          continue;
        }
        if (isRetryableHostError(error) && HOSTS.some((candidate) => candidate !== host && !attempted.has(candidate) && !unreachableHosts.has(candidate))) {
          const why = error instanceof Error ? error.message : String(error);
          console.log(`[safetrade] ${host} gagal, coba host cadangan: ${why.slice(0, 180)}`);
          giveUpHost = true;
          break;
        }
        throw error;
      }
    }
    attempted.add(host);
  }
  throw lastError instanceof Error ? lastError : new Error("SafeTrade: semua host gagal");
}

function networkName(net: SafeNetwork): string {
  return (net.protocol_name || net.protocol || net.blockchain_key || "?").trim() || "?";
}

function contractFromOptions(options: Record<string, unknown> | null | undefined): string | null {
  if (!options) return null;
  const direct = options.erc20_contract_address;
  const raw = typeof direct === "string" ? direct.trim() : "";
  if (raw && !/^https?:\/\//i.test(raw)) return raw;
  for (const [key, value] of Object.entries(options)) {
    if (!/contract_address$/i.test(key) || typeof value !== "string") continue;
    const addr = value.trim();
    if (addr && !/^https?:\/\//i.test(addr)) return addr;
  }
  return null;
}

function summarizeNetworks(currency: SafeCurrency): AssetFunding | null {
  const networks = currency.networks ?? [];
  if (networks.length === 0) return null;
  let depositEnabled = 0;
  let withdrawEnabled = 0;
  const parts: string[] = [];
  const contractRows: Array<{ chain: string; contract: string | null }> = [];
  for (const net of networks) {
    const name = networkName(net);
    const deposit = net.deposit_enabled === true;
    const withdraw = net.withdraw_enabled === true;
    if (deposit) depositEnabled = 1;
    if (withdraw) withdrawEnabled = 1;
    parts.push(`${name}: D${deposit ? "✓" : "✗"} W${withdraw ? "✓" : "✗"}`);
    contractRows.push({ chain: name, contract: contractFromOptions(net.options) });
  }
  return {
    depositEnabled,
    withdrawEnabled,
    chainstatusRaw: parts.join(", "),
    contracts: normalizeContracts(contractRows),
  };
}

function toNormalizedTicker(
  market: MarketInfo,
  row: SafeTicker | undefined,
  book: { bid: number | null; ask: number | null; bidSize: number | null; askSize: number | null },
  fetchedAt: string,
): NormalizedTicker {
  return {
    exchange: EXCHANGE_ID,
    rawSymbol: market.rawSymbol,
    base: market.base,
    quote: market.quote,
    last: toNum(row?.last),
    bid: book.bid,
    ask: book.ask,
    bidSize: book.bidSize,
    askSize: book.askSize,
    // volume = quote 24 jam, amount = base 24 jam (dicek BTC/USDT).
    baseVolume24h: toNum(row?.amount),
    quoteVolume24h: toNum(row?.volume),
    change24hPct: toNum(row?.price_change_percent),
    exchangeTimestamp: null,
    fetchedAt,
  };
}

function toLevels(rows: Array<[string, string] | string[]> | undefined, limit: number, side: "bid" | "ask"): OrderBookLevel[] {
  const out: OrderBookLevel[] = [];
  for (const row of rows ?? []) {
    const price = toNum(row[0]);
    const volume = toNum(row[1]);
    if (price == null || volume == null) continue;
    out.push({ price, volume, timestamp: null });
  }
  out.sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price));
  return out.slice(0, limit);
}

const EMPTY_BOOK = { bid: null, ask: null, bidSize: null, askSize: null };

async function fetchTickers(): Promise<TickerFetchResult> {
  const rawResponses: RawResponse[] = [];
  const [marketRes, tickerRes, currencyRes] = await Promise.all([
    safeGet<SafeMarket[]>("/trade/public/markets"),
    safeGet<Record<string, SafeTicker>>("/trade/public/tickers"),
    safeGet<SafeCurrency[]>("/trade/public/currencies").catch((error: unknown) => {
      console.log(
        `[safetrade] currencies gagal, Depo/WD dikosongkan: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }),
  ]);
  rawResponses.push({ endpoint: marketRes.url, rawJson: marketRes.rawText });
  rawResponses.push({ endpoint: tickerRes.url, rawJson: tickerRes.rawText });
  if (currencyRes) rawResponses.push({ endpoint: currencyRes.url, rawJson: currencyRes.rawText });

  const tickerMap = new Map<string, SafeTicker>();
  for (const [id, row] of Object.entries(tickerRes.data ?? {})) {
    const key = (row.id || id).trim().toLowerCase();
    if (key) tickerMap.set(key, row);
  }

  const fundingByCoin = new Map<string, AssetFunding>();
  const nameByCoin = new Map<string, string>();
  for (const row of currencyRes?.data ?? []) {
    const key = String(row.id ?? "").trim().toUpperCase();
    if (!key) continue;
    const funding = summarizeNetworks(row);
    if (funding) fundingByCoin.set(key, funding);
    const name = row.name?.trim();
    if (name) nameByCoin.set(key, name);
  }

  const markets: MarketInfo[] = [];
  let skippedQuote = 0;
  let skippedInactive = 0;
  for (const row of marketRes.data ?? []) {
    const rawSymbol = String(row.id || row.symbol || "").trim().toLowerCase();
    const base = String(row.base_unit ?? "").trim().toUpperCase();
    const quote = String(row.quote_unit ?? "").trim().toUpperCase();
    if (!rawSymbol || !base || !quote) continue;
    if (!ALLOWED_QUOTES.has(quote)) {
      skippedQuote += 1;
      continue;
    }
    const state = String(row.state ?? "").trim().toLowerCase();
    if (state && state !== "enabled") {
      skippedInactive += 1;
      continue;
    }
    const displayName = nameByCoin.get(base) ?? row.name?.trim() ?? null;
    const names = displayName ? [displayName] : undefined;
    const market: MarketInfo = {
      rawSymbol,
      base,
      quote,
      active: true,
      status: state || "enabled",
      isStock: isTokenizedStock({ base, rawSymbol, names }),
      isLeveraged: isLeveragedToken({ base, rawSymbol, names }),
      displayName,
    };
    const funding = fundingByCoin.get(base);
    if (funding) {
      market.depositEnabled = funding.depositEnabled;
      market.withdrawEnabled = funding.withdrawEnabled;
      market.chainstatusRaw = funding.chainstatusRaw;
      market.contracts = funding.contracts;
    }
    markets.push(market);
  }

  if (skippedQuote > 0) console.log(`[safetrade] lewati ${skippedQuote} pair bukan USDT/USD`);
  if (skippedInactive > 0) console.log(`[safetrade] lewati ${skippedInactive} pair tidak enabled`);

  const fetchedAt = new Date().toISOString();
  const tickers: DerivedTicker[] = markets.map((market) =>
    withDerivedFields(toNormalizedTicker(market, tickerMap.get(market.rawSymbol), EMPTY_BOOK, fetchedAt)),
  );
  return { tickers, markets, rawResponses };
}

async function fetchOrderBook(rawSymbol: string, count = 5): Promise<OrderBookFetchResult> {
  const market = rawSymbol.trim().toLowerCase();
  const limit = Math.min(Math.max(1, count), 1000);
  const result = await safeGet<SafeDepth>(`/trade/public/markets/${encodeURIComponent(market)}/depth`, { limit });
  return {
    endpoint: result.url,
    rawJson: result.rawText,
    orderbook: {
      exchange: EXCHANGE_ID,
      rawSymbol: market,
      bids: toLevels(result.data.bids, limit, "bid"),
      asks: toLevels(result.data.asks, limit, "ask"),
      fetchedAt: new Date().toISOString(),
    },
  };
}

export function safetradeSpotUrl(base: string, quote: string): string | null {
  if (!base || !quote) return null;
  return `https://safetrade.com/exchange/${base.toUpperCase()}-${quote.toUpperCase()}?type=basic`;
}

export const safetradeAdapter: ExchangeAdapter = {
  id: EXCHANGE_ID,
  name: "SafeTrade",
  fetchTickers,
  fetchOrderBook,
  spotUrl: safetradeSpotUrl,
};
