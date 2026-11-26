"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppHeader } from "@/components/AppHeader";
import { useExchangeSettings } from "@/components/ExchangeSettings";
import { FavoriteStar } from "@/components/FavoriteStar";
import { FundingIcons } from "@/components/FundingIcons";
import { useOrderBook } from "@/components/OrderBookModal";
import { RelativeTime } from "@/components/RelativeTime";
import { getSpotUrl } from "@/lib/exchanges/spot-urls";
import { formatPrice, formatRelativeId, formatUsdCompact, formatWib, sortByExchangeName } from "@/lib/format";
import { usePersistedState } from "@/lib/persist";
import {
  DEFAULT_SCAN_SETTINGS,
  type ScanFundingMode,
  type ScanLeg,
  type ScanResult,
  type ScanSettings,
} from "@/lib/scan";

type ExchangeLabel = { id: string; name: string };
type PairEntry = { exchange: string; raw_symbol: string };

type ScanApiResponse = {
  ok?: boolean;
  error?: string;
  results?: ScanResult[];
  total?: number;
  capped?: boolean;
  coinsScanned?: number;
  coinsFound?: number;
  exchangesScanned?: number;
  durationMs?: number;
  favorites?: PairEntry[];
};

type ScanMeta = {
  total: number;
  capped: boolean;
  coinsScanned: number;
  coinsFound: number;
  exchangesScanned: number;
  durationMs: number;
  clientMs: number;
  at: string;
};

type SortKey = "base" | "buy" | "sell" | "gapPct" | "count" | "buyVol" | "sellVol" | "age";

type CoinGroup = { base: string; best: ScanResult; items: ScanResult[] };

function pairKey(exchange: string, rawSymbol: string): string {
  return `${exchange}\t${rawSymbol}`;
}

function parseSettings(raw: unknown): ScanSettings | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const n = (v: unknown, f: number) => (typeof v === "number" && Number.isFinite(v) ? v : f);
  const d = DEFAULT_SCAN_SETTINGS;
  return {
    priceMode: o.priceMode === "last" ? "last" : "bidask",
    minGapPct: n(o.minGapPct, d.minGapPct),
    maxGapPct: n(o.maxGapPct, d.maxGapPct),
    minVolUsd: n(o.minVolUsd, d.minVolUsd),
    funding: o.funding === "all" || o.funding === "hide" || o.funding === "mark" ? o.funding : d.funding,
    exchanges: Array.isArray(o.exchanges) ? o.exchanges.filter((x): x is string => typeof x === "string") : [],
    onlyFavorites: o.onlyFavorites === true,
  };
}

function ageMs(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Date.now() - t : null;
}

function formatGap(value: number): string {
  return `${value.toFixed(2)}%`;
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

function BlacklistButton({ leg, onBlacklist }: { leg: ScanLeg; onBlacklist: (leg: ScanLeg) => void }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onBlacklist(leg);
      }}
      title={`Blacklist ${leg.rawSymbol} di ${leg.exchangeName}`}
      aria-label={`Blacklist ${leg.rawSymbol} di ${leg.exchangeName}`}
      style={{
        border: "none",
        background: "transparent",
        cursor: "pointer",
        padding: "0 2px",
        fontSize: 11,
        lineHeight: 1,
        opacity: 0.55,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
      onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.55")}
    >
      ⛔
    </button>
  );
}

function LegCard({
  leg,
  side,
  priceLabel,
  detail,
  onBlacklist,
  onOrderBook,
}: {
  leg: ScanLeg;
  side: "buy" | "sell";
  priceLabel: string;
  detail: boolean;
  onBlacklist: (leg: ScanLeg) => void;
  onOrderBook: (leg: ScanLeg) => void;
}) {
  const href = getSpotUrl(leg.exchange, leg.base, leg.quote, leg.rawSymbol, leg.contracts);
  const accent = side === "buy" ? "var(--up, #22a06b)" : "var(--down, #e5484d)";
  const name = (
    <span style={{ fontWeight: 600, fontSize: detail ? 13 : 14, color: "var(--foreground)" }}>
      {leg.exchangeName}
      <span className="muted" style={{ fontWeight: 400, marginLeft: 5, fontSize: 11 }}>
        {leg.rawSymbol}
      </span>
    </span>
  );
  return (
    <div
      onClick={(event) => event.stopPropagation()}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minWidth: 240,
        padding: "6px 10px",
        borderRadius: 8,
        border: "1px solid var(--border)",
        borderLeft: `3px solid ${accent}`,
        background: detail ? "var(--panel)" : "var(--panel-2)",
        lineHeight: 1.3,
        cursor: "default",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:opacity-80"
            title={`Buka ${leg.rawSymbol} di ${leg.exchangeName}`}
          >
            {name}
            <ExternalLinkIcon />
          </a>
        ) : (
          name
        )}
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 4 }}>
          <button
            type="button"
            onClick={() => onOrderBook(leg)}
            title={`Lihat orderbook ${leg.rawSymbol} di ${leg.exchangeName}`}
            style={{
              height: 22,
              padding: "0 8px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--background)",
              color: "var(--foreground)",
              fontSize: 11,
              fontWeight: 500,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            Orderbook
          </button>
          <BlacklistButton leg={leg} onBlacklist={onBlacklist} />
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, whiteSpace: "nowrap" }}>
        <span className="num">
          <span className="muted" style={{ fontSize: 11, marginRight: 4 }}>
            {priceLabel}
          </span>
          <span style={{ fontSize: detail ? 13 : 14, fontWeight: 600, color: "var(--foreground)" }}>{formatPrice(leg.price)}</span>
        </span>
        <span className="num">
          <span className="muted" style={{ fontSize: 11, marginRight: 4 }}>
            Vol
          </span>
          {formatUsdCompact(leg.volUsd)}
        </span>
        <span style={{ marginLeft: "auto" }}>
          <FundingIcons
            depositEnabled={leg.depositEnabled}
            withdrawEnabled={leg.withdrawEnabled}
            chainstatusRaw={leg.chainstatusRaw}
          />
        </span>
      </div>
    </div>
  );
}

const fieldStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, fontSize: 12 };
const inputStyle: React.CSSProperties = {
  height: 30,
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--panel-2)",
  color: "var(--foreground)",
  padding: "0 8px",
  fontSize: 13,
  outline: "none",
};

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        height: 30,
        alignItems: "center",
        borderRadius: 999,
        border: "1px solid var(--border)",
        background: "var(--panel-2)",
        padding: 2,
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            style={{
              height: 24,
              padding: "0 10px",
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 500,
              border: "none",
              cursor: "pointer",
              background: active ? "var(--foreground)" : "transparent",
              color: active ? "var(--background)" : "var(--muted)",
              whiteSpace: "nowrap",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function ExchangePicker({
  exchanges,
  selected,
  onChange,
}: {
  exchanges: ExchangeLabel[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const validSelected = selected.filter((id) => exchanges.some((e) => e.id === id));
  const all = validSelected.length === 0;
  const label = all ? `Semua (${exchanges.length})` : `${validSelected.length} dari ${exchanges.length}`;
  const isOn = (id: string) => all || validSelected.includes(id);
  const toggle = (id: string) => {
    const current = all ? exchanges.map((e) => e.id) : validSelected;
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    // Semua tercentang = simpan kosong (artinya semua, termasuk exchange baru nanti).
    onChange(next.length === exchanges.length ? [] : next.length === 0 ? current : next);
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button type="button" onClick={() => setOpen((v) => !v)} style={{ ...inputStyle, cursor: "pointer", minWidth: 130, textAlign: "left" }}>
        {label} ▾
      </button>
      {open ? (
        <div
          style={{
            position: "absolute",
            zIndex: 30,
            top: 34,
            left: 0,
            width: 260,
            maxHeight: 340,
            overflow: "auto",
            borderRadius: 10,
            border: "1px solid var(--border)",
            background: "var(--panel)",
            boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
            padding: 8,
          }}
        >
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <button type="button" className="btn-ghost" style={{ fontSize: 12 }} onClick={() => onChange([])}>
              Pilih semua
            </button>
          </div>
          {sortByExchangeName(exchanges, (item) => item.name).map((e) => (
            <label
              key={e.id}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 4px", fontSize: 13, cursor: "pointer" }}
            >
              <input type="checkbox" checked={isOn(e.id)} onChange={() => toggle(e.id)} />
              {e.name}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ScannerPage() {
  const { isDisabled } = useExchangeSettings();
  const [settings, setSettings] = usePersistedState<ScanSettings>("arbit.scanner.settings", DEFAULT_SCAN_SETTINGS, parseSettings);
  const [exchanges, setExchanges] = useState<ExchangeLabel[]>([]);
  const [results, setResults] = useState<ScanResult[] | null>(null);
  const [meta, setMeta] = useState<ScanMeta | null>(null);
  const [favorites, setFavorites] = useState<PairEntry[]>([]);
  const [scanning, setScanning] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "gapPct", desc: true });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { openOrderBook, orderBookModal } = useOrderBook();
  const openLegOrderBook = (leg: ScanLeg) => void openOrderBook(leg.exchange, leg.rawSymbol, leg.exchangeName);
  // Satu timer untuk semua baris (bukan 1 interval per sel).
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = window.setInterval(tick, 5000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [statusRes, favRes] = await Promise.all([
          fetch("/api/status", { cache: "no-store" }),
          fetch("/api/favorites", { cache: "no-store" }),
        ]);
        const status = (await statusRes.json()) as { exchanges?: Array<{ id: string; name: string; enabled?: number }> };
        const fav = (await favRes.json()) as { items?: PairEntry[] };
        setExchanges(
          sortByExchangeName(
            (status.exchanges ?? []).filter((e) => e.enabled !== 0).map((e) => ({ id: e.id, name: e.name })),
            (item) => item.name,
          ),
        );
        setFavorites(Array.isArray(fav.items) ? fav.items : []);
      } catch (error) {
        setBanner(error instanceof Error ? error.message : String(error));
      }
    })();
  }, []);

  const update = <K extends keyof ScanSettings>(key: K, value: ScanSettings[K]) =>
    setSettings((prev) => ({ ...prev, [key]: value }));

  const visibleExchanges = useMemo(
    () => exchanges.filter((e) => !isDisabled(e.id)),
    [exchanges, isDisabled],
  );

  const scan = useCallback(async () => {
    setScanning(true);
    setBanner(null);
    const started = performance.now();
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          ...settings,
          exchanges:
            settings.exchanges.length > 0
              ? settings.exchanges.filter((id) => !isDisabled(id))
              : visibleExchanges.map((e) => e.id),
        }),
      });
      const data = (await res.json()) as ScanApiResponse;
      if (!res.ok || !data.ok) throw new Error(data.error || "Scan gagal");
      setResults(Array.isArray(data.results) ? data.results : []);
      setExpanded(new Set());
      if (Array.isArray(data.favorites)) setFavorites(data.favorites);
      setMeta({
        total: data.total ?? 0,
        capped: data.capped === true,
        coinsScanned: data.coinsScanned ?? 0,
        coinsFound: data.coinsFound ?? 0,
        exchangesScanned: data.exchangesScanned ?? 0,
        durationMs: data.durationMs ?? 0,
        clientMs: Math.round(performance.now() - started),
        at: new Date().toISOString(),
      });
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error));
    } finally {
      setScanning(false);
    }
  }, [settings, isDisabled, visibleExchanges]);

  const favorited = useMemo(() => new Set(favorites.map((f) => pairKey(f.exchange, f.raw_symbol))), [favorites]);

  const onToggleFavorite = async (leg: ScanLeg, nextActive: boolean) => {
    const key = pairKey(leg.exchange, leg.rawSymbol);
    const entry = { exchange: leg.exchange, raw_symbol: leg.rawSymbol };
    setFavorites((prev) =>
      nextActive ? [entry, ...prev.filter((f) => pairKey(f.exchange, f.raw_symbol) !== key)] : prev.filter((f) => pairKey(f.exchange, f.raw_symbol) !== key),
    );
    try {
      const res = await fetch("/api/favorites", {
        method: nextActive ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify(entry),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.ok === false) throw new Error(data?.error || "Gagal mengubah favorit");
    } catch (error) {
      setFavorites((prev) =>
        nextActive ? prev.filter((f) => pairKey(f.exchange, f.raw_symbol) !== key) : [entry, ...prev],
      );
      setBanner(error instanceof Error ? error.message : String(error));
    }
  };

  const onBlacklist = async (leg: ScanLeg) => {
    const key = pairKey(leg.exchange, leg.rawSymbol);
    const hit = (r: ScanResult) =>
      pairKey(r.buy.exchange, r.buy.rawSymbol) === key || pairKey(r.sell.exchange, r.sell.rawSymbol) === key;
    const removed = (results ?? []).filter(hit);
    setResults((prev) => (prev ? prev.filter((r) => !hit(r)) : prev));
    try {
      const res = await fetch("/api/blacklist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ exchange: leg.exchange, raw_symbol: leg.rawSymbol }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.ok === false) throw new Error(data?.error || "Gagal menambah blacklist");
      setBanner(`${leg.rawSymbol} di ${leg.exchangeName} masuk blacklist.`);
    } catch (error) {
      setResults((prev) => (prev ? [...prev, ...removed].sort((x, y) => y.gapPct - x.gapPct) : prev));
      setBanner(error instanceof Error ? error.message : String(error));
    }
  };

  const groups = useMemo<CoinGroup[]>(() => {
    if (!results) return [];
    const byCoin = new Map<string, ScanResult[]>();
    for (const r of results) {
      if (isDisabled(r.buy.exchange) || isDisabled(r.sell.exchange)) continue;
      const list = byCoin.get(r.base);
      if (list) list.push(r);
      else byCoin.set(r.base, [r]);
    }
    const out: CoinGroup[] = [];
    for (const [base, items] of byCoin) {
      items.sort((x, y) => y.gapPct - x.gapPct);
      out.push({ base, best: items[0]!, items });
    }
    return out;
  }, [results, isDisabled]);

  const visibleGroups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const rows = needle
      ? groups.filter(
          (g) =>
            g.base.toLowerCase().includes(needle) ||
            g.items.some((r) =>
              [r.buy.exchangeName, r.buy.exchange, r.buy.rawSymbol, r.sell.exchangeName, r.sell.exchange, r.sell.rawSymbol]
                .join(" ")
                .toLowerCase()
                .includes(needle),
            ),
        )
      : [...groups];
    const val = (g: CoinGroup): number | string | null => {
      const r = g.best;
      switch (sort.key) {
        case "base":
          return g.base;
        case "buy":
          return r.buy.exchangeName;
        case "sell":
          return r.sell.exchangeName;
        case "gapPct":
          return r.gapPct;
        case "count":
          return g.items.length;
        case "buyVol":
          return r.buy.volUsd;
        case "sellVol":
          return r.sell.volUsd;
        case "age": {
          const a = ageMs(r.buy.fetchedAt);
          const b = ageMs(r.sell.fetchedAt);
          if (a == null && b == null) return null;
          return Math.max(a ?? 0, b ?? 0);
        }
      }
    };
    rows.sort((x, y) => {
      const av = val(x);
      const bv = val(y);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return sort.desc ? bv - av : av - bv;
      const c = String(av).localeCompare(String(bv), "en", { numeric: true, sensitivity: "base" });
      return sort.desc ? -c : c;
    });
    return rows;
  }, [groups, search, sort]);

  const toggleExpanded = (base: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(base)) next.delete(base);
      else next.add(base);
      return next;
    });

  const toggleSort = (key: SortKey) =>
    setSort((prev) => (prev.key === key ? { key, desc: !prev.desc } : { key, desc: !(key === "base" || key === "buy" || key === "sell") }));
  const mark = (key: SortKey) => (sort.key === key ? (sort.desc ? "↓" : "↑") : "");
  const buyLabel = settings.priceMode === "last" ? "last" : "ask";
  const sellLabel = settings.priceMode === "last" ? "last" : "bid";
  const markFunding = settings.funding === "mark";

  const sortTh = (k: SortKey, children: React.ReactNode, right?: boolean) => (
    <th key={k} className={right ? "text-right" : undefined}>
      <button
        type="button"
        onClick={() => toggleSort(k)}
        className={right ? "inline-flex w-full items-center justify-end gap-1" : "inline-flex items-center gap-1"}
      >
        {children} <span className="text-[10px] text-foreground">{mark(k)}</span>
      </button>
    </th>
  );

  return (
    <div className="app-shell flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
      <AppHeader current="scanner" />

      {banner ? (
        <div className="border-b border-border bg-panel px-4 py-2 text-[13px] text-muted sm:px-5">{banner}</div>
      ) : null}

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background p-3 sm:p-4">
        <section
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "flex-end",
            gap: 12,
            padding: 12,
            marginBottom: 12,
            borderRadius: 12,
            border: "1px solid var(--border)",
            background: "var(--panel)",
          }}
        >
          <div style={fieldStyle}>
            <span className="muted">Harga</span>
            <Segmented
              value={settings.priceMode}
              options={[
                { value: "bidask", label: "Bid/Ask" },
                { value: "last", label: "Last" },
              ]}
              onChange={(v) => update("priceMode", v)}
            />
          </div>
          <label style={fieldStyle}>
            <span className="muted">Gap min %</span>
            <input
              type="number"
              step="0.1"
              value={settings.minGapPct}
              onChange={(e) => update("minGapPct", Number(e.target.value) || 0)}
              style={{ ...inputStyle, width: 80 }}
            />
          </label>
          <label style={fieldStyle}>
            <span className="muted">Gap maks %</span>
            <input
              type="number"
              step="1"
              value={settings.maxGapPct}
              onChange={(e) => update("maxGapPct", Number(e.target.value) || 0)}
              style={{ ...inputStyle, width: 80 }}
            />
          </label>
          <label style={fieldStyle}>
            <span className="muted">Vol USD 24h min (per sisi)</span>
            <input
              type="number"
              step="1000"
              min={0}
              value={settings.minVolUsd}
              onChange={(e) => update("minVolUsd", Math.max(0, Number(e.target.value) || 0))}
              style={{ ...inputStyle, width: 130 }}
            />
          </label>
          <div style={fieldStyle}>
            <span className="muted" title="Sisi beli butuh WD buka, sisi jual butuh Depo buka. Status belum diketahui dianggap buka.">
              Depo/WD tutup
            </span>
            <Segmented<ScanFundingMode>
              value={settings.funding}
              options={[
                { value: "all", label: "Tampilkan semua" },
                { value: "mark", label: "Tandai saja" },
                { value: "hide", label: "Sembunyikan yang tutup" },
              ]}
              onChange={(v) => update("funding", v)}
            />
          </div>
          <div style={fieldStyle}>
            <span className="muted">Exchange</span>
            <ExchangePicker exchanges={visibleExchanges} selected={settings.exchanges} onChange={(v) => update("exchanges", v)} />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 6, height: 30, fontSize: 13, cursor: "pointer" }}>
            <input type="checkbox" checked={settings.onlyFavorites} onChange={(e) => update("onlyFavorites", e.target.checked)} />
            Hanya favorit
          </label>
          <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
            <button type="button" className="btn-ghost" onClick={() => setSettings(DEFAULT_SCAN_SETTINGS)} disabled={scanning}>
              Reset
            </button>
            <button
              type="button"
              onClick={() => void scan()}
              disabled={scanning}
              style={{
                height: 32,
                padding: "0 20px",
                borderRadius: 999,
                border: "none",
                fontSize: 13,
                fontWeight: 600,
                cursor: scanning ? "default" : "pointer",
                background: "var(--foreground)",
                color: "var(--background)",
                opacity: scanning ? 0.6 : 1,
              }}
            >
              {scanning ? "Scanning..." : "Scan"}
            </button>
          </div>
        </section>

        <div className="mb-3 flex flex-wrap items-center gap-2 sm:gap-3">
          <h2 className="text-[15px] font-semibold leading-none">Scanner</h2>
          {meta ? (
            <span className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-panel-2 px-2 text-[11px] text-muted">
              <span className="num font-medium text-foreground">{meta.total.toLocaleString("id-ID")}</span>
              peluang di{" "}
              <span className="num font-medium text-foreground">{meta.coinsFound.toLocaleString("id-ID")}</span> coin · dari{" "}
              {meta.coinsScanned.toLocaleString("id-ID")} coin · {meta.exchangesScanned} exchange ·{" "}
              {meta.durationMs} ms server / {meta.clientMs} ms total
            </span>
          ) : null}
          {meta?.capped ? (
            <span className="text-[12px]" style={{ color: "#e0a030" }}>
              Hasil dibatasi {groups.length.toLocaleString("id-ID")} coin teratas (gap terbesar, maks ±2.000 peluang).
            </span>
          ) : null}
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cari coin atau exchange..."
            className="w-full min-w-0 rounded-full border border-border bg-panel-2 py-1.5 px-3 text-[13px] text-foreground outline-none placeholder:text-muted focus:border-border-strong sm:w-64"
          />
        </div>

        <div className="tickers-scroll min-h-0 flex-1 overflow-auto" style={{ flex: "1 1 0%" }}>
          <table className="tickers-table w-full min-w-[72rem] border-separate border-spacing-0 text-left">
            <thead>
              <tr>
                <th style={{ width: "2.5rem", minWidth: "2.5rem" }} />
                {sortTh("base", "Coin")}
                <th>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                    <button type="button" onClick={() => toggleSort("buy")} className="inline-flex items-center gap-1">
                      Beli di <span className="text-[10px] text-foreground">{mark("buy")}</span>
                    </button>
                    <button type="button" onClick={() => toggleSort("buyVol")} className="inline-flex items-center gap-1 muted">
                      vol <span className="text-[10px] text-foreground">{mark("buyVol")}</span>
                    </button>
                  </span>
                </th>
                <th>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                    <button type="button" onClick={() => toggleSort("sell")} className="inline-flex items-center gap-1">
                      Jual di <span className="text-[10px] text-foreground">{mark("sell")}</span>
                    </button>
                    <button type="button" onClick={() => toggleSort("sellVol")} className="inline-flex items-center gap-1 muted">
                      vol <span className="text-[10px] text-foreground">{mark("sellVol")}</span>
                    </button>
                  </span>
                </th>
                {sortTh("gapPct", "Gap %", true)}
                {sortTh("count", "Peluang", true)}
                {sortTh("age", "Umur data")}
              </tr>
            </thead>
            <tbody>
              {visibleGroups.map((g) => {
                const isOpen = expanded.has(g.base);
                const extra = g.items.length - 1;
                const renderRow = (r: ScanResult, detail: boolean, index: number) => {
                  const buyFav = favorited.has(pairKey(r.buy.exchange, r.buy.rawSymbol));
                  const flagged = markFunding && r.fundingBlocked;
                  const isLastDetail = detail && index === g.items.length - 1;
                  // Baris ringkasan: garis atas tegas; baris detail: latar beda + aksen kiri.
                  const cell: React.CSSProperties = detail
                    ? {
                        height: 60,
                        padding: "5px 10px",
                        fontSize: 13,
                        backgroundColor: "var(--panel-2)",
                        borderBottom: isLastDetail ? "2px solid var(--border-strong, var(--border))" : "1px dashed var(--border)",
                      }
                    : {
                        height: 66,
                        padding: "7px 10px",
                        fontSize: 14,
                        borderTop: "1px solid var(--border-strong, var(--border))",
                        borderBottom: isOpen ? "1px solid var(--border)" : undefined,
                      };
                  const firstCell: React.CSSProperties = detail
                    ? { ...cell, width: "2.5rem", minWidth: "2.5rem", boxShadow: "inset 3px 0 0 var(--muted)" }
                    : { ...cell, width: "2.5rem", minWidth: "2.5rem" };
                  return (
                    <tr
                      key={detail ? `${g.base}|${r.buy.exchange}|${r.sell.exchange}|d` : `${g.base}|sum`}
                      style={{
                        ...(flagged ? { opacity: 0.55 } : {}),
                        ...(!detail && extra > 0 ? { cursor: "pointer" } : {}),
                      }}
                      title={flagged ? "WD sisi beli atau Depo sisi jual tutup" : undefined}
                      onClick={detail || extra === 0 ? undefined : () => toggleExpanded(g.base)}
                    >
                      <td style={firstCell}>
                        <FavoriteStar
                          active={buyFav}
                          symbol={`${r.buy.rawSymbol} (${r.buy.exchangeName})`}
                          onToggle={() => void onToggleFavorite(r.buy, !buyFav)}
                        />
                      </td>
                      <td className="whitespace-nowrap" style={cell}>
                        {detail ? (
                          <span className="muted" style={{ paddingLeft: 18, fontSize: 12 }}>
                            ↳ #{index + 1}
                          </span>
                        ) : (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                            <span className="muted" style={{ width: 12, fontSize: 10, display: "inline-block" }}>
                              {extra > 0 ? (isOpen ? "▼" : "▶") : ""}
                            </span>
                            <span style={{ fontWeight: 700, fontSize: 15 }}>{g.base}</span>
                            {extra > 0 ? (
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  toggleExpanded(g.base);
                                }}
                                title={isOpen ? "Tutup daftar peluang" : "Lihat semua peluang coin ini"}
                                style={{
                                  height: 20,
                                  padding: "0 8px",
                                  borderRadius: 999,
                                  border: "1px solid var(--border)",
                                  background: "var(--panel-2)",
                                  color: "var(--muted)",
                                  fontSize: 11,
                                  fontWeight: 500,
                                  cursor: "pointer",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {isOpen ? "Tutup" : `+${extra} peluang`}
                              </button>
                            ) : null}
                          </span>
                        )}
                        {flagged ? (
                          <span style={{ marginLeft: 6, fontSize: 10, color: "#e05050", fontWeight: 600 }}>TUTUP</span>
                        ) : null}
                      </td>
                      <td style={cell}>
                        <LegCard
                          leg={r.buy}
                          side="buy"
                          priceLabel={buyLabel}
                          detail={detail}
                          onBlacklist={(leg) => void onBlacklist(leg)}
                          onOrderBook={openLegOrderBook}
                        />
                      </td>
                      <td style={cell}>
                        <LegCard
                          leg={r.sell}
                          side="sell"
                          priceLabel={sellLabel}
                          detail={detail}
                          onBlacklist={(leg) => void onBlacklist(leg)}
                          onOrderBook={openLegOrderBook}
                        />
                      </td>
                      <td className="text-right num whitespace-nowrap up" style={{ ...cell, fontWeight: 700, fontSize: detail ? 14 : 16 }}>
                        {formatGap(r.gapPct)}
                      </td>
                      <td className="text-right num whitespace-nowrap muted" style={{ ...cell, fontSize: 12 }}>
                        {detail ? "" : g.items.length}
                      </td>
                      <td className="whitespace-nowrap" style={{ ...cell, fontSize: 12 }}>
                        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.35 }}>
                          <span className="muted" title={`Beli: ${formatWib(r.buy.fetchedAt)}`} suppressHydrationWarning>
                            B: {now == null ? "…" : formatRelativeId(r.buy.fetchedAt, now)}
                          </span>
                          <span className="muted" title={`Jual: ${formatWib(r.sell.fetchedAt)}`} suppressHydrationWarning>
                            J: {now == null ? "…" : formatRelativeId(r.sell.fetchedAt, now)}
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                };
                return [renderRow(g.best, false, 0), ...(isOpen ? g.items.map((r, i) => renderRow(r, true, i)) : [])];
              })}
              {results == null && !scanning ? (
                <tr>
                  <td colSpan={7} className="muted !h-24 px-4 text-center">
                    Atur opsi di atas lalu klik Scan. Data diambil dari hasil Fetch terakhir di DB.
                  </td>
                </tr>
              ) : null}
              {scanning && (results == null || results.length === 0) ? (
                <tr>
                  <td colSpan={7} className="muted !h-24 px-4 text-center">
                    Scanning...
                  </td>
                </tr>
              ) : null}
              {results != null && !scanning && visibleGroups.length === 0 ? (
                <tr>
                  <td colSpan={7} className="muted !h-24 px-4 text-center">
                    {results.length === 0 ? "Tidak ada peluang yang cocok dengan pengaturan ini." : "Tidak ada hasil yang cocok dengan pencarian."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {results ? (
          <p className="muted mt-3 text-[13px]">
            Menampilkan {visibleGroups.length.toLocaleString("id-ID")} dari {groups.length.toLocaleString("id-ID")} coin (
            {results.length.toLocaleString("id-ID")} peluang)
            {meta ? (
              <>
                {" "}· scan <RelativeTime value={meta.at} />
              </>
            ) : null}
          </p>
        ) : null}
      </main>

      {orderBookModal}
    </div>
  );
}
