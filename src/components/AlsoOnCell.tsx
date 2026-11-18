"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FundingIcons } from "@/components/FundingIcons";
import type { AlsoOnPeer } from "@/lib/also-on";
import { getSpotUrl } from "@/lib/exchanges/spot-urls";
import { formatPct, formatPrice, formatUsdCompact } from "@/lib/format";

const POP_WIDTH = 420;
const HIDE_DELAY_MS = 160;
const COLUMNS_KEY = "arbit-also-on-columns";
const COLUMNS_EVENT = "arbit-also-on-columns";

const ALSO_ON_COLUMNS = [
  { id: "exchange", label: "Exchange", defaultOn: true, locked: true },
  { id: "symbol", label: "Symbol", defaultOn: false, locked: false },
  { id: "last", label: "Last", defaultOn: true, locked: false },
  { id: "bid", label: "Bid", defaultOn: false, locked: false },
  { id: "ask", label: "Ask", defaultOn: false, locked: false },
  { id: "gap", label: "Gap %", defaultOn: true, locked: false },
  { id: "volume", label: "Vol USD 24h", defaultOn: true, locked: false },
  { id: "change24h", label: "24h %", defaultOn: false, locked: false },
  { id: "spread", label: "Spread %", defaultOn: false, locked: false },
  { id: "funding", label: "Depo/WD", defaultOn: true, locked: false },
] as const;

type AlsoOnColumnId = (typeof ALSO_ON_COLUMNS)[number]["id"];
type AlsoOnColumnVisibility = Record<AlsoOnColumnId, boolean>;

const DEFAULT_COLUMNS: AlsoOnColumnVisibility = Object.fromEntries(
  ALSO_ON_COLUMNS.map((column) => [column.id, column.defaultOn]),
) as AlsoOnColumnVisibility;

function parseColumns(raw: unknown): AlsoOnColumnVisibility | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const next = { ...DEFAULT_COLUMNS };
  for (const column of ALSO_ON_COLUMNS) {
    const flag = value[column.id];
    if (typeof flag === "boolean") next[column.id] = flag;
  }
  next.exchange = true;
  return next;
}

function readStoredColumns(): AlsoOnColumnVisibility {
  try {
    const raw = window.localStorage.getItem(COLUMNS_KEY);
    if (raw) {
      const parsed = parseColumns(JSON.parse(raw));
      if (parsed) return parsed;
    }
  } catch {
    // storage rusak atau diblokir
  }
  return DEFAULT_COLUMNS;
}

function useAlsoOnColumns(): [AlsoOnColumnVisibility, (id: AlsoOnColumnId, visible: boolean) => void] {
  const [columns, setColumns] = useState<AlsoOnColumnVisibility>(DEFAULT_COLUMNS);

  useEffect(() => {
    setColumns(readStoredColumns());
    const onExternal = (event: Event) => {
      const detail = (event as CustomEvent<AlsoOnColumnVisibility>).detail;
      const parsed = parseColumns(detail);
      if (parsed) setColumns(parsed);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== COLUMNS_KEY) return;
      setColumns(readStoredColumns());
    };
    window.addEventListener(COLUMNS_EVENT, onExternal);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(COLUMNS_EVENT, onExternal);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const toggle = useCallback((id: AlsoOnColumnId, visible: boolean) => {
    setColumns((prev) => {
      const next = { ...prev, [id]: visible, exchange: true };
      try {
        window.localStorage.setItem(COLUMNS_KEY, JSON.stringify(next));
      } catch {
        // storage penuh atau diblokir
      }
      window.dispatchEvent(new CustomEvent(COLUMNS_EVENT, { detail: next }));
      return next;
    });
  }, []);

  return [columns, toggle];
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

function placePopover(anchor: DOMRect, popHeight: number, popWidth: number) {
  const gap = 8;
  const margin = 10;
  const placeAbove =
    anchor.bottom + gap + popHeight > window.innerHeight - margin && anchor.top > popHeight + gap + margin;
  const top = placeAbove
    ? Math.max(margin, anchor.top - gap - popHeight)
    : Math.min(window.innerHeight - margin - popHeight, anchor.bottom + gap);
  let left = anchor.left + anchor.width / 2 - popWidth / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - popWidth - margin));
  return { top, left, placeAbove };
}

function changeClass(value: number | null): string {
  if (value == null) return "muted";
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "muted";
}

type AlsoOnCellProps = {
  count: number;
  peers: AlsoOnPeer[];
};

export const AlsoOnCell = memo(function AlsoOnCell({ count, peers }: AlsoOnCellProps) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const colsRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number>(0);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [colsOpen, setColsOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, placeAbove: false });
  const [columns, toggleColumn] = useAlsoOnColumns();

  const clearHide = () => {
    if (hideTimer.current) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = 0;
    }
  };

  const updatePos = useCallback(() => {
    const button = btnRef.current;
    if (!button) return;
    const popWidth = popRef.current?.offsetWidth ?? POP_WIDTH;
    const popHeight = popRef.current?.offsetHeight ?? Math.min(320, 52 + peers.length * 28);
    setPos(placePopover(button.getBoundingClientRect(), popHeight, popWidth));
  }, [peers.length]);

  const show = () => {
    clearHide();
    setOpen(true);
  };

  const close = () => {
    clearHide();
    setPinned(false);
    setColsOpen(false);
    setOpen(false);
  };

  const scheduleHide = () => {
    if (pinned || colsOpen) return;
    clearHide();
    hideTimer.current = window.setTimeout(() => {
      setOpen(false);
      setColsOpen(false);
    }, HIDE_DELAY_MS);
  };

  useLayoutEffect(() => {
    if (!open) return;
    updatePos();
  }, [open, columns, colsOpen, updatePos]);

  useEffect(() => {
    if (!open) return;
    const onReposition = () => updatePos();
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open, updatePos]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (btnRef.current?.contains(target) || popRef.current?.contains(target) || colsRef.current?.contains(target)) {
        return;
      }
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (colsOpen) setColsOpen(false);
      else close();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, colsOpen]);

  useEffect(() => () => clearHide(), []);

  if (count <= 0) {
    return <span className="muted">-</span>;
  }

  const visibleColumns = ALSO_ON_COLUMNS.filter((column) => columns[column.id]);

  const popover =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={popRef}
            className="also-on-pop"
            data-pinned={pinned ? "1" : undefined}
            style={{ top: pos.top, left: pos.left }}
            onMouseEnter={() => {
              clearHide();
              setOpen(true);
            }}
            onMouseLeave={scheduleHide}
          >
            <div className="also-on-pop-head">
              <div className="also-on-pop-title">Ada di {count} exchange lain</div>
              <div className="also-on-pop-cols" ref={colsRef}>
                <button
                  type="button"
                  className="also-on-pop-cols-btn"
                  aria-expanded={colsOpen}
                  aria-haspopup="true"
                  onClick={(event) => {
                    event.stopPropagation();
                    event.preventDefault();
                    clearHide();
                    setPinned(true);
                    setColsOpen((value) => !value);
                  }}
                >
                  Kolom
                </button>
                {colsOpen ? (
                  <div className="also-on-pop-cols-menu" role="menu" aria-label="Kolom popover Ada di">
                    {ALSO_ON_COLUMNS.map((column) => (
                      <label
                        key={column.id}
                        className={`also-on-pop-cols-item${column.locked ? " is-locked" : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={columns[column.id]}
                          disabled={column.locked}
                          onChange={(event) => {
                            if (column.locked) return;
                            toggleColumn(column.id, event.target.checked);
                          }}
                        />
                        <span>{column.label}</span>
                      </label>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
            <div className="also-on-pop-body">
              <table className="also-on-pop-table">
                <thead>
                  <tr>
                    {visibleColumns.map((column) => (
                      <th key={column.id} className={column.id === "exchange" || column.id === "symbol" ? "" : "num"}>
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {peers.map((peer) => {
                    const spotUrl = getSpotUrl(peer.exchange, peer.base, peer.quote, peer.rawSymbol);
                    const pair = `${peer.base}/${peer.quote}`;
                    return (
                      <tr key={peer.exchange}>
                        {visibleColumns.map((column) => {
                          if (column.id === "exchange") {
                            return (
                              <td key={column.id} className="also-on-pop-ex">
                                <span className="also-on-pop-ex-name">{peer.exchangeName}</span>
                                {spotUrl ? (
                                  <a
                                    href={spotUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="also-on-pop-link"
                                    title={`Buka ${peer.exchangeName} di tab baru`}
                                    onClick={(event) => event.stopPropagation()}
                                  >
                                    <ExternalLinkIcon />
                                  </a>
                                ) : null}
                              </td>
                            );
                          }
                          if (column.id === "symbol") {
                            return (
                              <td key={column.id} className="also-on-pop-symbol">
                                {pair}
                              </td>
                            );
                          }
                          if (column.id === "last") {
                            return (
                              <td key={column.id} className="num">
                                {formatPrice(peer.last)}
                              </td>
                            );
                          }
                          if (column.id === "bid") {
                            return (
                              <td key={column.id} className="num">
                                {formatPrice(peer.bid)}
                              </td>
                            );
                          }
                          if (column.id === "ask") {
                            return (
                              <td key={column.id} className="num">
                                {formatPrice(peer.ask)}
                              </td>
                            );
                          }
                          if (column.id === "gap") {
                            return (
                              <td key={column.id} className={`num ${changeClass(peer.gapPct)}`}>
                                {formatPct(peer.gapPct)}
                              </td>
                            );
                          }
                          if (column.id === "volume") {
                            return (
                              <td key={column.id} className="num">
                                {formatUsdCompact(peer.quoteVolume24h)}
                              </td>
                            );
                          }
                          if (column.id === "change24h") {
                            return (
                              <td key={column.id} className={`num ${changeClass(peer.change24hPct)}`}>
                                {formatPct(peer.change24hPct)}
                              </td>
                            );
                          }
                          if (column.id === "spread") {
                            return (
                              <td key={column.id} className="num">
                                {formatPct(peer.spreadPct)}
                              </td>
                            );
                          }
                          return (
                            <td key={column.id}>
                              <span className="also-on-pop-icons">
                                <FundingIcons
                                  depositEnabled={peer.depositEnabled}
                                  withdrawEnabled={peer.withdrawEnabled}
                                  chainstatusRaw={peer.chainstatusRaw}
                                />
                              </span>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="also-on-badge"
        aria-expanded={open}
        aria-label={`Ada di ${count} exchange lain`}
        onMouseEnter={show}
        onMouseLeave={scheduleHide}
        onClick={(event) => {
          event.stopPropagation();
          event.preventDefault();
          clearHide();
          if (pinned) {
            setPinned(false);
            setColsOpen(false);
            setOpen(false);
          } else {
            setPinned(true);
            setOpen(true);
          }
        }}
      >
        <span className="also-on-badge-count">{count}</span>
        <span className="also-on-badge-unit">ex</span>
      </button>
      {popover}
    </>
  );
});
