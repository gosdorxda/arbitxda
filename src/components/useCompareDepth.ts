"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OrderBookLevel } from "@/lib/types";

export const COMPARE_DEPTH_FRESH_MS = 60_000;
export const COMPARE_DEPTH_ERROR_MS = 15_000;
export const COMPARE_DEPTH_CHUNK_SIZE = 6;
const COMPARE_DEPTH_STORAGE_KEY = "arbit-compare-depth-cache";
const MAX_STORED_ENTRIES = 300;

export type CompareDepthPair = {
  exchange: string;
  rawSymbol: string;
};

export type CompareDepthEntry = {
  ok: boolean;
  at: number;
  bidUsd: number | null;
  askUsd: number | null;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
};

export type CompareDepthProgress = {
  loading: boolean;
  total: number;
  ready: number;
  failed: number;
};

export function compareDepthKey(exchange: string, rawSymbol: string): string {
  return `${exchange.trim().toLowerCase()}\t${rawSymbol.trim()}`;
}

function readStoredCache(): Map<string, CompareDepthEntry> {
  const map = new Map<string, CompareDepthEntry>();
  if (typeof window === "undefined") return map;
  try {
    const raw = window.localStorage.getItem(COMPARE_DEPTH_STORAGE_KEY);
    if (!raw) return map;
    const parsed = JSON.parse(raw) as Record<string, CompareDepthEntry>;
    if (!parsed || typeof parsed !== "object") return map;
    const now = Date.now();
    for (const [key, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry.at !== "number") continue;
      if (now - entry.at < COMPARE_DEPTH_FRESH_MS) {
        map.set(key, entry);
      }
    }
  } catch {
    // abaikan cache rusak
  }
  return map;
}

function writeStoredCache(map: Map<string, CompareDepthEntry>): void {
  if (typeof window === "undefined") return;
  try {
    const now = Date.now();
    const fresh: Array<[string, CompareDepthEntry]> = [];
    for (const [key, entry] of map) {
      if (now - entry.at < COMPARE_DEPTH_FRESH_MS) {
        fresh.push([key, entry]);
      }
    }
    fresh.sort((a, b) => b[1].at - a[1].at);
    const obj: Record<string, CompareDepthEntry> = {};
    for (const [key, entry] of fresh.slice(0, MAX_STORED_ENTRIES)) {
      obj[key] = entry;
    }
    window.localStorage.setItem(COMPARE_DEPTH_STORAGE_KEY, JSON.stringify(obj));
  } catch {
    // abaikan storage penuh/diblokir
  }
}

export function useCompareDepth(pairs: CompareDepthPair[], enabled: boolean) {
  const cacheRef = useRef<Map<string, CompareDepthEntry> | null>(null);
  if (cacheRef.current === null && typeof window !== "undefined") {
    cacheRef.current = readStoredCache();
  }
  const [tick, setTick] = useState(0);
  const [loading, setLoading] = useState(false);
  const forceRefreshRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const uniquePairs = useMemo(() => {
    const seen = new Set<string>();
    const out: CompareDepthPair[] = [];
    for (const pair of pairs) {
      const key = compareDepthKey(pair.exchange, pair.rawSymbol);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(pair);
    }
    return out;
  }, [pairs]);

  const pairsSignature = useMemo(
    () => uniquePairs.map((p) => compareDepthKey(p.exchange, p.rawSymbol)).join("|"),
    [uniquePairs],
  );

  const runFetch = useCallback(async (targetPairs: CompareDepthPair[], force: boolean) => {
    const cache = cacheRef.current ?? new Map<string, CompareDepthEntry>();
    cacheRef.current = cache;

    const now = Date.now();
    const pending = targetPairs.filter((pair) => {
      if (force) return true;
      const entry = cache.get(compareDepthKey(pair.exchange, pair.rawSymbol));
      if (!entry) return true;
      const ttl = entry.ok ? COMPARE_DEPTH_FRESH_MS : COMPARE_DEPTH_ERROR_MS;
      return now - entry.at >= ttl;
    });

    if (pending.length === 0) {
      setLoading(false);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);

    try {
      for (let idx = 0; idx < pending.length; idx += COMPARE_DEPTH_CHUNK_SIZE) {
        if (controller.signal.aborted) break;
        const chunk = pending.slice(idx, idx + COMPARE_DEPTH_CHUNK_SIZE);
        try {
          const response = await fetch("/api/depth", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
            signal: controller.signal,
            body: JSON.stringify({ pairs: chunk, includeLevels: true }),
          });
          const data = await response.json().catch(() => null);
          if (controller.signal.aborted) break;
          const fetchedAt = Date.now();
          if (response.ok && data?.ok && Array.isArray(data.items)) {
            for (const item of data.items as Array<{
              exchange: string;
              rawSymbol: string;
              ok: boolean;
              bidUsd: number | null;
              askUsd: number | null;
              bids?: OrderBookLevel[];
              asks?: OrderBookLevel[];
            }>) {
              cache.set(compareDepthKey(item.exchange, item.rawSymbol), {
                ok: Boolean(item.ok),
                at: fetchedAt,
                bidUsd: item.bidUsd ?? null,
                askUsd: item.askUsd ?? null,
                bids: Array.isArray(item.bids) ? item.bids : [],
                asks: Array.isArray(item.asks) ? item.asks : [],
              });
            }
          } else {
            for (const pair of chunk) {
              cache.set(compareDepthKey(pair.exchange, pair.rawSymbol), {
                ok: false,
                at: fetchedAt,
                bidUsd: null,
                askUsd: null,
                bids: [],
                asks: [],
              });
            }
          }
          writeStoredCache(cache);
          setTick((v) => v + 1);
        } catch (err) {
          if (controller.signal.aborted) break;
          const fetchedAt = Date.now();
          for (const pair of chunk) {
            cache.set(compareDepthKey(pair.exchange, pair.rawSymbol), {
              ok: false,
              at: fetchedAt,
              bidUsd: null,
              askUsd: null,
              bids: [],
              asks: [],
            });
          }
          setTick((v) => v + 1);
          void err;
        }
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled || uniquePairs.length === 0) {
      abortRef.current?.abort();
      setLoading(false);
      return;
    }
    const force = forceRefreshRef.current;
    forceRefreshRef.current = false;
    void runFetch(uniquePairs, force);
    return () => {
      abortRef.current?.abort();
    };
  }, [enabled, pairsSignature, uniquePairs, runFetch]);

  const refresh = useCallback(() => {
    if (!enabled || uniquePairs.length === 0) return;
    forceRefreshRef.current = true;
    void runFetch(uniquePairs, true);
  }, [enabled, uniquePairs, runFetch]);

  const getEntry = useCallback(
    (exchange: string, rawSymbol: string): CompareDepthEntry | null => {
      void tick;
      const cache = cacheRef.current;
      if (!cache) return null;
      return cache.get(compareDepthKey(exchange, rawSymbol)) ?? null;
    },
    [tick],
  );

  const progress = useMemo<CompareDepthProgress>(() => {
    void tick;
    const cache = cacheRef.current;
    let ready = 0;
    let failed = 0;
    if (cache) {
      for (const pair of uniquePairs) {
        const entry = cache.get(compareDepthKey(pair.exchange, pair.rawSymbol));
        if (!entry) continue;
        if (entry.ok) ready += 1;
        else failed += 1;
      }
    }
    return { loading, total: uniquePairs.length, ready, failed };
  }, [loading, uniquePairs, tick]);

  return { getEntry, progress, refresh };
}
