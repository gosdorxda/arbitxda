"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppHeader } from "@/components/AppHeader";
import { BlacklistPopoverButton, BlacklistRowButton, useCoinBlacklist } from "@/components/BlacklistSettings";
import { useExchangeSettings } from "@/components/ExchangeSettings";
import { useOrderBook } from "@/components/OrderBookModal";
import { useCompareDepth, type CompareDepthPair } from "@/components/useCompareDepth";
import type { CompareCoinEntry, CompareExchangeInfo } from "@/lib/compare";
import {
  computeCompareCoinGroups,
  computeDepthRouteMetrics,
  type CompareCoinGroup,
  type CompareRoute,
  type CompareSafetyFilters,
  type ContractMatchStatus,
  type DepthRouteMetrics,
} from "@/lib/compare-routes";
import { formatPct, formatPrice, formatRelativeId, formatUsdCompact, formatWib, sortByExchangeName } from "@/lib/format";
import { getSpotUrl } from "@/lib/exchanges/spot-urls";

const SETTINGS_STORAGE_KEY = "arbit.compare.settings.v4";
const LEGACY_SETTINGS_KEYS = ["arbit.compare.settings.v3", "arbit.compare.settings.v2"];

type CompareSettings = {
  search: string;
  defaultFeePct: string;
  exchangeFees: Record<string, string>;
  depthMode: boolean;
  modalUsd: string;
  showFundingOpen: boolean;
  showFundingSuspended: boolean;
  showFundingUnknown: boolean;
  showNegative: boolean;
  showContractMatch: boolean;
  showContractMismatch: boolean;
  showContractUnknown: boolean;
  showContractNative: boolean;
  hideStale: boolean;
  maxAgeMinutes: string;
  minSpreadPct: string;
  minVolumeUsd: string;
  pageSize: 25 | 50 | 100;
};

const DEFAULT_SETTINGS: CompareSettings = {
  search: "",
  defaultFeePct: "0.1",
  exchangeFees: {},
  depthMode: false,
  modalUsd: "100",
  showFundingOpen: true,
  showFundingSuspended: true,
  showFundingUnknown: true,
  showNegative: false,
  showContractMatch: true,
  showContractMismatch: true,
  showContractUnknown: true,
  showContractNative: true,
  hideStale: true,
  maxAgeMinutes: "",
  minSpreadPct: "",
  minVolumeUsd: "",
  pageSize: 25,
};

type SortKey =
  | "base"
  | "grossSpreadPct"
  | "netProfitPct"
  | "depthProfitPct"
  | "maxFillableUsd"
  | "volume"
  | "age"
  | "routes";

const FILTER_INPUT =
  "h-8 w-full rounded-md border border-border bg-panel-2 px-2 text-[13px] text-foreground outline-none placeholder:text-muted focus:border-border-strong";

function parseSettings(raw: unknown): CompareSettings | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const exchangeFees: Record<string, string> = {};
  if (r.exchangeFees && typeof r.exchangeFees === "object" && !Array.isArray(r.exchangeFees)) {
    for (const [k, v] of Object.entries(r.exchangeFees as Record<string, unknown>)) {
      if (typeof v === "string") exchangeFees[k.toLowerCase()] = v;
    }
  }
  const pageSize = r.pageSize === 50 ? 50 : r.pageSize === 100 ? 100 : 25;
  return {
    search: typeof r.search === "string" ? r.search : DEFAULT_SETTINGS.search,
    defaultFeePct: typeof r.defaultFeePct === "string" ? r.defaultFeePct : DEFAULT_SETTINGS.defaultFeePct,
    exchangeFees,
    depthMode: typeof r.depthMode === "boolean" ? r.depthMode : DEFAULT_SETTINGS.depthMode,
    modalUsd: typeof r.modalUsd === "string" ? r.modalUsd : DEFAULT_SETTINGS.modalUsd,
    showFundingOpen: typeof r.showFundingOpen === "boolean" ? r.showFundingOpen : true,
    showFundingSuspended: typeof r.showFundingSuspended === "boolean" ? r.showFundingSuspended : true,
    showFundingUnknown: typeof r.showFundingUnknown === "boolean" ? r.showFundingUnknown : true,
    showNegative: typeof r.showNegative === "boolean" ? r.showNegative : false,
    showContractMatch: typeof r.showContractMatch === "boolean" ? r.showContractMatch : true,
    showContractMismatch: typeof r.showContractMismatch === "boolean" ? r.showContractMismatch : true,
    showContractUnknown: typeof r.showContractUnknown === "boolean" ? r.showContractUnknown : true,
    showContractNative: typeof r.showContractNative === "boolean" ? r.showContractNative : true,
    hideStale: typeof r.hideStale === "boolean" ? r.hideStale : DEFAULT_SETTINGS.hideStale,
    maxAgeMinutes: typeof r.maxAgeMinutes === "string" ? r.maxAgeMinutes : DEFAULT_SETTINGS.maxAgeMinutes,
    minSpreadPct: typeof r.minSpreadPct === "string" ? r.minSpreadPct : DEFAULT_SETTINGS.minSpreadPct,
    minVolumeUsd: typeof r.minVolumeUsd === "string" ? r.minVolumeUsd : DEFAULT_SETTINGS.minVolumeUsd,
    pageSize,
  };
}

function parseOptionalNumber(raw: string): number | null {
  const trimmed = raw.trim().replace(/,/g, ".");
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function parsePositiveOrDefault(raw: string, fallback: number): number {
  const n = parseOptionalNumber(raw);
  return n != null && n > 0 ? n : fallback;
}

function parseNonNegativeOrDefault(raw: string, fallback: number): number {
  const n = parseOptionalNumber(raw);
  return n != null && n >= 0 ? n : fallback;
}

function useCompareSettings() {
  const [value, setValue] = useState<CompareSettings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const raw =
        window.localStorage.getItem(SETTINGS_STORAGE_KEY) ??
        LEGACY_SETTINGS_KEYS.reduce<string | null>((found, key) => found ?? window.localStorage.getItem(key), null);
      if (raw != null && raw !== "") {
        const parsed = parseSettings(JSON.parse(raw));
        if (parsed != null) setValue(parsed);
      }
    } catch {
      // storage rusak atau diblokir
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    try {
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(value));
    } catch {
      // storage penuh atau diblokir
    }
  }, [ready, value]);

  return [value, setValue] as const;
}

function pctClass(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "muted";
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "muted";
}

function formatSignedUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1000) return `${sign}${formatUsdCompact(abs)}`;
  if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;
  if (abs >= 0.01) return `${sign}$${abs.toFixed(3)}`;
  return `${sign}$${abs.toFixed(4)}`;
}

function ExternalLinkIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <path
        fill="currentColor"
        d="M9.5 2a.5.5 0 0 0 0 1h2.793L6.646 8.646a.5.5 0 1 0 .708.708L13 3.707V6.5a.5.5 0 0 0 1 0v-4a.5.5 0 0 0-.5-.5h-4ZM4 4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V9.5a.5.5 0 0 0-1 0V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.5a.5.5 0 0 0 0-1H4Z"
      />
    </svg>
  );
}

function BookIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <path
        fill="currentColor"
        d="M2.5 3.5h4.5v1.5H2.5V3.5Zm0 3.75h7v1.5h-7v-1.5Zm0 3.75h11v1.5h-11V11Zm6.5-7.5h4.5V5H9V3.5Z"
      />
    </svg>
  );
}

function LegBadge({ label, status }: { label: string; status: 0 | 1 | null }) {
  if (status === 1) {
    return (
      <span className="compare-chip-badge badge-ok" title={`${label}: buka`}>
        {label}
      </span>
    );
  }
  if (status === 0) {
    return (
      <span className="compare-chip-badge badge-bad" title={`${label}: suspend / tutup`}>
        {label} suspend
      </span>
    );
  }
  return (
    <span className="compare-chip-badge badge-warn" title={`${label}: status belum diketahui`}>
      {label}?
    </span>
  );
}

function RouteLegCell({
  side,
  exchangeId,
  exchangeName,
  price,
  base,
  quote,
  rawSymbol,
  contracts,
  fundingLabel,
  fundingStatus,
  onOpenOrderBook,
}: {
  side: "ask" | "bid";
  exchangeId: string;
  exchangeName: string;
  price: number;
  base: string;
  quote: string;
  rawSymbol: string;
  contracts: CompareRoute["buy"]["contracts"];
  fundingLabel: "WD" | "Depo";
  fundingStatus: 0 | 1 | null;
  onOpenOrderBook: (exchange: string, rawSymbol: string, exchangeName: string) => void;
}) {
  const spotUrl = getSpotUrl(exchangeId, base, quote, rawSymbol, contracts);
  return (
    <div className="compare-leg">
      <div className="compare-leg-head">
        <span className="compare-leg-ex">{exchangeName}</span>
        {spotUrl ? (
          <a
            href={spotUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="compare-leg-icon"
            title={`Buka ${base}/${quote} di ${exchangeName}`}
            aria-label={`Buka ${base}/${quote} di ${exchangeName}`}
          >
            <ExternalLinkIcon />
          </a>
        ) : null}
        <button
          type="button"
          onClick={() => onOpenOrderBook(exchangeId, rawSymbol, exchangeName)}
          className="compare-leg-icon"
          title={`Lihat orderbook ${rawSymbol} di ${exchangeName}`}
          aria-label={`Orderbook ${rawSymbol} di ${exchangeName}`}
        >
          <BookIcon />
        </button>
        <LegBadge label={fundingLabel} status={fundingStatus} />
      </div>
      <div className="compare-leg-price">
        <span className="num text-[13px] text-foreground">{formatPrice(price)}</span>
        <span className="muted text-[10px]">
          {side} · {rawSymbol}
        </span>
      </div>
    </div>
  );
}

function StatusBadges({ route }: { route: CompareRoute }) {
  return (
    <span className="compare-coin-badges">
      {route.buyWithdraw === 0 ? (
        <span className="compare-chip-badge badge-bad" title="Withdraw di exchange beli sedang suspend">
          WD suspend
        </span>
      ) : null}
      {route.sellDeposit === 0 ? (
        <span className="compare-chip-badge badge-bad" title="Deposit di exchange jual sedang suspend">
          Depo suspend
        </span>
      ) : null}
      {route.fundingUnknown ? (
        <span className="compare-chip-badge badge-warn" title="Status Depo atau WD belum diketahui">
          Status?
        </span>
      ) : null}
      {route.isStale ? (
        <span className="compare-chip-badge badge-warn" title="Data ticker stale">
          Stale
        </span>
      ) : null}
    </span>
  );
}

function contractStatusLabel(route: CompareRoute): { text: string; className: string } {
  if (route.contractStatus === "match") return { text: "✓ Sama", className: "is-match" };
  if (route.contractStatus === "mismatch") return { text: "✗ Beda", className: "is-mismatch" };
  if (route.contractStatus === "native") return { text: "Native", className: "is-native" };
  return { text: route.contractUnknownLabel || "?", className: "is-unknown" };
}

function ContractStatusCell({ route }: { route: CompareRoute }) {
  const status = contractStatusLabel(route);
  return (
    <td className="col-contract">
      <span className={`compare-contract ${status.className}`} title={route.contractTooltip}>
        {status.text}
      </span>
    </td>
  );
}

type SegOption<K extends string> = { key: K; label: string; count: number; title: string };

function SegmentedFilter<K extends string>({
  ariaLabel,
  options,
  isOn,
  onToggle,
}: {
  ariaLabel: string;
  options: readonly SegOption<K>[];
  isOn: (key: K) => boolean;
  onToggle: (key: K) => void;
}) {
  return (
    <div className="compare-seg" role="group" aria-label={ariaLabel}>
      {options.map((option) => {
        const on = isOn(option.key);
        return (
          <button
            key={option.key}
            type="button"
            className={on ? "is-on" : undefined}
            aria-pressed={on}
            title={option.title}
            onClick={() => onToggle(option.key)}
          >
            <span>{option.label}</span>
            <span className="num">{option.count.toLocaleString("id-ID")}</span>
          </button>
        );
      })}
    </div>
  );
}

export function ComparePage() {
  const { isDisabled, syncExchanges, allExchanges } = useExchangeSettings();
  const { isBlocked } = useCoinBlacklist();
  const { openOrderBook, orderBookModal } = useOrderBook();

  const [exchanges, setExchanges] = useState<CompareExchangeInfo[]>([]);
  const [byBase, setByBase] = useState<Record<string, CompareCoinEntry>>({});
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<string | null>(null);
  const [expandedCoins, setExpandedCoins] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: "netProfitPct",
    desc: true,
  });
  const [pageIndex, setPageIndex] = useState(0);
  const [feePopoverOpen, setFeePopoverOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const feePopoverRef = useRef<HTMLDivElement>(null);
  const filtersRef = useRef<HTMLDivElement>(null);

  const [settings, setSettings] = useCompareSettings();

  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 5000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!feePopoverOpen && !filtersOpen) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (feePopoverOpen && feePopoverRef.current && !feePopoverRef.current.contains(target)) {
        setFeePopoverOpen(false);
      }
      if (filtersOpen && filtersRef.current && !filtersRef.current.contains(target)) {
        setFiltersOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFeePopoverOpen(false);
        setFiltersOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [feePopoverOpen, filtersOpen]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/compare", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Gagal memuat perbandingan");
      const sorted: CompareExchangeInfo[] = sortByExchangeName(
        data.exchanges ?? [],
        (item) => item.name || item.id,
      );
      setExchanges(sorted);
      setByBase(data.byBase ?? {});
      syncExchanges(sorted.map((item) => ({ id: item.id, name: item.name, count: item.pairCount })));
      setBanner(null);
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [syncExchanges]);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleExchanges = useMemo(
    () => exchanges.filter((item) => !isDisabled(item.id)),
    [exchanges, isDisabled],
  );

  const activeExchangeIds = useMemo(
    () => new Set(visibleExchanges.map((item) => item.id.toLowerCase())),
    [visibleExchanges],
  );

  const exchangeNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const item of exchanges) map[item.id.toLowerCase()] = item.name || item.id;
    return map;
  }, [exchanges]);

  const defaultFeePct = parseNonNegativeOrDefault(settings.defaultFeePct, 0.1);
  const modalUsd = parsePositiveOrDefault(settings.modalUsd, 100);

  const numericExchangeFees = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [id, raw] of Object.entries(settings.exchangeFees)) {
      const parsed = parseOptionalNumber(raw);
      if (parsed != null && parsed >= 0) out[id.toLowerCase()] = parsed;
    }
    return out;
  }, [settings.exchangeFees]);

  const safetyFilters = useMemo<CompareSafetyFilters>(
    () => ({
      hideStale: settings.hideStale,
      maxAgeMinutes: parseOptionalNumber(settings.maxAgeMinutes),
      minSpreadPct: parseOptionalNumber(settings.minSpreadPct),
      minVolumeUsd: parseOptionalNumber(settings.minVolumeUsd),
    }),
    [settings.hideStale, settings.maxAgeMinutes, settings.minSpreadPct, settings.minVolumeUsd],
  );

  const coinGroups = useMemo(
    () =>
      computeCompareCoinGroups({
        byBase,
        activeExchangeIds,
        exchangeNames,
        defaultFeePct,
        exchangeFees: numericExchangeFees,
        modalUsd,
        filters: safetyFilters,
        nowMs,
        isBlocked,
      }),
    [byBase, activeExchangeIds, exchangeNames, defaultFeePct, numericExchangeFees, modalUsd, safetyFilters, nowMs, isBlocked],
  );

  const searchedGroups = useMemo(() => {
    const needle = settings.search.trim().toLowerCase();
    if (!needle) return coinGroups;
    return coinGroups.filter((group) => {
      if (group.base.toLowerCase().includes(needle)) return true;
      const allRoutes = [group.bestRoute, ...group.otherRoutes];
      return allRoutes.some(
        (route) =>
          route.buyExchangeName.toLowerCase().includes(needle) ||
          route.sellExchangeName.toLowerCase().includes(needle) ||
          route.buy.exchange.toLowerCase().includes(needle) ||
          route.sell.exchange.toLowerCase().includes(needle) ||
          route.buy.rawSymbol.toLowerCase().includes(needle) ||
          route.sell.rawSymbol.toLowerCase().includes(needle),
      );
    });
  }, [coinGroups, settings.search]);

  const statusCounts = useMemo(() => {
    const counts = { open: 0, suspended: 0, unknown: 0 };
    for (const group of searchedGroups) {
      counts[group.bestRoute.fundingStatus] += 1;
    }
    return counts;
  }, [searchedGroups]);

  const contractCounts = useMemo(() => {
    const counts = { match: 0, mismatch: 0, unknown: 0, native: 0 };
    for (const group of searchedGroups) {
      counts[group.bestRoute.contractStatus] += 1;
    }
    return counts;
  }, [searchedGroups]);

  const allowsContractStatus = (status: ContractMatchStatus) => {
    if (status === "match") return settings.showContractMatch;
    if (status === "mismatch") return settings.showContractMismatch;
    if (status === "unknown") return settings.showContractUnknown;
    return settings.showContractNative;
  };

  const statusVisibleGroups = useMemo(() => {
    return searchedGroups.filter((group) => {
      const status = group.bestRoute.fundingStatus;
      const fundingOk =
        status === "open"
          ? settings.showFundingOpen
          : status === "suspended"
            ? settings.showFundingSuspended
            : settings.showFundingUnknown;
      return fundingOk && allowsContractStatus(group.bestRoute.contractStatus);
    });
  }, [
    searchedGroups,
    settings.showFundingOpen,
    settings.showFundingSuspended,
    settings.showFundingUnknown,
    settings.showContractMatch,
    settings.showContractMismatch,
    settings.showContractUnknown,
    settings.showContractNative,
  ]);

  const negativeCount = useMemo(
    () => statusVisibleGroups.filter((group) => group.bestRoute.netProfitPct < 0).length,
    [statusVisibleGroups],
  );

  const visibleCoinGroups = useMemo(() => {
    if (settings.showNegative) return statusVisibleGroups;
    return statusVisibleGroups.filter((group) => group.bestRoute.netProfitPct >= 0);
  }, [statusVisibleGroups, settings.showNegative]);

  const preSortedGroups = useMemo(() => {
    if (sort.key === "depthProfitPct" || sort.key === "maxFillableUsd") {
      return [...visibleCoinGroups].sort((a, b) => b.bestRoute.netProfitPct - a.bestRoute.netProfitPct);
    }
    const list = [...visibleCoinGroups];
    const valueOf = (g: CompareCoinGroup): string | number | null => {
      switch (sort.key) {
        case "base":
          return g.base;
        case "grossSpreadPct":
          return g.bestRoute.grossSpreadPct;
        case "netProfitPct":
          return g.bestRoute.netProfitPct;
        case "volume":
          return g.bestRoute.minVolumeUsd;
        case "age":
          return g.bestRoute.ageMs;
        case "routes":
          return g.totalRoutes;
        default:
          return null;
      }
    };
    list.sort((a, b) => {
      const av = valueOf(a);
      const bv = valueOf(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") {
        return sort.desc ? bv - av : av - bv;
      }
      const cmp = String(av).localeCompare(String(bv), "en", { numeric: true, sensitivity: "base" });
      return sort.desc ? -cmp : cmp;
    });
    return list;
  }, [visibleCoinGroups, sort]);

  const totalCount = preSortedGroups.length;
  const pageCount = Math.max(1, Math.ceil(totalCount / settings.pageSize));
  const safePageIndex = Math.min(pageIndex, pageCount - 1);

  useEffect(() => {
    setPageIndex(0);
  }, [
    settings.search,
    settings.showFundingOpen,
    settings.showFundingSuspended,
    settings.showFundingUnknown,
    settings.showNegative,
    settings.showContractMatch,
    settings.showContractMismatch,
    settings.showContractUnknown,
    settings.showContractNative,
    settings.hideStale,
    settings.maxAgeMinutes,
    settings.minSpreadPct,
    settings.minVolumeUsd,
    settings.pageSize,
    activeExchangeIds,
  ]);

  const pageGroups = useMemo(() => {
    const start = safePageIndex * settings.pageSize;
    return preSortedGroups.slice(start, start + settings.pageSize);
  }, [preSortedGroups, safePageIndex, settings.pageSize]);

  const visibleDepthPairs = useMemo<CompareDepthPair[]>(() => {
    if (!settings.depthMode) return [];
    const pairs: CompareDepthPair[] = [];
    for (const group of pageGroups) {
      pairs.push({ exchange: group.bestRoute.buy.exchange, rawSymbol: group.bestRoute.buy.rawSymbol });
      pairs.push({ exchange: group.bestRoute.sell.exchange, rawSymbol: group.bestRoute.sell.rawSymbol });
      if (expandedCoins.has(group.base)) {
        for (const route of group.otherRoutes) {
          pairs.push({ exchange: route.buy.exchange, rawSymbol: route.buy.rawSymbol });
          pairs.push({ exchange: route.sell.exchange, rawSymbol: route.sell.rawSymbol });
        }
      }
    }
    return pairs;
  }, [settings.depthMode, pageGroups, expandedCoins]);

  const { getEntry: getDepthEntry, progress: depthProgress, refresh: refreshDepth } = useCompareDepth(
    visibleDepthPairs,
    settings.depthMode,
  );

  const getRouteDepth = useCallback(
    (route: CompareRoute): DepthRouteMetrics | null => {
      if (!settings.depthMode) return null;
      const buyEntry = getDepthEntry(route.buy.exchange, route.buy.rawSymbol);
      const sellEntry = getDepthEntry(route.sell.exchange, route.sell.rawSymbol);
      if (!buyEntry || !sellEntry) return null;
      if (!buyEntry.ok || !sellEntry.ok) {
        return computeDepthRouteMetrics({
          buyAsks: undefined,
          sellBids: undefined,
          modalUsd,
          buyFeePct: route.buyFeePct,
          sellFeePct: route.sellFeePct,
          error: true,
        });
      }
      return computeDepthRouteMetrics({
        buyAsks: buyEntry.asks,
        sellBids: sellEntry.bids,
        modalUsd,
        buyFeePct: route.buyFeePct,
        sellFeePct: route.sellFeePct,
      });
    },
    [settings.depthMode, getDepthEntry, modalUsd],
  );

  const displayedGroups = useMemo(() => {
    if (!settings.depthMode || (sort.key !== "depthProfitPct" && sort.key !== "maxFillableUsd")) {
      return pageGroups;
    }
    const list = [...pageGroups];
    list.sort((a, b) => {
      const da = getRouteDepth(a.bestRoute);
      const db = getRouteDepth(b.bestRoute);
      const va =
        sort.key === "depthProfitPct" ? da?.realisticProfitPct ?? null : da?.maxFillableUsd ?? null;
      const vb =
        sort.key === "depthProfitPct" ? db?.realisticProfitPct ?? null : db?.maxFillableUsd ?? null;
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return sort.desc ? vb - va : va - vb;
    });
    return list;
  }, [settings.depthMode, sort, pageGroups, getRouteDepth]);

  const toggleSort = (key: SortKey) => {
    setSort((prev) =>
      prev.key === key ? { key, desc: !prev.desc } : { key, desc: key !== "base" && key !== "age" },
    );
  };

  const sortMark = (key: SortKey) => (sort.key === key ? (sort.desc ? "↓" : "↑") : "");

  const sortTh = (key: SortKey, label: ReactNode, align: "left" | "right" = "right", className = "") => (
    <th key={key} className={`${align === "right" ? "text-right" : "text-left"}${className ? ` ${className}` : ""}`}>
      <button
        type="button"
        onClick={() => toggleSort(key)}
        className={`inline-flex items-center gap-1 ${align === "right" ? "w-full justify-end" : ""}`}
      >
        <span>{label}</span>
        <span className="text-[10px] text-foreground">{sortMark(key)}</span>
      </button>
    </th>
  );

  const toggleExpand = (base: string) => {
    setExpandedCoins((prev) => {
      const next = new Set(prev);
      if (next.has(base)) next.delete(base);
      else next.add(base);
      return next;
    });
  };

  const customFeeCount = Object.keys(numericExchangeFees).length;
  const colSpan = settings.depthMode ? 11 : 8;
  const from = totalCount === 0 ? 0 : safePageIndex * settings.pageSize + 1;
  const to = Math.min(totalCount, (safePageIndex + 1) * settings.pageSize);

  const activeFilterCount =
    Number(settings.hideStale !== DEFAULT_SETTINGS.hideStale) +
    Number(settings.maxAgeMinutes.trim() !== "") +
    Number(settings.minSpreadPct.trim() !== "") +
    Number(settings.minVolumeUsd.trim() !== "");

  const resetFilters = () => {
    setSettings((prev) => ({
      ...prev,
      hideStale: true,
      maxAgeMinutes: "",
      minSpreadPct: "",
      minVolumeUsd: "",
    }));
  };

  const toggleFundingStatus = (key: "showFundingOpen" | "showFundingSuspended" | "showFundingUnknown") => {
    setSettings((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      if (!next.showFundingOpen && !next.showFundingSuspended && !next.showFundingUnknown) {
        return prev;
      }
      return next;
    });
  };

  const toggleContractStatus = (
    key: "showContractMatch" | "showContractMismatch" | "showContractUnknown" | "showContractNative",
  ) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      if (
        !next.showContractMatch &&
        !next.showContractMismatch &&
        !next.showContractUnknown &&
        !next.showContractNative
      ) {
        return prev;
      }
      return next;
    });
  };

  const renderRouteCells = (route: CompareRoute) => {
    const depth = getRouteDepth(route);
    const totalFeePct = route.buyFeePct + route.sellFeePct;
    const ageTooOld = route.ageMs != null && route.ageMs > 15 * 60_000;

    return (
      <>
        <td className="col-buy">
          <RouteLegCell
            side="ask"
            exchangeId={route.buy.exchange}
            exchangeName={route.buyExchangeName}
            price={route.buyAsk}
            base={route.buy.base}
            quote={route.buy.quote}
            rawSymbol={route.buy.rawSymbol}
            contracts={route.buy.contracts}
            fundingLabel="WD"
            fundingStatus={route.buyWithdraw}
            onOpenOrderBook={(ex, sym, name) => void openOrderBook(ex, sym, name)}
          />
        </td>
        <td className="col-sell">
          <RouteLegCell
            side="bid"
            exchangeId={route.sell.exchange}
            exchangeName={route.sellExchangeName}
            price={route.sellBid}
            base={route.sell.base}
            quote={route.sell.quote}
            rawSymbol={route.sell.rawSymbol}
            contracts={route.sell.contracts}
            fundingLabel="Depo"
            fundingStatus={route.sellDeposit}
            onOpenOrderBook={(ex, sym, name) => void openOrderBook(ex, sym, name)}
          />
        </td>
        <ContractStatusCell route={route} />
        <td className="col-spread num whitespace-nowrap text-right">
          <div className={pctClass(route.grossSpreadPct)}>{formatPct(route.grossSpreadPct)}</div>
        </td>
        <td className="col-profit num whitespace-nowrap text-right">
          <div className={pctClass(route.netProfitPct)}>{formatPct(route.netProfitPct)}</div>
          <span className="compare-subline">
            <span className={pctClass(route.estProfitUsd)}>{formatSignedUsd(route.estProfitUsd)}</span>
            {` · fee ${totalFeePct.toFixed(2).replace(/\.00$/, "")}%`}
          </span>
        </td>
        {settings.depthMode ? (
          <>
            <td className="col-vwap num whitespace-nowrap text-right">
              {depth == null ? (
                <span className="muted text-[12px]">Memuat...</span>
              ) : depth.error ? (
                <span className="down text-[12px]">Gagal</span>
              ) : (
                <>
                  <div className="text-foreground">{formatPrice(depth.vwapBuy)}</div>
                  <span className="compare-subline">{formatPrice(depth.vwapSell)}</span>
                </>
              )}
            </td>
            <td className="col-depth-profit num whitespace-nowrap text-right">
              {depth == null ? (
                <span className="muted text-[12px]">Memuat...</span>
              ) : depth.error || depth.realisticProfitUsd == null ? (
                <span className="muted text-[12px]">-</span>
              ) : (
                <>
                  <div className={pctClass(depth.realisticProfitUsd)}>
                    {formatSignedUsd(depth.realisticProfitUsd)} ({formatPct(depth.realisticProfitPct)})
                  </div>
                  <span className={`compare-subline ${depth.partial ? "text-warn" : ""}`}>
                    {depth.partial
                      ? `Isi ${formatUsdCompact(depth.filledModalUsd)}/${formatUsdCompact(depth.modalUsd)}`
                      : `Modal ${formatUsdCompact(depth.modalUsd)}`}
                  </span>
                </>
              )}
            </td>
            <td className="col-fill num whitespace-nowrap text-right">
              {depth == null || depth.error ? (
                <span className="muted text-[12px]">-</span>
              ) : (
                <>
                  <div className="text-foreground">
                    {depth.maxFillableUsd > 0 ? formatUsdCompact(depth.maxFillableUsd) : "$0"}
                  </div>
                  <span className="compare-subline">
                    Net {depth.maxNetFillableUsd > 0 ? formatUsdCompact(depth.maxNetFillableUsd) : "$0"}
                  </span>
                </>
              )}
            </td>
          </>
        ) : null}
        <td
          className="col-vol num whitespace-nowrap text-right"
          title={`Vol beli: ${formatUsdCompact(route.buyVolumeUsd)} · Vol jual: ${formatUsdCompact(route.sellVolumeUsd)}`}
        >
          <div>{formatUsdCompact(route.minVolumeUsd)}</div>
          <span className="compare-subline">
            {formatUsdCompact(route.buyVolumeUsd)} / {formatUsdCompact(route.sellVolumeUsd)}
          </span>
        </td>
        <td
          className="col-age whitespace-nowrap"
          title={
            route.oldestFetchedAt
              ? `Data terlama: ${formatWib(route.oldestFetchedAt)}`
              : "Waktu fetch tidak tersedia"
          }
        >
          <span className={`text-[12px] ${ageTooOld ? "text-warn" : "muted"}`}>
            {formatRelativeId(route.oldestFetchedAt, nowMs)}
          </span>
        </td>
      </>
    );
  };

  return (
    <div className="app-shell flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
      <AppHeader current="compare">
        <button type="button" onClick={() => void load()} disabled={loading} className="btn-ghost">
          {loading ? "Memuat..." : "Muat ulang"}
        </button>
      </AppHeader>

      {banner ? (
        <div className="border-b border-border bg-panel px-4 py-2 text-[13px] text-muted sm:px-5">{banner}</div>
      ) : null}

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background p-3 sm:p-4">
        <div className="compare-toolbar">
          <input
            type="search"
            value={settings.search}
            onChange={(event) => setSettings((prev) => ({ ...prev, search: event.target.value }))}
            placeholder="Cari coin atau exchange..."
            className="h-8 w-full min-w-0 rounded-full border border-border bg-panel-2 px-3 text-[13px] text-foreground outline-none placeholder:text-muted focus:border-border-strong sm:w-52"
          />

          <label className="flex h-8 items-center gap-1.5 text-[13px] text-foreground">
            <span className="muted whitespace-nowrap">Fee %</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={settings.defaultFeePct}
              onChange={(event) => setSettings((prev) => ({ ...prev, defaultFeePct: event.target.value }))}
              className="num h-8 w-14 rounded-md border border-border bg-panel-2 px-2 text-right text-[13px] text-foreground outline-none focus:border-border-strong"
              title="Fee taker per sisi (default 0.1% beli + 0.1% jual)"
            />
          </label>

          <div className="relative" ref={feePopoverRef}>
            <button
              type="button"
              onClick={() => {
                setFeePopoverOpen((open) => !open);
                setFiltersOpen(false);
              }}
              className="btn-ghost inline-flex items-center gap-1.5"
              aria-expanded={feePopoverOpen}
            >
              Fee khusus
              {customFeeCount > 0 ? (
                <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-foreground px-1.5 py-0.5 text-[10px] font-medium leading-none text-background">
                  {customFeeCount}
                </span>
              ) : null}
            </button>
            {feePopoverOpen ? (
              <div className="absolute left-0 z-40 mt-1 w-72 max-w-[calc(100vw-24px)] rounded-lg border border-border bg-panel p-3 shadow-xl">
                <div className="mb-2 flex items-center justify-between">
                  <p className="muted text-[11px] uppercase tracking-wide">Override fee per exchange (%)</p>
                  {customFeeCount > 0 ? (
                    <button
                      type="button"
                      className="btn-ghost !px-2 !py-0.5 !text-[11px]"
                      onClick={() => setSettings((prev) => ({ ...prev, exchangeFees: {} }))}
                    >
                      Reset
                    </button>
                  ) : null}
                </div>
                <p className="muted mb-2 text-[11px]">
                  Kosongkan untuk pakai default ({defaultFeePct}%). Isi 0 untuk fee 0%.
                </p>
                <div className="max-h-56 space-y-1 overflow-y-auto pr-0.5">
                  {visibleExchanges.map((ex) => {
                    const id = ex.id.toLowerCase();
                    return (
                      <label key={id} className="flex items-center justify-between gap-2 text-[13px]">
                        <span className="truncate text-foreground">{ex.name}</span>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder={String(defaultFeePct)}
                          value={settings.exchangeFees[id] ?? ""}
                          onChange={(event) => {
                            const val = event.target.value;
                            setSettings((prev) => {
                              const next = { ...prev.exchangeFees };
                              if (val.trim() === "") delete next[id];
                              else next[id] = val;
                              return { ...prev, exchangeFees: next };
                            });
                          }}
                          className="num h-8 w-16 rounded-md border border-border bg-panel-2 px-2 text-right text-[13px] text-foreground outline-none focus:border-border-strong"
                        />
                      </label>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>

          <div className="relative" ref={filtersRef}>
            <button
              type="button"
              onClick={() => {
                setFiltersOpen((open) => !open);
                setFeePopoverOpen(false);
              }}
              className="btn-ghost inline-flex items-center gap-1.5"
              aria-expanded={filtersOpen}
            >
              Filter
              {activeFilterCount > 0 ? (
                <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-foreground px-1.5 py-0.5 text-[10px] font-medium leading-none text-background">
                  {activeFilterCount}
                </span>
              ) : null}
            </button>
            {filtersOpen ? (
              <div className="absolute left-0 z-40 mt-1 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-border bg-panel p-3 shadow-xl">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="muted text-[11px] uppercase tracking-wide">Filter aman</p>
                  <button
                    type="button"
                    onClick={resetFilters}
                    disabled={activeFilterCount === 0}
                    className="btn-ghost !px-2 !py-0.5 !text-[11px]"
                  >
                    Reset
                  </button>
                </div>
                <div className="mb-3 flex flex-col gap-1.5 text-[13px] text-foreground">
                  <label className="flex cursor-pointer items-center gap-2" title="Sembunyikan rute dengan data ticker stale.">
                    <input
                      type="checkbox"
                      checked={settings.hideStale}
                      onChange={(event) => setSettings((prev) => ({ ...prev, hideStale: event.target.checked }))}
                      className="accent-foreground"
                    />
                    <span>Non-stale</span>
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block min-w-0">
                    <span className="muted mb-1 block text-[10px] uppercase tracking-wide">Min spread %</span>
                    <input
                      type="number"
                      step="0.1"
                      placeholder="Semua"
                      value={settings.minSpreadPct}
                      onChange={(event) => setSettings((prev) => ({ ...prev, minSpreadPct: event.target.value }))}
                      className={FILTER_INPUT}
                    />
                  </label>
                  <label className="block min-w-0">
                    <span className="muted mb-1 block text-[10px] uppercase tracking-wide">Min vol $</span>
                    <input
                      type="number"
                      min="0"
                      step="100"
                      placeholder="Semua"
                      value={settings.minVolumeUsd}
                      onChange={(event) => setSettings((prev) => ({ ...prev, minVolumeUsd: event.target.value }))}
                      className={FILTER_INPUT}
                    />
                  </label>
                  <label className="col-span-2 block min-w-0">
                    <span className="muted mb-1 block text-[10px] uppercase tracking-wide">Maks umur (mnt)</span>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      placeholder="Bebas"
                      value={settings.maxAgeMinutes}
                      onChange={(event) => setSettings((prev) => ({ ...prev, maxAgeMinutes: event.target.value }))}
                      className={FILTER_INPUT}
                    />
                  </label>
                </div>
              </div>
            ) : null}
          </div>

          <SegmentedFilter
            ariaLabel="Filter status Depo/WD rute terbaik"
            options={[
              { key: "showFundingOpen", label: "Buka", count: statusCounts.open, title: "Rute dengan WD beli dan Depo jual terbuka" },
              { key: "showFundingSuspended", label: "Suspend", count: statusCounts.suspended, title: "Rute dengan WD beli atau Depo jual tertutup" },
              { key: "showFundingUnknown", label: "Tidak diketahui", count: statusCounts.unknown, title: "Rute dengan status Depo/WD belum diketahui" },
            ]}
            isOn={(key) => settings[key]}
            onToggle={toggleFundingStatus}
          />

          <SegmentedFilter
            ariaLabel="Filter status kontrak rute terbaik"
            options={[
              { key: "showContractMatch", label: "Sama", count: contractCounts.match, title: "Kontrak cocok di kedua exchange" },
              { key: "showContractMismatch", label: "Beda", count: contractCounts.mismatch, title: "Kedua sisi punya kontrak, tetapi tidak ada yang cocok" },
              { key: "showContractUnknown", label: "?", count: contractCounts.unknown, title: "Salah satu atau kedua exchange tidak punya data kontrak" },
              { key: "showContractNative", label: "Native", count: contractCounts.native, title: "Coin native tanpa kontrak on-chain di kedua sisi" },
            ]}
            isOn={(key) => settings[key]}
            onToggle={toggleContractStatus}
          />

          <BlacklistPopoverButton exchangeNames={exchangeNames} />

          <label
            className="flex h-8 cursor-pointer items-center gap-1.5 whitespace-nowrap text-[13px] text-foreground"
            title="Tampilkan juga coin yang rute terbaiknya masih minus setelah fee"
          >
            <input
              type="checkbox"
              checked={settings.showNegative}
              onChange={(event) => setSettings((prev) => ({ ...prev, showNegative: event.target.checked }))}
              className="accent-foreground"
            />
            <span>Tampilkan minus</span>
            <span className="num muted text-[11px]">{negativeCount.toLocaleString("id-ID")}</span>
          </label>

          <label className="flex h-8 cursor-pointer items-center gap-1.5 whitespace-nowrap text-[13px] text-foreground">
            <input
              type="checkbox"
              checked={settings.depthMode}
              onChange={(event) => setSettings((prev) => ({ ...prev, depthMode: event.target.checked }))}
              className="accent-foreground"
            />
            <span>Depth</span>
          </label>

          <label className="flex h-8 items-center gap-1.5 text-[13px]">
            <span className="muted whitespace-nowrap">Modal $</span>
            <input
              type="number"
              min="1"
              step="10"
              value={settings.modalUsd}
              onChange={(event) => setSettings((prev) => ({ ...prev, modalUsd: event.target.value }))}
              className="num h-8 w-16 rounded-md border border-border bg-panel-2 px-2 text-right text-[13px] text-foreground outline-none focus:border-border-strong"
            />
          </label>

          {settings.depthMode ? (
            <>
              <span className="num muted whitespace-nowrap text-[11px]">
                {depthProgress.loading
                  ? `Book ${depthProgress.ready}/${depthProgress.total}`
                  : `${depthProgress.ready}/${depthProgress.total} book`}
                {depthProgress.failed > 0 ? ` · ${depthProgress.failed} gagal` : ""}
              </span>
              <button
                type="button"
                onClick={refreshDepth}
                disabled={depthProgress.loading}
                className="btn-ghost !h-8 !px-2.5 text-[12px]"
              >
                Refresh
              </button>
            </>
          ) : null}

          <span className="muted ml-auto whitespace-nowrap text-[12px]">
            <span className="num font-medium text-foreground">
              {visibleExchanges.length}/{allExchanges.length || exchanges.length}
            </span>{" "}
            market ·{" "}
            <span className="num font-medium text-foreground">{totalCount.toLocaleString("id-ID")}</span> coin
          </span>
        </div>

        <div className="tickers-scroll min-h-0 min-w-0 flex-1 overflow-auto">
          <table
            className={`tickers-table compare-routes-table w-full border-separate border-spacing-0 text-left${
              settings.depthMode ? " is-depth" : ""
            }`}
          >
            <thead>
              <tr>
                {sortTh("base", "Coin", "left", "sticky-col sticky-coin")}
                <th className="col-buy text-left">Beli di</th>
                <th className="col-sell text-left">Jual di</th>
                <th className="col-contract text-left">Kontrak</th>
                {sortTh("grossSpreadPct", "Spread %", "right", "col-spread")}
                {sortTh("netProfitPct", "Profit bersih", "right", "col-profit")}
                {settings.depthMode ? (
                  <>
                    <th className="col-vwap text-right">VWAP</th>
                    {sortTh("depthProfitPct", "Profit depth", "right", "col-depth-profit")}
                    {sortTh("maxFillableUsd", "Max fill", "right", "col-fill")}
                  </>
                ) : null}
                {sortTh("volume", "Vol 24h", "right", "col-vol")}
                {sortTh("age", "Umur", "left", "col-age")}
              </tr>
            </thead>
            <tbody>
              {loading && exchanges.length === 0 ? (
                <tr>
                  <td colSpan={colSpan} className="muted !h-24 px-4 text-center">
                    Memuat data perbandingan...
                  </td>
                </tr>
              ) : visibleExchanges.length < 2 ? (
                <tr>
                  <td colSpan={colSpan} className="muted !h-24 px-4 text-center">
                    Aktifkan minimal 2 market di Pengaturan Market untuk membandingkan rute.
                  </td>
                </tr>
              ) : displayedGroups.length === 0 ? (
                <tr>
                  <td colSpan={colSpan} className="muted !h-24 px-4 text-center">
                    Tidak ada rute yang lolos filter saat ini.
                  </td>
                </tr>
              ) : (
                displayedGroups.map((group) => {
                  const route = group.bestRoute;
                  const isExpanded = expandedCoins.has(group.base);
                  const hasOthers = group.otherRoutes.length > 0;
                  return (
                    <Fragment key={group.base}>
                      <tr className={route.fundingClosed ? "compare-suspended" : undefined}>
                        <td className="sticky-col sticky-coin">
                          <div className="compare-coin">
                            {hasOthers ? (
                              <button
                                type="button"
                                onClick={() => toggleExpand(group.base)}
                                className="inline-flex h-5 shrink-0 items-center gap-0.5 rounded border border-border bg-panel-2 px-1.5 text-[10px] font-medium text-foreground hover:border-border-strong hover:bg-hover"
                                aria-expanded={isExpanded}
                                title={
                                  isExpanded
                                    ? "Sembunyikan rute lain"
                                    : `Lihat ${group.otherRoutes.length} rute lain untuk ${group.base}`
                                }
                              >
                                <span>{isExpanded ? "▾" : "▸"}</span>
                                <span className="num">+{group.otherRoutes.length}</span>
                              </button>
                            ) : null}
                            <span className="compare-coin-name">{group.base}</span>
                            <BlacklistRowButton
                              coin={group.base}
                              listings={[
                                { id: route.buy.exchange, name: route.buyExchangeName },
                                { id: route.sell.exchange, name: route.sellExchangeName },
                              ]}
                            />
                            <StatusBadges route={route} />
                          </div>
                        </td>
                        {renderRouteCells(route)}
                      </tr>

                      {isExpanded
                        ? group.otherRoutes.map((altRoute) => (
                            <tr key={altRoute.id} className={`compare-sub${altRoute.fundingClosed ? " compare-suspended" : ""}`}>
                              <td className="sticky-col sticky-coin">
                                <div className="compare-coin pl-2">
                                  <span className="muted text-[11px]">↳</span>
                                  <span className="compare-coin-name">{altRoute.base}</span>
                                  <BlacklistRowButton
                                    coin={altRoute.base}
                                    listings={[
                                      { id: altRoute.buy.exchange, name: altRoute.buyExchangeName },
                                      { id: altRoute.sell.exchange, name: altRoute.sellExchangeName },
                                    ]}
                                  />
                                  <StatusBadges route={altRoute} />
                                </div>
                              </td>
                              {renderRouteCells(altRoute)}
                            </tr>
                          ))
                        : null}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[13px]">
          <span className="muted">
            Menampilkan {from}–{to} dari {totalCount.toLocaleString("id-ID")}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <label className="muted flex items-center gap-1.5">
              <span>Baris per halaman</span>
              <select
                value={settings.pageSize}
                onChange={(event) =>
                  setSettings((prev) => ({
                    ...prev,
                    pageSize: Number(event.target.value) as 25 | 50 | 100,
                  }))
                }
                className="h-8 rounded-md border border-border bg-panel-2 px-2 text-[13px] text-foreground outline-none"
              >
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
              disabled={safePageIndex <= 0}
              className="btn-ghost"
            >
              Sebelumnya
            </button>
            <span className="num muted">
              {safePageIndex + 1} / {pageCount}
            </span>
            <button
              type="button"
              onClick={() => setPageIndex((p) => Math.min(pageCount - 1, p + 1))}
              disabled={safePageIndex >= pageCount - 1}
              className="btn-ghost"
            >
              Berikutnya
            </button>
          </div>
        </div>
      </main>

      {orderBookModal}
    </div>
  );
}
