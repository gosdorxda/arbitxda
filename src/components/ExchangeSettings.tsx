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
import { sortByExchangeName } from "@/lib/format";
import { usePersistedState } from "@/lib/persist";

export const DISABLED_EXCHANGES_STORAGE_KEY = "arbit-disabled-exchanges";

export type ExchangeSettingOption = {
  id: string;
  name: string;
  count?: number;
};

type ExchangeSettingsContextValue = {
  allExchanges: ExchangeSettingOption[];
  disabledIds: Set<string>;
  disabledList: string[];
  ready: boolean;
  isDisabled: (id: string) => boolean;
  isEnabled: (id: string) => boolean;
  setExchangeEnabled: (id: string, enabled: boolean) => void;
  toggleExchange: (id: string) => void;
  enableAll: () => void;
  disableAll: () => void;
  syncExchanges: (list: ExchangeSettingOption[]) => void;
};

const ExchangeSettingsContext = createContext<ExchangeSettingsContextValue | null>(null);

function parseDisabledList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const id = item.trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function ExchangeSettingsProvider({ children }: { children: ReactNode }) {
  const [disabledList, setDisabledList] = usePersistedState<string[]>(
    DISABLED_EXCHANGES_STORAGE_KEY,
    [],
    parseDisabledList,
  );
  const [allExchanges, setAllExchanges] = useState<ExchangeSettingOption[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(true);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== DISABLED_EXCHANGES_STORAGE_KEY) return;
      try {
        const parsed = event.newValue ? parseDisabledList(JSON.parse(event.newValue)) : [];
        if (parsed) setDisabledList(parsed);
      } catch {
        // abaikan JSON rusak
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [setDisabledList]);

  const syncExchanges = useCallback((list: ExchangeSettingOption[]) => {
    const map = new Map<string, ExchangeSettingOption>();
    for (const item of list) {
      const id = item.id.trim().toLowerCase();
      if (!id) continue;
      map.set(id, {
        id,
        name: (item.name || item.id).trim(),
        count: typeof item.count === "number" ? item.count : undefined,
      });
    }
    const sorted = sortByExchangeName([...map.values()], (item) => item.name || item.id);
    setAllExchanges((prev) => {
      if (
        prev.length === sorted.length &&
        prev.every(
          (item, index) =>
            item.id === sorted[index]!.id &&
            item.name === sorted[index]!.name &&
            item.count === sorted[index]!.count,
        )
      ) {
        return prev;
      }
      return sorted;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/status", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || !data?.ok || !Array.isArray(data.exchanges)) return;
        const list: ExchangeSettingOption[] = data.exchanges
          .filter((item: { enabled?: number }) => item.enabled !== 0)
          .map((item: { id: string; name?: string; tickerCount?: number }) => ({
            id: item.id,
            name: item.name || item.id,
            count: typeof item.tickerCount === "number" ? item.tickerCount : undefined,
          }));
        syncExchanges(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [syncExchanges]);

  const disabledIds = useMemo(() => new Set(disabledList.map((id) => id.toLowerCase())), [disabledList]);

  const isDisabled = useCallback(
    (id: string) => disabledIds.has(id.trim().toLowerCase()),
    [disabledIds],
  );

  const isEnabled = useCallback(
    (id: string) => !disabledIds.has(id.trim().toLowerCase()),
    [disabledIds],
  );

  const setExchangeEnabled = useCallback(
    (id: string, enabled: boolean) => {
      const norm = id.trim().toLowerCase();
      if (!norm) return;
      setDisabledList((prev) => {
        const has = prev.includes(norm);
        if (enabled) return has ? prev.filter((item) => item !== norm) : prev;
        return has ? prev : [...prev, norm];
      });
    },
    [setDisabledList],
  );

  const toggleExchange = useCallback(
    (id: string) => {
      const norm = id.trim().toLowerCase();
      if (!norm) return;
      setDisabledList((prev) =>
        prev.includes(norm) ? prev.filter((item) => item !== norm) : [...prev, norm],
      );
    },
    [setDisabledList],
  );

  const enableAll = useCallback(() => {
    setDisabledList([]);
  }, [setDisabledList]);

  const disableAll = useCallback(() => {
    setDisabledList((prev) => {
      if (allExchanges.length === 0) return prev;
      const allIds = allExchanges.map((item) => item.id.toLowerCase());
      return allIds;
    });
  }, [allExchanges, setDisabledList]);

  const value = useMemo<ExchangeSettingsContextValue>(
    () => ({
      allExchanges,
      disabledIds,
      disabledList,
      ready,
      isDisabled,
      isEnabled,
      setExchangeEnabled,
      toggleExchange,
      enableAll,
      disableAll,
      syncExchanges,
    }),
    [
      allExchanges,
      disabledIds,
      disabledList,
      ready,
      isDisabled,
      isEnabled,
      setExchangeEnabled,
      toggleExchange,
      enableAll,
      disableAll,
      syncExchanges,
    ],
  );

  return <ExchangeSettingsContext.Provider value={value}>{children}</ExchangeSettingsContext.Provider>;
}

const FALLBACK_CONTEXT: ExchangeSettingsContextValue = {
  allExchanges: [],
  disabledIds: new Set(),
  disabledList: [],
  ready: false,
  isDisabled: () => false,
  isEnabled: () => true,
  setExchangeEnabled: () => undefined,
  toggleExchange: () => undefined,
  enableAll: () => undefined,
  disableAll: () => undefined,
  syncExchanges: () => undefined,
};

export function useExchangeSettings(): ExchangeSettingsContextValue {
  return useContext(ExchangeSettingsContext) ?? FALLBACK_CONTEXT;
}

function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M7.1 1.5h1.8l.3 1.55c.36.1.7.24 1.02.42l1.3-.88 1.27 1.27-.88 1.3c.18.32.32.66.42 1.02l1.55.3v1.8l-1.55.3c-.1.36-.24.7-.42 1.02l.88 1.3-1.27 1.27-1.3-.88c-.32.18-.66.32-1.02.42l-.3 1.55H7.1l-.3-1.55a4.9 4.9 0 0 1-1.02-.42l-1.3.88-1.27-1.27.88-1.3a4.9 4.9 0 0 1-.42-1.02L2.12 8.9V7.1l1.55-.3c.1-.36.24-.7.42-1.02l-.88-1.3 1.27-1.27 1.3.88c.32-.18.66-.32 1.02-.42l.3-1.55zM8 10.25a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function ExchangeSettingsButton() {
  const { allExchanges, isDisabled, toggleExchange, enableAll, disableAll } = useExchangeSettings();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
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

  const total = allExchanges.length;
  const activeCount = useMemo(
    () => allExchanges.filter((item) => !isDisabled(item.id)).length,
    [allExchanges, isDisabled],
  );
  const hasDisabled = total > 0 && activeCount < total;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allExchanges;
    return allExchanges.filter(
      (item) => item.name.toLowerCase().includes(q) || item.id.toLowerCase().includes(q),
    );
  }, [allExchanges, search]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`btn-ghost inline-flex h-8 items-center gap-1.5 !px-2.5 ${
          hasDisabled ? "!border-warn/60 text-foreground" : ""
        }`}
        title={
          total > 0
            ? `Pengaturan market aktif (${activeCount}/${total})`
            : "Pengaturan market aktif"
        }
        aria-label="Pengaturan market aktif"
        aria-expanded={open}
      >
        <GearIcon />
        <span className="hidden text-[12px] sm:inline">Market</span>
        {total > 0 ? (
          <span
            className={`num rounded-full px-1.5 py-0.5 text-[10px] leading-none ${
              hasDisabled ? "bg-warn/20 text-warn" : "bg-panel-2 text-muted"
            }`}
          >
            {activeCount}/{total}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          className="exchange-settings-panel"
          role="dialog"
          aria-label="Pengaturan market aktif"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[12px] font-semibold text-foreground">Market aktif di UI</span>
            <span className="num text-[11px] text-muted">
              {activeCount}/{total}
            </span>
          </div>

          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Cari exchange..."
            className="mb-2 h-7 w-full rounded border border-border bg-panel-2 px-2 text-[12px] text-foreground placeholder:text-muted focus:border-border-strong focus:outline-none"
          />

          <div className="mb-2 flex items-center gap-1.5">
            <button
              type="button"
              onClick={enableAll}
              disabled={activeCount === total}
              className="btn-ghost !h-7 flex-1 !px-2 text-[11px]"
            >
              Pilih semua
            </button>
            <button
              type="button"
              onClick={disableAll}
              disabled={activeCount === 0}
              className="btn-ghost !h-7 flex-1 !px-2 text-[11px]"
            >
              Kosongkan
            </button>
          </div>

          <div className="max-h-64 overflow-y-auto pr-0.5">
            {filtered.length === 0 ? (
              <p className="muted py-3 text-center text-[12px]">
                {total === 0 ? "Memuat daftar exchange..." : "Tidak ada exchange cocok."}
              </p>
            ) : (
              filtered.map((item) => {
                const checked = !isDisabled(item.id);
                return (
                  <label
                    key={item.id}
                    className="flex cursor-pointer items-center justify-between gap-2 rounded px-1.5 py-1 text-[12px] hover:bg-hover"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleExchange(item.id)}
                        className="shrink-0"
                      />
                      <span className={`truncate ${checked ? "text-foreground" : "muted line-through"}`}>
                        {item.name}
                      </span>
                    </span>
                    {typeof item.count === "number" ? (
                      <span className="num muted shrink-0 text-[11px]">
                        {item.count.toLocaleString("id-ID")}
                      </span>
                    ) : null}
                  </label>
                );
              })
            )}
          </div>

          <p className="exchange-settings-foot">
            Hanya mengubah tampilan UI. File .env tidak diubah.
          </p>
        </div>
      ) : null}
    </div>
  );
}
