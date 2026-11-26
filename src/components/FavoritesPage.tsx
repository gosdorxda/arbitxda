"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlsoOnCell } from "@/components/AlsoOnCell";
import { AppHeader } from "@/components/AppHeader";
import { useCoinBlacklist } from "@/components/BlacklistSettings";
import { useExchangeSettings } from "@/components/ExchangeSettings";
import { DepthCell, DepthProvider, DepthStatusBar } from "@/components/DepthBar";
import { FavoriteStar } from "@/components/FavoriteStar";
import { FundingIcons } from "@/components/FundingIcons";
import { useOrderBook } from "@/components/OrderBookModal";
import { useVisibleDepth } from "@/components/useVisibleDepth";
import { buildAlsoOnIndex, peersForRow, type TickerTableRow } from "@/lib/also-on";
import { shortChainLabel } from "@/lib/contracts";
import { getSpotUrl } from "@/lib/exchanges/spot-urls";
import {
  formatAmountCompact,
  formatPct,
  formatPrice,
  formatUsdCompact,
  formatWib,
  formatWibShort,
  marketStatusMeta,
  sortByExchangeName,
  type MarketStatusTone,
} from "@/lib/format";
import { usePersistedState } from "@/lib/persist";
import type { TickerRow } from "@/lib/types";

type FavoriteEntry = { exchange: string; raw_symbol: string };

type ExchangeLabel = { id: string; name: string };

type StatusResponse = {
  ok?: boolean;
  error?: string;
  exchanges?: Array<{ id: string; name: string; enabled?: number }>;
};

type TickersResponse = {
  ok?: boolean;
  error?: string;
  tickers?: TickerRow[];
  blacklist?: FavoriteEntry[];
  favorites?: FavoriteEntry[];
};

const COLUMN_VISIBILITY_KEY = "arbit-favorites-column-visibility";
const MAX_VISIBLE_CONTRACTS = 1;

const STATUS_TONE_CLASS: Record<MarketStatusTone, string> = {
  ok: "badge-ok",
  warn: "badge-warn",
  bad: "badge-bad",
  neutral: "badge-neutral",
};

const FAVORITE_COLUMNS = [
  { id: "exchange", label: "Exchange", defaultOn: true, align: "left", sortable: true },
  { id: "base", label: "Coin", defaultOn: true, align: "left", sortable: true },
  { id: "raw_symbol", label: "Symbol", defaultOn: true, align: "left", sortable: true },
  { id: "status", label: "Status", defaultOn: false, align: "left", sortable: true },
  { id: "last", label: "Last", defaultOn: true, align: "right", sortable: true },
  { id: "bid", label: "Bid", defaultOn: true, align: "right", sortable: true },
  { id: "bid_size", label: "Bid size", defaultOn: false, align: "right", sortable: true },
  { id: "ask", label: "Ask", defaultOn: true, align: "right", sortable: true },
  { id: "ask_size", label: "Ask size", defaultOn: false, align: "right", sortable: true },
  { id: "spread_pct", label: "Spread %", defaultOn: true, align: "right", sortable: true },
  { id: "quote_volume_24h", label: "Vol USD 24h", defaultOn: true, align: "right", sortable: true },
  { id: "base_volume_24h", label: "Vol 24h (koin)", defaultOn: false, align: "right", sortable: true },
  { id: "change_24h_pct", label: "24h %", defaultOn: true, align: "right", sortable: true },
  { id: "last_vs_mid_pct", label: "Last vs Mid %", defaultOn: false, align: "right", sortable: true },
  { id: "stale", label: "Stale", defaultOn: false, align: "left", sortable: true },
  { id: "fetched_at", label: "Waktu fetch", defaultOn: false, align: "left", sortable: true },
  { id: "chainstatus", label: "Depo/WD", defaultOn: true, align: "left", sortable: false },
  { id: "alsoOnCount", label: "Ada di", defaultOn: true, align: "left", sortable: true },
  { id: "depth", label: "Depth", defaultOn: false, align: "left", sortable: false },
  { id: "orderbook", label: "Orderbook", defaultOn: true, align: "left", sortable: false },
  { id: "contracts", label: "Kontrak", defaultOn: false, align: "left", sortable: false },
] as const;

type FavoriteColumnId = (typeof FAVORITE_COLUMNS)[number]["id"];
type FavoriteColumnVisibility = Record<FavoriteColumnId, boolean>;
type SortKey = Extract<(typeof FAVORITE_COLUMNS)[number], { sortable: true }>["id"];

const DEFAULT_COLUMN_VISIBILITY: FavoriteColumnVisibility = Object.fromEntries(
  FAVORITE_COLUMNS.map((column) => [column.id, column.defaultOn]),
) as FavoriteColumnVisibility;

const ASC_FIRST = new Set<SortKey>(["exchange", "base", "raw_symbol", "status"]);

function parseColumnVisibility(raw: unknown): FavoriteColumnVisibility | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const next = { ...DEFAULT_COLUMN_VISIBILITY };
  const record = raw as Record<string, unknown>;
  for (const column of FAVORITE_COLUMNS) {
    if (typeof record[column.id] === "boolean") next[column.id] = record[column.id] as boolean;
  }
  return next;
}

function pairKey(exchange: string, rawSymbol: string): string {
  return `${exchange}\t${rawSymbol}`;
}

function placeholderTicker(exchange: string, rawSymbol: string): TickerRow {
  const symbol = rawSymbol.trim();
  const parts = symbol.split(/[-_/]/).filter(Boolean);
  const base = (parts[0] ?? symbol).toUpperCase();
  const quote = (parts[1] ?? "").toUpperCase();
  return {
    exchange,
    raw_symbol: rawSymbol,
    base,
    quote,
    last: null,
    bid: null,
    ask: null,
    bid_size: null,
    ask_size: null,
    base_volume_24h: null,
    quote_volume_24h: null,
    change_24h_pct: null,
    spread_pct: null,
    last_vs_mid_pct: null,
    stale: 0,
    stale_reasons: null,
    deposit_enabled: null,
    withdraw_enabled: null,
    exchange_timestamp: null,
    fetched_at: "",
    status: null,
    active: null,
    contracts: null,
  };
}

function changeClass(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "muted";
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "";
}

function compareStatus(a: TickerRow, b: TickerRow): number {
  const am = marketStatusMeta(a.status, a.active);
  const bm = marketStatusMeta(b.status, b.active);
  if (am.active !== bm.active) return am.active ? 1 : -1;
  return am.label.localeCompare(bm.label, "id");
}

function sortRows(rows: TickerTableRow[], key: SortKey, desc: boolean): TickerTableRow[] {
  const copy = [...rows];
  copy.sort((a, b) => {
    if (key === "status") {
      const cmp = compareStatus(a, b);
      return desc ? -cmp : cmp;
    }
    const av = a[key];
    const bv = b[key];
    if (av == null && bv == null) return 0;
    if (av == null) return desc ? -1 : 1;
    if (bv == null) return desc ? 1 : -1;
    if (typeof av === "number" && typeof bv === "number") return desc ? bv - av : av - bv;
    return desc
      ? String(bv).localeCompare(String(av), "en", { numeric: true, sensitivity: "base" })
      : String(av).localeCompare(String(bv), "en", { numeric: true, sensitivity: "base" });
  });
  return copy;
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

function SymbolLink({ row }: { row: TickerRow }) {
  const href = getSpotUrl(row.exchange, row.base, row.quote, row.raw_symbol, row.contracts);
  const label = row.base || row.raw_symbol;
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
  const visible =
    expanded || contracts.length <= MAX_VISIBLE_CONTRACTS
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

function FavoriteCell({
  columnId,
  row,
  namesById,
  openOrderBook,
}: {
  columnId: FavoriteColumnId;
  row: TickerTableRow;
  namesById: Record<string, string>;
  openOrderBook: (exchange: string, rawSymbol: string, exchangeName?: string) => void;
}) {
  switch (columnId) {
    case "exchange":
      return namesById[row.exchange] ?? row.exchange;
    case "base":
      return <SymbolLink row={row} />;
    case "raw_symbol":
      return <span className="font-medium">{row.raw_symbol}</span>;
    case "status":
      return <StatusBadge row={row} />;
    case "last":
      return formatPrice(row.last);
    case "bid":
      return formatPrice(row.bid);
    case "bid_size":
      return <span className="num">{formatAmountCompact(row.bid_size)}</span>;
    case "ask":
      return formatPrice(row.ask);
    case "ask_size":
      return <span className="num">{formatAmountCompact(row.ask_size)}</span>;
    case "spread_pct":
      return formatPct(row.spread_pct);
    case "quote_volume_24h":
      return formatUsdCompact(row.quote_volume_24h);
    case "base_volume_24h":
      return <span className="num">{formatAmountCompact(row.base_volume_24h)}</span>;
    case "change_24h_pct":
      return formatPct(row.change_24h_pct);
    case "last_vs_mid_pct":
      return <span className={changeClass(row.last_vs_mid_pct)}>{formatPct(row.last_vs_mid_pct)}</span>;
    case "stale":
      return <StaleCell row={row} />;
    case "fetched_at":
      return <FetchTimeCell value={row.fetched_at} />;
    case "chainstatus":
      return (
        <FundingIcons
          depositEnabled={row.deposit_enabled}
          withdrawEnabled={row.withdraw_enabled}
          chainstatusRaw={row.chainstatus_raw}
        />
      );
    case "alsoOnCount":
      return <AlsoOnCell count={row.alsoOnCount} peers={row.alsoOnPeers} />;
    case "depth":
      return <DepthCell exchange={row.exchange} rawSymbol={row.raw_symbol} />;
    case "orderbook":
      return (
        <button
          type="button"
          onClick={() => void openOrderBook(row.exchange, row.raw_symbol, namesById[row.exchange] ?? row.exchange)}
          title={`Lihat orderbook ${row.raw_symbol} di ${namesById[row.exchange] ?? row.exchange}`}
          style={{
            height: 24,
            padding: "0 10px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--background)",
            color: "var(--foreground)",
            fontSize: 12,
            fontWeight: 500,
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          Orderbook
        </button>
      );
    case "contracts":
      return <ContractsCell row={row} />;
  }
}

export function FavoritesPage() {
  const { isDisabled } = useExchangeSettings();
  const { isBlocked } = useCoinBlacklist();
  const { openOrderBook, orderBookModal } = useOrderBook();
  const [tickers, setTickers] = useState<TickerRow[]>([]);
  const [exchanges, setExchanges] = useState<ExchangeLabel[]>([]);
  const [blacklist, setBlacklist] = useState<FavoriteEntry[]>([]);
  const [favorites, setFavorites] = useState<FavoriteEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "quote_volume_24h", desc: true });
  const [columnVisibility, setColumnVisibility] = usePersistedState<FavoriteColumnVisibility>(
    COLUMN_VISIBILITY_KEY,
    DEFAULT_COLUMN_VISIBILITY,
    parseColumnVisibility,
  );
  const [columnVisibilityOpen, setColumnVisibilityOpen] = useState(false);
  const visibilityRef = useRef<HTMLDivElement>(null);
  const pendingFavorites = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tickersRes, statusRes] = await Promise.all([
        fetch("/api/tickers", { cache: "no-store" }),
        fetch("/api/status", { cache: "no-store" }),
      ]);
      const tickersData = (await tickersRes.json()) as TickersResponse;
      const statusData = (await statusRes.json()) as StatusResponse;
      if (!tickersRes.ok || !tickersData.ok) {
        throw new Error(tickersData.error || "Gagal memuat ticker");
      }
      if (!statusRes.ok || !statusData.ok) {
        throw new Error(statusData.error || "Gagal memuat status");
      }
      setTickers(Array.isArray(tickersData.tickers) ? tickersData.tickers : []);
      setBlacklist(Array.isArray(tickersData.blacklist) ? tickersData.blacklist : []);
      setFavorites((prev) => {
        const next = Array.isArray(tickersData.favorites) ? tickersData.favorites : [];
        if (pendingFavorites.current.size === 0) return next;
        const nextSet = new Set(next.map((item) => pairKey(item.exchange, item.raw_symbol)));
        const prevSet = new Set(prev.map((item) => pairKey(item.exchange, item.raw_symbol)));
        for (const key of pendingFavorites.current) {
          if (prevSet.has(key)) nextSet.add(key);
          else nextSet.delete(key);
        }
        if (pendingFavorites.current.size > 0) {
          const byKey = new Map(next.map((item) => [pairKey(item.exchange, item.raw_symbol), item]));
          for (const item of prev) {
            const key = pairKey(item.exchange, item.raw_symbol);
            if (!byKey.has(key) && nextSet.has(key)) byKey.set(key, item);
          }
          return [...byKey.values()].filter((item) => nextSet.has(pairKey(item.exchange, item.raw_symbol)));
        }
        return next;
      });
      setExchanges(
        sortByExchangeName(
          (statusData.exchanges ?? [])
            .filter((item) => item.enabled !== 0)
            .map((item) => ({ id: item.id, name: item.name })),
          (item) => item.name,
        ),
      );
      setBanner(null);
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!columnVisibilityOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (visibilityRef.current && !visibilityRef.current.contains(target)) {
        setColumnVisibilityOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setColumnVisibilityOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [columnVisibilityOpen]);

  const favorited = useMemo(
    () => new Set(favorites.map((item) => pairKey(item.exchange, item.raw_symbol))),
    [favorites],
  );
  const blocked = useMemo(
    () => new Set(blacklist.map((item) => pairKey(item.exchange, item.raw_symbol))),
    [blacklist],
  );

  const visibleExchanges = useMemo(
    () => exchanges.filter((item) => !isDisabled(item.id)),
    [exchanges, isDisabled],
  );
  const visibleTickers = useMemo(
    () => tickers.filter((row) => !isDisabled(row.exchange) && !isBlocked(row.base, row.exchange)),
    [tickers, isDisabled, isBlocked],
  );
  const visibleFavorites = useMemo(
    () =>
      favorites.filter((item) => {
        if (isDisabled(item.exchange)) return false;
        const ticker = tickers.find(
          (row) => row.exchange === item.exchange && row.raw_symbol === item.raw_symbol,
        );
        const base = ticker?.base;
        if (base && isBlocked(base, item.exchange)) return false;
        return true;
      }),
    [favorites, tickers, isDisabled, isBlocked],
  );

  const alsoOnIndex = useMemo(() => {
    const enabledIds = new Set(visibleExchanges.map((item) => item.id));
    const namesById: Record<string, string> = {};
    for (const item of visibleExchanges) namesById[item.id] = item.name;
    return buildAlsoOnIndex(visibleTickers, { enabledIds, namesById, blocked });
  }, [visibleTickers, visibleExchanges, blocked]);

  const tickerByKey = useMemo(() => {
    const map = new Map<string, TickerRow>();
    for (const row of tickers) map.set(pairKey(row.exchange, row.raw_symbol), row);
    return map;
  }, [tickers]);

  const namesById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const item of exchanges) map[item.id] = item.name;
    return map;
  }, [exchanges]);

  const visibleColumns = useMemo(
    () => FAVORITE_COLUMNS.filter((column) => columnVisibility[column.id]),
    [columnVisibility],
  );
  const colSpan = visibleColumns.length + 1;

  const visibleRows = useMemo<TickerTableRow[]>(() => {
    const needle = search.trim().toLowerCase();
    const rows: TickerTableRow[] = [];
    for (const item of visibleFavorites) {
      const row = tickerByKey.get(pairKey(item.exchange, item.raw_symbol)) ?? placeholderTicker(item.exchange, item.raw_symbol);
      const peers = peersForRow(alsoOnIndex, row);
      const exchangeName = namesById[row.exchange] ?? row.exchange;
      if (needle) {
        const statusLabel = marketStatusMeta(row.status, row.active).label;
        const hay = [row.raw_symbol, row.base, row.quote, row.exchange, exchangeName, row.status, statusLabel]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      rows.push({ ...row, alsoOnCount: peers.length, alsoOnPeers: peers });
    }
    return sortRows(rows, sort.key, sort.desc);
  }, [visibleFavorites, tickerByKey, alsoOnIndex, namesById, search, sort]);

  const depthLookup = useVisibleDepth(visibleRows, columnVisibility.depth);

  const onToggleFavorite = async (row: TickerRow, nextActive: boolean) => {
    const key = pairKey(row.exchange, row.raw_symbol);
    pendingFavorites.current.add(key);
    setFavorites((prev) => {
      const exists = prev.some((item) => pairKey(item.exchange, item.raw_symbol) === key);
      if (nextActive) {
        if (exists) return prev;
        return [{ exchange: row.exchange, raw_symbol: row.raw_symbol }, ...prev];
      }
      return prev.filter((item) => pairKey(item.exchange, item.raw_symbol) !== key);
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
      setFavorites((prev) => {
        const exists = prev.some((item) => pairKey(item.exchange, item.raw_symbol) === key);
        if (nextActive) {
          return exists ? prev.filter((item) => pairKey(item.exchange, item.raw_symbol) !== key) : prev;
        }
        if (exists) return prev;
        return [{ exchange: row.exchange, raw_symbol: row.raw_symbol }, ...prev];
      });
      setBanner(error instanceof Error ? error.message : String(error));
    } finally {
      pendingFavorites.current.delete(key);
    }
  };

  const toggleSort = (key: SortKey) => {
    setSort((prev) => (prev.key === key ? { key, desc: !prev.desc } : { key, desc: !ASC_FIRST.has(key) }));
  };

  const sortMark = (key: SortKey) => {
    if (sort.key !== key) return "";
    return sort.desc ? "↓" : "↑";
  };

  const toggleColumn = (id: FavoriteColumnId, checked: boolean) => {
    setColumnVisibility((prev) => ({ ...prev, [id]: checked }));
  };

  return (
    <div className="app-shell flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
      <AppHeader current="favorites">
        <button type="button" onClick={() => void load()} disabled={loading} className="btn-ghost">
          {loading ? "Memuat..." : "Muat ulang"}
        </button>
      </AppHeader>

      {banner ? (
        <div className="border-b border-border bg-panel px-4 py-2 text-[13px] text-muted sm:px-5">{banner}</div>
      ) : null}

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background p-3 sm:p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2 sm:gap-3">
          <h2 className="text-[15px] font-semibold leading-none">Favorit</h2>
          <span className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-panel-2 px-2 text-[11px] text-muted">
            <span className="num font-medium text-foreground">{visibleFavorites.length.toLocaleString("id-ID")}</span>
            pair
            {favorites.length > visibleFavorites.length ? (
              <span className="muted">({(favorites.length - visibleFavorites.length).toLocaleString("id-ID")} nonaktif)</span>
            ) : null}
          </span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Cari coin, symbol, atau exchange..."
            className="w-full min-w-0 rounded-full border border-border bg-panel-2 py-1.5 px-3 text-[13px] text-foreground outline-none placeholder:text-muted focus:border-border-strong sm:w-64"
          />
          <div className="relative" ref={visibilityRef}>
            <button
              type="button"
              onClick={() => setColumnVisibilityOpen((open) => !open)}
              className="btn-ghost"
            >
              Kolom
            </button>
            {columnVisibilityOpen ? (
              <div className="absolute left-0 z-30 mt-1 w-56 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-panel-2 p-2 shadow-xl">
                <p className="muted px-1 pb-2 text-[11px] uppercase tracking-wide">Tampilkan kolom</p>
                <div className="max-h-[min(18rem,70vh)] overflow-auto">
                  {FAVORITE_COLUMNS.map((column) => (
                    <label
                      key={column.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 text-xs text-foreground hover:bg-hover"
                    >
                      <input
                        type="checkbox"
                        checked={columnVisibility[column.id]}
                        onChange={(event) => toggleColumn(column.id, event.target.checked)}
                        className="accent-foreground"
                      />
                      {column.label}
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <DepthProvider value={depthLookup}>
          {columnVisibility.depth ? <DepthStatusBar /> : null}
          <div className="tickers-scroll min-h-0 flex-1 overflow-auto">
            <table className="tickers-table w-full min-w-[56rem] border-separate border-spacing-0 text-left">
              <thead>
                <tr>
                  <th style={{ width: "2.5rem", minWidth: "2.5rem" }} />
                  {visibleColumns.map((column) => {
                    const alignRight = column.align === "right";
                    return (
                      <th key={column.id} className={alignRight ? "text-right" : undefined}>
                        {column.sortable ? (
                          <button
                            type="button"
                            onClick={() => toggleSort(column.id as SortKey)}
                            className={`inline-flex items-center gap-1 ${alignRight ? "w-full justify-end" : ""}`}
                          >
                            {column.label}{" "}
                            <span className="text-[10px] text-foreground">{sortMark(column.id as SortKey)}</span>
                          </button>
                        ) : (
                          column.label
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => {
                  const active = favorited.has(pairKey(row.exchange, row.raw_symbol));
                  return (
                    <tr key={`${row.exchange}-${row.raw_symbol}`}>
                      <td style={{ width: "2.5rem", minWidth: "2.5rem" }}>
                        <FavoriteStar
                          active={active}
                          symbol={row.raw_symbol}
                          onToggle={() => void onToggleFavorite(row, !active)}
                        />
                      </td>
                      {visibleColumns.map((column) => {
                        const alignRight = column.align === "right";
                        const numeric = alignRight || column.id === "fetched_at";
                        const changeTone = column.id === "change_24h_pct" ? changeClass(row.change_24h_pct) : "";
                        return (
                          <td
                            key={column.id}
                            className={[
                              alignRight ? "text-right" : "",
                              numeric ? "num whitespace-nowrap" : "",
                              changeTone,
                            ]
                              .filter(Boolean)
                              .join(" ") || undefined}
                          >
                            <FavoriteCell
                              columnId={column.id}
                              row={row}
                              namesById={namesById}
                              openOrderBook={openOrderBook}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                {!loading && favorites.length === 0 ? (
                  <tr>
                    <td colSpan={colSpan} className="muted !h-24 px-4 text-center">
                      Belum ada pair favorit. Klik ikon bintang di tabel utama untuk menambahkannya ke halaman ini.
                    </td>
                  </tr>
                ) : null}
                {!loading && favorites.length > 0 && visibleRows.length === 0 ? (
                  <tr>
                    <td colSpan={colSpan} className="muted !h-24 px-4 text-center">
                      Tidak ada pair favorit yang cocok dengan pencarian.
                    </td>
                  </tr>
                ) : null}
                {loading && favorites.length === 0 ? (
                  <tr>
                    <td colSpan={colSpan} className="muted !h-24 px-4 text-center">
                      Memuat favorit...
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </DepthProvider>

        <p className="muted mt-3 text-[13px]">
          {loading && favorites.length === 0
            ? "Memuat favorit..."
            : `Menampilkan ${visibleRows.length.toLocaleString("id-ID")} dari ${favorites.length.toLocaleString("id-ID")} favorit`}
        </p>
      </main>
      {orderBookModal}
    </div>
  );
}
