/**
 * Deteksi pool Solana (server-only): Raydium + Orca lewat API publik resmi masing-masing.
 * - Raydium: api-v3.raydium.io (pools/info/mint, mint/price) + transaction-v1.raydium.io (compute/swap-base-in) untuk harga eksekusi.
 * - Orca: api.orca.so/v2/solana/pools?token= (whirlpool). Orca tidak punya API quote HTTP resmi -> harga mid + likuiditas saja.
 * - SOL_RPC_URL (opsional): validasi mint + desimal via getTokenSupply.
 * Tidak memakai DexScreener.
 */
import { sleep } from "./rate-limit";
import { dexPoolKey, summarizeMid } from "./dex-pools-types";
import type { DexId, DexPoolInfo, DexPoolsResult, DexSimResult, DexSimRow, DexSimSide } from "./dex-pools-types";

type SolBase = { symbol: string; mint: string; decimals: number; stable: boolean };

export const SOL_RPC_ENV = "SOL_RPC_URL";
const WSOL: SolBase = { symbol: "SOL", mint: "So11111111111111111111111111111111111111112", decimals: 9, stable: false };
const SOL_BASES: SolBase[] = [
  WSOL,
  { symbol: "USDC", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, stable: true },
  { symbol: "USDT", mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6, stable: true },
];
const MAX_POOLS_PER_DEX = 6;
const RETRIES = 3;

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 15_000): Promise<unknown> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { Accept: "application/json", ...(init?.headers ?? {}) },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`HTTP ${res.status}`);
        const retryAfter = Number(res.headers.get("retry-after"));
        if (attempt < RETRIES) {
          await sleep(Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 600 * 2 ** attempt, 8_000));
          continue;
        }
        throw lastError;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (error) {
      lastError = error;
      const msg = error instanceof Error ? error.message : String(error);
      if (/^HTTP 4\d\d/.test(msg) && !/429/.test(msg)) throw error;
      if (attempt < RETRIES) {
        await sleep(600 * 2 ** attempt);
        continue;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function toRaw(amount: number, decimals: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "0";
  const scaled = BigInt(Math.round(amount * 1e6));
  return ((scaled * BigInt(10) ** BigInt(decimals)) / BigInt(1_000_000)).toString();
}

function fromRaw(raw: string | number | null | undefined, decimals: number): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n / 10 ** decimals : null;
}

type MintMeta = { address: string; symbol?: string; decimals?: number };

type RaydiumPool = {
  type?: string;
  id: string;
  mintA: MintMeta;
  mintB: MintMeta;
  price?: number;
  mintAmountA?: number;
  mintAmountB?: number;
  feeRate?: number;
  tvl?: number;
};

type OrcaPool = {
  address: string;
  feeRate?: number;
  liquidity?: string;
  price?: string;
  tokenMintA: string;
  tokenMintB: string;
  tokenA?: MintMeta;
  tokenB?: MintMeta;
  tokenBalanceA?: string;
  tokenBalanceB?: string;
  tvlUsdc?: string;
  hasWarning?: boolean;
};

async function rpcDecimals(rpcUrl: string, mint: string): Promise<number | null> {
  const json = (await fetchJson(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenSupply", params: [mint] }),
  })) as { result?: { value?: { decimals?: number } }; error?: { message?: string } };
  if (json?.error) return null;
  const d = json?.result?.value?.decimals;
  return typeof d === "number" ? d : null;
}

function emptyResult(mint: string, sizeUsd: number, warnings: string[]): DexPoolsResult {
  return {
    chain: "SOL",
    chainName: "Solana",
    contract: mint,
    symbol: null,
    decimals: null,
    sizeUsd,
    refUsd: null,
    refSource: null,
    pools: [],
    cow: null,
    bestDex: null,
    bestPool: null,
    bestExecUsd: null,
    gapPct: null,
    vsCowPct: null,
    dexes: [],
    fetchedAt: Date.now(),
    warnings,
  };
}

export async function detectSolanaPools(
  mint: string,
  opts: { sizeUsd: number; hintUsd?: number | null },
): Promise<DexPoolsResult> {
  const warnings: string[] = [];
  const sizeUsd = opts.sizeUsd;
  const baseByMint = new Map(SOL_BASES.map((b) => [b.mint, b]));
  const rpcUrl = process.env[SOL_RPC_ENV]?.trim() || null;

  const [priceRes, rayRes, orcaRes, rpcDec] = await Promise.all([
    fetchJson(`https://api-v3.raydium.io/mint/price?mints=${WSOL.mint},${mint}`).catch((e) => {
      warnings.push(`Raydium price: ${e instanceof Error ? e.message : e}`);
      return null;
    }),
    fetchJson(
      `https://api-v3.raydium.io/pools/info/mint?mint1=${mint}&poolType=all&poolSortField=liquidity&sortType=desc&pageSize=30&page=1`,
    ).catch((e) => {
      warnings.push(`Raydium pools: ${e instanceof Error ? e.message : e}`);
      return null;
    }),
    fetchJson(`https://api.orca.so/v2/solana/pools?token=${mint}&sortBy=tvl&sortDirection=desc&size=30`).catch((e) => {
      warnings.push(`Orca pools: ${e instanceof Error ? e.message : e}`);
      return null;
    }),
    rpcUrl ? rpcDecimals(rpcUrl, mint).catch(() => null) : Promise.resolve(null),
  ]);

  const prices = ((priceRes as { data?: Record<string, string> } | null)?.data ?? {}) as Record<string, string>;
  const solUsd = num(prices[WSOL.mint]);
  const apiTokenUsd = num(prices[mint]);
  const baseUsd = (b: SolBase): number | null => (b.stable ? 1 : solUsd);

  let symbol: string | null = null;
  let decimals: number | null = rpcDec;
  const pools: Array<DexPoolInfo & { base: SolBase }> = [];

  // ---- Raydium ----
  const rayPools = (((rayRes as { data?: { data?: RaydiumPool[] } } | null)?.data?.data ?? []) as RaydiumPool[]).filter(Boolean);
  for (const p of rayPools) {
    const tokenIsA = p.mintA?.address === mint;
    const tokenMeta = tokenIsA ? p.mintA : p.mintB;
    const other = tokenIsA ? p.mintB : p.mintA;
    if (tokenMeta?.address !== mint) continue;
    symbol = symbol ?? tokenMeta.symbol ?? null;
    if (decimals == null && typeof tokenMeta.decimals === "number") decimals = tokenMeta.decimals;
    const base = baseByMint.get(other?.address ?? "");
    if (!base || base.mint === mint) continue;
    if (pools.filter((x) => x.dex === "raydium").length >= MAX_POOLS_PER_DEX) continue;
    const priceBA = num(p.price); // mintB per mintA
    const tokenInBase = priceBA && priceBA > 0 ? (tokenIsA ? priceBA : 1 / priceBA) : null;
    const bu = baseUsd(base);
    const reserveToken = num(tokenIsA ? p.mintAmountA : p.mintAmountB);
    const reserveQuote = num(tokenIsA ? p.mintAmountB : p.mintAmountA);
    pools.push({
      base,
      dex: "raydium",
      pool: p.id,
      pair: `${tokenMeta.symbol ?? "TOKEN"}/${base.symbol}`,
      quoteToken: base.mint,
      quoteSymbol: base.symbol,
      feePct: p.feeRate != null ? Math.round(p.feeRate * 1e6) / 1e4 : null,
      reserveToken,
      reserveQuote,
      liquidityUsd: num(p.tvl),
      midUsd: tokenInBase != null && bu != null ? tokenInBase * bu : null,
      execUsd: null,
      impactPct: null,
      untradeable: !reserveToken || !reserveQuote,
      note: p.type,
    });
  }

  // ---- Orca (whirlpool) ----
  const orcaPools = (((orcaRes as { data?: OrcaPool[] } | null)?.data ?? []) as OrcaPool[]).filter(Boolean);
  for (const p of orcaPools) {
    const tokenIsA = p.tokenMintA === mint;
    if (!tokenIsA && p.tokenMintB !== mint) continue;
    const tokenMeta = tokenIsA ? p.tokenA : p.tokenB;
    const otherMint = tokenIsA ? p.tokenMintB : p.tokenMintA;
    symbol = symbol ?? tokenMeta?.symbol ?? null;
    if (decimals == null && typeof tokenMeta?.decimals === "number") decimals = tokenMeta.decimals;
    const base = baseByMint.get(otherMint);
    if (!base || base.mint === mint) continue;
    if (pools.filter((x) => x.dex === "orca").length >= MAX_POOLS_PER_DEX) continue;
    const priceBA = num(p.price); // tokenB per tokenA (unit manusia)
    const tokenInBase = priceBA && priceBA > 0 ? (tokenIsA ? priceBA : 1 / priceBA) : null;
    const bu = baseUsd(base);
    const tokDec = typeof tokenMeta?.decimals === "number" ? tokenMeta.decimals : decimals;
    const reserveToken = tokDec != null ? fromRaw(tokenIsA ? p.tokenBalanceA : p.tokenBalanceB, tokDec) : null;
    const reserveQuote = fromRaw(tokenIsA ? p.tokenBalanceB : p.tokenBalanceA, base.decimals);
    const liqZero = p.liquidity != null && p.liquidity === "0";
    pools.push({
      base,
      dex: "orca",
      pool: p.address,
      pair: `${tokenMeta?.symbol ?? "TOKEN"}/${base.symbol}`,
      quoteToken: base.mint,
      quoteSymbol: base.symbol,
      feePct: p.feeRate != null ? p.feeRate / 10_000 : null,
      reserveToken,
      reserveQuote,
      liquidityUsd: num(p.tvlUsdc),
      midUsd: tokenInBase != null && bu != null ? tokenInBase * bu : null,
      execUsd: null,
      impactPct: null,
      untradeable: liqZero || !reserveToken || !reserveQuote,
      note: liqZero ? "whirlpool · liquidity 0" : p.hasWarning ? "whirlpool · warning" : "whirlpool · harga mid",
    });
  }

  if (decimals == null && pools.length === 0) {
    return emptyResult(mint, sizeUsd, [...warnings, "Tidak ada pool Raydium/Orca untuk mint ini"]);
  }

  // ---- Harga referensi ----
  let refUsd: number | null = null;
  let refSource: string | null = null;
  let bestLiq = 0;
  for (const p of pools) {
    if (p.untradeable || p.midUsd == null || p.liquidityUsd == null) continue;
    if (p.liquidityUsd > bestLiq) {
      bestLiq = p.liquidityUsd;
      refUsd = p.midUsd;
      refSource = `${p.dex} ${p.pair}`;
    }
  }
  if (refUsd == null && apiTokenUsd) {
    refUsd = apiTokenUsd;
    refSource = "Raydium mint price";
  }
  if (refUsd == null && opts.hintUsd) {
    refUsd = opts.hintUsd;
    refSource = "harga CEX (exchange)";
  }

  // Default = harga mid saja; harga eksekusi Raydium dihitung on-demand lewat simulasi (simulateSolanaPools).
  if (pools.some((p) => p.dex === "orca")) warnings.push("Orca: tanpa API quote resmi -> simulasi '–'");

  // ---- Ringkasan (harga mid, best-per-DEX) ----
  const { best, gapPct } = summarizeMid(pools);
  const bestV = best?.midUsd ?? null;

  const dexSet = new Set<DexId>();
  for (const p of pools) if (!p.untradeable) dexSet.add(p.dex);
  const outPools: DexPoolInfo[] = pools
    .map(({ base: _base, ...rest }) => {
      void _base;
      return rest;
    })
    .sort(
      (a, b) =>
        Number(a.untradeable) - Number(b.untradeable) ||
        (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1),
    );

  return {
    chain: "SOL",
    chainName: "Solana",
    contract: mint,
    symbol,
    decimals,
    sizeUsd,
    refUsd,
    refSource,
    pools: outPools,
    cow: null,
    bestDex: best?.dex ?? null,
    bestPool: best?.pool ?? null,
    bestExecUsd: bestV ?? null,
    bestMidUsd: bestV ?? null,
    gapPct,
    vsCowPct: null,
    dexes: (["raydium", "orca"] as DexId[]).filter((d) => dexSet.has(d)),
    fetchedAt: Date.now(),
    warnings,
  };
}

// ---------- simulasi beli/jual (on-demand) ----------

type RaydiumCompute = {
  success?: boolean;
  msg?: string;
  data?: { outputAmount?: string; routePlan?: Array<{ poolId: string }> };
};

async function raydiumQuote(inputMint: string, outputMint: string, amountRaw: string): Promise<{ out: string; route: string[] } | { error: string }> {
  if (amountRaw === "0") return { error: "jumlah 0" };
  try {
    const json = (await fetchJson(
      `https://transaction-v1.raydium.io/compute/swap-base-in?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=50&txVersion=V0`,
    )) as RaydiumCompute;
    if (json?.success && json.data?.outputAmount) {
      return { out: json.data.outputAmount, route: (json.data.routePlan ?? []).map((r) => r.poolId) };
    }
    return { error: json?.msg ?? "quote gagal" };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Simulasi per pool pakai base token pool itu sendiri.
 * Jual = token -> base pool; Beli = base pool -> token. Raydium via compute/swap-base-in (router resmi,
 * dihitung sekali per base token lalu ditempel ke pool Raydium yang dipakai rute / pool terdalam base itu).
 * Orca tidak punya API quote HTTP resmi -> '–'.
 */
export async function simulateSolanaPools(result: DexPoolsResult, side: DexSimSide, amountUsd: number): Promise<DexSimResult> {
  const warnings: string[] = [];
  const rows: Record<string, DexSimRow> = {};
  const mint = result.contract;
  const decimals = result.decimals;
  const baseByMint = new Map(SOL_BASES.map((b) => [b.mint, b]));
  const out: DexSimResult = {
    chain: "SOL",
    contract: mint,
    side,
    amountUsd,
    resultUnit: side === "sell" ? "USD" : "TOKEN",
    rows,
    cow: null,
    bestKey: null,
    fetchedAt: Date.now(),
    warnings,
  };
  if (decimals == null) {
    warnings.push("Desimal token tidak diketahui");
    return out;
  }
  let solUsd: number | null = null;
  try {
    const pr = (await fetchJson(`https://api-v3.raydium.io/mint/price?mints=${WSOL.mint}`)) as { data?: Record<string, string> };
    solUsd = num(pr?.data?.[WSOL.mint]);
  } catch (error) {
    warnings.push(`Raydium price: ${error instanceof Error ? error.message : String(error)}`);
  }
  const baseUsd = (b: SolBase): number | null => (b.stable ? 1 : solUsd);

  for (const p of result.pools) {
    if (p.dex === "orca") rows[dexPoolKey(p)] = { execUsd: null, impactPct: null, result: null, note: "Orca tanpa API quote" };
  }

  const ray = result.pools.filter((p) => p.dex === "raydium" && !p.untradeable);
  const basesUsed = [...new Set(ray.map((p) => p.quoteToken))];
  const refUsd = result.refUsd;
  for (const baseMint of basesUsed) {
    const base = baseByMint.get(baseMint);
    if (!base) continue;
    const bu = baseUsd(base);
    const poolsOfBase = ray.filter((p) => p.quoteToken === baseMint);
    const deepest = poolsOfBase.reduce((a, b) => ((b.liquidityUsd ?? -1) > (a.liquidityUsd ?? -1) ? b : a));
    if (bu == null || (side === "sell" && !refUsd)) {
      for (const p of poolsOfBase) rows[dexPoolKey(p)] = { execUsd: null, impactPct: null, result: null, note: "harga USD tidak ada" };
      continue;
    }
    const inMint = side === "sell" ? mint : baseMint;
    const outMint = side === "sell" ? baseMint : mint;
    const inDec = side === "sell" ? decimals : base.decimals;
    const outDec = side === "sell" ? base.decimals : decimals;
    const inHuman = side === "sell" ? amountUsd / refUsd! : amountUsd / bu;
    const full = await raydiumQuote(inMint, outMint, toRaw(inHuman, inDec));
    await sleep(150);
    const small = await raydiumQuote(inMint, outMint, toRaw(inHuman / 100, inDec));
    if ("error" in full) {
      rows[dexPoolKey(deepest)] = { execUsd: null, impactPct: null, result: null, note: `Raydium: ${full.error}`.slice(0, 120) };
      continue;
    }
    const outHuman = fromRaw(full.out, outDec) ?? 0;
    const smallOut = "out" in small ? fromRaw(small.out, outDec) ?? 0 : 0;
    let row: DexSimRow;
    if (side === "sell") {
      const usd = outHuman * bu;
      const exec = inHuman > 0 ? usd / inHuman : null;
      const smallExec = smallOut > 0 ? (smallOut * bu) / (inHuman / 100) : null;
      row = {
        execUsd: exec,
        result: usd,
        impactPct: exec != null && smallExec ? Math.max(0, ((smallExec - exec) / smallExec) * 100) : null,
      };
    } else {
      const exec = outHuman > 0 ? amountUsd / outHuman : null;
      const smallExec = smallOut > 0 ? amountUsd / 100 / smallOut : null;
      row = {
        execUsd: exec,
        result: outHuman,
        impactPct: exec != null && smallExec ? Math.max(0, ((exec - smallExec) / smallExec) * 100) : null,
      };
    }
    const routePool = full.route.length === 1 ? poolsOfBase.find((p) => p.pool === full.route[0]) : undefined;
    const target = routePool ?? deepest;
    if (!routePool) row.note = `router Raydium · ${full.route.length} hop`;
    rows[dexPoolKey(target)] = row;
    for (const p of poolsOfBase) {
      if (p !== target) rows[dexPoolKey(p)] ??= { execUsd: null, impactPct: null, result: null, note: "rute Raydium lewat pool lain" };
    }
  }

  let bestVal = -1;
  for (const [key, row] of Object.entries(rows)) {
    if (row.result != null && row.result > bestVal) {
      bestVal = row.result;
      out.bestKey = key;
    }
  }
  return out;
}
