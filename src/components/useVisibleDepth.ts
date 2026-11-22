"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DepthLookup, DepthView } from "@/components/DepthBar";

const CLIENT_TTL_MS = 60_000;
const ERROR_TTL_MS = 15_000;
const MAX_PAIRS = 80;

type CacheEntry = {
  status: "ok" | "error";
  bidUsd: number | null;
  askUsd: number | null;
  at: number;
  ttl: number;
};

const clientCache = new Map<string, CacheEntry>();

function pairKey(exchange: string, rawSymbol: string): string {
  return `${exchange}\t${rawSymbol}`;
}

function readEntry(key: string, now = Date.now()): CacheEntry | null {
  const entry = clientCache.get(key);
  if (!entry) return null;
  if (now - entry.at >= entry.ttl) {
    clientCache.delete(key);
    return null;
  }
  return entry;
}

type DepthRow = { exchange: string; raw_symbol: string };

export function useVisibleDepth(rows: DepthRow[], enabled: boolean): DepthLookup {
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const loadingRef = useRef(new Set<string>());
  const [tick, setTick] = useState(0);

  const fingerprint = useMemo(
    () => (enabled ? rows.map((row) => pairKey(row.exchange, row.raw_symbol)).join("\n") : ""),
    [rows, enabled],
  );

  useEffect(() => {
    if (!enabled) return;
    const current = rowsRef.current.slice(0, MAX_PAIRS);
    const now = Date.now();
    const needed: DepthRow[] = [];
    for (const row of current) {
      const key = pairKey(row.exchange, row.raw_symbol);
      if (readEntry(key, now)) continue;
      if (loadingRef.current.has(key)) continue;
      needed.push(row);
    }
    if (needed.length === 0) return;

    const controller = new AbortController();
    for (const row of needed) loadingRef.current.add(pairKey(row.exchange, row.raw_symbol));
    setTick((value) => value + 1);

    const load = async () => {
      try {
        const response = await fetch("/api/depth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          signal: controller.signal,
          body: JSON.stringify(
            needed.map((row) => ({ exchange: row.exchange, rawSymbol: row.raw_symbol })),
          ),
        });
        const data = (await response.json()) as {
          ok?: boolean;
          items?: Array<{
            exchange: string;
            rawSymbol: string;
            bidUsd: number | null;
            askUsd: number | null;
            ok?: boolean;
          }>;
        };
        if (controller.signal.aborted) return;
        const stamp = Date.now();
        if (!response.ok || !data.ok || !Array.isArray(data.items)) {
          throw new Error("Gagal memuat depth");
        }
        const seen = new Set<string>();
        for (const item of data.items) {
          const key = pairKey(item.exchange, item.rawSymbol);
          seen.add(key);
          const ok = item.ok !== false && (item.bidUsd != null || item.askUsd != null || item.ok === true);
          clientCache.set(key, {
            status: ok ? "ok" : "error",
            bidUsd: item.bidUsd,
            askUsd: item.askUsd,
            at: stamp,
            ttl: ok ? CLIENT_TTL_MS : ERROR_TTL_MS,
          });
        }
        for (const row of needed) {
          const key = pairKey(row.exchange, row.raw_symbol);
          if (seen.has(key)) continue;
          clientCache.set(key, { status: "error", bidUsd: null, askUsd: null, at: stamp, ttl: ERROR_TTL_MS });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        const stamp = Date.now();
        for (const row of needed) {
          const key = pairKey(row.exchange, row.raw_symbol);
          if (readEntry(key, stamp)) continue;
          clientCache.set(key, { status: "error", bidUsd: null, askUsd: null, at: stamp, ttl: ERROR_TTL_MS });
        }
        console.warn(error instanceof Error ? error.message : String(error));
      } finally {
        for (const row of needed) loadingRef.current.delete(pairKey(row.exchange, row.raw_symbol));
        if (!controller.signal.aborted) setTick((value) => value + 1);
      }
    };

    void load();
    return () => {
      controller.abort();
      for (const row of needed) loadingRef.current.delete(pairKey(row.exchange, row.raw_symbol));
    };
  }, [fingerprint, enabled]);

  const visibleKeys = useMemo(() => {
    const set = new Set<string>();
    if (!fingerprint) return set;
    for (const line of fingerprint.split("\n")) {
      if (line) set.add(line);
    }
    return set;
  }, [fingerprint]);

  const getDepth = useCallback(
    (exchange: string, rawSymbol: string): DepthView => {
      const key = pairKey(exchange, rawSymbol);
      const hit = readEntry(key);
      if (hit) return { status: hit.status, bidUsd: hit.bidUsd, askUsd: hit.askUsd };
      if (loadingRef.current.has(key) || visibleKeys.has(key)) {
        return { status: "loading", bidUsd: null, askUsd: null };
      }
      return { status: "idle", bidUsd: null, askUsd: null };
    },
    [tick, visibleKeys],
  );

  return { getDepth };
}
