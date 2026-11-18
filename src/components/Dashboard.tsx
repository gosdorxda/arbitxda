"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppHeader } from "@/components/AppHeader";
import { ExchangeMarketBar } from "@/components/ExchangeMarketBar";
import { useOrderBook } from "@/components/OrderBookModal";
import { RelativeTime } from "@/components/RelativeTime";
import { TickersTable, type BlacklistEntry, type FavoriteEntry } from "@/components/TickersTable";
import type { EnrichStatus, TickerRow } from "@/lib/types";

type ExchangeStatus = {
  id: string;
  name: string;
  enabled: number;
  tickerCount: number;
  lastFetch: {
    id: number;
    exchange: string;
    started_at: string;
    finished_at: string | null;
    status: string;
    error_message: string | null;
    row_count: number | null;
  } | null;
};

type FetchJobStatus = "pending" | "running" | "success" | "error";

type FetchJobItem = {
  id: string;
  name: string;
  status: FetchJobStatus;
  rowCount: number | null;
  error: string | null;
};

type FetchJob = {
  items: FetchJobItem[];
  finished: boolean;
};

type ExchangeFetchResult = {
  exchange: string;
  status: string;
  rowCount: number;
  error: string | null;
};

async function postExchangeFetch(exchange: string): Promise<ExchangeFetchResult> {
  const response = await fetch(`/api/fetch?exchange=${encodeURIComponent(exchange)}`, {
    method: "POST",
    cache: "no-store",
  });
  const data = await response.json();
  const result = (data.results ?? [])[0] as ExchangeFetchResult | undefined;
  if (result) return result;
  return {
    exchange,
    status: "error",
    rowCount: 0,
    error: typeof data.error === "string" ? data.error : `Gagal fetch ${exchange}`,
  };
}

function patchFetchJob(items: FetchJobItem[], id: string, patch: Partial<FetchJobItem>): FetchJobItem[] {
  return items.map((item) => (item.id === id ? { ...item, ...patch } : item));
}

export function Dashboard() {
  const [exchanges, setExchanges] = useState<ExchangeStatus[]>([]);
  const [tickers, setTickers] = useState<TickerRow[]>([]);
  const [blacklist, setBlacklist] = useState<BlacklistEntry[]>([]);
  const [favorites, setFavorites] = useState<FavoriteEntry[]>([]);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [loadingTickers, setLoadingTickers] = useState(true);
  const [fetching, setFetching] = useState<string | null>(null);
  const [fetchJob, setFetchJob] = useState<FetchJob | null>(null);
  const fetchingLock = useRef(false);
  const fetchHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const { openOrderBook, orderBookModal } = useOrderBook();
  const [activeExchange, setActiveExchange] = useState<string | null>(null);
  const [enrichStatus, setEnrichStatus] = useState<EnrichStatus | null>(null);

  const loadStatus = useCallback(async () => {
    const response = await fetch("/api/status", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Gagal memuat status");
    setExchanges(data.exchanges ?? []);
  }, []);

  const loadTickers = useCallback(async () => {
    const response = await fetch("/api/tickers", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Gagal memuat ticker");
    setTickers(data.tickers ?? []);
    setBlacklist(Array.isArray(data.blacklist) ? data.blacklist : []);
    setFavorites(Array.isArray(data.favorites) ? data.favorites : []);
  }, []);

  const refreshAll = useCallback(async () => {
    setLoadingStatus(true);
    setLoadingTickers(true);
    try {
      await Promise.all([loadStatus(), loadTickers()]);
      setBanner(null);
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingStatus(false);
      setLoadingTickers(false);
    }
  }, [loadStatus, loadTickers]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    return () => {
      if (fetchHideTimer.current) clearTimeout(fetchHideTimer.current);
    };
  }, []);

  useEffect(() => {
    if (exchanges.length === 0) return;
    if (!activeExchange || !exchanges.some((item) => item.id === activeExchange)) {
      setActiveExchange(exchanges[0].id);
    }
  }, [exchanges, activeExchange]);

  useEffect(() => {
    if (!activeExchange) {
      setEnrichStatus(null);
      return;
    }
    let stopped = false;
    let statusTimer: ReturnType<typeof setInterval> | undefined;
    let tickersTimer: ReturnType<typeof setInterval> | undefined;
    let wasRunning = false;

    const stopTimers = () => {
      if (statusTimer) {
        clearInterval(statusTimer);
        statusTimer = undefined;
      }
      if (tickersTimer) {
        clearInterval(tickersTimer);
        tickersTimer = undefined;
      }
    };

    const poll = async () => {
      try {
        const response = await fetch(`/api/enrich-status?exchange=${encodeURIComponent(activeExchange)}`, {
          cache: "no-store",
        });
        const data = await response.json();
        if (stopped) return;
        const status = (data.status ?? null) as EnrichStatus | null;
        setEnrichStatus(status);
        const running = Boolean(status?.running);
        if (running && !statusTimer) {
          statusTimer = setInterval(() => {
            void poll();
          }, 2000);
          tickersTimer = setInterval(() => {
            void loadTickers();
          }, 5000);
        }
        if (!running) {
          stopTimers();
          if (wasRunning) void loadTickers();
        }
        wasRunning = running;
      } catch {
        // polling gagal diam-diam; interval berikutnya akan coba lagi
      }
    };

    void poll();
    return () => {
      stopped = true;
      stopTimers();
    };
  }, [activeExchange, fetching, loadTickers]);

  const active = exchanges.find((item) => item.id === activeExchange) ?? exchanges[0] ?? null;
  const visibleTickers = useMemo(
    () => (active ? tickers.filter((row) => row.exchange === active.id) : []),
    [tickers, active],
  );

  const runFetch = async (exchange: string) => {
    if (fetchingLock.current) return;
    fetchingLock.current = true;
    if (fetchHideTimer.current) {
      clearTimeout(fetchHideTimer.current);
      fetchHideTimer.current = null;
    }
    setBanner(null);

    if (exchange === "all") {
      if (exchanges.length === 0) {
        fetchingLock.current = false;
        setBanner("Belum ada exchange aktif.");
        return;
      }
      const items: FetchJobItem[] = exchanges.map((item) => ({
        id: item.id,
        name: item.name,
        status: "pending",
        rowCount: null,
        error: null,
      }));
      setFetching("all");
      setFetchJob({ items, finished: false });
      const results: ExchangeFetchResult[] = [];
      try {
        // Satu per satu, sama seperti server sebelumnya, supaya progress bar
        // naik tiap exchange selesai tanpa bikin Fetch Semua lebih lambat.
        for (const item of items) {
          setFetchJob((prev) => (prev ? { ...prev, items: patchFetchJob(prev.items, item.id, { status: "running" }) } : prev));
          try {
            const result = await postExchangeFetch(item.id);
            results.push(result);
            setFetchJob((prev) =>
              prev
                ? {
                    ...prev,
                    items: patchFetchJob(prev.items, item.id, {
                      status: result.status === "success" ? "success" : "error",
                      rowCount: result.rowCount,
                      error: result.error,
                    }),
                  }
                : prev,
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            results.push({ exchange: item.id, status: "error", rowCount: 0, error: message });
            setFetchJob((prev) =>
              prev
                ? {
                    ...prev,
                    items: patchFetchJob(prev.items, item.id, {
                      status: "error",
                      rowCount: 0,
                      error: message,
                    }),
                  }
                : prev,
            );
          }
          void Promise.all([loadStatus(), loadTickers()]).catch(() => undefined);
        }
        const failed = results.filter((item) => item.status !== "success");
        const ok = results.length - failed.length;
        const summary =
          failed.length === 0
            ? `Fetch selesai: ${ok} exchange berhasil`
            : `Fetch selesai: ${ok} berhasil, ${failed.length} gagal — ${failed
                .map((item) => `${item.exchange}${item.error ? ` (${item.error})` : ""}`)
                .join(", ")}`;
        setBanner(summary);
        setFetchJob((prev) => (prev ? { ...prev, finished: true } : prev));
        if (failed.length === 0) {
          fetchHideTimer.current = setTimeout(() => {
            setFetchJob(null);
            fetchHideTimer.current = null;
          }, 4000);
        }
      } finally {
        fetchingLock.current = false;
        setFetching(null);
      }
      return;
    }

    setFetching(exchange);
    try {
      const result = await postExchangeFetch(exchange);
      const summary =
        result.status === "success"
          ? `${result.exchange}: ${result.rowCount} pair`
          : `${result.exchange}: gagal${result.error ? ` (${result.error})` : ""}`;
      setBanner(summary);
      await Promise.all([loadStatus(), loadTickers()]);
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error));
    } finally {
      fetchingLock.current = false;
      setFetching(null);
    }
  };

  return (
    <div className="app-shell flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
      <AppHeader current="tabel">
        <button onClick={() => void refreshAll()} disabled={fetching !== null} className="btn-ghost">
          Muat ulang
        </button>
        <button
          onClick={() => void runFetch("all")}
          disabled={fetching !== null}
          className="btn-primary"
          aria-busy={fetching === "all"}
        >
          {fetching === "all" && fetchJob
            ? `Mengambil... ${fetchJob.items.filter((item) => item.status === "success" || item.status === "error").length}/${fetchJob.items.length}`
            : fetching === "all"
              ? "Mengambil..."
              : "Fetch semua"}
        </button>
      </AppHeader>

      {fetchJob ? (
        <FetchAllProgress
          job={fetchJob}
          onDismiss={() => {
            if (fetchHideTimer.current) {
              clearTimeout(fetchHideTimer.current);
              fetchHideTimer.current = null;
            }
            setFetchJob(null);
          }}
        />
      ) : banner ? (
        <div className="border-b border-border bg-panel px-4 py-2 text-[13px] text-muted sm:px-5">{banner}</div>
      ) : null}

      <ExchangeMarketBar
        loading={loadingStatus}
        totalCount={exchanges.reduce((sum, item) => sum + item.tickerCount, 0)}
        items={exchanges.map((exchange) => ({
          id: exchange.id,
          name: exchange.name,
          count: exchange.tickerCount,
          selected: active?.id === exchange.id,
          fetching:
            fetching === exchange.id ||
            (fetching === "all" && fetchJob?.items.some((item) => item.id === exchange.id && item.status === "running")),
          error: exchange.lastFetch?.status === "error",
          onSelect: () => setActiveExchange(exchange.id),
        }))}
      />

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background p-3 sm:p-4">
        {active ? (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <h2 className="text-[15px] font-semibold leading-none">{active.name}</h2>
              <StatusBadge status={active.lastFetch?.status} />
              <RelativeTime
                className="muted text-xs"
                prefix="Fetch terakhir: "
                value={active.lastFetch?.finished_at || active.lastFetch?.started_at}
              />
              <span className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-panel-2 px-2 text-[11px] text-muted">
                <span className="num font-medium text-foreground">
                  {active.tickerCount.toLocaleString("id-ID")}
                </span>
                pair
                {active.lastFetch?.row_count != null ? (
                  <span>· fetch {active.lastFetch.row_count.toLocaleString("id-ID")}</span>
                ) : null}
              </span>
              <EnrichProgress status={enrichStatus} />
              <button
                onClick={() => void runFetch(active.id)}
                disabled={fetching !== null}
                className="btn-primary ml-auto"
              >
                {fetching === active.id ? "Mengambil..." : `Fetch ${active.name}`}
              </button>
              {active.lastFetch?.error_message ? (
                <p className="down w-full text-xs">{active.lastFetch.error_message}</p>
              ) : null}
            </div>
            <TickersTable
              tickers={visibleTickers}
              allTickers={tickers}
              exchanges={exchanges.map((item) => ({ id: item.id, name: item.name }))}
              blacklist={blacklist}
              favorites={favorites}
              loading={loadingTickers}
              onOpenOrderBook={openOrderBook}
            />
          </>
        ) : (
          <p className="muted px-1 py-8 text-sm">Belum ada exchange aktif.</p>
        )}
      </main>

      {orderBookModal}
    </div>
  );
}

function shortWibTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toLocaleTimeString("id-ID", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })} WIB`;
}

function formatDuration(startedAt: string | null, finishedAt: string | null): string | null {
  if (!startedAt || !finishedAt) return null;
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} dtk`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} mnt ${rest} dtk` : `${minutes} mnt`;
}

function FetchAllProgress({ job, onDismiss }: { job: FetchJob; onDismiss: () => void }) {
  const total = job.items.length;
  const done = job.items.filter((item) => item.status === "success" || item.status === "error").length;
  const failed = job.items.filter((item) => item.status === "error").length;
  const running = job.items.find((item) => item.status === "running");
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const barWidth = job.finished ? 100 : percent;

  let statusLabel = "Menyiapkan...";
  if (job.finished) {
    statusLabel =
      failed > 0
        ? `Selesai · ${total - failed} berhasil, ${failed} gagal`
        : "Selesai · semua exchange berhasil";
  } else if (running) {
    statusLabel = `Sedang mengambil ${running.name}...`;
  } else if (done > 0) {
    statusLabel = "Menyiapkan exchange berikutnya...";
  }

  return (
    <div className="fetch-all-progress" role="status" aria-live="polite">
      <div className="fetch-all-progress-head">
        <span className="fetch-all-progress-count num">
          {done} / {total} exchange
        </span>
        <span className="fetch-all-progress-label">{statusLabel}</span>
        <span className="fetch-all-progress-pct num">{barWidth}%</span>
        {job.finished ? (
          <button type="button" className="fetch-all-progress-close" onClick={onDismiss}>
            Tutup
          </button>
        ) : null}
      </div>
      <div className="fetch-all-progress-track" aria-hidden="true">
        <div
          className={`fetch-all-progress-fill${failed > 0 ? " is-error" : ""}${job.finished && failed === 0 ? " is-done" : ""}`}
          style={{ width: `${barWidth}%` }}
        />
      </div>
      <div className="fetch-all-progress-pills">
        {job.items.map((item) => {
          const title =
            item.error ??
            (item.status === "success" && item.rowCount != null ? `${item.rowCount} pair` : item.name);
          return (
            <span key={item.id} className={`fetch-all-pill is-${item.status}`} title={title}>
              {item.name}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function EnrichProgress({ status }: { status: EnrichStatus | null }) {
  if (!status || (!status.running && !status.startedAt)) return null;
  const percent = status.total > 0 ? Math.min(100, Math.round((status.done / status.total) * 100)) : 0;
  const barWidth = !status.running && status.phase === "done" ? 100 : percent;
  let label = "";
  if (status.running && status.phase === "bidask") {
    label = `Mengisi bid/ask ${status.done}/${status.total}`;
  } else if (status.running && status.phase === "deposit") {
    label = `Mengisi status deposit ${status.done}/${status.total}`;
  } else if (!status.running && status.phase === "done") {
    const duration = formatDuration(status.startedAt, status.finishedAt);
    label = `Selesai · ${shortWibTime(status.finishedAt)}${duration ? ` (${duration})` : ""}`;
  } else if (status.running) {
    label = `Mengisi ${status.done}/${status.total}`;
  } else {
    return null;
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <div className="h-1 w-28 overflow-hidden rounded-full bg-border">
        <div className="h-full rounded-full bg-foreground transition-[width] duration-300" style={{ width: `${barWidth}%` }} />
      </div>
      <span className="text-[11px] text-muted">{label}</span>
      {status.errors > 0 ? <span className="text-[11px] text-down">{status.errors} gagal</span> : null}
    </div>
  );
}

function StatusBadge({ status }: { status?: string }) {
  if (!status) {
    return <span className="badge-neutral rounded-full px-2 py-0.5 text-[10px] uppercase">belum fetch</span>;
  }
  if (status === "success") {
    return <span className="badge-ok rounded-full px-2 py-0.5 text-[10px] uppercase">berhasil</span>;
  }
  if (status === "running") {
    return <span className="badge-neutral rounded-full px-2 py-0.5 text-[10px] uppercase text-foreground">berjalan</span>;
  }
  return <span className="badge-bad rounded-full px-2 py-0.5 text-[10px] uppercase">gagal</span>;
}
