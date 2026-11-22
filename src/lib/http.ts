import dns from "node:dns";
import net from "node:net";
import { sleep } from "./rate-limit";

// Server-only: prefer IPv4 so Windows/ISP routes with broken IPv6
// don't stall on a failed AAAA attempt before falling back to IPv4.
dns.setDefaultResultOrder("ipv4first");
if (typeof net.setDefaultAutoSelectFamily === "function") {
  net.setDefaultAutoSelectFamily(true);
}
if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === "function") {
  // Fail over from a hanging first address within ~300ms (Node 22.13+ / 24).
  net.setDefaultAutoSelectFamilyAttemptTimeout(300);
}

export class ExchangeApiError extends Error {
  status?: number;
  body?: string;

  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = "ExchangeApiError";
    this.status = status;
    this.body = body;
  }
}

type FetchJsonOptions = {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  method?: "GET" | "POST";
  body?: string;
};

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  if (name === "AbortError" || name === "TimeoutError") {
    const message = "message" in error ? String(error.message) : "";
    // TimeoutError / AbortSignal.timeout tetap dianggap timeout, bukan batal user.
    if (name === "TimeoutError") return false;
    if (/timeout/i.test(message)) return false;
    return true;
  }
  return false;
}

export function isRateLimitError(error: unknown): boolean {
  if (error instanceof ExchangeApiError && error.status === 429) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /429/.test(message);
}

const DEFAULT_HEADERS = {
  Accept: "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
};

export const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 1;
const RETRY_BACKOFF_MS = 500;

function hostLabel(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("kraken")) return "Kraken";
    if (host.includes("bingx")) return "BingX";
    if (host.includes("lbank") || host.includes("lbkex")) return "LBank";
    if (host.includes("bybit") || host.includes("bytick")) return "Bybit";
    if (host.includes("bitget")) return "Bitget";
    if (host.includes("gate")) return "Gate";
    if (host.includes("poloniex")) return "Poloniex";
    if (host.includes("bitrue")) return "Bitrue";
    if (host.includes("mexc")) return "MEXC";
    if (host.includes("huobi") || host.includes("htx")) return "HTX";
    if (host.includes("fameex")) return "FameEX";
    if (host.includes("xt.com") || host.startsWith("xt.") || host === "xt.com") return "XT";
    if (host.includes("bifinance")) return "BiFinance";
    if (host.includes("hotcoin")) return "Hotcoin";
    if (host.includes("big.one") || host.includes("bigone")) return "BigONE";
    if (host.includes("crypto.com")) return "Crypto.com";
    if (host.includes("asterdex")) return "AsterDEX";
    if (host.includes("toobit")) return "Toobit";
    if (host.includes("ourbit")) return "Ourbit";
    if (host.includes("mgbx")) return "MGBX";
    if (host.includes("btse")) return "BTSE";
    if (host.includes("pionex")) return "Pionex";
    if (host.includes("coinw")) return "CoinW";
    if (host.includes("weex")) return "WEEX";
    if (host.includes("phemex")) return "Phemex";
    if (host.includes("dex-trade")) return "Dex-Trade";
    if (host.includes("p2pb2b")) return "P2PB2B";
    if (host.includes("safe.trade") || host.includes("safetrade")) return "SafeTrade";
    if (host.includes("binance.com") && (url.includes("/bapi/defi/") || url.includes("/alpha"))) return "Binance Alpha";
    return host || url;
  } catch {
    return url;
  }
}

function getErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const e = error as { code?: unknown; cause?: unknown };
  if (typeof e.code === "string" && e.code) return e.code;
  if (e.cause) return getErrorCode(e.cause);
  return "";
}

function getErrorName(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  if (error && typeof error === "object" && "cause" in error) {
    return getErrorName((error as { cause?: unknown }).cause);
  }
  return "";
}

function isTimeoutError(error: unknown, code: string, name: string): boolean {
  if (
    code === "ETIMEDOUT" ||
    code === "ESOCKETTIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT"
  ) {
    return true;
  }
  if (name === "AbortError" || name === "TimeoutError" || name === "DOMException") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /timeout|timed out|aborted|abort/i.test(message);
}

export function describeNetworkError(error: unknown, url: string, timeoutMs = DEFAULT_TIMEOUT_MS): string {
  const label = hostLabel(url);
  const code = getErrorCode(error);
  const name = getErrorName(error);

  if (isTimeoutError(error, code, name)) {
    return `${label} tidak bisa dihubungi (timeout ${Math.round(timeoutMs / 1000)} detik)`;
  }
  if (code === "ECONNREFUSED") {
    return `${label} tidak bisa dihubungi (koneksi ditolak)`;
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_FAIL" || code === "UND_ERR_DNS") {
    return `${label} tidak bisa dihubungi (DNS gagal)`;
  }
  if (code === "ENETUNREACH" || code === "EHOSTUNREACH") {
    return `${label} tidak bisa dihubungi (jaringan tidak terjangkau)`;
  }
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") {
    return `${label} tidak bisa dihubungi (koneksi terputus)`;
  }

  const fallback = error instanceof Error ? error.message : String(error);
  return `${label} tidak bisa dihubungi (${fallback})`;
}

function toNetworkError(error: unknown, url: string, timeoutMs: number): Error {
  const message = describeNetworkError(error, url, timeoutMs);
  const wrapped = new Error(message);
  wrapped.cause = error instanceof Error ? error : undefined;
  (wrapped as Error & { code?: string }).code = getErrorCode(error) || undefined;
  return wrapped;
}

function isRetryableNetworkError(error: unknown): boolean {
  const code = getErrorCode(error);
  const name = getErrorName(error);
  if (isTimeoutError(error, code, name)) return true;
  return [
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EAI_FAIL",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "ECONNRESET",
    "UND_ERR_SOCKET",
    "UND_ERR_DNS",
    "UND_ERR_CONNECT_TIMEOUT",
  ].includes(code);
}

export async function fetchJson<T>(
  url: string,
  options: FetchJsonOptions = {},
): Promise<{ data: T; rawText: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const maxAttempts = 1 + Math.max(0, retries);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new DOMException("Aborted", "AbortError");
    }
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    try {
      const response = await fetch(url, {
        method: options.method ?? "GET",
        headers: { ...DEFAULT_HEADERS, ...options.headers },
        body: options.body,
        signal,
        cache: "no-store",
      });
      const rawText = await response.text();
      const retryableHttp = response.status === 429 || response.status >= 500;

      if (!response.ok) {
        lastError = new ExchangeApiError(
          `HTTP ${response.status} ${response.statusText} dari ${url}`,
          response.status,
          rawText.slice(0, 2000),
        );
        if (retryableHttp && attempt < maxAttempts - 1 && !options.signal?.aborted) {
          await sleep(RETRY_BACKOFF_MS);
          continue;
        }
        throw lastError;
      }

      return { data: JSON.parse(rawText) as T, rawText };
    } catch (error) {
      if (error instanceof ExchangeApiError) throw error;
      if (options.signal?.aborted) {
        throw options.signal.reason instanceof Error
          ? options.signal.reason
          : new DOMException("Aborted", "AbortError");
      }
      lastError = toNetworkError(error, url, timeoutMs);
      if (attempt < maxAttempts - 1 && isRetryableNetworkError(error)) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      throw lastError;
    }
  }

  throw lastError ?? new Error(`Gagal fetch ${url}`);
}
