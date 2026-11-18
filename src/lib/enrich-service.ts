import { aggregateChainFlag, mergeChainStatus } from "./chainstatus";
import { serializeContracts } from "./contracts";
import { getMarketChainstatus, patchMarketContracts, patchMarketDeposit, patchTickerBidAsk } from "./db";
import { isAbortError, isRateLimitError } from "./http";
import type {
  DerivedTicker,
  EnrichPhase,
  EnrichPlan,
  EnrichStatus,
  ExchangeAdapter,
  MarketInfo,
} from "./types";

// Dibuat pelan supaya tidak kena WAF exchange (LBank balas 405 kalau kecepetan).
const DEFAULT_CONCURRENCY = 3;
const REQUEST_GAP_MS = 300; // jeda per worker antar request (~5-6 request/detik total)
const RETRY_BACKOFF_MS = 800;
const RETRY_429_BACKOFF_MS = 3000;
const WAF_COOLDOWN_MS = 30_000; // 403/405/418 = kemungkinan diblok WAF, semua worker istirahat 30 detik
const WAF_MAX_HITS = 4; // lebih dari ini job dihentikan biar IP tidak makin diblok

const pool = { pauseUntil: 0, wafHits: 0 };

function isWafError(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  if (status === 403 || status === 405 || status === 418) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\b(403|405|418)\b/.test(message);
}

type EnrichJob = {
  id: number;
  controller: AbortController;
  status: EnrichStatus;
};

const globalForEnrich = globalThis as unknown as {
  __arbitEnrichJobs?: Map<string, EnrichJob>;
  __arbitEnrichSeq?: number;
};

function jobs(): Map<string, EnrichJob> {
  if (!globalForEnrich.__arbitEnrichJobs) {
    globalForEnrich.__arbitEnrichJobs = new Map();
  }
  return globalForEnrich.__arbitEnrichJobs;
}

function nextId(): number {
  globalForEnrich.__arbitEnrichSeq = (globalForEnrich.__arbitEnrichSeq ?? 0) + 1;
  return globalForEnrich.__arbitEnrichSeq;
}

function emptyStatus(exchange: string): EnrichStatus {
  return {
    exchange,
    running: false,
    done: 0,
    total: 0,
    phase: null,
    errors: 0,
    startedAt: null,
    finishedAt: null,
  };
}

function isCurrent(exchange: string, jobId: number): boolean {
  return jobs().get(exchange)?.id === jobId;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  signal: AbortSignal,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let index = 0;
  pool.pauseUntil = 0;
  pool.wafHits = 0;
  const run = async () => {
    while (!signal.aborted) {
      const wait = pool.pauseUntil - Date.now();
      if (wait > 0) await sleep(wait, signal);
      const current = index;
      index += 1;
      if (current >= items.length) return;
      await worker(items[current]);
      await sleep(REQUEST_GAP_MS, signal);
    }
  };
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => run());
  await Promise.all(workers);
}

async function withRetry<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw error;
    if (isWafError(error)) {
      pool.wafHits += 1;
      console.warn(`[enrich] diblok sementara oleh exchange (WAF), istirahat ${WAF_COOLDOWN_MS / 1000} detik (${pool.wafHits}/${WAF_MAX_HITS})`);
      if (pool.wafHits > WAF_MAX_HITS) {
        throw Object.assign(new Error("Dihentikan: exchange terus memblok (HTTP 405/403). Coba lagi beberapa menit lagi."), { wafStop: true });
      }
      pool.pauseUntil = Math.max(pool.pauseUntil, Date.now() + WAF_COOLDOWN_MS);
      await sleep(WAF_COOLDOWN_MS, signal);
      return await fn();
    }
    const delay = isRateLimitError(error) ? RETRY_429_BACKOFF_MS : RETRY_BACKOFF_MS;
    await sleep(delay, signal);
    return await fn();
  }
}

export function hasEnrichment(adapter: ExchangeAdapter): boolean {
  return Boolean(adapter.buildEnrichPlan && (adapter.enrichBidAsk || adapter.enrichDeposit));
}

export function getEnrichStatus(exchange: string): EnrichStatus {
  return jobs().get(exchange.toLowerCase())?.status ?? emptyStatus(exchange.toLowerCase());
}

export function cancelEnrichment(exchange: string) {
  const id = exchange.toLowerCase();
  const existing = jobs().get(id);
  if (!existing) return;
  existing.controller.abort();
  if (existing.status.running) {
    existing.status.running = false;
  }
}

export function startEnrichment(
  exchange: string,
  adapter: ExchangeAdapter,
  tickers: DerivedTicker[],
  markets: MarketInfo[],
) {
  const id = exchange.toLowerCase();
  if (!hasEnrichment(adapter) || !adapter.buildEnrichPlan) return;

  cancelEnrichment(id);

  const plan: EnrichPlan = adapter.buildEnrichPlan({ tickers, markets });
  const bidAsk = [...plan.bidAsk].sort(
    (a, b) => (b.quoteVolume24h ?? 0) - (a.quoteVolume24h ?? 0),
  );
  const deposits = [...plan.deposits].sort(
    (a, b) => (b.quoteVolume24h ?? 0) - (a.quoteVolume24h ?? 0),
  );
  if (bidAsk.length === 0 && deposits.length === 0) return;

  const jobId = nextId();
  const controller = new AbortController();
  const firstPhase: EnrichPhase = bidAsk.length > 0 ? "bidask" : "deposit";
  const status: EnrichStatus = {
    exchange: id,
    running: true,
    done: 0,
    total: firstPhase === "bidask" ? bidAsk.length : deposits.length,
    phase: firstPhase,
    errors: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs().set(id, { id: jobId, controller, status });
  console.log(
    `[${id}] enrich mulai: bid/ask ${bidAsk.length}, deposit ${deposits.length}, concurrency ${adapter.enrichConcurrency ?? DEFAULT_CONCURRENCY}`,
  );
  void runEnrichment(id, jobId, adapter, bidAsk, deposits, controller.signal, status).catch((error) => {
    if (!isCurrent(id, jobId)) return;
    if (isAbortError(error) || controller.signal.aborted) return;
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[${id}] enrich gagal: ${message}`);
    status.running = false;
    status.finishedAt = new Date().toISOString();
  });
}

async function runEnrichment(
  exchange: string,
  jobId: number,
  adapter: ExchangeAdapter,
  bidAsk: EnrichPlan["bidAsk"],
  deposits: EnrichPlan["deposits"],
  signal: AbortSignal,
  status: EnrichStatus,
) {
  const concurrency = Math.max(1, adapter.enrichConcurrency ?? DEFAULT_CONCURRENCY);
  const started = Date.now();

  if (adapter.enrichBidAsk && bidAsk.length > 0) {
    status.phase = "bidask";
    status.done = 0;
    status.total = bidAsk.length;
    const enrichBidAsk = adapter.enrichBidAsk;
    await runPool(bidAsk, concurrency, signal, async (item) => {
      if (!isCurrent(exchange, jobId) || signal.aborted) return;
      try {
        const result = await withRetry(() => enrichBidAsk(item.rawSymbol, signal), signal);
        if (!isCurrent(exchange, jobId) || signal.aborted) return;
        patchTickerBidAsk(exchange, result.rawSymbol, {
          bid: result.bid,
          ask: result.ask,
          bidSize: result.bidSize,
          askSize: result.askSize,
        });
      } catch (error) {
        if (isAbortError(error) || signal.aborted || !isCurrent(exchange, jobId)) return;
        if ((error as { wafStop?: boolean })?.wafStop) throw error;
        status.errors += 1;
      } finally {
        if (isCurrent(exchange, jobId)) {
          status.done += 1;
          if (status.done === status.total || status.done % 100 === 0) {
            console.log(`[${exchange}] enrich bid/ask ${status.done}/${status.total} (err ${status.errors})`);
          }
        }
      }
    });
  }

  if (!isCurrent(exchange, jobId) || signal.aborted) return;

  if (adapter.enrichDeposit && deposits.length > 0) {
    status.phase = "deposit";
    status.done = 0;
    status.total = deposits.length;
    const enrichDeposit = adapter.enrichDeposit;
    await runPool(deposits, concurrency, signal, async (item) => {
      if (!isCurrent(exchange, jobId) || signal.aborted) return;
      try {
        const result = await withRetry(() => enrichDeposit(item.base, signal), signal);
        if (!isCurrent(exchange, jobId) || signal.aborted) return;
        const merged = mergeChainStatus(getMarketChainstatus(exchange, result.base), result.networks);
        const depositEnabled = result.depositEnabled ?? aggregateChainFlag(merged, "deposit");
        const withdrawEnabled = result.withdrawEnabled ?? aggregateChainFlag(merged, "withdraw");
        patchMarketDeposit(exchange, result.base, depositEnabled, withdrawEnabled, merged || null);
        if (result.contracts !== undefined) {
          const json = serializeContracts(result.contracts);
          if (json != null) patchMarketContracts(exchange, result.base, json);
        }
      } catch (error) {
        if (isAbortError(error) || signal.aborted || !isCurrent(exchange, jobId)) return;
        if ((error as { wafStop?: boolean })?.wafStop) throw error;
        status.errors += 1;
      } finally {
        if (isCurrent(exchange, jobId)) {
          status.done += 1;
          if (status.done === status.total || status.done % 100 === 0) {
            console.log(`[${exchange}] enrich deposit ${status.done}/${status.total} (err ${status.errors})`);
          }
        }
      }
    });
  }

  if (!isCurrent(exchange, jobId) || signal.aborted) return;
  status.running = false;
  status.phase = "done";
  status.finishedAt = new Date().toISOString();
  console.log(
    `[${exchange}] enrich selesai ${(Date.now() - started) / 1000}s, error ${status.errors}`,
  );
}
