"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlsoOnCell } from "@/components/AlsoOnCell";
import { buildAlsoOnIndex, peersForRow, type TickerTableRow } from "@/lib/also-on";
import {
  columnFilteringFeature,
  columnVisibilityFeature,
  createColumnHelper,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  flexRender,
  globalFilteringFeature,
  metaHelper,
  rowPaginationFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnVisibilityState,
  type SortingState,
} from "@tanstack/react-table";
import {
  formatAmountCompact,
  formatPct,
  formatPrice,
  formatUsdCompact,
  formatWib,
  formatWibShort,
  isMarketActive,
  marketStatusMeta,
  parseCompactNumber,
  type MarketStatusTone,
} from "@/lib/format";
import { shortChainLabel } from "@/lib/contracts";
import { getSpotUrl } from "@/lib/exchanges/spot-urls";
import { FavoriteStar } from "@/components/FavoriteStar";
import { FundingIcons } from "@/components/FundingIcons";
import { usePersistedState } from "@/lib/persist";
import type { TickerRow } from "@/lib/types";

export type BlacklistEntry = { exchange: string; raw_symbol: string };
export type FavoriteEntry = { exchange: string; raw_symbol: string };

function blacklistKey(exchange: string, rawSymbol: string): string {
  return `${exchange}\t${rawSymbol}`;
}

function favoriteKey(exchange: string, rawSymbol: string): string {
  return `${exchange}\t${rawSymbol}`;
}

const MAX_VISIBLE_CONTRACTS = 1;
const COLUMN_VISIBILITY_KEY = "arbit-column-visibility";
const TABLE_FILTERS_KEY = "arbit-table-filters";

const FILTER_INPUT =
  "h-8 w-full rounded-md border border-border bg-panel-2 px-2 text-[13px] text-foreground outline-none placeholder:text-muted focus:border-border-strong";

type TableFilters = {
  search: string;
  minVolUsd: string;
  minSpread: string;
  maxSpread: string;
  minChange: string;
  maxChange: string;
  status: "all" | "online";
  stale: "all" | "hide" | "only";
  funding: "all" | "deposit" | "withdraw" | "both";
  hasBidAsk: boolean;
  hasContract: boolean;
  showBlacklist: boolean;
  /** Minimal jumlah exchange LAIN (aktif) yang juga punya coin ini; 0 = semua. */
  minAlsoOn: number;
};

const MIN_ALSO_ON_OPTIONS = [1, 2, 3, 5, 10] as const;

const DEFAULT_FILTERS: TableFilters = {
  search: "",
  minVolUsd: "",
  minSpread: "",
  maxSpread: "",
  minChange: "",
  maxChange: "",
  status: "all",
  stale: "all",
  funding: "all",
  hasBidAsk: false,
  hasContract: false,
  showBlacklist: false,
  minAlsoOn: 0,
};

function parseColumnVisibility(raw: unknown): ColumnVisibilityState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const state: ColumnVisibilityState = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "boolean") state[key] = value;
  }
  state.base = true;
  state.blacklist = true;
  if (state.fetched_at === undefined && typeof state.exchange_timestamp === "boolean") {
    state.fetched_at = state.exchange_timestamp;
  }
  delete state.exchange_timestamp;
  return state;
}

function isFilterStatus(value: unknown): value is TableFilters["status"] {
  return value === "all" || value === "online";
}

function isFilterStale(value: unknown): value is TableFilters["stale"] {
  return value === "all" || value === "hide" || value === "only";
}

function isFilterFunding(value: unknown): value is TableFilters["funding"] {
  return value === "all" || value === "deposit" || value === "withdraw" || value === "both";
}

function parseTableFilters(raw: unknown): TableFilters | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  return {
    search: typeof value.search === "string" ? value.search : DEFAULT_FILTERS.search,
    minVolUsd: typeof value.minVolUsd === "string" ? value.minVolUsd : DEFAULT_FILTERS.minVolUsd,
    minSpread: typeof value.minSpread === "string" ? value.minSpread : DEFAULT_FILTERS.minSpread,
    maxSpread: typeof value.maxSpread === "string" ? value.maxSpread : DEFAULT_FILTERS.maxSpread,
    minChange: typeof value.minChange === "string" ? value.minChange : DEFAULT_FILTERS.minChange,
    maxChange: typeof value.maxChange === "string" ? value.maxChange : DEFAULT_FILTERS.maxChange,
    status: isFilterStatus(value.status) ? value.status : DEFAULT_FILTERS.status,
    stale: isFilterStale(value.stale) ? value.stale : DEFAULT_FILTERS.stale,
    funding: isFilterFunding(value.funding) ? value.funding : DEFAULT_FILTERS.funding,
    hasBidAsk: typeof value.hasBidAsk === "boolean" ? value.hasBidAsk : DEFAULT_FILTERS.hasBidAsk,
    hasContract: typeof value.hasContract === "boolean" ? value.hasContract : DEFAULT_FILTERS.hasContract,
    showBlacklist: typeof value.showBlacklist === "boolean" ? value.showBlacklist : DEFAULT_FILTERS.showBlacklist,
    minAlsoOn:
      typeof value.minAlsoOn === "number" && Number.isInteger(value.minAlsoOn) && value.minAlsoOn >= 0
        ? value.minAlsoOn
        : DEFAULT_FILTERS.minAlsoOn,
  };
}

function rowMatchesSearch(ticker: TickerRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const statusLabel = marketStatusMeta(ticker.status, ticker.active).label;
  return [ticker.raw_symbol, ticker.base, ticker.quote, ticker.exchange, ticker.status, statusLabel].some(
    (value) => value != null && String(value).toLowerCase().includes(needle),
  );
}

function inBound(value: number | null, min: number | null, max: number | null): boolean {
  if (min == null && max == null) return true;
  if (value == null || !Number.isFinite(value)) return false;
  if (min != null && value < min) return false;
  if (max != null && value > max) return false;
  return true;
}

function applyTableFilters(
  rows: TickerRow[],
  filters: TableFilters,
  blocked: Set<string>,
): TickerRow[] {
  const minVol = parseCompactNumber(filters.minVolUsd);
  const minSpread = parseCompactNumber(filters.minSpread);
  const maxSpread = parseCompactNumber(filters.maxSpread);
  const minChange = parseCompactNumber(filters.minChange);
  const maxChange = parseCompactNumber(filters.maxChange);
  return rows.filter((row) => {
    if (!filters.showBlacklist && blocked.has(blacklistKey(row.exchange, row.raw_symbol))) return false;
    if (!rowMatchesSearch(row, filters.search)) return false;
    if (!inBound(row.quote_volume_24h, minVol, null)) return false;
    if (!inBound(row.spread_pct, minSpread, maxSpread)) return false;
    if (!inBound(row.change_24h_pct, minChange, maxChange)) return false;
    if (filters.status === "online" && !isMarketActive(row.status, row.active)) return false;
    if (filters.stale === "hide" && row.stale === 1) return false;
    if (filters.stale === "only" && row.stale !== 1) return false;
    if (filters.funding === "deposit" && row.deposit_enabled !== 1) return false;
    if (filters.funding === "withdraw" && row.withdraw_enabled !== 1) return false;
    if (filters.funding === "both" && (row.deposit_enabled !== 1 || row.withdraw_enabled !== 1)) return false;
    if (filters.hasBidAsk && (row.bid == null || row.bid === 0 || row.ask == null || row.ask === 0)) return false;
    if (filters.hasContract && (!row.contracts || row.contracts.length === 0)) return false;
    return true;
  });
}

function countActiveFilters(filters: TableFilters): number {
  return (
    Number(Boolean(filters.search.trim())) +
    Number(Boolean(filters.minVolUsd.trim())) +
    Number(Boolean(filters.minSpread.trim())) +
    Number(Boolean(filters.maxSpread.trim())) +
    Number(Boolean(filters.minChange.trim())) +
    Number(Boolean(filters.maxChange.trim())) +
    Number(filters.status !== "all") +
    Number(filters.stale !== "all") +
    Number(filters.funding !== "all") +
    Number(filters.hasBidAsk) +
    Number(filters.hasContract) +
    Number(filters.minAlsoOn > 0)
  );
}

const PAGE_SIZE_OPTIONS = [50, 100, 250, 500] as const;
const ALL_PAGE_SIZE = Number.MAX_SAFE_INTEGER;

const STATUS_TONE_CLASS: Record<MarketStatusTone, string> = {
  ok: "badge-ok",
  warn: "badge-warn",
  bad: "badge-bad",
  neutral: "badge-neutral",
};

const features = tableFeatures({
  columnVisibilityFeature,
  columnFilteringFeature,
  globalFilteringFeature,
  rowSortingFeature,
  rowPaginationFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  columnMeta: metaHelper<{ align?: "left" | "right"; sticky?: "bl" | "coin" }>(),
  tableMeta: metaHelper<{
    openOrderBook: (exchange: string, rawSymbol: string) => void;
    isBlacklisted: (exchange: string, rawSymbol: string) => boolean;
    onToggleBlacklist: (row: TickerRow, checked: boolean) => void;
    isFavorited: (exchange: string, rawSymbol: string) => boolean;
    onToggleFavorite: (row: TickerRow, next: boolean) => void;
  }>(),
});

const columnHelper = createColumnHelper<typeof features, TickerTableRow>();

function sortNullsLast(
  rowA: { getValue: (id: string) => unknown },
  rowB: { getValue: (id: string) => unknown },
  columnId: string,
  desc: boolean,
): number {
  const a = rowA.getValue(columnId);
  const b = rowB.getValue(columnId);
  if (a == null && b == null) return 0;
  if (a == null) return desc ? -1 : 1;
  if (b == null) return desc ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" });
}

function priceCell({ getValue }: { getValue: () => number | null }) {
  return formatPrice(getValue());
}

function usdCell({ getValue }: { getValue: () => number | null }) {
  return formatUsdCompact(getValue());
}

function amountCell({ getValue }: { getValue: () => number | null }) {
  return <span className="num">{formatAmountCompact(getValue())}</span>;
}

function lastVsMidCell({ getValue }: { getValue: () => number | null }) {
  const value = getValue();
  const cls =
    value == null || !Number.isFinite(value) ? "muted" : value > 0 ? "up" : value < 0 ? "down" : "";
  return <span className={cls}>{formatPct(value)}</span>;
}

function StaleCell({ row }: { row: TickerRow }) {
  if (row.stale !== 1) return <span className="muted">-</span>;
  const reason = (row.stale_reasons ?? "").trim() || "Data dianggap basi";
  return (
    <span
      className="badge-warn inline-flex whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium leading-tight"
      title={reason}
    >
      Stale
    </span>
  );
}

function FetchTimeCell({ value }: { value: string | null }) {
  if (!value) return <span className="muted">-</span>;
  return (
    <span className="num muted whitespace-nowrap" title={formatWib(value)}>
      {formatWibShort(value)}
    </span>
  );
}

function changeCell({ getValue }: { getValue: () => number | null }) {
  const value = getValue();
  const cls =
    value == null || !Number.isFinite(value) ? "muted" : value > 0 ? "up" : value < 0 ? "down" : "";
  return <span className={cls}>{formatPct(value)}</span>;
}

function spreadCell({ getValue }: { getValue: () => number | null }) {
  return <span>{formatPct(getValue())}</span>;
}

function ChainStatusCell({ row }: { row: TickerRow }) {
  return (
    <FundingIcons
      depositEnabled={row.deposit_enabled}
      withdrawEnabled={row.withdraw_enabled}
      chainstatusRaw={row.chainstatus_raw}
    />
  );
}

function ExternalLinkIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" className="shrink-0 muted">
      <path
        fill="currentColor"
        d="M6.5 3a.75.75 0 0 0 0 1.5h3.69L3.22 11.47a.75.75 0 1 0 1.06 1.06L11.25 5.56v3.69a.75.75 0 0 0 1.5 0V3.75A.75.75 0 0 0 12 3H6.5z"
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className="muted shrink-0">
      <path
        fill="currentColor"
        d="M11.2 10.15a5.25 5.25 0 1 0-1.05 1.05l2.85 2.85a.75.75 0 0 0 1.06-1.06l-2.86-2.84zM6.75 10.5a3.75 3.75 0 1 1 0-7.5 3.75 3.75 0 0 1 0 7.5z"
      />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" className="shrink-0">
      <path
        fill="currentColor"
        d="M5.5 2.75A1.75 1.75 0 0 1 7.25 1h5A1.75 1.75 0 0 1 14 2.75v7A1.75 1.75 0 0 1 12.25 11h-.5a.75.75 0 0 1 0-1.5h.5a.25.25 0 0 0 .25-.25v-7a.25.25 0 0 0-.25-.25h-5a.25.25 0 0 0-.25.25v.5a.75.75 0 0 1-1.5 0v-.5zM1 6.75A1.75 1.75 0 0 1 2.75 5h5A1.75 1.75 0 0 1 9.5 6.75v7A1.75 1.75 0 0 1 7.75 15.5h-5A1.75 1.75 0 0 1 1 13.75v-7zM2.75 6.5a.25.25 0 0 0-.25.25v7c0 .138.112.25.25.25h5a.25.25 0 0 0 .25-.25v-7a.25.25 0 0 0-.25-.25h-5z"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" className="shrink-0">
      <path
        fill="currentColor"
        d="M13.78 4.22a.75.75 0 0 1 0 1.06l-6.5 6.5a.75.75 0 0 1-1.06 0l-3-3a.75.75 0 0 1 1.06-1.06L6.75 10.19l5.97-5.97a.75.75 0 0 1 1.06 0z"
      />
    </svg>
  );
}

function ContractCopyButton({ chain, contract }: { chain: string; contract: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(contract);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button
      type="button"
      title={contract}
      onClick={() => void copy()}
      className="inline-flex items-center gap-0.5 rounded border border-border bg-panel-2 px-1.5 py-0.5 text-[10px] leading-tight text-muted hover:border-border-strong hover:text-foreground"
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      <span>{shortChainLabel(chain)}</span>
    </button>
  );
}

function ContractsCell({ row }: { row: TickerRow }) {
  const contracts = row.contracts;
  const [expanded, setExpanded] = useState(false);
  if (contracts == null) return <span className="muted">-</span>;
  if (contracts.length === 0) return <span className="muted">Native</span>;
  const visible = expanded || contracts.length <= MAX_VISIBLE_CONTRACTS
    ? contracts
    : contracts.slice(0, MAX_VISIBLE_CONTRACTS);
  const extra = contracts.length - 1;
  const extraLabels = contracts.slice(1).map((item) => shortChainLabel(item.chain)).join(", ");
  return (
    <div className="contracts-cell">
      {visible.map((item) => (
        <ContractCopyButton
          key={`${item.chain}:${item.contract}`}
          chain={item.chain}
          contract={item.contract}
        />
      ))}
      {contracts.length > 1 ? (
        <button
          type="button"
          className="contracts-more"
          title={expanded ? "Sembunyikan kontrak lain" : `Tampilkan ${extra} kontrak lain: ${extraLabels}`}
          aria-expanded={expanded}
          aria-label={expanded ? "Sembunyikan kontrak lain" : `Tampilkan ${extra} kontrak lain`}
          onClick={(event) => {
            event.stopPropagation();
            setExpanded((value) => !value);
          }}
        >
          {expanded ? "−" : `+${extra}`}
        </button>
      ) : null}
    </div>
  );
}

function SymbolCell({ row, label }: { row: TickerRow; label: string }) {
  const href = getSpotUrl(row.exchange, row.base, row.quote, row.raw_symbol);
  const text = <span className="font-medium text-foreground">{label}</span>;
  if (!href) return text;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-foreground hover:opacity-80"
      title={`Buka ${row.base}/${row.quote} di ${row.exchange}`}
    >
      {text}
      <ExternalLinkIcon />
    </a>
  );
}

function StatusBadge({ row }: { row: TickerRow }) {
  const meta = marketStatusMeta(row.status, row.active);
  return (
    <span
      className={`inline-flex whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium leading-tight ${STATUS_TONE_CLASS[meta.tone]}`}
    >
      {meta.label}
    </span>
  );
}



const STICKY_BL_WIDTH = "3.75rem";

function stickyColStyle(sticky: "bl" | "coin" | undefined): { width?: string; minWidth?: string; maxWidth?: string; left?: string; paddingLeft?: string; paddingRight?: string } | undefined {
  if (sticky === "bl") {
    return {
      width: STICKY_BL_WIDTH,
      minWidth: STICKY_BL_WIDTH,
      maxWidth: STICKY_BL_WIDTH,
      left: "0",
      paddingLeft: "0.35rem",
      paddingRight: "0.25rem",
    };
  }
  if (sticky === "coin") {
    return { left: STICKY_BL_WIDTH };
  }
  return undefined;
}

const columns = columnHelper.columns([
  columnHelper.display({
    id: "blacklist",
    header: "",
    enableSorting: false,
    enableGlobalFilter: false,
    enableHiding: false,
    meta: { align: "left", sticky: "bl" },
    cell: (info) => {
      const row = info.row.original;
      const checked = Boolean(info.table.options.meta?.isBlacklisted(row.exchange, row.raw_symbol));
      const favorited = Boolean(info.table.options.meta?.isFavorited(row.exchange, row.raw_symbol));
      return (
        <div className="flex items-center justify-center gap-0.5">
          <FavoriteStar
            active={favorited}
            symbol={row.raw_symbol}
            onToggle={() => info.table.options.meta?.onToggleFavorite(row, !favorited)}
          />
          <label className="flex cursor-pointer items-center justify-center" title={checked ? "Hapus dari blacklist" : "Sembunyikan pair ini"}>
            <span className="sr-only">Blacklist {row.raw_symbol}</span>
            <input
              type="checkbox"
              checked={checked}
              onChange={(event) => info.table.options.meta?.onToggleBlacklist(row, event.target.checked)}
              onClick={(event) => event.stopPropagation()}
              className="accent-foreground"
            />
          </label>
        </div>
      );
    },
  }),
  columnHelper.accessor("base", {
    header: "Coin",
    enableGlobalFilter: true,
    enableHiding: false,
    meta: { align: "left", sticky: "coin" },
    cell: (info) => <SymbolCell row={info.row.original} label={info.getValue()} />,
  }),
  columnHelper.accessor("alsoOnCount", {
    header: "Ada di",
    enableGlobalFilter: false,
    enableHiding: true,
    sortDescFirst: true,
    meta: { align: "left" },
    cell: (info) => {
      const row = info.row.original;
      return <AlsoOnCell count={row.alsoOnCount} peers={row.alsoOnPeers} />;
    },
  }),
  columnHelper.accessor("raw_symbol", {
    header: "Symbol",
    enableGlobalFilter: true,
    enableHiding: true,
    meta: { align: "left" },
    cell: (info) => <span className="font-medium">{info.getValue()}</span>,
  }),
  columnHelper.accessor((row) => row.status ?? "", {
    id: "status",
    header: "Status",
    enableGlobalFilter: false,
    meta: { align: "left" },
    cell: (info) => <StatusBadge row={info.row.original} />,
    sortFn: (rowA, rowB) => {
      const a = marketStatusMeta(rowA.original.status, rowA.original.active);
      const b = marketStatusMeta(rowB.original.status, rowB.original.active);
      if (a.active !== b.active) return a.active ? 1 : -1;
      return a.label.localeCompare(b.label, "id");
    },
  }),
  columnHelper.accessor("last", {
    header: "Last",
    enableGlobalFilter: false,
    sortDescFirst: true,
    meta: { align: "right" },
    cell: priceCell,
  }),
  columnHelper.accessor("bid", {
    header: "Bid",
    enableGlobalFilter: false,
    sortDescFirst: true,
    meta: { align: "right" },
    cell: priceCell,
  }),
  columnHelper.accessor("bid_size", {
    header: "Bid size",
    enableGlobalFilter: false,
    sortDescFirst: true,
    meta: { align: "right" },
    cell: amountCell,
  }),
  columnHelper.accessor("ask", {
    header: "Ask",
    enableGlobalFilter: false,
    sortDescFirst: true,
    meta: { align: "right" },
    cell: priceCell,
  }),
  columnHelper.accessor("ask_size", {
    header: "Ask size",
    enableGlobalFilter: false,
    sortDescFirst: true,
    meta: { align: "right" },
    cell: amountCell,
  }),
  columnHelper.accessor("quote_volume_24h", {
    header: "Vol USD 24h",
    enableGlobalFilter: false,
    sortDescFirst: true,
    meta: { align: "right" },
    cell: usdCell,
  }),
  columnHelper.accessor("base_volume_24h", {
    header: "Vol 24h (koin)",
    enableGlobalFilter: false,
    sortDescFirst: true,
    meta: { align: "right" },
    cell: amountCell,
  }),
  columnHelper.accessor("change_24h_pct", {
    header: "24h %",
    enableGlobalFilter: false,
    sortDescFirst: true,
    meta: { align: "right" },
    cell: changeCell,
  }),
  columnHelper.accessor("spread_pct", {
    header: "Spread %",
    enableGlobalFilter: false,
    sortDescFirst: true,
    meta: { align: "right" },
    cell: spreadCell,
  }),
  columnHelper.accessor("last_vs_mid_pct", {
    header: "Last vs Mid %",
    enableGlobalFilter: false,
    sortDescFirst: true,
    meta: { align: "right" },
    cell: lastVsMidCell,
  }),
  columnHelper.accessor("stale", {
    header: "Stale",
    enableGlobalFilter: false,
    sortDescFirst: true,
    meta: { align: "left" },
    cell: (info) => <StaleCell row={info.row.original} />,
  }),
  columnHelper.accessor("fetched_at", {
    header: "Waktu fetch",
    enableGlobalFilter: false,
    sortDescFirst: true,
    meta: { align: "left" },
    cell: (info) => <FetchTimeCell value={info.getValue()} />,
  }),
  columnHelper.display({
    id: "orderbook",
    header: "Orderbook",
    enableSorting: false,
    enableGlobalFilter: false,
    cell: (info) => {
      const row = info.row.original;
      return (
        <button
          type="button"
          onClick={() => info.table.options.meta?.openOrderBook(row.exchange, row.raw_symbol)}
          className="btn-ghost !px-2 !py-0.5 !text-[11px]"
        >
          Orderbook
        </button>
      );
    },
  }),
  columnHelper.display({
    id: "contracts",
    header: "Kontrak",
    enableSorting: false,
    enableGlobalFilter: false,
    meta: { align: "left" },
    cell: (info) => <ContractsCell row={info.row.original} />,
  }),
  columnHelper.display({
    id: "chainstatus",
    header: "Depo/WD",
    enableSorting: false,
    enableGlobalFilter: false,
    meta: { align: "left" },
    cell: (info) => <ChainStatusCell row={info.row.original} />,
  }),
]);

type ExchangeLabel = { id: string; name: string };

type TickersTableProps = {
  tickers: TickerRow[];
  allTickers?: TickerRow[];
  exchanges?: ExchangeLabel[];
  blacklist?: BlacklistEntry[];
  favorites?: FavoriteEntry[];
  loading: boolean;
  onOpenOrderBook: (exchange: string, rawSymbol: string) => void;
};

export function TickersTable({
  tickers,
  allTickers,
  exchanges = [],
  blacklist = [],
  favorites = [],
  loading,
  onOpenOrderBook,
}: TickersTableProps) {
  const pendingBlacklist = useRef<Set<string>>(new Set());
  const pendingFavorites = useRef<Set<string>>(new Set());
  const [blocked, setBlocked] = useState<Set<string>>(
    () => new Set(blacklist.map((item) => blacklistKey(item.exchange, item.raw_symbol))),
  );
  const blacklistSig = blacklist.map((item) => blacklistKey(item.exchange, item.raw_symbol)).sort().join("|");
  useEffect(() => {
    setBlocked((prev) => {
      const next = new Set(blacklist.map((item) => blacklistKey(item.exchange, item.raw_symbol)));
      for (const key of pendingBlacklist.current) {
        if (prev.has(key)) next.add(key);
        else next.delete(key);
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sinkron dari prop lewat signature
  }, [blacklistSig]);

  const onToggleBlacklist = async (row: TickerRow, checked: boolean) => {
    const key = blacklistKey(row.exchange, row.raw_symbol);
    pendingBlacklist.current.add(key);
    setBlocked((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
    try {
      const response = await fetch("/api/blacklist", {
        method: checked ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ exchange: row.exchange, raw_symbol: row.raw_symbol }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.ok === false) {
        throw new Error(data?.error || `Gagal ${checked ? "menambah" : "menghapus"} blacklist`);
      }
    } catch (error) {
      setBlocked((prev) => {
        const next = new Set(prev);
        if (checked) next.delete(key);
        else next.add(key);
        return next;
      });
      console.warn(error instanceof Error ? error.message : String(error));
    } finally {
      pendingBlacklist.current.delete(key);
    }
  };

  const [starred, setStarred] = useState<Set<string>>(
    () => new Set(favorites.map((item) => favoriteKey(item.exchange, item.raw_symbol))),
  );
  const favoritesSig = favorites.map((item) => favoriteKey(item.exchange, item.raw_symbol)).sort().join("|");
  useEffect(() => {
    setStarred((prev) => {
      const next = new Set(favorites.map((item) => favoriteKey(item.exchange, item.raw_symbol)));
      for (const key of pendingFavorites.current) {
        if (prev.has(key)) next.add(key);
        else next.delete(key);
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sinkron dari prop lewat signature
  }, [favoritesSig]);

  const onToggleFavorite = async (row: TickerRow, nextActive: boolean) => {
    const key = favoriteKey(row.exchange, row.raw_symbol);
    pendingFavorites.current.add(key);
    setStarred((prev) => {
      const next = new Set(prev);
      if (nextActive) next.add(key);
      else next.delete(key);
      return next;
    });
    try {
      const response = await fetch("/api/favorites", {
        method: nextActive ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ exchange: row.exchange, raw_symbol: row.raw_symbol }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.ok === false) {
        throw new Error(data?.error || `Gagal ${nextActive ? "menambah" : "menghapus"} favorit`);
      }
    } catch (error) {
      setStarred((prev) => {
        const next = new Set(prev);
        if (nextActive) next.delete(key);
        else next.add(key);
        return next;
      });
      console.warn(error instanceof Error ? error.message : String(error));
    } finally {
      pendingFavorites.current.delete(key);
    }
  };
  const [sorting, setSorting] = useState<SortingState>([{ id: "base", desc: false }]);
  const [columnVisibility, setColumnVisibility] = usePersistedState<ColumnVisibilityState>(
    COLUMN_VISIBILITY_KEY,
    {},
    parseColumnVisibility,
  );
  const [filters, setFilters] = usePersistedState<TableFilters>(
    TABLE_FILTERS_KEY,
    DEFAULT_FILTERS,
    parseTableFilters,
  );
  const [columnVisibilityOpen, setColumnVisibilityOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const visibilityRef = useRef<HTMLDivElement>(null);
  const filtersRef = useRef<HTMLDivElement>(null);
  const sortingRef = useRef(sorting);
  sortingRef.current = sorting;

  const sortFn = useMemo(
    () =>
      (
        rowA: { getValue: (id: string) => unknown },
        rowB: { getValue: (id: string) => unknown },
        columnId: string,
      ) => {
        const desc = sortingRef.current.find((item) => item.id === columnId)?.desc ?? false;
        return sortNullsLast(rowA, rowB, columnId, desc);
      },
    [],
  );

  const statusCounts = useMemo(() => {
    let active = 0;
    for (const ticker of tickers) {
      if (isMarketActive(ticker.status, ticker.active)) active += 1;
    }
    return { active, inactive: tickers.length - active };
  }, [tickers]);

  const alsoOnIndex = useMemo(() => {
    const source = allTickers && allTickers.length > 0 ? allTickers : tickers;
    const enabledIds = new Set(exchanges.map((item) => item.id));
    const namesById: Record<string, string> = {};
    for (const item of exchanges) namesById[item.id] = item.name;
    return buildAlsoOnIndex(source, { enabledIds, namesById, blocked });
  }, [allTickers, tickers, exchanges, blocked]);

  const visibleTickers = useMemo<TickerTableRow[]>(
    () =>
      applyTableFilters(tickers, filters, blocked)
        .map((row) => {
          const peers = peersForRow(alsoOnIndex, row);
          return { ...row, alsoOnCount: peers.length, alsoOnPeers: peers };
        })
        .filter((row) => filters.minAlsoOn <= 0 || row.alsoOnCount >= filters.minAlsoOn),
    [tickers, filters, blocked, alsoOnIndex],
  );
  const blacklistCount = useMemo(
    () => tickers.filter((row) => blocked.has(blacklistKey(row.exchange, row.raw_symbol))).length,
    [tickers, blocked],
  );
  const activeFilterCount = useMemo(() => countActiveFilters(filters), [filters]);

  useEffect(() => {
    if (!columnVisibilityOpen && !filtersOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (visibilityRef.current && !visibilityRef.current.contains(target)) {
        setColumnVisibilityOpen(false);
      }
      if (filtersRef.current && !filtersRef.current.contains(target)) {
        setFiltersOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setColumnVisibilityOpen(false);
        setFiltersOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [columnVisibilityOpen, filtersOpen]);

  const table = useTable({
    features,
    columns,
    data: visibleTickers,
    getRowId: (row) => `${row.exchange}-${row.raw_symbol}`,
    enableMultiSort: true,
    enableSortingRemoval: false,
    state: { sorting, columnVisibility },
    onSortingChange: setSorting,
    onColumnVisibilityChange: (updater) => {
      setColumnVisibility((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        return { ...next, base: true, blacklist: true };
      });
    },
    initialState: {
      pagination: { pageIndex: 0, pageSize: 100 },
    },
    meta: {
      openOrderBook: onOpenOrderBook,
      isBlacklisted: (exchange, rawSymbol) => blocked.has(blacklistKey(exchange, rawSymbol)),
      onToggleBlacklist,
      isFavorited: (exchange, rawSymbol) => starred.has(favoriteKey(exchange, rawSymbol)),
      onToggleFavorite,
    },
    defaultColumn: { sortFn },
  });

  const tableRef = useRef(table);
  tableRef.current = table;
  useEffect(() => {
    tableRef.current.setPageIndex(0);
  }, [filters]);

  const filteredCount = visibleTickers.length;
  const { pageIndex, pageSize } = table.state.pagination;
  const from = filteredCount === 0 ? 0 : pageIndex * pageSize + 1;
  const to = Math.min(filteredCount, (pageIndex + 1) * pageSize);
  const pageCount = table.getPageCount();
  const hideableColumns = table.getAllLeafColumns().filter((column) => column.getCanHide());

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3 flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-3">
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <label className="relative block w-full min-w-0 sm:w-64">
              <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center">
                <SearchIcon />
              </span>
              <input
                type="search"
                value={filters.search}
                onChange={(event) => setFilters((prev) => ({ ...prev, search: event.target.value }))}
                placeholder="Cari symbol, base, atau status..."
                className="w-full rounded-full border border-border bg-panel-2 py-1.5 pl-9 pr-3 text-[13px] text-foreground outline-none placeholder:text-muted focus:border-border-strong"
              />
            </label>
            <div className="relative" ref={filtersRef}>
              <button
                type="button"
                onClick={() => {
                  setFiltersOpen((open) => !open);
                  setColumnVisibilityOpen(false);
                }}
                className="btn-ghost inline-flex items-center gap-1.5"
              >
                Filter
                {activeFilterCount > 0 ? (
                  <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-foreground px-1.5 py-0.5 text-[10px] font-medium leading-none text-background">
                    {activeFilterCount}
                  </span>
                ) : null}
              </button>
              {filtersOpen ? (
                <div className="absolute left-0 z-30 mt-1 w-[min(36rem,calc(100vw-2rem))] max-h-[min(70vh,36rem)] overflow-auto rounded-lg border border-border bg-panel p-3 shadow-xl">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="muted text-[11px] uppercase tracking-wide">Filter tabel</p>
                    <button
                      type="button"
                      onClick={() => setFilters(DEFAULT_FILTERS)}
                      disabled={activeFilterCount === 0}
                      className="btn-ghost !px-2 !py-0.5 !text-[11px]"
                    >
                      Reset
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <label className="block min-w-0">
                      <span className="muted mb-1 block text-[10px] uppercase tracking-wide">Min Vol USD</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={filters.minVolUsd}
                        onChange={(event) => setFilters((prev) => ({ ...prev, minVolUsd: event.target.value }))}
                        placeholder="10k"
                        className={FILTER_INPUT}
                      />
                    </label>
                    <label className="block min-w-0">
                      <span className="muted mb-1 block text-[10px] uppercase tracking-wide">Min Spread %</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={filters.minSpread}
                        onChange={(event) => setFilters((prev) => ({ ...prev, minSpread: event.target.value }))}
                        placeholder="0.1"
                        className={FILTER_INPUT}
                      />
                    </label>
                    <label className="block min-w-0">
                      <span className="muted mb-1 block text-[10px] uppercase tracking-wide">Max Spread %</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={filters.maxSpread}
                        onChange={(event) => setFilters((prev) => ({ ...prev, maxSpread: event.target.value }))}
                        placeholder="2"
                        className={FILTER_INPUT}
                      />
                    </label>
                    <label className="block min-w-0">
                      <span className="muted mb-1 block text-[10px] uppercase tracking-wide">Min 24h %</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={filters.minChange}
                        onChange={(event) => setFilters((prev) => ({ ...prev, minChange: event.target.value }))}
                        placeholder="-5"
                        className={FILTER_INPUT}
                      />
                    </label>
                    <label className="block min-w-0">
                      <span className="muted mb-1 block text-[10px] uppercase tracking-wide">Max 24h %</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={filters.maxChange}
                        onChange={(event) => setFilters((prev) => ({ ...prev, maxChange: event.target.value }))}
                        placeholder="10"
                        className={FILTER_INPUT}
                      />
                    </label>
                    <label className="block min-w-0">
                      <span className="muted mb-1 block text-[10px] uppercase tracking-wide">Status</span>
                      <select
                        value={filters.status}
                        onChange={(event) =>
                          setFilters((prev) => ({ ...prev, status: event.target.value as TableFilters["status"] }))
                        }
                        className={FILTER_INPUT}
                      >
                        <option value="all">Semua</option>
                        <option value="online">Hanya online</option>
                      </select>
                    </label>
                    <label className="block min-w-0">
                      <span className="muted mb-1 block text-[10px] uppercase tracking-wide">Stale</span>
                      <select
                        value={filters.stale}
                        onChange={(event) =>
                          setFilters((prev) => ({ ...prev, stale: event.target.value as TableFilters["stale"] }))
                        }
                        className={FILTER_INPUT}
                      >
                        <option value="all">Semua</option>
                        <option value="hide">Sembunyikan stale</option>
                        <option value="only">Hanya stale</option>
                      </select>
                    </label>
                    <label className="block min-w-0">
                      <span className="muted mb-1 block text-[10px] uppercase tracking-wide">Depo/WD</span>
                      <select
                        value={filters.funding}
                        onChange={(event) =>
                          setFilters((prev) => ({ ...prev, funding: event.target.value as TableFilters["funding"] }))
                        }
                        className={FILTER_INPUT}
                      >
                        <option value="all">Semua</option>
                        <option value="deposit">Deposit on</option>
                        <option value="withdraw">WD on</option>
                        <option value="both">Keduanya on</option>
                      </select>
                    </label>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                    <label className="flex cursor-pointer items-center gap-1.5 text-[13px] text-foreground">
                      <input
                        type="checkbox"
                        checked={filters.hasBidAsk}
                        onChange={(event) => setFilters((prev) => ({ ...prev, hasBidAsk: event.target.checked }))}
                        className="accent-foreground"
                      />
                      Ada bid & ask
                    </label>
                    <label className="flex cursor-pointer items-center gap-1.5 text-[13px] text-foreground">
                      <input
                        type="checkbox"
                        checked={filters.hasContract}
                        onChange={(event) => setFilters((prev) => ({ ...prev, hasContract: event.target.checked }))}
                        className="accent-foreground"
                      />
                      Ada kontrak
                    </label>
                    <label className="flex cursor-pointer items-center gap-1.5 text-[13px] text-foreground">
                      <input
                        type="checkbox"
                        checked={filters.showBlacklist}
                        onChange={(event) => setFilters((prev) => ({ ...prev, showBlacklist: event.target.checked }))}
                        className="accent-foreground"
                      />
                      Tampilkan blacklist{blacklistCount > 0 ? ` (${blacklistCount})` : ""}
                    </label>
                  </div>
                </div>
              ) : null}
            </div>
            {/* Style inline supaya tampil walau CSS dev server belum ter-rebuild. */}
            <label
              className="min-also-on"
              style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 32, fontSize: 12, whiteSpace: "nowrap" }}
              title="Hanya coin yang juga ada di minimal N exchange lain (sama dengan kolom Ada di)"
            >
              <span className="muted">Min ada di</span>
              <select
                value={String(filters.minAlsoOn)}
                onChange={(event) => setFilters((prev) => ({ ...prev, minAlsoOn: Number(event.target.value) || 0 }))}
                className={filters.minAlsoOn > 0 ? "is-active" : undefined}
                style={{
                  height: 32,
                  padding: "0 8px",
                  border: `1px solid ${filters.minAlsoOn > 0 ? "var(--foreground)" : "var(--border)"}`,
                  borderRadius: 6,
                  background: "var(--panel-2)",
                  color: "var(--foreground)",
                  fontSize: 13,
                  outline: "none",
                  cursor: "pointer",
                }}
              >
                <option value="0">Semua</option>
                {MIN_ALSO_ON_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    ≥ {n} ex lain
                  </option>
                ))}
              </select>
            </label>
            <div className="relative" ref={visibilityRef}>
              <button
                type="button"
                onClick={() => {
                  setColumnVisibilityOpen((open) => !open);
                  setFiltersOpen(false);
                }}
                className="btn-ghost"
              >
                Kolom
              </button>
              {columnVisibilityOpen ? (
                <div className="absolute left-0 z-30 mt-1 w-56 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-panel-2 p-2 shadow-xl">
                  <p className="muted px-1 pb-2 text-[11px] uppercase tracking-wide">Tampilkan kolom</p>
                  <div className="max-h-[min(18rem,70vh)] overflow-auto">
                    {hideableColumns.map((column) => (
                      <label
                        key={column.id}
                        className="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 text-xs text-foreground hover:bg-hover"
                      >
                        <input
                          type="checkbox"
                          checked={column.getIsVisible()}
                          onChange={column.getToggleVisibilityHandler()}
                          className="accent-foreground"
                        />
                        {typeof column.columnDef.header === "string" ? column.columnDef.header : column.id}
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
            {tickers.length > 0 ? (
              <span className="muted text-xs sm:text-[13px]">
                Aktif {statusCounts.active}
                {statusCounts.inactive > 0 ? ` · Non-aktif ${statusCounts.inactive}` : ""}
                {" · "}
                {filteredCount} dari {tickers.length} pair
              </span>
            ) : null}
          </div>
          <span className="muted hidden text-xs lg:inline">
            Klik judul kolom untuk mengurutkan. Shift+klik untuk multi-sort. Volume 0 tetap tampil.
          </span>
        </div>
      </div>

      <div className="tickers-scroll min-h-0 flex-1 overflow-auto">
        <table className="tickers-table w-full border-separate border-spacing-0 text-left">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const sticky = header.column.columnDef.meta?.sticky;
                  const align = header.column.columnDef.meta?.align === "right" ? "text-right" : "text-left";
                  const canSort = header.column.getCanSort();
                  const sorted = header.column.getIsSorted();
                  const sortIndex = header.column.getSortIndex();
                  const showIndex = sorted && sorting.length > 1;
                  const compactHeader = header.column.id === "alsoOnCount";
                  return (
                    <th key={header.id} className={`col-${header.column.id}${sticky ? ` sticky-col sticky-${sticky}` : ""}`} style={stickyColStyle(sticky)}>
                      {canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className={`inline-flex items-center gap-1 ${compactHeader ? "" : "w-full"} ${align === "text-right" ? "justify-end" : "justify-start"}`}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          <span className="inline-flex min-w-3 items-center text-[10px] text-foreground">
                            {sorted === "asc" ? "↑" : sorted === "desc" ? "↓" : ""}
                            {showIndex ? sortIndex + 1 : ""}
                          </span>
                        </button>
                      ) : (
                        <span className={align}>{flexRender(header.column.columnDef.header, header.getContext())}</span>
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => {
              const inactive = !isMarketActive(row.original.status, row.original.active);
              const listed = blocked.has(blacklistKey(row.original.exchange, row.original.raw_symbol));
              const rowClass = [inactive ? "inactive" : "", listed ? "blacklisted" : ""].filter(Boolean).join(" ");
              return (
                <tr key={row.id} className={rowClass || undefined}>
                  {row.getVisibleCells().map((cell) => {
                    const sticky = cell.column.columnDef.meta?.sticky;
                    const align = cell.column.columnDef.meta?.align === "right" ? "text-right num whitespace-nowrap" : "";
                    return (
                      <td key={cell.id} className={`col-${cell.column.id} ${align}${sticky ? ` sticky-col sticky-${sticky}` : ""}`} style={stickyColStyle(sticky)}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {!loading && tickers.length === 0 ? (
              <tr>
                <td colSpan={Math.max(1, table.getVisibleLeafColumns().length)} className="muted !h-24 px-4 text-center">
                  Belum ada data. Klik tombol Fetch untuk mengambil ticker dari exchange.
                </td>
              </tr>
            ) : null}
            {!loading && tickers.length > 0 && filteredCount === 0 ? (
              <tr>
                <td colSpan={Math.max(1, table.getVisibleLeafColumns().length)} className="muted !h-24 px-4 text-center">
                  Tidak ada pair yang cocok dengan filter atau pencarian.
                </td>
              </tr>
            ) : null}
            {loading && tickers.length === 0 ? (
              <tr>
                <td colSpan={Math.max(1, table.getVisibleLeafColumns().length)} className="muted !h-24 px-4 text-center">
                  Memuat tabel...
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[13px]">
        <span className="muted">
          {loading && tickers.length === 0
            ? "Memuat tabel..."
            : `Menampilkan ${from}-${to} dari ${filteredCount}`}
        </span>
        <div className="flex flex-wrap items-center gap-3">
          <label className="muted flex items-center gap-2">
            <span>Baris per halaman</span>
            <select
              value={pageSize === ALL_PAGE_SIZE ? "all" : String(pageSize)}
              onChange={(event) => {
                const value = event.target.value;
                table.setPageSize(value === "all" ? ALL_PAGE_SIZE : Number(value));
              }}
              className="rounded-md border border-border bg-panel-2 px-2 py-1 text-[13px] text-foreground outline-none"
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
              <option value="all">Semua</option>
            </select>
          </label>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
              className="btn-ghost !px-2 !py-1"
            >
              Sebelumnya
            </button>
            <span className="muted px-2">
              {pageCount === 0 ? 0 : pageIndex + 1} / {pageCount}
            </span>
            <button
              type="button"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              className="btn-ghost !px-2 !py-1"
            >
              Berikutnya
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
