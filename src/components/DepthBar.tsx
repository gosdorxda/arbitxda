"use client";

import { createContext, useContext, type ReactNode } from "react";
import { formatUsdCompact } from "@/lib/format";

export type DepthView = {
  status: "idle" | "loading" | "ok" | "error";
  bidUsd: number | null;
  askUsd: number | null;
};

export type DepthLookup = {
  getDepth: (exchange: string, rawSymbol: string) => DepthView;
};

const DepthContext = createContext<DepthLookup>({
  getDepth: () => ({ status: "idle", bidUsd: null, askUsd: null }),
});

export function DepthProvider({ value, children }: { value: DepthLookup; children: ReactNode }) {
  return <DepthContext.Provider value={value}>{children}</DepthContext.Provider>;
}

export function DepthCell({ exchange, rawSymbol }: { exchange: string; rawSymbol: string }) {
  const { getDepth } = useContext(DepthContext);
  const view = getDepth(exchange, rawSymbol);
  if (view.status === "loading") {
    return <DepthSkeleton />;
  }
  if (view.status === "idle" || view.status === "error" || (view.bidUsd == null && view.askUsd == null)) {
    return <span className="muted">-</span>;
  }
  return <DepthBar bidUsd={view.bidUsd ?? 0} askUsd={view.askUsd ?? 0} />;
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
