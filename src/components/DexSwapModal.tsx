"use client";

/**
 * Modal Swap langsung ke SATU pool DEX (tanpa routing) lewat MetaMask.
 * - Private key tidak pernah menyentuh app/server: transaksi dibangun di browser, user tanda tangan di MetaMask.
 * - Quote / allowance / saldo / estimasi gas dibaca server lewat RPC dari env (POST /api/dex-pools).
 * - Tidak ada pengiriman otomatis: Approve dan Confirm Swap harus diklik user, lalu ditandatangani di MetaMask.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserProvider, Interface, type Eip1193Provider } from "ethers";
import { DEX_LABELS, type DexPoolInfo, type DexSimSide } from "@/lib/dex-pools-types";
import {
  ADD_CHAIN_PARAMS,
  formatUnitsStr,
  getSwapDex,
  type SwapGasResponse,
  type SwapQuote,
  type SwapQuoteResponse,
} from "@/lib/dex-swap-types";

type Eip1193 = Eip1193Provider & {
  on?: (event: string, fn: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, fn: (...args: unknown[]) => void) => void;
};

declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}

export type DexSwapParams = {
  chain: string;
  contract: string;
  symbol: string | null;
  pool: DexPoolInfo;
};

const ERC20_IFACE = new Interface(["function approve(address spender, uint256 amount) returns (bool)"]);
const V2_IFACE = new Interface([
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
]);
const V3_IFACE = new Interface([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
]);
/** USDT Ethereum mewajibkan allowance di-reset ke 0 sebelum diubah ke nilai lain. */
const USDT_ETH = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const DEADLINE_SEC = 20 * 60;

// ---------- host tunggal (modal tetap hidup walau tooltip tertutup) ----------
let host: HTMLDivElement | null = null;
let root: Root | null = null;

export function openDexSwap(params: DexSwapParams) {
  if (typeof document === "undefined") return;
  if (!host) {
    host = document.createElement("div");
    host.className = "dex-swap-host";
    document.body.appendChild(host);
    root = createRoot(host);
  }
  root!.render(<DexSwapModal key={`${params.pool.dex}:${params.pool.pool}:${Date.now()}`} params={params} onClose={closeDexSwap} />);
}

export function closeDexSwap() {
  root?.render(<></>);
}

// ---------- helper ----------
async function api<T>(body: unknown): Promise<T> {
  const res = await fetch("/api/dex-pools", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as T | null;
  if (!json) throw new Error(`HTTP ${res.status}`);
  return json;
}

function errMsg(error: unknown): string {
  const e = error as { shortMessage?: string; reason?: string; info?: { error?: { message?: string } }; code?: unknown; message?: string };
  if (e?.code === "ACTION_REJECTED" || e?.code === 4001) return "Ditolak di MetaMask";
  return (e?.shortMessage || e?.reason || e?.info?.error?.message || e?.message || String(error)).slice(0, 200);
}

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

type TxState = { label: string; hash: string; status: "pending" | "success" | "failed"; error?: string };

function DexSwapModal({ params, onClose }: { params: DexSwapParams; onClose: () => void }) {
  const { chain, contract, pool } = params;
  const sw = getSwapDex(chain, pool.dex);
  const symbol = params.symbol ?? "TOKEN";
  const [side, setSide] = useState<DexSimSide>("sell");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState("0.5");
  const [account, setAccount] = useState<string | null>(null);
  const [walletChain, setWalletChain] = useState<string | null>(null);
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [gas, setGas] = useState<{ gas: string; gasPriceWei: string | null } | null>(null);
  const [gasErr, setGasErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [txs, setTxs] = useState<TxState[]>([]);
  const [ack, setAck] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const quoteSeq = useRef(0);

  const eth = typeof window !== "undefined" ? window.ethereum : undefined;
  const wrongChain = Boolean(account && sw && walletChain && walletChain.toLowerCase() !== sw.chain.chainIdHex);
  const slipPct = Number(slippage.replace(",", "."));
  const slipValid = Number.isFinite(slipPct) && slipPct >= 0 && slipPct <= 50;
  const tokenInLabel = side === "sell" ? symbol : pool.quoteSymbol;
  const tokenOutLabel = side === "sell" ? pool.quoteSymbol : symbol;

  // ---- wallet ----
  useEffect(() => {
    if (!eth) return;
    const onAccounts = (...args: unknown[]) => {
      const list = args[0] as string[] | undefined;
      setAccount(list && list.length ? list[0] : null);
    };
    const onChain = (...args: unknown[]) => setWalletChain(String(args[0]));
    void eth.request({ method: "eth_accounts" }).then((a) => onAccounts(a)).catch(() => undefined);
    void eth.request({ method: "eth_chainId" }).then((c) => onChain(c)).catch(() => undefined);
    eth.on?.("accountsChanged", onAccounts);
    eth.on?.("chainChanged", onChain);
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, [eth]);

  const connect = async () => {
    if (!eth) return;
    setActionErr(null);
    try {
      const list = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      setAccount(list?.[0] ?? null);
      setWalletChain(String(await eth.request({ method: "eth_chainId" })));
    } catch (error) {
      setActionErr(errMsg(error));
    }
  };

  const switchChain = async () => {
    if (!eth || !sw) return;
    setActionErr(null);
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: sw.chain.chainIdHex }] });
    } catch (error) {
      const code = (error as { code?: number; data?: { originalError?: { code?: number } } })?.code;
      const inner = (error as { data?: { originalError?: { code?: number } } })?.data?.originalError?.code;
      if ((code === 4902 || inner === 4902) && ADD_CHAIN_PARAMS[sw.chain.chainIdHex]) {
        try {
          await eth.request({ method: "wallet_addEthereumChain", params: [ADD_CHAIN_PARAMS[sw.chain.chainIdHex]] });
        } catch (addError) {
          setActionErr(errMsg(addError));
        }
      } else {
        setActionErr(errMsg(error));
      }
    }
  };

  // ---- quote (debounce) ----
  useEffect(() => {
    setQuote(null);
    setGas(null);
    setGasErr(null);
    setAck(false);
    const value = amount.trim();
    if (!value || !(Number(value.replace(",", ".")) > 0)) {
      setQuoteErr(null);
      return;
    }
    const seq = ++quoteSeq.current;
    const timer = window.setTimeout(async () => {
      setQuoting(true);
      try {
        const res = await api<SwapQuoteResponse>({
          mode: "swapquote",
          swap: {
            chain,
            contract,
            dex: pool.dex,
            pool: pool.pool,
            quoteToken: pool.quoteToken,
            feePct: pool.feePct,
            side,
            amount: value,
            owner: account,
          },
        });
        if (seq !== quoteSeq.current) return;
        if (res.ok) {
          setQuote(res.quote);
          setQuoteErr(null);
        } else {
          setQuoteErr(res.error);
        }
      } catch (error) {
        if (seq === quoteSeq.current) setQuoteErr(errMsg(error));
      } finally {
        if (seq === quoteSeq.current) setQuoting(false);
      }
    }, 450);
    return () => window.clearTimeout(timer);
  }, [amount, side, account, chain, contract, pool.dex, pool.pool, pool.quoteToken, pool.feePct, refreshTick]);

  const amountIn = quote ? BigInt(quote.amountInRaw) : null;
  const amountOut = quote ? BigInt(quote.amountOutRaw) : null;
  const minOut = useMemo(() => {
    if (amountOut == null || !slipValid) return null;
    const bps = BigInt(Math.round(slipPct * 100));
    return (amountOut * (BigInt(10_000) - bps)) / BigInt(10_000);
  }, [amountOut, slipPct, slipValid]);
  const needsApprove = Boolean(quote && account && quote.allowanceRaw != null && amountIn != null && BigInt(quote.allowanceRaw) < amountIn);
  const insufficient = Boolean(quote && quote.balanceRaw != null && amountIn != null && BigInt(quote.balanceRaw) < amountIn);

  const buildSwapData = useCallback(
    (q: SwapQuote, min: bigint, recipient: string): string => {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SEC);
      if (q.kind === "v2") {
        return V2_IFACE.encodeFunctionData("swapExactTokensForTokens", [
          BigInt(q.amountInRaw),
          min,
          [q.tokenIn.address, q.tokenOut.address],
          recipient,
          deadline,
        ]);
      }
      const inner = V3_IFACE.encodeFunctionData("exactInputSingle", [
        {
          tokenIn: q.tokenIn.address,
          tokenOut: q.tokenOut.address,
          fee: q.fee,
          recipient,
          amountIn: BigInt(q.amountInRaw),
          amountOutMinimum: min,
          sqrtPriceLimitX96: BigInt(0),
        },
      ]);
      return V3_IFACE.encodeFunctionData("multicall(uint256,bytes[])", [deadline, [inner]]);
    },
    [],
  );

  // ---- estimasi gas (server, RPC env) ----
  useEffect(() => {
    if (!quote || !account || minOut == null || needsApprove) {
      setGas(null);
      setGasErr(needsApprove ? "estimasi gas swap setelah approve" : null);
      return;
    }
    let cancelled = false;
    void api<SwapGasResponse>({
      mode: "swapgas",
      gas: { chain, from: account, to: quote.router, data: buildSwapData(quote, minOut, account) },
    })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setGas({ gas: res.gas, gasPriceWei: res.gasPriceWei });
          setGasErr(null);
        } else {
          setGas(null);
          setGasErr(res.error);
        }
      })
      .catch((error) => !cancelled && setGasErr(errMsg(error)));
    return () => {
      cancelled = true;
    };
  }, [quote, account, minOut, needsApprove, chain, buildSwapData]);

  const trackTx = async (label: string, hash: string, provider: BrowserProvider) => {
    setTxs((prev) => [{ label, hash, status: "pending" }, ...prev]);
    try {
      const receipt = await provider.waitForTransaction(hash);
      const ok = receipt?.status === 1;
      setTxs((prev) => prev.map((t) => (t.hash === hash ? { ...t, status: ok ? "success" : "failed" } : t)));
      return ok;
    } catch (error) {
      setTxs((prev) => prev.map((t) => (t.hash === hash ? { ...t, status: "failed", error: errMsg(error) } : t)));
      return false;
    }
  };

  const approve = async () => {
    if (!eth || !quote || !account || amountIn == null || wrongChain) return;
    setBusy("approve");
    setActionErr(null);
    try {
      const provider = new BrowserProvider(eth);
      const signer = await provider.getSigner();
      const current = quote.allowanceRaw != null ? BigInt(quote.allowanceRaw) : BigInt(0);
      if (quote.tokenIn.address.toLowerCase() === USDT_ETH && current > BigInt(0)) {
        const resetTx = await signer.sendTransaction({ to: quote.tokenIn.address, data: ERC20_IFACE.encodeFunctionData("approve", [quote.router, BigInt(0)]) });
        if (!(await trackTx("Reset allowance USDT", resetTx.hash, provider))) throw new Error("Reset allowance gagal");
      }
      // Approve PERSIS sebesar jumlah swap (bukan unlimited).
      const tx = await signer.sendTransaction({ to: quote.tokenIn.address, data: ERC20_IFACE.encodeFunctionData("approve", [quote.router, amountIn]) });
      await trackTx(`Approve ${quote.tokenIn.symbol}`, tx.hash, provider);
      setRefreshTick((v) => v + 1);
    } catch (error) {
      setActionErr(errMsg(error));
    } finally {
      setBusy(null);
    }
  };

  const confirmSwap = async () => {
    if (!eth || !quote || !account || minOut == null || wrongChain || !ack) return;
    setBusy("swap");
    setActionErr(null);
    try {
      const provider = new BrowserProvider(eth);
      const network = await provider.getNetwork();
      if (sw && Number(network.chainId) !== sw.chain.chainId) throw new Error(`Wallet bukan di ${sw.chain.name}`);
      const signer = await provider.getSigner();
      const from = await signer.getAddress();
      if (from.toLowerCase() !== account.toLowerCase()) throw new Error("Akun wallet berubah, cek ulang preview");
      const data = buildSwapData(quote, minOut, from);
      const tx = await signer.sendTransaction({ to: quote.router, data });
      await trackTx(`Swap ${quote.tokenIn.symbol} → ${quote.tokenOut.symbol}`, tx.hash, provider);
      setRefreshTick((v) => v + 1);
    } catch (error) {
      setActionErr(errMsg(error));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  if (!sw) return null;
  const explorer = sw.chain.explorer;
  const gasCostNative =
    gas && gas.gasPriceWei ? Number(formatUnitsStr(BigInt(gas.gas) * BigInt(gas.gasPriceWei), 18, 8)) : null;
  const gasUsd = gasCostNative != null && quote?.nativeUsd ? gasCostNative * quote.nativeUsd : null;
  const execPrice =
    quote && amountIn && amountOut && amountOut > BigInt(0)
      ? side === "sell"
        ? Number(formatUnitsStr(amountOut, quote.tokenOut.decimals, 12)) / Number(formatUnitsStr(amountIn, quote.tokenIn.decimals, 12))
        : Number(formatUnitsStr(amountIn, quote.tokenIn.decimals, 12)) / Number(formatUnitsStr(amountOut, quote.tokenOut.decimals, 12))
      : null;

  return (
    <div className="dex-swap-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dex-swap" role="dialog" aria-modal="true" aria-label="Swap DEX">
        <div className="dex-swap-head">
          <div>
            <div className="dex-swap-title">
              Swap · <b>{symbol}/{pool.quoteSymbol}</b>
            </div>
            <div className="dex-swap-sub">
              {DEX_LABELS[pool.dex]}
              {pool.feePct != null ? ` ${pool.feePct}%` : ""} · {sw.chain.name} · pool{" "}
              <a href={`${explorer}/address/${pool.pool}`} target="_blank" rel="noopener noreferrer" className="dex-pop-link">
                {shortAddr(pool.pool)} ↗
              </a>
            </div>
          </div>
          <button type="button" className="dex-sim-clear" onClick={onClose} disabled={Boolean(busy)} aria-label="Tutup">
            ×
          </button>
        </div>

        <div className="dex-swap-row">
          <div className="dex-sim-toggle" role="group" aria-label="Arah">
            {(["buy", "sell"] as DexSimSide[]).map((s) => (
              <button
                key={s}
                type="button"
                className={`dex-sim-side is-${s}${side === s ? " is-on" : ""}`}
                onClick={() => setSide(s)}
                disabled={Boolean(busy)}
              >
                {s === "buy" ? "Beli" : "Jual"}
              </button>
            ))}
          </div>
          <span className="muted dex-sim-hint">
            {side === "sell" ? `jual ${symbol} → ${pool.quoteSymbol}` : `beli ${symbol} pakai ${pool.quoteSymbol}`}
          </span>
        </div>

        <div className="dex-swap-grid">
          <label className="dex-swap-field">
            <span>Jumlah ({tokenInLabel})</span>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.0" disabled={Boolean(busy)} />
            {quote?.balanceRaw != null ? (
              <button
                type="button"
                className="dex-swap-max"
                onClick={() => setAmount(formatUnitsStr(quote.balanceRaw!, quote.tokenIn.decimals, quote.tokenIn.decimals))}
              >
                saldo {formatUnitsStr(quote.balanceRaw, quote.tokenIn.decimals, 6)} {quote.tokenIn.symbol}
              </button>
            ) : null}
          </label>
          <label className="dex-swap-field dex-swap-field-sm">
            <span>Slippage %</span>
            <input value={slippage} onChange={(e) => setSlippage(e.target.value)} inputMode="decimal" disabled={Boolean(busy)} />
          </label>
        </div>

        <div className="dex-swap-preview">
          {quoting ? <div className="muted">menghitung quote…</div> : null}
          {quoteErr ? <div className="down">✗ {quoteErr}</div> : null}
          {!slipValid ? <div className="down">Slippage harus 0–50%</div> : null}
          {quote && amountOut != null ? (
            <table className="dex-swap-table">
              <tbody>
                <tr>
                  <td>Kamu bayar</td>
                  <td className="num">
                    {formatUnitsStr(quote.amountInRaw, quote.tokenIn.decimals)} {quote.tokenIn.symbol}
                  </td>
                </tr>
                <tr>
                  <td>Perkiraan dapat</td>
                  <td className="num">
                    {formatUnitsStr(amountOut, quote.tokenOut.decimals)} {quote.tokenOut.symbol}
                  </td>
                </tr>
                <tr>
                  <td>Minimal diterima ({slippage}%)</td>
                  <td className="num">
                    <b>{minOut != null ? formatUnitsStr(minOut, quote.tokenOut.decimals) : "–"}</b> {quote.tokenOut.symbol}
                  </td>
                </tr>
                <tr>
                  <td>Harga eksekusi</td>
                  <td className="num">
                    {execPrice != null ? `${execPrice.toPrecision(6)} ${pool.quoteSymbol} / ${symbol}` : "–"}
                  </td>
                </tr>
                <tr>
                  <td>Estimasi gas</td>
                  <td className="num">
                    {gas
                      ? `${Number(gas.gas).toLocaleString("en-US")} gas${gasCostNative != null ? ` ≈ ${gasCostNative.toPrecision(3)} ${sw.chain.nativeSymbol}` : ""}${gasUsd != null ? ` (~$${gasUsd.toFixed(2)})` : ""}`
                      : gasErr
                        ? <span className="muted">{gasErr}</span>
                        : account
                          ? "…"
                          : <span className="muted">connect wallet dulu</span>}
                  </td>
                </tr>
                <tr>
                  <td>Router</td>
                  <td className="num">
                    <a href={`${explorer}/address/${quote.router}`} target="_blank" rel="noopener noreferrer" className="dex-pop-link">
                      {shortAddr(quote.router)} ↗
                    </a>{" "}
                    <span className="muted">{quote.kind === "v2" ? "swapExactTokensForTokens" : `exactInputSingle fee ${quote.fee}`}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          ) : null}
          {quote && !quote.poolVerified ? (
            <div className="down">⚠ Pool dari factory tidak cocok dengan pool yang dipilih — swap diblokir.</div>
          ) : null}
          {insufficient ? <div className="down">⚠ Saldo {quote?.tokenIn.symbol} tidak cukup.</div> : null}
        </div>

        {quote && account ? (
          <label className="dex-swap-ack">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} disabled={Boolean(busy)} />
            <span>
              Saya cek: bayar <b>{formatUnitsStr(quote.amountInRaw, quote.tokenIn.decimals)} {quote.tokenIn.symbol}</b>, minimal dapat{" "}
              <b>{minOut != null ? formatUnitsStr(minOut, quote.tokenOut.decimals) : "–"} {quote.tokenOut.symbol}</b>, lewat pool{" "}
              <b>{DEX_LABELS[pool.dex]} {shortAddr(pool.pool)}</b> di <b>{sw.chain.name}</b>.
            </span>
          </label>
        ) : null}

        <div className="dex-swap-actions">
          {!eth ? (
            <span className="down">MetaMask tidak terdeteksi di browser ini.</span>
          ) : !account ? (
            <button type="button" className="btn-primary" onClick={connect}>
              Connect Wallet
            </button>
          ) : wrongChain ? (
            <button type="button" className="btn-primary" onClick={switchChain}>
              Ganti jaringan ke {sw.chain.name}
            </button>
          ) : (
            <>
              <span className="muted dex-swap-acct" title={account}>
                {shortAddr(account)}
              </span>
              {needsApprove ? (
                <button type="button" className="btn-primary" onClick={approve} disabled={Boolean(busy) || insufficient || !quote?.poolVerified}>
                  {busy === "approve" ? "Approve…" : `Approve ${quote?.tokenIn.symbol ?? ""}`}
                </button>
              ) : null}
              <button
                type="button"
                className="btn-primary dex-swap-confirm"
                onClick={confirmSwap}
                disabled={Boolean(busy) || !quote || needsApprove || insufficient || !ack || minOut == null || !quote.poolVerified}
              >
                {busy === "swap" ? "Menunggu MetaMask…" : "Confirm Swap"}
              </button>
            </>
          )}
        </div>
        {actionErr ? <div className="down dex-swap-err">✗ {actionErr}</div> : null}

        {txs.length ? (
          <div className="dex-swap-txs">
            {txs.map((t) => (
              <div key={t.hash} className="dex-swap-tx">
                <span className={`dex-pop-status ${t.status === "success" ? "is-ok" : t.status === "failed" ? "is-bad" : ""}`}>
                  {t.status === "pending" ? "pending…" : t.status === "success" ? "sukses" : "gagal"}
                </span>
                <span>{t.label}</span>
                <a href={`${explorer}/tx/${t.hash}`} target="_blank" rel="noopener noreferrer" className="dex-pop-link">
                  {shortAddr(t.hash)} ↗
                </a>
                {t.error ? <span className="muted">{t.error}</span> : null}
              </div>
            ))}
          </div>
        ) : null}

        <div className="muted dex-swap-foot">
          Single pool, tanpa routing. Tanda tangan hanya di MetaMask; app tidak menyimpan private key. Base {pool.quoteSymbol} dipakai sebagai ERC-20
          (WETH/WBNB, bukan native {sw.chain.nativeSymbol}). Token fee-on-transfer bisa gagal.
        </div>
      </div>
    </div>
  );
}
