"use client";

import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { shortChainLabel } from "@/lib/contracts";
import { formatAmountCompact, formatPrice, formatUsdCompact } from "@/lib/format";
import {
  DEX_LABELS,
  DEX_SUPPORTED_CHAINS,
  isValidDexAddress,
  type DexPoolInfo,
  type DexPoolsResponse,
  type DexPoolsResult,
} from "@/lib/dex-pools-types";
import type { TokenContract } from "@/lib/types";

// ---------- konfigurasi antrian ----------
const DEX_FRESH_MS = 5 * 60_000;
const DEX_ERROR_MS = 60_000;
const DEX_NO_RPC_RECHECK_MS = 60_000;
const DEX_CONCURRENCY = 2;
const DEX_JOB_GAP_MS = 350;
const DEX_MAX_RETRIES = 3;
const DEX_STORAGE_KEY = "arbit-dex-pools-cache";
const DEX_MAX_STORED = 150;
const COMPARE_SETTINGS_KEY = "arbit.compare.settings.v4";

export type DexTarget = { chain: string; contract: string; hintUsd: number | null };

type DexEntry =
  | { status: "ok"; at: number; result: DexPoolsResult }
  | { status: "error"; at: number; error: string };

export type DexCellState =
  | { kind: "none"; reason: string }
  | { kind: "queued" }
  | { kind: "loading" }
  | { kind: "no-rpc"; error: string }
  | { kind: "error"; error: string }
  | { kind: "ok"; result: DexPoolsResult };

/** Pilih kontrak pertama yang chain-nya didukung (ERC20 = Ethereum, BEP20 = BSC, SOL = Solana). */
export function pickDexContract(contracts: TokenContract[] | null | undefined): { chain: string; contract: string } | null {
  if (!contracts?.length) return null;
  for (const item of contracts) {
    const chain = shortChainLabel(item.chain);
    if ((DEX_SUPPORTED_CHAINS as readonly string[]).includes(chain) && isValidDexAddress(chain, item.contract.trim())) {
      return { chain, contract: item.contract.trim() };
    }
  }
  return null;
}

function targetKey(chain: string, contract: string, sizeUsd: number): string {
  return `${chain}|${chain === "SOL" ? contract : contract.toLowerCase()}|${sizeUsd}`;
}

// ---------- store modul (dibagi semua sel) ----------
const cache = new Map<string, DexEntry>();
const loading = new Set<string>();
const queue: Array<{ key: string; target: DexTarget; sizeUsd: number; attempt: number }> = [];
const queuedKeys = new Set<string>();
const listeners = new Set<() => void>();
let running = 0;
let lastStart = 0;
/** RPC belum diisi, per chain (ETH_RPC_URL / BSC_RPC_URL). */
const noRpc = new Map<string, { error: string; at: number }>();
let hydrated = false;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

function emit() {
  for (const fn of listeners) fn();
}

function hydrate() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  try {
    const raw = window.localStorage.getItem(DEX_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, DexEntry>;
    const now = Date.now();
    for (const [key, entry] of Object.entries(parsed ?? {})) {
      if (entry?.status === "ok" && now - entry.at < DEX_FRESH_MS && entry.result) cache.set(key, entry);
    }
  } catch {
    // abaikan cache rusak
  }
}

function persist() {
  if (typeof window === "undefined") return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      const now = Date.now();
      const ok = [...cache.entries()]
        .filter(([, e]) => e.status === "ok" && now - e.at < DEX_FRESH_MS)
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, DEX_MAX_STORED);
      window.localStorage.setItem(DEX_STORAGE_KEY, JSON.stringify(Object.fromEntries(ok)));
    } catch {
      // storage penuh / diblokir
    }
  }, 300);
}

function isFresh(entry: DexEntry | undefined, now = Date.now()): boolean {
  if (!entry) return false;
  return now - entry.at < (entry.status === "ok" ? DEX_FRESH_MS : DEX_ERROR_MS);
}

function enqueue(target: DexTarget, sizeUsd: number, force = false) {
  const key = targetKey(target.chain, target.contract, sizeUsd);
  if (queuedKeys.has(key) || loading.has(key)) return;
  if (!force && isFresh(cache.get(key))) return;
  if (force) cache.delete(key);
  queue.push({ key, target, sizeUsd, attempt: 0 });
  queuedKeys.add(key);
}

function pump() {
  const now = Date.now();
  let i = 0;
  while (running < DEX_CONCURRENCY && i < queue.length) {
    const job = queue[i];
    const nr = noRpc.get(job.target.chain);
    if (nr && now - nr.at < DEX_NO_RPC_RECHECK_MS) {
      i += 1;
      continue;
    }
    queue.splice(i, 1);
    queuedKeys.delete(job.key);
    running += 1;
    loading.add(job.key);
    void runJob(job);
  }
  emit();
}

async function runJob(job: { key: string; target: DexTarget; sizeUsd: number; attempt: number }) {
  const wait = lastStart + DEX_JOB_GAP_MS - Date.now();
  lastStart = Math.max(Date.now(), lastStart + DEX_JOB_GAP_MS);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  let requeue = false;
  try {
    const response = await fetch("/api/dex-pools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        chain: job.target.chain,
        contract: job.target.contract,
        sizeUsd: job.sizeUsd,
        hintUsd: job.target.hintUsd,
      }),
    });
    if (response.status === 429 || response.status >= 500) {
      throw Object.assign(new Error(`HTTP ${response.status}`), { retryable: true });
    }
    const data = (await response.json().catch(() => null)) as DexPoolsResponse | null;
    if (!data) throw Object.assign(new Error("Respons kosong"), { retryable: true });
    if (data.ok) {
      noRpc.delete(job.target.chain);
      cache.set(job.key, { status: "ok", at: Date.now(), result: data.result });
      persist();
    } else if (data.code === "no-rpc") {
      noRpc.set(job.target.chain, { error: data.error, at: Date.now() });
      requeue = true; // tunggu RPC diisi, coba lagi nanti
    } else {
      const retryable = /429|rate|limit|timeout|HTTP 5/i.test(data.error);
      if (retryable && job.attempt < DEX_MAX_RETRIES) throw Object.assign(new Error(data.error), { retryable: true });
      cache.set(job.key, { status: "error", at: Date.now(), error: data.error });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = (error as { retryable?: boolean }).retryable || error instanceof TypeError;
    if (retryable && job.attempt < DEX_MAX_RETRIES) {
      const backoff = 1000 * 2 ** job.attempt;
      job.attempt += 1;
      loading.delete(job.key);
      running -= 1;
      emit();
      setTimeout(() => {
        if (!queuedKeys.has(job.key)) {
          queue.unshift(job);
          queuedKeys.add(job.key);
        }
        pump();
      }, backoff);
      return;
    }
    cache.set(job.key, { status: "error", at: Date.now(), error: message });
  } finally {
    if (loading.has(job.key)) {
      loading.delete(job.key);
      running -= 1;
    }
  }
  if (requeue && !queuedKeys.has(job.key)) {
    queue.push({ ...job, attempt: 0 });
    queuedKeys.add(job.key);
    setTimeout(pump, DEX_NO_RPC_RECHECK_MS + 50);
  }
  pump();
}

function readSizeUsd(): number {
  if (typeof window === "undefined") return 100;
  try {
    const raw = window.localStorage.getItem(COMPARE_SETTINGS_KEY);
    const parsed = raw ? (JSON.parse(raw) as { modalUsd?: unknown }) : null;
    const value = Number(parsed?.modalUsd);
    return Number.isFinite(value) && value > 0 ? value : 100;
  } catch {
    return 100;
  }
}

// ---------- hook + context ----------
export type DexLookup = {
  enabled: boolean;
  sizeUsd: number;
  get: (target: { chain: string; contract: string } | null) => DexCellState;
  refresh: (target: DexTarget) => void;
  progress: { total: number; done: number; pending: number };
};

const DexContext = createContext<DexLookup | null>(null);
export const DexPoolsProvider = DexContext.Provider;

export function useDexPools(targets: DexTarget[], enabled: boolean): DexLookup {
  hydrate();
  const [tick, setTick] = useState(0);
  const [sizeUsd, setSizeUsd] = useState(100);

  useEffect(() => {
    const sync = () => setSizeUsd(readSizeUsd());
    sync();
    window.addEventListener("storage", sync);
    window.addEventListener("focus", sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("focus", sync);
    };
  }, []);

  useEffect(() => {
    const fn = () => setTick((v) => v + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);

  const uniqueTargets = useMemo(() => {
    const seen = new Set<string>();
    const out: DexTarget[] = [];
    for (const t of targets) {
      const key = `${t.chain}|${t.contract.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    return out;
  }, [targets]);
  const signature = useMemo(() => uniqueTargets.map((t) => `${t.chain}|${t.contract.toLowerCase()}`).join(","), [uniqueTargets]);

  useEffect(() => {
    if (!enabled) return;
    // Antrian halaman baru menggantikan sisa antrian halaman lama.
    for (const job of queue.splice(0)) queuedKeys.delete(job.key);
    for (const t of uniqueTargets) enqueue(t, sizeUsd);
    pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, signature, sizeUsd]);

  const get = useCallback(
    (target: { chain: string; contract: string } | null): DexCellState => {
      void tick;
      if (!target) return { kind: "none", reason: "Tidak ada kontrak ERC20 / BEP20 / Solana" };
      const key = targetKey(target.chain, target.contract, sizeUsd);
      const entry = cache.get(key);
      if (entry?.status === "ok") return { kind: "ok", result: entry.result };
      if (loading.has(key)) return { kind: "loading" };
      const nr = noRpc.get(target.chain);
      if (nr) return { kind: "no-rpc", error: nr.error };
      if (queuedKeys.has(key)) return { kind: "queued" };
      if (entry?.status === "error") return { kind: "error", error: entry.error };
      return { kind: "queued" };
    },
    [tick, sizeUsd],
  );

  const refresh = useCallback(
    (target: DexTarget) => {
      enqueue(target, sizeUsd, true);
      const idx = queue.findIndex((j) => j.key === targetKey(target.chain, target.contract, sizeUsd));
      if (idx > 0) queue.unshift(...queue.splice(idx, 1));
      noRpc.delete(target.chain);
      pump();
    },
    [sizeUsd],
  );

  const progress = useMemo(() => {
    void tick;
    let done = 0;
    let pending = 0;
    for (const t of uniqueTargets) {
      const key = targetKey(t.chain, t.contract, sizeUsd);
      if (cache.has(key) && !loading.has(key)) done += 1;
      else pending += 1;
    }
    return { total: uniqueTargets.length, done, pending };
  }, [tick, uniqueTargets, sizeUsd]);

  return { enabled, sizeUsd, get, refresh, progress };
}

// ---------- tampilan ----------
function fmtPct(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

function shortAddr(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function CopyGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" style={{ display: "inline", verticalAlign: "-1px" }}>
      <path d="M4 4V2.5A1.5 1.5 0 0 1 5.5 1h8A1.5 1.5 0 0 1 15 2.5v8a1.5 1.5 0 0 1-1.5 1.5H12v1.5A1.5 1.5 0 0 1 10.5 15h-8A1.5 1.5 0 0 1 1 13.5v-8A1.5 1.5 0 0 1 2.5 4H4zm1.5 0h5A1.5 1.5 0 0 1 12 5.5v5h1.5V2.5h-8V4zM2.5 5.5v8h8v-8h-8z" />
    </svg>
  );
}

function CopyAddr({ address, label }: { address: string; label?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="dex-pop-addr"
      title={`${address} (klik untuk copy)`}
      onClick={async (event) => {
        event.stopPropagation();
        try {
          await navigator.clipboard.writeText(address);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1000);
        } catch {
          // abaikan
        }
      }}
    >
      {copied ? (label ? "✓" : "✓ copied") : label ?? shortAddr(address)}
    </button>
  );
}

/** Link halaman pool/DEX. Format yang tidak bisa diverifikasi -> explorer (Etherscan/BscScan/Solscan). */
function dexPoolUrl(p: DexPoolInfo, chain: string): string {
  if (p.dex === "univ3" || p.dex === "univ2") return `https://app.uniswap.org/explore/pools/ethereum/${p.pool}`;
  if (p.dex === "sushi") return `https://www.sushi.com/ethereum/pool/v2/${p.pool}`;
  if (p.dex === "balancer" && p.poolId) return `https://balancer.fi/pools/ethereum/v2/${p.poolId}`;
  if (p.dex === "orca") return `https://www.orca.so/pools/${p.pool}`;
  if (chain === "SOL") return `https://solscan.io/account/${p.pool}`;
  if (chain === "BEP20") return `https://bscscan.com/address/${p.pool}`;
  return `https://etherscan.io/address/${p.pool}`;
}

function tokenUrl(chain: string, address: string): string {
  if (chain === "SOL") return `https://solscan.io/token/${address}`;
  if (chain === "BEP20") return `https://bscscan.com/token/${address}`;
  return `https://etherscan.io/token/${address}`;
}

function cowSwapUrl(contract: string, buyToken: string): string {
  return `https://swap.cow.fi/#/1/swap/${contract}/${buyToken}`;
}

function ExtLink({ href, title, children }: { href: string; title?: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="dex-pop-link"
      title={title ?? href}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </a>
  );
}

function fmtUsdPrice(value: number | null | undefined): string {
  return value != null && Number.isFinite(value) ? `$${formatPrice(value)}` : "–";
}

function DexTooltip({ result }: { result: DexPoolsResult }) {
  const bestLabel = result.bestDex ? DEX_LABELS[result.bestDex] : "–";
  const chainName = result.chainName ?? (result.chain === "ERC20" ? "Ethereum" : result.chain);
  const hasCow = result.chain === "ERC20";
  return (
    <>
      <div className="dex-pop-head">
        <div className="dex-pop-title">
          DEX Pools · <b>{result.symbol ?? "?"}</b> · {chainName}
        </div>
        <span className="dex-pop-head-addr">
          <ExtLink href={tokenUrl(result.chain, result.contract)} title={`${result.contract} — buka di explorer`}>
            {shortAddr(result.contract)}
          </ExtLink>
          <CopyAddr address={result.contract} label={<CopyGlyph />} />
        </span>
      </div>
      <div className="dex-pop-summary">
        <div className="dex-pop-stat">
          <span className="dex-pop-stat-label">Best DEX</span>
          <span className="dex-pop-stat-value">
            {bestLabel}
            {result.bestExecUsd != null ? <span className="muted"> @ {fmtUsdPrice(result.bestExecUsd)}</span> : null}
          </span>
        </div>
        <div className="dex-pop-stat">
          <span className="dex-pop-stat-label">Gap antar DEX</span>
          <span className="dex-pop-stat-value">{result.gapPct != null ? `${result.gapPct.toFixed(2)}%` : "–"}</span>
        </div>
        {hasCow ? (
          <div className="dex-pop-stat">
            <span className="dex-pop-stat-label">Selisih vs CoW</span>
            <span className="dex-pop-stat-value">{fmtPct(result.vsCowPct)}</span>
          </div>
        ) : null}
        <div className="dex-pop-stat">
          <span className="dex-pop-stat-label">Ukuran trade (jual)</span>
          <span className="dex-pop-stat-value">{formatUsdCompact(result.sizeUsd)}</span>
        </div>
        {result.refUsd != null ? (
          <div className="dex-pop-stat">
            <span className="dex-pop-stat-label">Harga ref</span>
            <span className="dex-pop-stat-value" title={result.refSource ?? ""}>
              {fmtUsdPrice(result.refUsd)}
            </span>
          </div>
        ) : null}
      </div>
      <div className="dex-pop-body">
        <table className="dex-pop-table">
          <thead>
            <tr>
              <th>DEX</th>
              <th>Pair</th>
              <th>Pool</th>
              <th className="num">Fee</th>
              <th className="num">Reserve</th>
              <th className="num">Likuiditas</th>
              <th className="num">Harga eksekusi</th>
              <th className="num">Impact</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {result.pools.map((p) => (
              <tr
                key={`${p.dex}:${p.pool}:${p.pair}`}
                className={
                  p.untradeable
                    ? "is-untradeable"
                    : p.pool === result.bestPool && !p.note?.startsWith("router")
                      ? "is-best"
                      : ""
                }
              >
                <td>
                  <ExtLink href={dexPoolUrl(p, result.chain)} title={`Buka pool di ${DEX_LABELS[p.dex]}`}>
                    {DEX_LABELS[p.dex]} ↗
                  </ExtLink>
                </td>
                <td>
                  <span className="dex-pop-pair">{p.pair}</span>
                  <CopyAddr address={p.quoteToken} label={<CopyGlyph />} />
                </td>
                <td>
                  <ExtLink href={dexPoolUrl(p, result.chain)} title={`${p.pool} — buka pool di ${DEX_LABELS[p.dex]}`}>
                    {shortAddr(p.pool)}
                  </ExtLink>
                  <CopyAddr address={p.pool} label={<CopyGlyph />} />
                </td>
                <td className="num">{p.feePct != null ? `${p.feePct}%` : "–"}</td>
                <td className="num">
                  {p.reserveToken != null || p.reserveQuote != null ? (
                    <>
                      {formatAmountCompact(p.reserveToken)}
                      <span className="muted"> / </span>
                      {formatAmountCompact(p.reserveQuote)} <span className="muted">{p.quoteSymbol}</span>
                    </>
                  ) : (
                    "–"
                  )}
                </td>
                <td className="num">{p.liquidityUsd != null ? formatUsdCompact(p.liquidityUsd) : "–"}</td>
                <td className="num" title={p.execUsd == null && p.midUsd != null ? `Harga mid ${fmtUsdPrice(p.midUsd)}` : undefined}>
                  {p.execUsd != null ? (
                    fmtUsdPrice(p.execUsd)
                  ) : p.midUsd != null && !p.untradeable ? (
                    <span className="muted">mid {fmtUsdPrice(p.midUsd)}</span>
                  ) : (
                    "–"
                  )}
                </td>
                <td className={`num${p.impactPct != null && p.impactPct > 5 ? " down" : ""}`}>
                  {p.impactPct != null ? `${p.impactPct.toFixed(2)}%` : "–"}
                </td>
                <td title={p.note}>
                  {p.untradeable ? (
                    <span className="dex-pop-status is-bad">untradeable</span>
                  ) : (
                    <span className="dex-pop-status is-ok">OK</span>
                  )}
                  {p.note ? <span className="dex-pop-note">{p.note}</span> : null}
                </td>
              </tr>
            ))}
            {result.cow ? (
              <tr className={result.cow.ok ? "" : "is-untradeable"}>
                <td>
                  <ExtLink href={cowSwapUrl(result.contract, result.cow.buyToken)} title="Buka swap di CoW Swap">
                    CoW ↗
                  </ExtLink>
                </td>
                <td>
                  <span className="dex-pop-pair">
                    {result.symbol ?? "?"}/{result.cow.buyToken}
                  </span>
                </td>
                <td className="muted">—</td>
                <td className="num">–</td>
                <td className="num">–</td>
                <td className="num">–</td>
                <td className="num">{fmtUsdPrice(result.cow.execUsd)}</td>
                <td className="num">–</td>
                <td title={result.cow.error}>
                  {result.cow.ok ? (
                    <span className="dex-pop-status is-ok">✓ quote</span>
                  ) : (
                    <span className="dex-pop-status is-bad">✗ {result.cow.error ?? ""}</span>
                  )}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        {result.pools.length === 0 && !result.cow?.ok ? <div className="muted dex-pop-empty">Tidak ada pool yang cocok.</div> : null}
        {result.warnings.length ? <div className="muted dex-pop-empty">{result.warnings.join(" · ")}</div> : null}
      </div>
    </>
  );
}

const HIDE_DELAY_MS = 180;

export const DexPoolsCell = memo(function DexPoolsCell({
  contracts,
  hintUsd,
}: {
  contracts: TokenContract[] | null | undefined;
  hintUsd: number | null;
}) {
  const lookup = useContext(DexContext);
  const target = useMemo(() => pickDexContract(contracts), [contracts]);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef(0);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const state: DexCellState = lookup ? lookup.get(target) : { kind: "none", reason: "" };

  const place = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const w = popRef.current?.offsetWidth ?? 560;
    const h = popRef.current?.offsetHeight ?? 260;
    const below = rect.bottom + 6 + h <= window.innerHeight - 8;
    const top = below ? rect.bottom + 6 : Math.max(8, rect.top - 6 - h);
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - w - 8));
    setPos({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place, state.kind]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  if (!target || state.kind === "none") {
    return <span className="muted" title={target ? "" : "Tidak ada kontrak ERC20 / BEP20 / Solana"}>-</span>;
  }
  if (state.kind === "queued") return <span className="dex-status muted" title="Masuk antrian deteksi">antri…</span>;
  if (state.kind === "loading") return <span className="dex-status muted">memuat…</span>;
  if (state.kind === "no-rpc") return <span className="dex-status down" title={state.error}>RPC?</span>;
  if (state.kind === "error") {
    return (
      <button
        type="button"
        className="dex-status down"
        title={`${state.error} — klik untuk coba lagi`}
        onClick={() => lookup?.refresh({ ...target, hintUsd })}
      >
        error ↻
      </button>
    );
  }

  const result = state.result;
  if (result.dexes.length === 0 && result.pools.length === 0) {
    return <span className="muted" title={result.warnings.join(" · ") || "Tidak ada pool yang cocok"}>-</span>;
  }

  const show = () => {
    window.clearTimeout(hideTimer.current);
    setOpen(true);
  };
  const scheduleHide = () => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setOpen(false), HIDE_DELAY_MS);
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="dex-badges"
        onMouseEnter={show}
        onMouseLeave={scheduleHide}
        onFocus={show}
        onBlur={scheduleHide}
        onClick={() => setOpen((v) => !v)}
        aria-label="Detail DEX pools"
      >
        {result.dexes.length === 0 ? <span className="muted">-</span> : null}
        {result.dexes.map((dex) => (
          <span key={dex} className={`dex-badge dex-${dex}${dex === result.bestDex ? " is-best" : ""}`}>
            {DEX_LABELS[dex]}
            {dex === "cow" ? " ✓" : ""}
          </span>
        ))}
        {result.cow && !result.cow.ok && result.dexes.length > 0 ? <span className="dex-badge dex-cow is-off">CoW ✗</span> : null}
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={popRef}
              className="dex-pop"
              style={{ top: pos.top, left: pos.left }}
              onMouseEnter={show}
              onMouseLeave={scheduleHide}
            >
              <DexTooltip result={result} />
            </div>,
            document.body,
          )
        : null}
    </>
  );
});
