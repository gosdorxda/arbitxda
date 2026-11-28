"use client";

import { sortByExchangeName } from "@/lib/format";
import { usePersistedState } from "@/lib/persist";

const PILLS_COLLAPSED_KEY = "arbit-market-pills-collapsed";

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

function parseCollapsed(raw: unknown): boolean | null {
  return typeof raw === "boolean" ? raw : null;
}

export function ExchangeMarketBar({ loading, items, totalCount }: ExchangeMarketBarProps) {
  const sorted = sortByExchangeName(items, (item) => item.name);
  const [collapsed, setCollapsed] = usePersistedState(PILLS_COLLAPSED_KEY, false, parseCollapsed);
  const exchangeCount = sorted.length;
  const summary = `${exchangeCount} exchange · ${formatCount(totalCount)} pair`;

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-background px-4 py-2 sm:px-5">
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
        aria-controls="exchange-market-pills"
        title={collapsed ? `${summary} · buka daftar` : `${summary} · tutup daftar`}
        aria-label={collapsed ? `Buka daftar exchange (${summary})` : `Tutup daftar exchange (${summary})`}
        className="inline-flex h-7 shrink-0 items-center overflow-hidden rounded-full border border-border-strong bg-panel-2 text-[12px] hover:bg-hover"
      >
        <span className="px-2.5 text-muted">
          Total{exchangeCount > 0 ? ` · ${exchangeCount} ex` : " Market"}
        </span>
        <span className="num inline-flex h-full items-center border-l border-border px-2 font-semibold text-foreground">
          {formatCount(totalCount)}
        </span>
        <span className="inline-flex h-full items-center border-l border-border px-1.5 text-muted" aria-hidden="true">
          <svg
            viewBox="0 0 16 16"
            width="12"
            height="12"
            className={`block transition-transform duration-150 ease-out ${collapsed ? "-rotate-90" : ""}`}
          >
            <path
              fill="currentColor"
              d="M4.7 6.3a.75.75 0 0 1 1.06 0L8 8.54l2.24-2.24a.75.75 0 1 1 1.06 1.06l-2.77 2.77a.75.75 0 0 1-1.06 0L4.7 7.36a.75.75 0 0 1 0-1.06z"
            />
          </svg>
        </span>
      </button>
      {!collapsed ? (
        <div id="exchange-market-pills" className="contents">
          {exchangeCount > 0 ? <span className="mx-0.5 h-5 w-px shrink-0 bg-border" aria-hidden="true" /> : null}
          {loading && exchangeCount === 0 ? (
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
      ) : null}
    </div>
  );
}
