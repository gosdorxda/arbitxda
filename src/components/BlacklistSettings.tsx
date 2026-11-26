"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { usePersistedState } from "@/lib/persist";

export const COIN_BLACKLIST_STORAGE_KEY = "arbit.coin-blacklist.v1";

export type CoinBlacklistEntry =
  | { kind: "coin"; coin: string }
  | { kind: "listing"; coin: string; exchange: string };

type BlacklistContextValue = {
  entries: CoinBlacklistEntry[];
  count: number;
  ready: boolean;
  isCoinBlocked: (coin: string) => boolean;
  isBlocked: (coin: string, exchangeId?: string) => boolean;
  addCoin: (coin: string) => boolean;
  addListing: (coin: string, exchangeId: string) => boolean;
  addFromInput: (raw: string) => { ok: boolean; error?: string };
  removeEntry: (entry: CoinBlacklistEntry) => void;
  clearAll: () => void;
};

const BlacklistContext = createContext<BlacklistContextValue | null>(null);

export function normalizeCoin(raw: string): string {
  return raw.trim().toUpperCase().replace(/^\$/, "");
}

export function normalizeExchangeId(raw: string): string {
  return raw.trim().toLowerCase();
}

export function blacklistEntryKey(entry: CoinBlacklistEntry): string {
  return entry.kind === "coin" ? `coin:${entry.coin}` : `listing:${entry.coin}@${entry.exchange}`;
}

export function parseBlacklistInput(raw: string): CoinBlacklistEntry | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const at = trimmed.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)[@\s]+([A-Za-z0-9][A-Za-z0-9._-]*)$/);
  if (at) {
    const coin = normalizeCoin(at[1] ?? "");
    const exchange = normalizeExchangeId(at[2] ?? "");
    if (!coin || !exchange) return null;
    return { kind: "listing", coin, exchange };
  }
  const coin = normalizeCoin(trimmed);
  if (!coin || !/^[A-Z0-9][A-Z0-9._-]*$/.test(coin)) return null;
  return { kind: "coin", coin };
}

function parseBlacklistEntries(raw: unknown): CoinBlacklistEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const out: CoinBlacklistEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const kind = row.kind === "listing" ? "listing" : row.kind === "coin" ? "coin" : null;
    const coin = typeof row.coin === "string" ? normalizeCoin(row.coin) : "";
    if (!kind || !coin) continue;
    const entry: CoinBlacklistEntry =
      kind === "listing"
        ? { kind: "listing", coin, exchange: normalizeExchangeId(String(row.exchange ?? "")) }
        : { kind: "coin", coin };
    if (entry.kind === "listing" && !entry.exchange) continue;
    const key = blacklistEntryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

export function BlacklistProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = usePersistedState<CoinBlacklistEntry[]>(
    COIN_BLACKLIST_STORAGE_KEY,
    [],
    parseBlacklistEntries,
  );
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(true);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== COIN_BLACKLIST_STORAGE_KEY) return;
      try {
        const parsed = event.newValue ? parseBlacklistEntries(JSON.parse(event.newValue)) : [];
        if (parsed) setEntries(parsed);
      } catch {
        // abaikan JSON rusak
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [setEntries]);

  const coinSet = useMemo(() => {
    const set = new Set<string>();
    for (const entry of entries) if (entry.kind === "coin") set.add(entry.coin);
    return set;
  }, [entries]);

  const listingSet = useMemo(() => {
    const set = new Set<string>();
    for (const entry of entries) {
      if (entry.kind === "listing") set.add(`${entry.coin}@${entry.exchange}`);
    }
    return set;
  }, [entries]);

  const isCoinBlocked = useCallback((coin: string) => coinSet.has(normalizeCoin(coin)), [coinSet]);

  const isBlocked = useCallback(
    (coin: string, exchangeId?: string) => {
      const base = normalizeCoin(coin);
      if (!base) return false;
      if (coinSet.has(base)) return true;
      const ex = exchangeId ? normalizeExchangeId(exchangeId) : "";
      if (!ex) return false;
      return listingSet.has(`${base}@${ex}`);
    },
    [coinSet, listingSet],
  );

  const addCoin = useCallback(
    (coin: string) => {
      const base = normalizeCoin(coin);
      if (!base) return false;
      setEntries((prev) => {
        if (prev.some((item) => item.kind === "coin" && item.coin === base)) return prev;
        const rest = prev.filter((item) => !(item.kind === "listing" && item.coin === base));
        return [...rest, { kind: "coin", coin: base }];
      });
      return true;
    },
    [setEntries],
  );

  const addListing = useCallback(
    (coin: string, exchangeId: string) => {
      const base = normalizeCoin(coin);
      const ex = normalizeExchangeId(exchangeId);
      if (!base || !ex) return false;
      setEntries((prev) => {
        if (prev.some((item) => item.kind === "coin" && item.coin === base)) return prev;
        if (prev.some((item) => item.kind === "listing" && item.coin === base && item.exchange === ex)) {
          return prev;
        }
        return [...prev, { kind: "listing", coin: base, exchange: ex }];
      });
      return true;
    },
    [setEntries],
  );

  const addFromInput = useCallback(
    (raw: string): { ok: boolean; error?: string } => {
      const parsed = parseBlacklistInput(raw);
      if (!parsed) return { ok: false, error: "Ketik coin (BTC) atau coin@exchange (BTC@gate)" };
      if (parsed.kind === "coin") addCoin(parsed.coin);
      else addListing(parsed.coin, parsed.exchange);
      return { ok: true };
    },
    [addCoin, addListing],
  );

  const removeEntry = useCallback(
    (entry: CoinBlacklistEntry) => {
      const key = blacklistEntryKey(entry);
      setEntries((prev) => prev.filter((item) => blacklistEntryKey(item) !== key));
    },
    [setEntries],
  );

  const clearAll = useCallback(() => setEntries([]), [setEntries]);

  const value = useMemo<BlacklistContextValue>(
    () => ({
      entries,
      count: entries.length,
      ready,
      isCoinBlocked,
      isBlocked,
      addCoin,
      addListing,
      addFromInput,
      removeEntry,
      clearAll,
    }),
    [entries, ready, isCoinBlocked, isBlocked, addCoin, addListing, addFromInput, removeEntry, clearAll],
  );

  return <BlacklistContext.Provider value={value}>{children}</BlacklistContext.Provider>;
}

const FALLBACK_CONTEXT: BlacklistContextValue = {
  entries: [],
  count: 0,
  ready: false,
  isCoinBlocked: () => false,
  isBlocked: () => false,
  addCoin: () => false,
  addListing: () => false,
  addFromInput: () => ({ ok: false }),
  removeEntry: () => undefined,
  clearAll: () => undefined,
};

export function useCoinBlacklist(): BlacklistContextValue {
  return useContext(BlacklistContext) ?? FALLBACK_CONTEXT;
}

function BanIcon({ size = 13 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 1.25A6.75 6.75 0 1 0 8 14.75 6.75 6.75 0 0 0 8 1.25zm4.69 3.44L4.69 12.69A5.25 5.25 0 0 1 3.31 11.31L11.31 3.31a5.25 5.25 0 0 1 1.38 1.38zM8 2.75a5.25 5.25 0 0 1 3.31 1.17L4 11.23A5.25 5.25 0 0 1 8 2.75z"
      />
    </svg>
  );
}

export function formatBlacklistLabel(
  entry: CoinBlacklistEntry,
  exchangeName?: string,
): string {
  if (entry.kind === "coin") return `${entry.coin} · semua exchange`;
  const name = (exchangeName || entry.exchange).trim();
  return `${entry.coin} di ${name}`;
}

export function BlacklistManager({
  compact = false,
  exchangeNames = {},
}: {
  compact?: boolean;
  exchangeNames?: Record<string, string>;
}) {
  const { entries, addFromInput, removeEntry, clearAll, count } = useCoinBlacklist();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const names = useMemo(() => {
    const map: Record<string, string> = {};
    for (const [id, name] of Object.entries(exchangeNames)) {
      map[id.toLowerCase()] = name || id;
    }
    return map;
  }, [exchangeNames]);

  const submit = () => {
    const result = addFromInput(draft);
    if (!result.ok) {
      setError(result.error ?? "Input tidak valid");
      return;
    }
    setDraft("");
    setError(null);
  };

  return (
    <div className={compact ? "" : "flex min-w-0 flex-col"}>
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            if (error) setError(null);
          }}
          placeholder="BTC atau BTC@gate"
          className="h-7 min-w-0 flex-1 rounded border border-border bg-panel-2 px-2 text-[12px] text-foreground placeholder:text-muted focus:border-border-strong focus:outline-none"
          aria-label="Tambah coin ke blacklist"
        />
        <button type="submit" className="btn-ghost !h-7 shrink-0 !px-2 text-[11px]">
          Tambah
        </button>
      </form>
      {error ? <p className="mt-1 text-[11px] text-[color:var(--down)]">{error}</p> : null}

      <div className={`mt-2 overflow-y-auto pr-0.5 ${compact ? "max-h-48" : "max-h-56"}`}>
        {entries.length === 0 ? (
          <p className="muted py-2 text-center text-[12px]">Belum ada coin di blacklist.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {entries.map((entry) => (
              <li
                key={blacklistEntryKey(entry)}
                className="flex items-center justify-between gap-2 rounded px-1 py-0.5 text-[12px] hover:bg-hover"
              >
                <span className="min-w-0 truncate text-foreground">
                  {formatBlacklistLabel(entry, entry.kind === "listing" ? names[entry.exchange] : undefined)}
                </span>
                <button
                  type="button"
                  className="btn-ghost !h-6 shrink-0 !px-1.5 !text-[11px]"
                  onClick={() => removeEntry(entry)}
                  title="Hapus dari blacklist"
                >
                  Hapus
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {count > 0 ? (
        <div className="mt-1 flex justify-end">
          <button type="button" className="btn-ghost !h-6 !px-1.5 !text-[11px]" onClick={clearAll}>
            Kosongkan
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function BlacklistPopoverButton({
  className = "",
  exchangeNames = {},
}: {
  className?: string;
  exchangeNames?: Record<string, string>;
}) {
  const { count } = useCoinBlacklist();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className={`relative ${className}`} ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`btn-ghost inline-flex h-8 items-center gap-1.5 !px-2.5 ${count > 0 ? "!border-warn/60 text-foreground" : ""}`}
        aria-expanded={open}
        aria-label="Blacklist coin"
        title="Kelola blacklist coin dan listing"
      >
        <BanIcon size={13} />
        <span className="text-[12px]">Blacklist</span>
        <span
          className={`num rounded px-1.5 py-0.5 text-[10px] leading-none ${
            count > 0 ? "bg-warn/20 text-warn" : "bg-panel-2 text-muted"
          }`}
        >
          {count}
        </span>
      </button>
      {open ? (
        <div
          className="absolute right-0 z-40 mt-1 w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-border bg-panel p-3 shadow-xl"
          role="dialog"
          aria-label="Blacklist coin"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[12px] font-semibold text-foreground">Blacklist</span>
            <span className="num text-[11px] text-muted">{count}</span>
          </div>
          <BlacklistManager compact exchangeNames={exchangeNames} />
        </div>
      ) : null}
    </div>
  );
}

export function BlacklistSettingsSection({
  exchangeNames = {},
}: {
  exchangeNames?: Record<string, string>;
}) {
  const { count } = useCoinBlacklist();
  return (
    <div className="exchange-settings-blacklist">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[12px] font-semibold text-foreground">Blacklist</span>
        <span className="num text-[11px] text-muted">{count}</span>
      </div>
      <p className="muted mb-2 text-[11px] leading-snug">
        Sembunyikan coin di semua exchange, atau hanya listing coin@exchange.
      </p>
      <BlacklistManager compact exchangeNames={exchangeNames} />
    </div>
  );
}

export function BlacklistRowButton({
  coin,
  listings,
}: {
  coin: string;
  listings: { id: string; name: string }[];
}) {
  const { addCoin, addListing } = useCoinBlacklist();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const uniqueListings = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>();
    for (const item of listings) {
      const id = normalizeExchangeId(item.id);
      if (!id || map.has(id)) continue;
      map.set(id, { id, name: item.name || item.id });
    }
    return [...map.values()];
  }, [listings]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (btnRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const toggle = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) {
      const width = 220;
      const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
      const top = rect.bottom + 4;
      setPos({ top, left });
    }
    setOpen((value) => !value);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="compare-bl-btn"
        title={`Blacklist ${coin}`}
        aria-label={`Blacklist ${coin}`}
        aria-expanded={open}
        onClick={toggle}
      >
        <BanIcon size={12} />
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              className="compare-bl-menu"
              style={{ top: pos.top, left: pos.left }}
              role="menu"
              aria-label={`Blacklist ${coin}`}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  addCoin(coin);
                  setOpen(false);
                }}
              >
                Sembunyikan {coin} (semua)
              </button>
              {uniqueListings.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    addListing(coin, item.id);
                    setOpen(false);
                  }}
                >
                  Sembunyikan {coin} di {item.name}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
