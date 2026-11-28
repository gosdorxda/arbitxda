"use client";

import { useMemo, useState } from "react";
import { AppHeader } from "@/components/AppHeader";
import { DexTooltip, useDexPools, type DexTarget } from "@/components/DexPoolsCell";
import { isValidDexAddress } from "@/lib/dex-pools-types";

type ChainOption = { key: "ERC20" | "BEP20" | "SOL"; label: string };

const CHAINS: ChainOption[] = [
  { key: "ERC20", label: "Ethereum" },
  { key: "BEP20", label: "BSC" },
  { key: "SOL", label: "Solana" },
];

const FIELD =
  "rounded-md border border-border-strong bg-panel-2 px-2.5 text-[13px] text-foreground outline-none focus:border-foreground";

type Entry = { chain: string; contract: string; label: string };

function parseLines(text: string, chain: string): { entries: Entry[]; invalid: string[] } {
  const seen = new Set<string>();
  const entries: Entry[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\n,;]+/)) {
    // baris boleh "0xabc... LABEL" -> token pertama = alamat, sisanya label per baris
    const [addr, ...rest] = raw.trim().split(/\s+/);
    if (!addr) continue;
    if (!isValidDexAddress(chain, addr)) {
      invalid.push(addr);
      continue;
    }
    const key = chain === "SOL" ? addr : addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ chain, contract: addr, label: rest.join(" ") });
  }
  return { entries, invalid };
}

function PoolBlock({
  entry,
  symbolLabel,
  lookup,
}: {
  entry: Entry;
  symbolLabel: string;
  lookup: ReturnType<typeof useDexPools>;
}) {
  const state = lookup.get(entry);
  const label = entry.label || symbolLabel;
  const chainName = CHAINS.find((c) => c.key === entry.chain)?.label ?? entry.chain;
  const target: DexTarget = { chain: entry.chain, contract: entry.contract, hintUsd: null };
  return (
    <section className="pool-block">
      <div className="pool-block-head">
        <span className="pool-block-label">{label || "—"}</span>
        <span className="pool-block-chain">{chainName}</span>
        <code className="pool-block-addr" title={entry.contract}>
          {entry.contract}
        </code>
        <button type="button" className="btn-ghost pool-block-refresh" onClick={() => lookup.refresh(target)}>
          Muat ulang
        </button>
      </div>
      {state.kind === "ok" ? (
        state.result.pools.length === 0 && !state.result.cow ? (
          <div className="pool-block-msg muted">
            Tidak ada pool yang cocok.{state.result.warnings.length ? ` ${state.result.warnings.join(" · ")}` : ""}
          </div>
        ) : (
          <div className="dex-pop dex-pop-inline">
            <DexTooltip result={state.result} hintUsd={null} />
          </div>
        )
      ) : state.kind === "queued" ? (
        <div className="pool-block-msg muted">antri…</div>
      ) : state.kind === "loading" ? (
        <div className="pool-block-msg muted">memuat…</div>
      ) : state.kind === "no-rpc" ? (
        <div className="pool-block-msg down">{state.error}</div>
      ) : state.kind === "error" ? (
        <div className="pool-block-msg down">{state.error}</div>
      ) : (
        <div className="pool-block-msg muted">–</div>
      )}
    </section>
  );
}

export function PoolPage() {
  const [text, setText] = useState("");
  const [chain, setChain] = useState<ChainOption["key"]>("ERC20");
  const [symbol, setSymbol] = useState("");
  const [targets, setTargets] = useState<Entry[]>([]);
  const [symbolLabel, setSymbolLabel] = useState("");
  const [invalid, setInvalid] = useState<string[]>([]);

  const dexTargets = useMemo<DexTarget[]>(
    () => targets.map((t) => ({ chain: t.chain, contract: t.contract, hintUsd: null })),
    [targets],
  );
  const lookup = useDexPools(dexTargets, targets.length > 0);

  const run = () => {
    const { entries, invalid: bad } = parseLines(text, chain);
    setInvalid(bad);
    setSymbolLabel(symbol.trim());
    setTargets(entries);
    // cek ulang kontrak yang sama (paksa data baru)
    for (const e of entries) lookup.refresh({ chain: e.chain, contract: e.contract, hintUsd: null });
  };

  const { done, total } = lookup.progress;

  return (
    <div className="app-shell flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
      <AppHeader current="pool" />
      <main className="min-h-0 flex-1 overflow-auto px-4 py-4 sm:px-5">
        <div className="mx-auto flex max-w-[1200px] flex-col gap-4">
          <div className="pool-form">
            <div className="flex flex-wrap items-end gap-3">
              <label className="block">
                <span className="muted mb-1 block text-[10px] uppercase tracking-wide">Chain</span>
                <select
                  value={chain}
                  onChange={(e) => setChain(e.target.value as ChainOption["key"])}
                  className={`${FIELD} h-8`}
                >
                  {CHAINS.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block min-w-[10rem]">
                <span className="muted mb-1 block text-[10px] uppercase tracking-wide">Simbol (opsional)</span>
                <input
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value)}
                  placeholder="mis. BIO"
                  className={`${FIELD} h-8 w-full`}
                />
              </label>
              <button type="button" className="btn-primary" onClick={run} disabled={!text.trim()}>
                Cek
              </button>
              {targets.length > 0 ? (
                <span className="muted text-[12px]">
                  {done}/{total} selesai
                </span>
              ) : null}
            </div>
            <label className="mt-3 block">
              <span className="muted mb-1 block text-[10px] uppercase tracking-wide">
                Kontrak (satu per baris; boleh ditambah label setelah spasi)
              </span>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) run();
                }}
                rows={5}
                spellCheck={false}
                placeholder={chain === "SOL" ? "Mint Solana, satu per baris" : "0x…, satu per baris"}
                className={`${FIELD} w-full py-2 font-mono`}
              />
            </label>
            <p className="muted mt-2 text-[11px]">
              Detail sama dengan tooltip DEX Pools. Ethereum/BSC butuh ETH_RPC_URL / BSC_RPC_URL di .env; Solana tanpa RPC.
              Ctrl+Enter = Cek.
            </p>
            {invalid.length > 0 ? (
              <p className="down mt-2 text-[12px]">
                Alamat tidak valid untuk chain ini (dilewati): {invalid.map((a) => (a.length > 20 ? `${a.slice(0, 10)}…` : a)).join(", ")}
              </p>
            ) : null}
          </div>

          {targets.length === 0 ? (
            <div className="muted text-[13px]">Paste kontrak di atas lalu klik Cek.</div>
          ) : (
            <div className="flex flex-col gap-4">
              {targets.map((t) => (
                <PoolBlock key={`${t.chain}|${t.contract}`} entry={t} symbolLabel={symbolLabel} lookup={lookup} />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
