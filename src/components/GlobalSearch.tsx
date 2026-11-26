"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useExchangeSettings } from "@/components/ExchangeSettings";
import { FundingIcons } from "@/components/FundingIcons";
import { formatPct, formatPrice, formatUsdCompact } from "@/lib/format";

type SearchHit = {
  exchange: string;
  exchangeName: string;
  base: string;
  quote: string;
  rawSymbol: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
  quoteVolume24h: number | null;
  change24hPct: number | null;
  depositEnabled: number | null;
  withdrawEnabled: number | null;
  chainstatusRaw: string | null;
  fetchedAt: string | null;
  stale: number | null;
  blacklisted: boolean;
  spotUrl: string | null;
};

const MIN_QUERY = 2;
const DEBOUNCE_MS = 250;

function pctClass(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "muted";
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "";
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

function ExternalLinkIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" className="shrink-0">
      <path
        fill="currentColor"
        d="M6.5 3a.75.75 0 0 0 0 1.5h3.69L3.22 11.47a.75.75 0 1 0 1.06 1.06L11.25 5.56v3.69a.75.75 0 0 0 1.5 0V3.75A.75.75 0 0 0 12 3H6.5z"
      />
    </svg>
  );
}

function openSpot(url: string | null) {
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

export function GlobalSearch() {
  const { isDisabled } = useExchangeSettings();
  const inputId = useId();
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SearchHit[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [pos, setPos] = useState({ top: 64, backdropTop: 56 });

  const trimmed = query.trim();
  const canSearch = trimmed.length >= MIN_QUERY;

  const updatePos = () => {
    const el = rootRef.current;
    const header = el?.closest("header");
    const headerBottom = header?.getBoundingClientRect().bottom ?? el?.getBoundingClientRect().bottom ?? 56;
    setPos({
      top: headerBottom + 10,
      backdropTop: headerBottom,
    });
  };

  useLayoutEffect(() => {
    if (!open) return;
    updatePos();
    const onResize = () => updatePos();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [open]);

  useEffect(() => {
    if (!canSearch) {
      abortRef.current?.abort();
      setResults([]);
      setLoading(false);
      setError(null);
      setActiveIndex(0);
      return;
    }

    const timer = window.setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setError(null);
      void fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, {
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (response) => {
          const data = await response.json();
          if (!response.ok || !data.ok) throw new Error(data.error || "Gagal mencari token");
          setResults(Array.isArray(data.results) ? data.results : []);
          setActiveIndex(0);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [canSearch, trimmed]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      const panel = document.getElementById(listId);
      if (panel?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && open) {
        event.preventDefault();
        setOpen(false);
        return;
      }
      const target = event.target as HTMLElement | null;
      const typingInField =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !typingInField) {
        event.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
        updatePos();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [listId, open]);

  const showPanel = open && (canSearch || trimmed.length > 0);

  useEffect(() => {
    if (!showPanel) return;
    const panel = document.getElementById(listId);
    const row = panel?.querySelector("tr.is-active");
    if (row instanceof HTMLElement) row.scrollIntoView({ block: "nearest" });
  }, [activeIndex, listId, showPanel]);

  const visibleResults = results.filter((hit) => !isDisabled(hit.exchange));

  const commitActive = () => {
    const hit = visibleResults[activeIndex] ?? visibleResults[0];
    if (!hit) return;
    openSpot(hit.spotUrl);
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (open) {
        setOpen(false);
        return;
      }
      inputRef.current?.blur();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        updatePos();
        return;
      }
      if (visibleResults.length === 0) return;
      setActiveIndex((index) => (index + 1) % visibleResults.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (visibleResults.length === 0) return;
      setActiveIndex((index) => (index - 1 + visibleResults.length) % visibleResults.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        updatePos();
        return;
      }
      commitActive();
    }
  };

  const clearQuery = () => {
    abortRef.current?.abort();
    setQuery("");
    setResults([]);
    setError(null);
    setLoading(false);
    setActiveIndex(0);
    inputRef.current?.focus();
    setOpen(true);
  };

  return (
    <div ref={rootRef} className="global-search">
      <label className="global-search-field" htmlFor={inputId}>
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center">
          <SearchIcon />
        </span>
        <input
          id={inputId}
          ref={inputRef}
          type="search"
          value={query}
          autoComplete="off"
          spellCheck={false}
          placeholder="Cari token / symbol..."
          aria-label="Cari token atau symbol di semua exchange"
          aria-expanded={showPanel}
          aria-controls={listId}
          aria-autocomplete="list"
          role="combobox"
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            updatePos();
          }}
          onFocus={() => {
            setOpen(true);
            updatePos();
          }}
          onKeyDown={onInputKeyDown}
          className="global-search-input"
        />
        {query ? (
          <button
            type="button"
            className="global-search-clear"
            onClick={clearQuery}
            aria-label="Hapus pencarian"
          >
            ×
          </button>
        ) : (
          <kbd className="global-search-hint">/</kbd>
        )}
      </label>

      {showPanel && typeof document !== "undefined"
        ? createPortal(
            <div className="global-search-layer" role="presentation">
              <button
                type="button"
                className="global-search-backdrop"
                style={{ top: pos.backdropTop }}
                aria-label="Tutup pencarian"
                onClick={() => setOpen(false)}
              />
              <div
                id={listId}
                className="global-search-panel"
                style={{ top: pos.top }}
                role="listbox"
                aria-label="Hasil pencarian token"
              >
              <div className="global-search-panel-head">
                <div>
                  <div className="global-search-panel-title">Hasil pencarian</div>
                  <div className="muted text-[11px]">
                    {canSearch ? `Token atau symbol “${trimmed}” di semua exchange` : `Ketik minimal ${MIN_QUERY} huruf`}
                  </div>
                </div>
                <button
                  type="button"
                  className="global-search-panel-close"
                  onClick={() => setOpen(false)}
                  aria-label="Tutup hasil pencarian"
                >
                  ×
                </button>
              </div>
              {!canSearch ? (
                <p className="muted px-3 py-3 text-[13px]">Ketik minimal {MIN_QUERY} huruf untuk mencari di semua exchange.</p>
              ) : error ? (
                <p className="px-3 py-3 text-[13px] text-foreground">{error}</p>
              ) : !loading && visibleResults.length === 0 ? (
                <p className="muted px-3 py-3 text-[13px]">Tidak ada pair yang cocok untuk “{trimmed}”.</p>
              ) : (
                <div className="global-search-scroll">
                  <table className="global-search-table">
                    <thead>
                      <tr>
                        <th>Exchange</th>
                        <th>Pair</th>
                        <th className="num">Last</th>
                        <th className="num">Bid / Ask</th>
                        <th className="num">Vol USD 24h</th>
                        <th className="num">24h %</th>
                        <th>Depo/WD</th>
                        <th className="global-search-link-col" />
                      </tr>
                    </thead>
                    <tbody>
                      {visibleResults.map((hit, index) => {
                        const active = index === activeIndex;
                        const pair = `${hit.base}/${hit.quote}`;
                        return (
                          <tr
                            key={`${hit.exchange}-${hit.rawSymbol}`}
                            role="option"
                            aria-selected={active}
                            className={active ? "is-active" : undefined}
                            onMouseEnter={() => setActiveIndex(index)}
                            onClick={() => openSpot(hit.spotUrl)}
                          >
                            <td>
                              <div className="flex items-center gap-1.5">
                                <span>{hit.exchangeName}</span>
                                {hit.blacklisted ? (
                                  <span className="badge-neutral inline-flex rounded px-1 py-0.5 text-[10px] font-medium leading-tight">
                                    Blacklist
                                  </span>
                                ) : null}
                                {hit.stale === 1 ? (
                                  <span className="badge-warn inline-flex rounded px-1 py-0.5 text-[10px] font-medium leading-tight">
                                    Stale
                                  </span>
                                ) : null}
                              </div>
                            </td>
                            <td className="font-medium">{pair}</td>
                            <td className="num">{formatPrice(hit.last)}</td>
                            <td className="num whitespace-nowrap">
                              {formatPrice(hit.bid)}
                              <span className="muted"> / </span>
                              {formatPrice(hit.ask)}
                            </td>
                            <td className="num">{formatUsdCompact(hit.quoteVolume24h)}</td>
                            <td className={`num ${pctClass(hit.change24hPct)}`}>{formatPct(hit.change24hPct)}</td>
                            <td>
                              <FundingIcons
                                depositEnabled={hit.depositEnabled}
                                withdrawEnabled={hit.withdrawEnabled}
                                chainstatusRaw={hit.chainstatusRaw}
                              />
                            </td>
                            <td className="global-search-link-col">
                              {hit.spotUrl ? (
                                <a
                                  href={hit.spotUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="global-search-link"
                                  title={`Buka ${pair} di ${hit.exchangeName}`}
                                  aria-label={`Buka ${pair} di ${hit.exchangeName}`}
                                  onClick={(event) => event.stopPropagation()}
                                >
                                  <ExternalLinkIcon />
                                </a>
                              ) : (
                                <span className="muted">-</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {canSearch ? (
                <div className="global-search-footer muted">
                  {loading ? "Mencari..." : `${visibleResults.length} hasil`}
                  <span className="ml-2 hidden sm:inline">Enter buka spot · Esc tutup</span>
                </div>
              ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
