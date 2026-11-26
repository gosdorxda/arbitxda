import { getAdapter, hasAdapter } from "./exchanges/registry";
import type { OrderBookLevel } from "./types";

export const DEPTH_CACHE_TTL_MS = 60_000;
export const DEPTH_ERROR_CACHE_MS = 15_000;
export const DEPTH_MAX_PAIRS = 80;
export const DEPTH_PER_EXCHANGE_CONCURRENCY = 3;
export const DEPTH_PAIR_TIMEOUT_MS = 8_000;

export type DepthPairRequest = {
  exchange: string;
  rawSymbol: string;
};

export type DepthPairResult = {
  exchange: string;
  rawSymbol: string;
  bidUsd: number | null;
  askUsd: number | null;
  ok: boolean;
  bids?: OrderBookLevel[];
  asks?: OrderBookLevel[];
};

export type FetchDepthBatchOptions = {
  includeLevels?: boolean;
};

type CacheEntry = {
  exchange: string;
  rawSymbol: string;
  bidUsd: number | null;
  askUsd: number | null;
  ok: boolean;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  cachedAt: number;
  ttl: number;
};

const cache = new Map<string, CacheEntry>();

export function depthCacheKey(exchange: string, rawSymbol: string): string {
  return `${exchange.trim().toLowerCase()}\t${rawSymbol.trim()}`;
}

/** Top `count` cleaned bid/ask levels sorted best-first (bid desc, ask asc). */
export function topSideLevels(
  levels: OrderBookLevel[] | undefined,
  side: "bid" | "ask",
  count = 5,
): OrderBookLevel[] {
  if (!levels?.length) return [];
  const cleaned: OrderBookLevel[] = [];
  for (const level of levels) {
    const price = Number(level.price);
    const volume = Number(level.volume);
    if (Number.isFinite(price) && price > 0 && Number.isFinite(volume) && volume > 0) {
      cleaned.push({ price, volume });
    }
  }
  cleaned.sort((left, right) => (side === "bid" ? right.price - left.price : left.price - right.price));
  return cleaned.slice(0, count);
}

/** Total USDT/USD notional (price * qty) of the best `count` bid or ask levels. */
export function topSideNotional(
  levels: OrderBookLevel[] | undefined,
  side: "bid" | "ask",
  count = 5,
): number {
  let total = 0;
  for (const level of topSideLevels(levels, side, count)) {
    total += level.price * level.volume;
  }
  return total;
}

function readCache(key: string, now = Date.now()): CacheEntry | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (now - entry.cachedAt >= entry.ttl) {
    cache.delete(key);
    return null;
  }
  return entry;
}

function writeCache(entry: Omit<CacheEntry, "cachedAt" | "ttl">, ttl: number, now = Date.now()): void {
  cache.set(depthCacheKey(entry.exchange, entry.rawSymbol), { ...entry, cachedAt: now, ttl });
}

function formatResult(
  pair: DepthPairRequest,
  entry: Pick<CacheEntry, "bidUsd" | "askUsd" | "ok" | "bids" | "asks">,
  includeLevels: boolean,
): DepthPairResult {
  if (!includeLevels) {
    return {
      exchange: pair.exchange,
      rawSymbol: pair.rawSymbol,
      bidUsd: entry.bidUsd,
      askUsd: entry.askUsd,
      ok: entry.ok,
    };
  }
  return {
    exchange: pair.exchange,
    rawSymbol: pair.rawSymbol,
    bidUsd: entry.bidUsd,
    askUsd: entry.askUsd,
    ok: entry.ok,
    bids: entry.bids,
    asks: entry.asks,
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: timeout ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  let index = 0;
  const run = async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      await worker(items[current]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
}

function normalizePairs(pairs: DepthPairRequest[]): DepthPairRequest[] {
  const seen = new Set<string>();
  const out: DepthPairRequest[] = [];
  for (const pair of pairs) {
    if (!pair || typeof pair !== "object") continue;
    const exchange = String((pair as DepthPairRequest).exchange ?? "").trim();
    const rawSymbol = String(
      (pair as DepthPairRequest).rawSymbol ??
        (pair as { raw_symbol?: string; pair?: string }).raw_symbol ??
        (pair as { pair?: string }).pair ??
        "",
    ).trim();
    if (!exchange || !rawSymbol) continue;
    const key = depthCacheKey(exchange, rawSymbol);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ exchange, rawSymbol });
    if (out.length >= DEPTH_MAX_PAIRS) break;
  }
  return out;
}

async function fetchOne(pair: DepthPairRequest): Promise<Omit<CacheEntry, "cachedAt" | "ttl">> {
  const id = pair.exchange.toLowerCase();
  if (!hasAdapter(id)) {
    return {
      exchange: pair.exchange,
      rawSymbol: pair.rawSymbol,
      bidUsd: null,
      askUsd: null,
      ok: false,
      bids: [],
      asks: [],
    };
  }
  try {
    const result = await withTimeout(
      getAdapter(id).fetchOrderBook(pair.rawSymbol, 5),
      DEPTH_PAIR_TIMEOUT_MS,
      `${id} ${pair.rawSymbol}`,
    );
    const bids = topSideLevels(result.orderbook.bids, "bid", 5);
    const asks = topSideLevels(result.orderbook.asks, "ask", 5);
    const bidUsd = bids.reduce((sum, lvl) => sum + lvl.price * lvl.volume, 0);
    const askUsd = asks.reduce((sum, lvl) => sum + lvl.price * lvl.volume, 0);
    return {
      exchange: pair.exchange,
      rawSymbol: pair.rawSymbol,
      bidUsd,
      askUsd,
      ok: true,
      bids,
      asks,
    };
  } catch {
    return {
      exchange: pair.exchange,
      rawSymbol: pair.rawSymbol,
      bidUsd: null,
      askUsd: null,
      ok: false,
      bids: [],
      asks: [],
    };
  }
}

/** Ambil top-5 depth untuk batch pair; cache memori ~60s; gagal satu pair tidak menggagalkan batch. */
export async function fetchDepthBatch(
  pairs: DepthPairRequest[],
  options?: FetchDepthBatchOptions,
): Promise<DepthPairResult[]> {
  const includeLevels = options?.includeLevels === true;
  const unique = normalizePairs(pairs);
  const now = Date.now();
  const results = new Map<string, DepthPairResult>();
  const pending: DepthPairRequest[] = [];

  for (const pair of unique) {
    const key = depthCacheKey(pair.exchange, pair.rawSymbol);
    const hit = readCache(key, now);
    if (hit) {
      results.set(key, formatResult(pair, hit, includeLevels));
    } else {
      pending.push(pair);
    }
  }

  const byExchange = new Map<string, DepthPairRequest[]>();
  for (const pair of pending) {
    const id = pair.exchange.toLowerCase();
    const list = byExchange.get(id) ?? [];
    list.push(pair);
    byExchange.set(id, list);
  }

  await Promise.all(
    [...byExchange.values()].map((group) =>
      runPool(group, DEPTH_PER_EXCHANGE_CONCURRENCY, async (pair) => {
        const entry = await fetchOne(pair);
        writeCache(entry, entry.ok ? DEPTH_CACHE_TTL_MS : DEPTH_ERROR_CACHE_MS);
        results.set(depthCacheKey(pair.exchange, pair.rawSymbol), formatResult(pair, entry, includeLevels));
      }),
    ),
  );

  return unique.map(
    (pair) =>
      results.get(depthCacheKey(pair.exchange, pair.rawSymbol)) ??
      formatResult(pair, { bidUsd: null, askUsd: null, ok: false, bids: [], asks: [] }, includeLevels),
  );
}

/** Hanya untuk tes/skrip: kosongkan cache memori. */
export function clearDepthCache(): void {
  cache.clear();
}
