"use client";

import { createContext, useContext, type ReactNode } from "react";
import { formatRelativeId, formatUsdCompact } from "@/lib/format";

export type DepthView = {
  status: "idle" | "loading" | "ok" | "error" | "stale";
  bidUsd: number | null;
  askUsd: number | null;
  at?: number;
};

export type DepthProgress = {
  running: boolean;
  page: number | null;
  done: number;
  total: number;
  queued: number;
  failed: number;
  staleCount: number;
  lastUpdated: number | null;
};

export type DepthLookup = {
  getDepth: (exchange: string, rawSymbol: string) => DepthView;
  progress: DepthProgress;
  retryFailed: () => void;
  retryOne: (exchange: string, rawSymbol: string) => void;
};

const emptyProgress: DepthProgress = {
  running: false,
  page: null,
  done: 0,
  total: 0,
  queued: 0,
  failed: 0,
  staleCount: 0,
  lastUpdated: null,
};

const DepthContext = createContext<DepthLookup>({
  getDepth: () => ({ status: "idle", bidUsd: null, askUsd: null }),
  progress: emptyProgress,
  retryFailed: () => {},
  retryOne: () => {},
});

export function DepthProvider({ value, children }: { value: DepthLookup; children: ReactNode }) {
  return <DepthContext.Provider value={value}>{children}</DepthContext.Provider>;
}

export function DepthCell({ exchange, rawSymbol }: { exchange: string; rawSymbol: string }) {
  const { getDepth, retryOne, progress } = useContext(DepthContext);
  const view = getDepth(exchange, rawSymbol);
  if (view.status === "loading") {
    return (
      <div className="depth-bar-wrap">
        <DepthSkeleton />
        <span className="depth-stale-hint">&nbsp;</span>
      </div>
    );
  }
  if (view.status === "error") {
    return (
      <div className="depth-bar-wrap depth-bar-error">
        <span className="muted">-</span>
        <button
          type="button"
          className="depth-retry-btn"
          title="Coba lagi"
          aria-label="Coba lagi"
          disabled={progress.running}
          onClick={() => retryOne(exchange, rawSymbol)}
        >
          ↻
        </button>
      </div>
    );
  }
  if (view.status === "idle" || (view.bidUsd == null && view.askUsd == null)) {
    return (
      <div className="depth-bar-wrap">
        <span className="muted">-</span>
        <span className="depth-stale-hint">&nbsp;</span>
      </div>
    );
  }
  const stale = view.status === "stale";
  const updated = view.at ? formatRelativeId(new Date(view.at).toISOString()) : "";
  return (
    <div className={stale ? "depth-bar-wrap depth-bar-stale" : "depth-bar-wrap"} title={stale ? `Data lama · update ${updated}` : undefined}>
      <DepthBar bidUsd={view.bidUsd ?? 0} askUsd={view.askUsd ?? 0} />
      <span className="depth-stale-hint">{stale ? "data lama" : "\u00a0"}</span>
    </div>
  );
}

export function DepthSkeleton() {
  return (
    <div className="depth-bar-cell" aria-hidden="true">
      <div className="flex justify-between">
        <span className="inline-block h-2.5 w-8 animate-pulse rounded bg-panel-2" />
        <span className="inline-block h-2.5 w-8 animate-pulse rounded bg-panel-2" />
      </div>
      <div className="mt-0.5 h-1.5 animate-pulse rounded-full bg-panel-2" />
    </div>
  );
}

export function DepthBar({ bidUsd, askUsd }: { bidUsd: number; askUsd: number }) {
  const bid = Number.isFinite(bidUsd) ? Math.max(0, bidUsd) : 0;
  const ask = Number.isFinite(askUsd) ? Math.max(0, askUsd) : 0;
  const total = bid + ask;
  const bidPct = total > 0 ? (bid / total) * 100 : 50;
  const askPct = total > 0 ? (ask / total) * 100 : 50;
  return (
    <div className="depth-bar-cell" title={`Bid ${formatUsdCompact(bid)} · Ask ${formatUsdCompact(ask)} (top 5)`}>
      <div className="flex items-baseline justify-between gap-1 text-[10px] leading-none">
        <span className="num up">{formatUsdCompact(bid)}</span>
        <span className="num down">{formatUsdCompact(ask)}</span>
      </div>
      <div className="mt-0.5 flex h-1.5 overflow-hidden rounded-full bg-panel-2">
        <span className="depth-bar-bid h-full shrink-0" style={{ width: `${bidPct}%` }} />
        <span className="depth-bar-ask h-full shrink-0" style={{ width: `${askPct}%` }} />
      </div>
    </div>
  );
}

export function DepthStatusBar() {
  const { progress } = useContext(DepthContext);

  const parts: string[] = [];
  if (progress.running) {
    parts.push("Mengambil depth");
  } else if (progress.done > 0) {
    parts.push("Depth siap");
  } else if (progress.failed > 0) {
    parts.push("Depth gagal");
  } else {
    parts.push("Depth belum diambil");
  }
  if (progress.page != null) parts.push(`halaman ${progress.page}`);
  if (progress.total > 0) {
    parts.push(`${progress.done.toLocaleString("id-ID")}/${progress.total.toLocaleString("id-ID")} selesai`);
  }
  if (progress.running || progress.queued > 0) {
    parts.push(`${progress.queued.toLocaleString("id-ID")} antrian`);
  }
  if (progress.failed > 0) {
    parts.push(`${progress.failed.toLocaleString("id-ID")} gagal`);
  }
  if (progress.staleCount > 0 && !progress.running) {
    parts.push(`${progress.staleCount.toLocaleString("id-ID")} data lama`);
  }
  if (progress.lastUpdated != null) {
    parts.push(`update ${formatRelativeId(new Date(progress.lastUpdated).toISOString())}`);
  }

  return (
    <div className="depth-status-bar" title={parts.join(" · ")}>
      <p className="depth-status-text">{parts.join(" · ")}</p>
    </div>
  );
}
