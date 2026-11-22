"use client";

import { sortByExchangeName } from "@/lib/format";

type ExchangeMarketBarItem = {
  id: string;
  name: string;
  count: number;
  selected: boolean;
  fetching?: boolean;
  error?: boolean;
  onSelect: () => void;
};

type ExchangeMarketBarProps = {
  loading: boolean;
  items: ExchangeMarketBarItem[];
  totalCount: number;
};

function formatCount(value: number): string {
  return new Intl.NumberFormat("id-ID").format(value);
}

export function ExchangeMarketBar({ loading, items, totalCount }: ExchangeMarketBarProps) {
  const sorted = sortByExchangeName(items, (item) => item.name);
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-background px-4 py-2 sm:px-5">
      <div
        className="inline-flex h-7 shrink-0 items-center overflow-hidden rounded-full border border-border-strong bg-panel-2 text-[12px]"
        title={`${sorted.length} exchange · ${formatCount(totalCount)} pair`}
      >
        <span className="px-2.5 text-muted">
          Total{sorted.length > 0 ? ` · ${items.length} ex` : " Market"}
        </span>
        <span className="num inline-flex h-full items-center border-l border-border px-2 font-semibold text-foreground">
          {formatCount(totalCount)}
        </span>
      </div>
      {sorted.length > 0 ? <span className="mx-0.5 h-5 w-px shrink-0 bg-border" aria-hidden="true" /> : null}
      {loading && sorted.length === 0 ? (
        <span className="muted px-1 py-1 text-[13px]">Memuat exchange...</span>
      ) : null}
      {sorted.map((exchange) => {
        const selected = exchange.selected;
        return (
          <button
            key={exchange.id}
            type="button"
            onClick={exchange.onSelect}
            aria-pressed={selected}
            title={`${exchange.name} · ${formatCount(exchange.count)} pair`}
            className={`inline-flex h-7 shrink-0 items-center overflow-hidden rounded-full border text-[12px] font-medium ${
              selected
                ? "border-foreground bg-foreground text-background"
                : "border-border bg-panel text-muted hover:border-border-strong hover:bg-panel-2 hover:text-foreground"
            }`}
          >
            <span className="inline-flex items-center gap-1.5 px-2.5">
              {exchange.fetching ? (
                <span className="market-pill-spin" aria-hidden="true" />
              ) : exchange.error ? (
                <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-down" aria-hidden="true" />
              ) : null}
              {exchange.name}
            </span>
            <span
              className={`num inline-flex h-full items-center border-l px-1.5 text-[11px] ${
                selected ? "border-background/25 text-background/75" : "border-border text-muted"
              }`}
            >
              {formatCount(exchange.count)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
