"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlsoOnCell } from "@/components/AlsoOnCell";
import { AppHeader } from "@/components/AppHeader";
import { FavoriteStar } from "@/components/FavoriteStar";
import { FundingIcons } from "@/components/FundingIcons";
import { useOrderBook } from "@/components/OrderBookModal";
import { buildAlsoOnIndex, peersForRow, type TickerTableRow } from "@/lib/also-on";
import { getSpotUrl } from "@/lib/exchanges/spot-urls";
import { formatPct, formatPrice, formatUsdCompact } from "@/lib/format";
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
  };
}

function changeClass(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "muted";
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "";
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
  const href = getSpotUrl(row.exchange, row.base, row.quote, row.raw_symbol);
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

type SortKey =
  | "exchange"
  | "base"
  | "raw_symbol"
  | "last"
  | "bid"
  | "ask"
  | "spread_pct"
  | "quote_volume_24h"
  | "change_24h_pct"
  | "alsoOnCount";

function sortRows(rows: TickerTableRow[], key: SortKey, desc: boolean): TickerTableRow[] {
  const copy = [...rows];
  copy.sort((a, b) => {
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

export function FavoritesPage() {
  const { openOrderBook, orderBookModal } = useOrderBook();
  const [tickers, setTickers] = useState<TickerRow[]>([]);
  const [exchanges, setExchanges] = useState<ExchangeLabel[]>([]);
  const [blacklist, setBlacklist] = useState<FavoriteEntry[]>([]);
  const [favorites, setFavorites] = useState<FavoriteEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "quote_volume_24h", desc: true });
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
        (statusData.exchanges ?? [])
          .filter((item) => item.enabled !== 0)
          .map((item) => ({ id: item.id, name: item.name })),
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

  const favorited = useMemo(
    () => new Set(favorites.map((item) => pairKey(item.exchange, item.raw_symbol))),
    [favorites],
  );
  const blocked = useMemo(
    () => new Set(blacklist.map((item) => pairKey(item.exchange, item.raw_symbol))),
    [blacklist],
  );

  const alsoOnIndex = useMemo(() => {
    const enabledIds = new Set(exchanges.map((item) => item.id));
    const namesById: Record<string, string> = {};
    for (const item of exchanges) namesById[item.id] = item.name;
    return buildAlsoOnIndex(tickers, { enabledIds, namesById, blocked });
  }, [tickers, exchanges, blocked]);

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

  const visibleRows = useMemo<TickerTableRow[]>(() => {
    const needle = search.trim().toLowerCase();
    const rows: TickerTableRow[] = [];
    for (const item of favorites) {
      const row = tickerByKey.get(pairKey(item.exchange, item.raw_symbol)) ?? placeholderTicker(item.exchange, item.raw_symbol);
      const peers = peersForRow(alsoOnIndex, row);
      const exchangeName = namesById[row.exchange] ?? row.exchange;
      if (needle) {
        const hay = [row.raw_symbol, row.base, row.quote, row.exchange, exchangeName].join(" ").toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      rows.push({ ...row, alsoOnCount: peers.length, alsoOnPeers: peers });
    }
    return sortRows(rows, sort.key, sort.desc);
  }, [favorites, tickerByKey, alsoOnIndex, namesById, search, sort]);

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
    setSort((prev) => (prev.key === key ? { key, desc: !prev.desc } : { key, desc: key !== "exchange" && key !== "base" && key !== "raw_symbol" }));
  };

  const sortMark = (key: SortKey) => {
    if (sort.key !== key) return "";
    return sort.desc ? "↓" : "↑";
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
            <span className="num font-medium text-foreground">{favorites.length.toLocaleString("id-ID")}</span>
            pair
          </span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Cari coin, symbol, atau exchange..."
            className="w-full min-w-0 rounded-full border border-border bg-panel-2 py-1.5 px-3 text-[13px] text-foreground outline-none placeholder:text-muted focus:border-border-strong sm:w-64"
          />
        </div>

        <div className="tickers-scroll min-h-0 flex-1 overflow-auto">
          <table className="tickers-table w-full min-w-[56rem] border-separate border-spacing-0 text-left">
            <thead>
              <tr>
                <th style={{ width: "2.5rem", minWidth: "2.5rem" }} />
                <th>
                  <button type="button" onClick={() => toggleSort("exchange")} className="inline-flex items-center gap-1">
                    Exchange <span className="text-[10px] text-foreground">{sortMark("exchange")}</span>
                  </button>
                </th>
                <th>
                  <button type="button" onClick={() => toggleSort("base")} className="inline-flex items-center gap-1">
                    Coin <span className="text-[10px] text-foreground">{sortMark("base")}</span>
                  </button>
                </th>
                <th>
                  <button type="button" onClick={() => toggleSort("raw_symbol")} className="inline-flex items-center gap-1">
                    Symbol <span className="text-[10px] text-foreground">{sortMark("raw_symbol")}</span>
                  </button>
                </th>
                <th className="text-right">
                  <button type="button" onClick={() => toggleSort("last")} className="inline-flex w-full items-center justify-end gap-1">
                    Last <span className="text-[10px] text-foreground">{sortMark("last")}</span>
                  </button>
                </th>
                <th className="text-right">
                  <button type="button" onClick={() => toggleSort("bid")} className="inline-flex w-full items-center justify-end gap-1">
                    Bid <span className="text-[10px] text-foreground">{sortMark("bid")}</span>
                  </button>
                </th>
                <th className="text-right">
                  <button type="button" onClick={() => toggleSort("ask")} className="inline-flex w-full items-center justify-end gap-1">
                    Ask <span className="text-[10px] text-foreground">{sortMark("ask")}</span>
                  </button>
                </th>
                <th className="text-right">
                  <button type="button" onClick={() => toggleSort("spread_pct")} className="inline-flex w-full items-center justify-end gap-1">
                    Spread % <span className="text-[10px] text-foreground">{sortMark("spread_pct")}</span>
                  </button>
                </th>
                <th className="text-right">
                  <button type="button" onClick={() => toggleSort("quote_volume_24h")} className="inline-flex w-full items-center justify-end gap-1">
                    Vol USD 24h <span className="text-[10px] text-foreground">{sortMark("quote_volume_24h")}</span>
                  </button>
                </th>
                <th className="text-right">
                  <button type="button" onClick={() => toggleSort("change_24h_pct")} className="inline-flex w-full items-center justify-end gap-1">
                    24h % <span className="text-[10px] text-foreground">{sortMark("change_24h_pct")}</span>
                  </button>
                </th>
                <th>Depo/WD</th>
                <th>
                  <button type="button" onClick={() => toggleSort("alsoOnCount")} className="inline-flex items-center gap-1">
                    Ada di <span className="text-[10px] text-foreground">{sortMark("alsoOnCount")}</span>
                  </button>
                </th>
                <th>Orderbook</th>
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
                    <td>{namesById[row.exchange] ?? row.exchange}</td>
                    <td>
                      <SymbolLink row={row} />
                    </td>
                    <td>
                      <span className="font-medium">{row.raw_symbol}</span>
                    </td>
                    <td className="text-right num whitespace-nowrap">{formatPrice(row.last)}</td>
                    <td className="text-right num whitespace-nowrap">{formatPrice(row.bid)}</td>
                    <td className="text-right num whitespace-nowrap">{formatPrice(row.ask)}</td>
                    <td className="text-right num whitespace-nowrap">{formatPct(row.spread_pct)}</td>
                    <td className="text-right num whitespace-nowrap">{formatUsdCompact(row.quote_volume_24h)}</td>
                    <td className={`text-right num whitespace-nowrap ${changeClass(row.change_24h_pct)}`}>
                      {formatPct(row.change_24h_pct)}
                    </td>
                    <td>
                      <FundingIcons
                        depositEnabled={row.deposit_enabled}
                        withdrawEnabled={row.withdraw_enabled}
                        chainstatusRaw={row.chainstatus_raw}
                      />
                    </td>
                    <td>
                      <AlsoOnCell count={row.alsoOnCount} peers={row.alsoOnPeers} />
                    </td>
                    <td>
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
                    </td>
                  </tr>
                );
              })}
              {!loading && favorites.length === 0 ? (
                <tr>
                  <td colSpan={13} className="muted !h-24 px-4 text-center">
                    Belum ada pair favorit. Klik ikon bintang di tabel utama untuk menambahkannya ke halaman ini.
                  </td>
                </tr>
              ) : null}
              {!loading && favorites.length > 0 && visibleRows.length === 0 ? (
                <tr>
                  <td colSpan={13} className="muted !h-24 px-4 text-center">
                    Tidak ada pair favorit yang cocok dengan pencarian.
                  </td>
                </tr>
              ) : null}
              {loading && favorites.length === 0 ? (
                <tr>
                  <td colSpan={13} className="muted !h-24 px-4 text-center">
                    Memuat favorit...
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

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
