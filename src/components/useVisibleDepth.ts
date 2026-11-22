"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DepthLookup, DepthProgress, DepthView } from "@/components/DepthBar";

export const DEPTH_FRESH_MS = 60_000;
export const DEPTH_STALE_MAX_MS = 30 * 60_000;
export const DEPTH_ERROR_BACKOFF_MS = 15_000;
export const DEPTH_CHUNK_SIZE = 5;
export const DEPTH_STORAGE_KEY = "arbit-depth-cache";
const STORAGE_VERSION = 1;

type CacheEntry = {
  status: "ok" | "error";
  bidUsd: number | null;
  askUsd: number | null;
  at: number;
  failedAt?: number;
};

type StoredCache = {
  v: number;
  items: Record<string, CacheEntry>;
};

const clientCache = new Map<string, CacheEntry>();
let storageHydrated = false;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

function pairKey(exchange: string, rawSymbol: string): string {
  return `${exchange}\t${rawSymbol}`;
}

function hasUsableData(entry: CacheEntry): boolean {
  return entry.status === "ok" && (entry.bidUsd != null || entry.askUsd != null);
}

function ageMs(entry: CacheEntry, now: number): number {
  return now - entry.at;
}

type Phase = "fresh" | "stale" | "expired" | "error";

function phaseOf(entry: CacheEntry, now: number): Phase {
  if (hasUsableData(entry)) {
    const age = ageMs(entry, now);
    if (age < DEPTH_FRESH_MS) return "fresh";
    if (age < DEPTH_STALE_MAX_MS) return "stale";
    return "expired";
  }
  return "error";
}

function hydrateStorage(): void {
  if (storageHydrated || typeof window === "undefined") return;
  storageHydrated = true;
  try {
    const raw = window.localStorage.getItem(DEPTH_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as StoredCache;
    if (!parsed || parsed.v !== STORAGE_VERSION || !parsed.items || typeof parsed.items !== "object") return;
    const now = Date.now();
    for (const [key, entry] of Object.entries(parsed.items)) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.status !== "ok" && entry.status !== "error") continue;
      if (typeof entry.at !== "number" || !Number.isFinite(entry.at)) continue;
      if (now - entry.at >= DEPTH_STALE_MAX_MS && !entry.failedAt) continue;
      clientCache.set(key, {
        status: entry.status,
        bidUsd: typeof entry.bidUsd === "number" && Number.isFinite(entry.bidUsd) ? entry.bidUsd : null,
        askUsd: typeof entry.askUsd === "number" && Number.isFinite(entry.askUsd) ? entry.askUsd : null,
        at: entry.at,
        failedAt: typeof entry.failedAt === "number" && Number.isFinite(entry.failedAt) ? entry.failedAt : undefined,
      });
    }
  } catch {
    // storage rusak atau diblokir
  }
}

function persistCache(): void {
  if (typeof window === "undefined") return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      const now = Date.now();
      const items: Record<string, CacheEntry> = {};
      for (const [key, entry] of clientCache) {
        if (now - entry.at >= DEPTH_STALE_MAX_MS && !hasUsableData(entry)) continue;
        if (hasUsableData(entry) && now - entry.at >= DEPTH_STALE_MAX_MS) continue;
        items[key] = entry;
      }
      window.localStorage.setItem(DEPTH_STORAGE_KEY, JSON.stringify({ v: STORAGE_VERSION, items } satisfies StoredCache));
    } catch {
      // storage penuh atau diblokir
    }
  }, 200);
}

hydrateStorage();

type DepthRow = { exchange: string; raw_symbol: string };

export type UseVisibleDepthOptions = {
  page?: number;
};

function emptyProgress(page?: number): DepthProgress {
  return {
    running: false,
    page: page ?? null,
    done: 0,
    total: 0,
    queued: 0,
    failed: 0,
    staleCount: 0,
    lastUpdated: null,
  };
}

export function useVisibleDepth(rows: DepthRow[], enabled: boolean, options?: UseVisibleDepthOptions): DepthLookup {
  hydrateStorage();
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const loadingRef = useRef(new Set<string>());
  const forceRef = useRef(false);
  const [tick, setTick] = useState(0);
  const [retryNonce, setRetryNonce] = useState(0);
  const [sweepNonce, setSweepNonce] = useState(0);
  const page = options?.page;

  const fingerprint = useMemo(
    () => (enabled ? rows.map((row) => pairKey(row.exchange, row.raw_symbol)).join("\n") : ""),
    [rows, enabled],
  );

  useEffect(() => {
    if (!enabled) return;
    const current = rowsRef.current;
    const now = Date.now();
    const force = forceRef.current;
    forceRef.current = false;

    const needed: DepthRow[] = [];
    for (const row of current) {
      const key = pairKey(row.exchange, row.raw_symbol);
      if (loadingRef.current.has(key)) continue;
      const entry = clientCache.get(key);
      if (!entry) {
        needed.push(row);
        continue;
      }
      const phase = phaseOf(entry, now);
      if (force) {
        if (phase !== "fresh" || entry.failedAt) needed.push(row);
        continue;
      }
      if (phase === "fresh") continue;
      if (phase === "error" && entry.at && now - entry.at < DEPTH_ERROR_BACKOFF_MS) continue;
      needed.push(row);
    }

    if (needed.length === 0) return;

    let cancelled = false;
    for (const row of needed) loadingRef.current.add(pairKey(row.exchange, row.raw_symbol));
    setTick((value) => value + 1);

    const applyChunk = (
      chunk: DepthRow[],
      items: Array<{
        exchange: string;
        rawSymbol: string;
        bidUsd: number | null;
        askUsd: number | null;
        ok?: boolean;
      }> | null,
      httpOk: boolean,
    ) => {
      const stamp = Date.now();
      const seen = new Set<string>();
      if (httpOk && items) {
        for (const item of items) {
          const key = pairKey(item.exchange, item.rawSymbol);
          seen.add(key);
          const ok = item.ok !== false && (item.bidUsd != null || item.askUsd != null || item.ok === true);
          const previous = clientCache.get(key);
          if (ok) {
            clientCache.set(key, {
              status: "ok",
              bidUsd: item.bidUsd,
              askUsd: item.askUsd,
              at: stamp,
            });
          } else if (previous && hasUsableData(previous) && stamp - previous.at < DEPTH_STALE_MAX_MS) {
            clientCache.set(key, { ...previous, failedAt: stamp });
          } else {
            clientCache.set(key, { status: "error", bidUsd: null, askUsd: null, at: stamp });
          }
        }
      }
      for (const row of chunk) {
        const key = pairKey(row.exchange, row.raw_symbol);
        if (seen.has(key)) continue;
        const previous = clientCache.get(key);
        if (previous && hasUsableData(previous) && stamp - previous.at < DEPTH_STALE_MAX_MS) {
          clientCache.set(key, { ...previous, failedAt: stamp });
        } else if (!previous || !hasUsableData(previous)) {
          clientCache.set(key, { status: "error", bidUsd: null, askUsd: null, at: stamp });
        }
      }
      persistCache();
    };

    const load = async () => {
      for (let index = 0; index < needed.length; index += DEPTH_CHUNK_SIZE) {
        if (cancelled) break;
        const chunk = needed.slice(index, index + DEPTH_CHUNK_SIZE);
        try {
          const response = await fetch("/api/depth", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
            body: JSON.stringify(
              chunk.map((row) => ({ exchange: row.exchange, rawSymbol: row.raw_symbol })),
            ),
          });
          type DepthApiResponse = {
            ok?: boolean;
            items?: Array<{
              exchange: string;
              rawSymbol: string;
              bidUsd: number | null;
              askUsd: number | null;
              ok?: boolean;
            }>;
          };
          let data: DepthApiResponse | null = null;
          try {
            data = (await response.json()) as DepthApiResponse;
          } catch {
            data = null;
          }
          const items = data && Array.isArray(data.items) ? data.items : null;
          const httpOk = response.ok && data?.ok === true && items != null;
          applyChunk(chunk, httpOk ? items : null, httpOk);
        } catch (error) {
          applyChunk(chunk, null, false);
          console.warn(error instanceof Error ? error.message : String(error));
        } finally {
          for (const row of chunk) loadingRef.current.delete(pairKey(row.exchange, row.raw_symbol));
          setTick((value) => value + 1);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [fingerprint, enabled, retryNonce, sweepNonce]);

  useEffect(() => {
    if (!enabled || !fingerprint) return;
    const now = Date.now();
    let soonest = Infinity;
    for (const line of fingerprint.split("\n")) {
      if (!line) continue;
      if (loadingRef.current.has(line)) continue;
      const entry = clientCache.get(line);
      if (!entry) {
        if (now < soonest) soonest = now;
        continue;
      }
      const phase = phaseOf(entry, now);
      let until: number;
      if (phase === "fresh" && !entry.failedAt) {
        until = entry.at + DEPTH_FRESH_MS;
      } else if (phase === "error") {
        until = entry.at + DEPTH_ERROR_BACKOFF_MS;
      } else {
        const lastTry = entry.failedAt ?? entry.at;
        until = lastTry + DEPTH_FRESH_MS;
      }
      if (until < soonest) soonest = until;
    }
    if (!Number.isFinite(soonest)) return;
    const delay = Math.max(50, soonest - now + 25);
    const timer = setTimeout(() => {
      setTick((value) => value + 1);
      setSweepNonce((value) => value + 1);
    }, delay);
    return () => clearTimeout(timer);
  }, [fingerprint, enabled, tick]);

  const visibleKeys = useMemo(() => {
    const set = new Set<string>();
    if (!fingerprint) return set;
    for (const line of fingerprint.split("\n")) {
      if (line) set.add(line);
    }
    return set;
  }, [fingerprint]);

  const progress = useMemo<DepthProgress>(() => {
    if (!enabled) return emptyProgress(page);
    const now = Date.now();
    let done = 0;
    let failed = 0;
    let staleCount = 0;
    let queued = 0;
    let lastUpdated: number | null = null;
    let running = false;
    for (const key of visibleKeys) {
      const loading = loadingRef.current.has(key);
      if (loading) {
        queued += 1;
        running = true;
      }
      const entry = clientCache.get(key);
      if (!entry) {
        if (!loading) queued += 1;
        continue;
      }
      const phase = phaseOf(entry, now);
      if (hasUsableData(entry) && phase !== "expired") {
        done += 1;
        if (phase === "stale") staleCount += 1;
        if (lastUpdated == null || entry.at > lastUpdated) lastUpdated = entry.at;
      } else if (phase === "error") {
        failed += 1;
      }
      if (entry.failedAt) failed += phase === "error" ? 0 : 1;
    }
    return {
      running,
      page: page ?? null,
      done,
      total: visibleKeys.size,
      queued,
      failed,
      staleCount,
      lastUpdated,
    };
  }, [enabled, page, tick, visibleKeys]);

  const getDepth = useCallback(
    (exchange: string, rawSymbol: string): DepthView => {
      const key = pairKey(exchange, rawSymbol);
      const now = Date.now();
      const entry = clientCache.get(key);
      if (entry) {
        const phase = phaseOf(entry, now);
        if (phase === "fresh") {
          return { status: "ok", bidUsd: entry.bidUsd, askUsd: entry.askUsd, at: entry.at };
        }
        if (phase === "stale") {
          return { status: "stale", bidUsd: entry.bidUsd, askUsd: entry.askUsd, at: entry.at };
        }
        if (phase === "error") {
          if (loadingRef.current.has(key) || visibleKeys.has(key)) {
            return loadingRef.current.has(key)
              ? { status: "loading", bidUsd: null, askUsd: null }
              : { status: "error", bidUsd: null, askUsd: null, at: entry.at };
          }
          return { status: "idle", bidUsd: null, askUsd: null };
        }
      }
      if (loadingRef.current.has(key) || visibleKeys.has(key)) {
        return { status: "loading", bidUsd: null, askUsd: null };
      }
      return { status: "idle", bidUsd: null, askUsd: null };
    },
    [tick, visibleKeys],
  );

  const retryFailed = useCallback(() => {
    forceRef.current = true;
    setRetryNonce((value) => value + 1);
  }, []);

  return { getDepth, progress, retryFailed };
}
