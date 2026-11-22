"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppHeader } from "@/components/AppHeader";
import { DepthBar, DepthSkeleton } from "@/components/DepthBar";
import { useManifestOrderBook } from "@/components/OrderBookModal";
import { RelativeTime } from "@/components/RelativeTime";
import { colorClass, formatPct, formatPrice, formatUsdCompact } from "@/lib/format";
import type {
  ManifestDepthItem,
  ManifestMarket,
  ManifestSnapshot,
  ManifestTokenGroup,
} from "@/lib/manifest-types";
import { isUsdLikeQuote, MANIFEST_DUST_USD, MANIFEST_PAGE_SIZE } from "@/lib/manifest-types";

const CLIENT_DEPTH_TTL_MS = 60_000;
const CLIENT_DEPTH_ERROR_TTL_MS = 15_000;
const MAX_DEPTH_IDS = 80;
const CLIENT_FETCH_TIMEOUT_MS = 35_000;
const STALE_POLL_MS = 4_000;
const MAX_STALE_POLLS = 8;

type DepthView = { status: "idle" | "loading" | "ok" | "error"; bidUsd: number | null; askUsd: number | null };
type DepthCacheEntry = DepthView & { at: number; ttl: number };

const depthCache = new Map<string, DepthCacheEntry>();

function formatUsdPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return `$${formatPrice(value)}`;
}

function shortMint(mint: string): string {
  if (mint.length <= 10) return mint;
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

function bestSpreadPct(token: ManifestTokenGroup): number | null {
  let best: number | null = null;
  for (const market of token.markets) {
    const spread = market.spreadPct;
    if (spread == null || !Number.isFinite(spread) || spread < 0) continue;
    if (best == null || spread < best) best = spread;
  }
  return best;
}

function readDepth(id: string, now = Date.now()): DepthCacheEntry | null {
  const entry = depthCache.get(id);
  if (!entry) return null;
  if (now - entry.at >= entry.ttl) {
    depthCache.delete(id);
    return null;
  }
  return entry;
}

function useManifestDepth(tickerIds: string[], enabled: boolean): (id: string) => DepthView {
  const idsRef = useRef(tickerIds);
  idsRef.current = tickerIds;
  const loadingRef = useRef(new Set<string>());
  const [tick, setTick] = useState(0);
  const fingerprint = useMemo(() => (enabled ? tickerIds.join("\n") : ""), [tickerIds, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const current = idsRef.current.slice(0, MAX_DEPTH_IDS);
    const now = Date.now();
    const needed = current.filter((id) => !readDepth(id, now) && !loadingRef.current.has(id));
    if (needed.length === 0) return;

    const controller = new AbortController();
    for (const id of needed) loadingRef.current.add(id);
    setTick((value) => value + 1);

    const load = async () => {
      try {
        const response = await fetch("/api/manifest/depth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          signal: controller.signal,
          body: JSON.stringify({ markets: needed }),
        });
        const data = (await response.json()) as { ok?: boolean; items?: ManifestDepthItem[] };
        if (controller.signal.aborted) return;
        const stamp = Date.now();
        if (!response.ok || !data.ok || !Array.isArray(data.items)) {
          throw new Error("Gagal memuat depth Manifest");
        }
        const seen = new Set<string>();
        for (const item of data.items) {
          seen.add(item.tickerId);
          const ok = item.ok !== false && (item.bidUsd != null || item.askUsd != null || item.ok === true);
          depthCache.set(item.tickerId, {
            status: ok ? "ok" : "error",
            bidUsd: item.bidUsd,
            askUsd: item.askUsd,
            at: stamp,
            ttl: ok ? CLIENT_DEPTH_TTL_MS : CLIENT_DEPTH_ERROR_TTL_MS,
          });
        }
        for (const id of needed) {
          if (seen.has(id)) continue;
          depthCache.set(id, { status: "error", bidUsd: null, askUsd: null, at: stamp, ttl: CLIENT_DEPTH_ERROR_TTL_MS });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        const stamp = Date.now();
        for (const id of needed) {
          if (readDepth(id, stamp)) continue;
          depthCache.set(id, { status: "error", bidUsd: null, askUsd: null, at: stamp, ttl: CLIENT_DEPTH_ERROR_TTL_MS });
        }
        console.warn(error instanceof Error ? error.message : String(error));
      } finally {
        for (const id of needed) loadingRef.current.delete(id);
        if (!controller.signal.aborted) setTick((value) => value + 1);
      }
    };

    void load();
    return () => {
      controller.abort();
      for (const id of needed) loadingRef.current.delete(id);
    };
  }, [fingerprint, enabled]);

  return useCallback(
    (id: string): DepthView => {
      const hit = readDepth(id);
      if (hit) return { status: hit.status, bidUsd: hit.bidUsd, askUsd: hit.askUsd };
      if (loadingRef.current.has(id) || (fingerprint && fingerprint.split("\n").includes(id))) {
        return { status: "loading", bidUsd: null, askUsd: null };
      }
      return { status: "idle", bidUsd: null, askUsd: null };
    },
    [tick, fingerprint],
  );
}

function DepthCell({ tickerId, getDepth }: { tickerId: string; getDepth: (id: string) => DepthView }) {
  const view = getDepth(tickerId);
  if (view.status === "loading") return <DepthSkeleton />;
  if (view.status === "idle" || view.status === "error" || (view.bidUsd == null && view.askUsd == null)) {
    return <span className="muted">-</span>;
  }
  return <DepthBar bidUsd={view.bidUsd ?? 0} askUsd={view.askUsd ?? 0} />;
}

function QuotePrice({ market, field }: { market: ManifestMarket; field: "last" | "bid" | "ask" }) {
  const native = market[field];
  const usd = field === "last" ? market.lastUsd : field === "bid" ? market.bidUsd : market.askUsd;
  const convert = !isUsdLikeQuote(market.quoteSymbol, market.quoteUsd) && usd != null;
  if (!convert) return <span className="num">{formatPrice(native)}</span>;
  return (
    <span className="num inline-flex flex-col items-end leading-tight">
      <span>{formatPrice(usd)}</span>
      <span className="text-[10px] font-normal text-muted">
        {formatPrice(native)} {market.quoteSymbol}
      </span>
    </span>
  );
}

function CopyMint({ mint }: { mint: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={mint}
      className="num inline-flex items-center gap-1 rounded px-1 text-[11px] text-muted hover:bg-panel-2 hover:text-foreground"
      onClick={async (event) => {
        event.stopPropagation();
        try {
          await navigator.clipboard.writeText(mint);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        } catch {
          setCopied(false);
        }
      }}
    >
      <span>{shortMint(mint)}</span>
      <span className="text-[10px]">{copied ? "tersalin" : "salin"}</span>
    </button>
  );
}

type SortKey = "volume" | "symbol" | "markets" | "gap";

function clientFetchError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "AbortError" || name === "TimeoutError" || /abort|timeout/i.test(message)) {
    return "Timeout: API Manifest tidak merespons. Coba lagi.";
  }
  return message || "Gagal memuat data Manifest";
}

export function ManifestPage() {
  const [snapshot, setSnapshot] = useState<ManifestSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const snapshotRef = useRef<ManifestSnapshot | null>(null);
  const pollCountRef = useRef(0);
  const [search, setSearch] = useState("");
  const [hideDust, setHideDust] = useState(true);
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "volume", desc: true });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [syncing, setSyncing] = useState(false);
  const { openOrderBook, orderBookModal } = useManifestOrderBook();

  const load = useCallback(async (options?: { refreshSol?: boolean; quiet?: boolean }) => {
    const refreshSol = options?.refreshSol === true;
    const hasOk = snapshotRef.current?.ok === true;
    const quiet = options?.quiet === true || (hasOk && !refreshSol);
    if (!quiet) pollCountRef.current = 0;
    if (refreshSol) setSyncing(true);
    else if (!hasOk) setLoading(true);
    else setUpdating(true);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), CLIENT_FETCH_TIMEOUT_MS);
    try {
      const url = refreshSol ? "/api/manifest?refreshSol=1" : "/api/manifest";
      const response = await fetch(url, { cache: "no-store", signal: controller.signal });
      const data = (await response.json()) as ManifestSnapshot;
      if (data.ok || !hasOk) setSnapshot(data);
    } catch (error) {
      if (!hasOk) {
        setSnapshot({
          ok: false,
          error: clientFetchError(error),
          status: null,
          fetchedAt: new Date().toISOString(),
          source: "https://mfx-stats-mainnet.fly.dev/tickers",
        });
      }
    } finally {
      window.clearTimeout(timer);
      if (refreshSol) setSyncing(false);
      setLoading(false);
      setUpdating(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!snapshot?.ok) {
      pollCountRef.current = 0;
      return;
    }
    if (!snapshot.stale && !snapshot.refreshing) {
      pollCountRef.current = 0;
      return;
    }
    if (pollCountRef.current >= MAX_STALE_POLLS) return;
    const id = window.setTimeout(() => {
      pollCountRef.current += 1;
      void load({ quiet: true });
    }, STALE_POLL_MS);
    return () => window.clearTimeout(id);
  }, [snapshot, load]);

  snapshotRef.current = snapshot;

  const tokens = snapshot && snapshot.ok ? snapshot.tokens : [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = tokens;
    if (hideDust) rows = rows.filter((token) => token.volume24hUsd >= MANIFEST_DUST_USD);
    if (q) {
      rows = rows.filter((token) => {
        if (token.symbol.toLowerCase().includes(q)) return true;
        if (token.baseMint.toLowerCase().includes(q)) return true;
        return token.markets.some(
          (market) =>
            market.quoteSymbol.toLowerCase().includes(q) ||
            market.tickerId.toLowerCase().includes(q),
        );
      });
    }
    const sorted = [...rows];
    sorted.sort((a, b) => {
      const dir = sort.desc ? -1 : 1;
      if (sort.key === "symbol") return dir * a.symbol.localeCompare(b.symbol);
      if (sort.key === "markets") return dir * (a.marketCount - b.marketCount);
      if (sort.key === "gap") {
        const ga = a.cexGap?.gapPct;
        const gb = b.cexGap?.gapPct;
        if (ga == null && gb == null) return a.symbol.localeCompare(b.symbol);
        if (ga == null) return 1;
        if (gb == null) return -1;
        return dir * (ga - gb);
      }
      const dv = a.volume24hUsd - b.volume24hUsd;
      if (dv !== 0) return dir * dv;
      return a.symbol.localeCompare(b.symbol);
    });
    return sorted;
  }, [tokens, search, hideDust, sort]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / MANIFEST_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(safePage * MANIFEST_PAGE_SIZE, (safePage + 1) * MANIFEST_PAGE_SIZE);

  useEffect(() => {
    setPage(0);
  }, [search, hideDust, sort]);

  const allPageOpen = pageRows.length > 0 && pageRows.every((token) => expanded.has(token.baseMint));

  const toggleToken = (mint: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(mint)) next.delete(mint);
      else next.add(mint);
      return next;
    });
  };

  const toggleAllOnPage = () => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (allPageOpen) {
        for (const token of pageRows) next.delete(token.baseMint);
      } else {
        for (const token of pageRows) next.add(token.baseMint);
      }
      return next;
    });
  };

  const expandedMarketIds = useMemo(
    () =>
      pageRows
        .filter((token) => expanded.has(token.baseMint))
        .flatMap((token) => token.markets.map((market) => market.tickerId)),
    [pageRows, expanded],
  );
  const getDepth = useManifestDepth(expandedMarketIds, Boolean(snapshot?.ok) && !loading && expandedMarketIds.length > 0);

  const toggleSort = (key: SortKey) => {
    setSort((prev) => (prev.key === key ? { key, desc: !prev.desc } : { key, desc: key !== "symbol" }));
  };
  const sortMark = (key: SortKey) => (sort.key === key ? (sort.desc ? "↓" : "↑") : "");

  const ok = snapshot?.ok === true;
  const stats = ok ? snapshot.stats : null;

  return (
    <div className="app-shell flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
      <AppHeader current="manifest">
        <button type="button" onClick={() => void load()} disabled={loading && !ok} className="btn-ghost">
          {loading && !ok ? "Memuat..." : "Muat ulang"}
        </button>
      </AppHeader>

      {snapshot && !snapshot.ok ? (
        <div className="border-b border-border bg-panel px-4 py-3 text-[13px] sm:px-5">
          <p className="font-medium text-foreground">API resmi Manifest sedang down.</p>
          <p className="mt-1 text-muted">
            {snapshot.error}
            {snapshot.status != null ? ` (HTTP ${snapshot.status})` : ""}. Sumber: {snapshot.source}. Belum ada
            snapshot tersimpan, jadi daftar tidak bisa ditampilkan. Coba lagi setelah API pulih.
          </p>
          <button type="button" className="btn-ghost mt-2" onClick={() => void load()} disabled={loading}>
            {loading ? "Memuat..." : "Coba lagi"}
          </button>
        </div>
      ) : null}

      {ok && snapshot.warning ? (
        <div className="border-b border-border bg-panel px-4 py-2 text-[13px] text-muted sm:px-5">{snapshot.warning}</div>
      ) : null}

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background p-3 sm:p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2 sm:gap-3">
          <h2 className="text-[15px] font-semibold leading-none">Manifest Trade</h2>
          {stats ? (
            <>
              <span className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-panel-2 px-2 text-[11px] text-muted">
                <span className="num font-medium text-foreground">{stats.tokens.toLocaleString("id-ID")}</span>
                token
              </span>
              <span className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-panel-2 px-2 text-[11px] text-muted">
                <span className="num font-medium text-foreground">{stats.keptMarkets.toLocaleString("id-ID")}</span>
                market
              </span>
              {stats.droppedStockMarkets > 0 ? (
                <span className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-panel-2 px-2 text-[11px] text-muted">
                  <span className="num font-medium text-foreground">{stats.droppedStockMarkets.toLocaleString("id-ID")}</span>
                  saham disaring
                </span>
              ) : null}
            </>
          ) : null}
          {ok && snapshot.stale ? (
            <span className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-panel-2 px-2 text-[11px] text-muted">
              Data lama · update <RelativeTime value={snapshot.fetchedAt} />
            </span>
          ) : null}
          {updating || (ok && snapshot.refreshing) ? (
            <span className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-panel-2 px-2 text-[11px] text-muted">
              Lagi update...
            </span>
          ) : null}
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Cari symbol, mint, atau quote..."
            className="w-full min-w-0 rounded-full border border-border bg-panel-2 py-1.5 px-3 text-[13px] text-foreground outline-none placeholder:text-muted focus:border-border-strong sm:w-64"
          />
          <label className="inline-flex items-center gap-2 text-[12px] text-muted">
            <input
              type="checkbox"
              checked={hideDust}
              onChange={(event) => setHideDust(event.target.checked)}
              className="accent-foreground"
            />
            Sembunyikan dust (&lt; {formatUsdCompact(MANIFEST_DUST_USD)})
          </label>
          <button
            type="button"
            className="btn-ghost"
            disabled={pageRows.length === 0}
            onClick={toggleAllOnPage}
          >
            {allPageOpen ? "Tutup semua" : "Buka semua"}
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={syncing || loading}
            onClick={() => void load({ refreshSol: true })}
          >
            {syncing ? "Menyinkronkan..." : "Sinkron SOL/USD"}
          </button>
          {ok && snapshot.solRate ? (
            <span className="text-[12px] text-muted">
              <span className="num font-medium text-foreground">{formatPrice(snapshot.solRate.price)}</span>
              {" USDT · "}
              {snapshot.solRate.source}
              {" · "}
              <RelativeTime value={snapshot.solRate.fetchedAt} />
            </span>
          ) : ok ? (
            <span className="text-[12px] text-muted">Kurs SOL/USDT belum tersedia</span>
          ) : null}
        </div>

        <p className="mb-3 max-w-4xl text-[12px] leading-snug text-muted">
          Satu baris per coin (mint dasar), tertutup default — klik untuk melihat kontrak market. Filter saham
          memakai nama/symbol resmi Manifest (xStock, Backpack Securities, Ondo Tokenized, suffix ticker ekuitas).
          Kolom gap CEX mencocokkan <span className="text-foreground">symbol saja</span> — bisa jadi token yang
          tidak terkait. Last/bid/ask pair non-USD (mis. quote SOL) ditampilkan dalam USDT; harga asli tetap
          terlihat di bawahnya. Tombol Sinkron SOL/USD mengambil kurs resmi terbaru.
        </p>

        <div className="tickers-scroll min-h-0 flex-1 overflow-auto">
          <table className="tickers-table w-full min-w-[52rem] border-separate border-spacing-0 text-left">
            <thead>
              <tr>
                <th style={{ width: "2rem" }} />
                <th>
                  <button type="button" onClick={() => toggleSort("symbol")} className="inline-flex items-center gap-1">
                    Token <span className="text-[10px] text-foreground">{sortMark("symbol")}</span>
                  </button>
                </th>
                <th>
                  <button type="button" onClick={() => toggleSort("markets")} className="inline-flex items-center gap-1">
                    Market <span className="text-[10px] text-foreground">{sortMark("markets")}</span>
                  </button>
                </th>
                <th className="text-right">
                  <button type="button" onClick={() => toggleSort("volume")} className="inline-flex w-full items-center justify-end gap-1">
                    Vol 24j <span className="text-[10px] text-foreground">{sortMark("volume")}</span>
                  </button>
                </th>
                <th className="text-right">USD</th>
                <th className="text-right">Spread</th>
                <th className="text-right">
                  <button type="button" onClick={() => toggleSort("gap")} className="inline-flex w-full items-center justify-end gap-1">
                    Gap CEX <span className="text-[10px] text-foreground">{sortMark("gap")}</span>
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {loading && !ok ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-muted">
                    Memuat data resmi Manifest…
                  </td>
                </tr>
              ) : pageRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-muted">
                    {ok
                      ? "Tidak ada token yang cocok."
                      : snapshot && !snapshot.ok
                        ? "API Manifest sedang down. Tidak ada snapshot cache untuk ditampilkan."
                        : "Tidak ada data."}
                  </td>
                </tr>
              ) : (
                pageRows.map((token) => (
                  <TokenBlock
                    key={token.baseMint}
                    token={token}
                    open={expanded.has(token.baseMint)}
                    onToggle={() => toggleToken(token.baseMint)}
                    getDepth={getDepth}
                    onOpenOrderBook={openOrderBook}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>

        {filtered.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted">
            <span>
              {safePage * MANIFEST_PAGE_SIZE + 1}–{Math.min(filtered.length, (safePage + 1) * MANIFEST_PAGE_SIZE)} dari{" "}
              {filtered.length.toLocaleString("id-ID")} token
              {hideDust && tokens.length !== filtered.length ? ` (dari ${tokens.length.toLocaleString("id-ID")} setelah filter saham)` : ""}
            </span>
            <div className="flex items-center gap-2">
              <button type="button" className="btn-ghost" disabled={safePage <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                Sebelumnya
              </button>
              <span>
                {safePage + 1} / {pageCount}
              </span>
              <button
                type="button"
                className="btn-ghost"
                disabled={safePage >= pageCount - 1}
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              >
                Berikutnya
              </button>
            </div>
          </div>
        ) : null}
      </main>
      {orderBookModal}
    </div>
  );
}

function TokenBlock({
  token,
  open,
  onToggle,
  getDepth,
  onOpenOrderBook,
}: {
  token: ManifestTokenGroup;
  open: boolean;
  onToggle: () => void;
  getDepth: (id: string) => DepthView;
  onOpenOrderBook: (input: { tickerId: string; baseSymbol: string; quoteSymbol: string }) => void;
}) {
  const gap = token.cexGap;
  const spread = bestSpreadPct(token);
  return (
    <>
      <tr
        className="manifest-token-row cursor-pointer"
        onClick={onToggle}
        aria-expanded={open}
      >
        <td className="w-8 text-center text-[11px] text-muted">
          <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        </td>
        <td className="sticky-coin">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-[13px] font-semibold text-foreground">{token.symbol}</span>
            <CopyMint mint={token.baseMint} />
          </div>
        </td>
        <td className="num">{token.marketCount}</td>
        <td className="num text-right">{formatUsdCompact(token.volume24hUsd)}</td>
        <td className="num text-right">{formatUsdPrice(token.priceUsd)}</td>
        <td className={`num text-right ${colorClass(spread)}`}>{formatPct(spread)}</td>
        <td className="num text-right">
          {gap ? (
            <span
              className={colorClass(Math.abs(gap.gapPct))}
              title={`Manifest ${formatUsdPrice(gap.manifestPriceUsd)} vs CEX ${formatUsdPrice(gap.cexPriceUsd)} · cocokkan symbol saja; bisa token yang berbeda`}
            >
              {gap.gapPct >= 0 ? "+" : ""}
              {formatPct(gap.gapPct)}
              <span className="ml-1 text-[10px] font-normal text-muted">
                {gap.spotUrl ? (
                  <a
                    href={gap.spotUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted underline-offset-2 hover:text-foreground hover:underline"
                    title={`Buka ${gap.symbol}/${gap.quote} di ${gap.exchange}`}
                    onClick={(event) => event.stopPropagation()}
                  >
                    {gap.exchange}
                  </a>
                ) : (
                  gap.exchange
                )}{" "}
                {gap.quote} {formatUsdPrice(gap.cexPriceUsd)}
              </span>
            </span>
          ) : (
            <span className="muted">-</span>
          )}
        </td>
      </tr>
      {open ? (
        <tr className="manifest-markets-row">
          <td colSpan={7} className="!bg-background p-0">
            <div className="border-y border-border bg-panel px-3 py-2 pl-8">
              <table className="tickers-table w-full min-w-[60rem] border-separate border-spacing-0 text-left">
                <thead>
                  <tr>
                    <th>Kontrak</th>
                    <th>Quote</th>
                    <th className="text-right">Last</th>
                    <th className="text-right">USD</th>
                    <th className="text-right">Vol 24j</th>
                    <th className="text-right">Bid</th>
                    <th className="text-right">Ask</th>
                    <th className="text-right">Spread</th>
                    <th className="text-right">Liq</th>
                    <th className="text-right">Depth</th>
                    <th>Orderbook</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {token.markets.map((market) => (
                    <tr key={market.tickerId}>
                      <td>
                        <span className="num text-[12px] text-muted" title={market.tickerId}>
                          {shortMint(market.tickerId)}
                        </span>
                      </td>
                      <td className="font-medium">{market.quoteSymbol}</td>
                      <td className="text-right"><QuotePrice market={market} field="last" /></td>
                      <td className="num text-right">{formatUsdPrice(market.lastUsd)}</td>
                      <td className="num text-right">{formatUsdCompact(market.volume24hUsd)}</td>
                      <td className="text-right"><QuotePrice market={market} field="bid" /></td>
                      <td className="text-right"><QuotePrice market={market} field="ask" /></td>
                      <td className={`num text-right ${colorClass(market.spreadPct)}`}>{formatPct(market.spreadPct)}</td>
                      <td className="num text-right">{formatUsdCompact(market.liquidityUsd)}</td>
                      <td>
                        <DepthCell tickerId={market.tickerId} getDepth={getDepth} />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn-ghost !px-2 !py-0.5 !text-[11px]"
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpenOrderBook({
                              tickerId: market.tickerId,
                              baseSymbol: market.baseSymbol,
                              quoteSymbol: market.quoteSymbol,
                            });
                          }}
                        >
                          Orderbook
                        </button>
                      </td>
                      <td>
                        <a
                          href={market.tradeUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[12px] text-foreground underline-offset-2 hover:underline"
                          onClick={(event) => event.stopPropagation()}
                        >
                          Trade
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
