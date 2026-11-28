/**
 * Deteksi pool Solana (server-only): Raydium + Orca lewat API publik resmi masing-masing.
 * - Raydium: api-v3.raydium.io (pools/info/mint, mint/price) + transaction-v1.raydium.io (compute/swap-base-in) untuk harga eksekusi.
 * - Orca: api.orca.so/v2/solana/pools?token= (whirlpool). Orca tidak punya API quote HTTP resmi -> harga mid + likuiditas saja.
 * - SOL_RPC_URL (opsional): validasi mint + desimal via getTokenSupply.
 * Tidak memakai DexScreener.
 */
import { sleep } from "./rate-limit";
import type { DexId, DexPoolInfo, DexPoolsResult } from "./dex-pools-types";

type SolBase = { symbol: string; mint: string; decimals: number; stable: boolean };

export const SOL_RPC_ENV = "SOL_RPC_URL";
const WSOL: SolBase = { symbol: "SOL", mint: "So11111111111111111111111111111111111111112", decimals: 9, stable: false };
const SOL_BASES: SolBase[] = [
  WSOL,
  { symbol: "USDC", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, stable: true },
  { symbol: "USDT", mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6, stable: true },
];
const USDC = SOL_BASES[1];
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
  const isBase = baseByMint.has(mint);
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

  // ---- Harga eksekusi Raydium (router resmi Raydium; jual token -> USDC/SOL) ----
  if (refUsd && decimals != null && !isBase && pools.some((p) => p.dex === "raydium" && !p.untradeable)) {
    const amountIn = toRaw(sizeUsd / refUsd, decimals);
    const out = USDC;
    try {
      const json = (await fetchJson(
        `https://transaction-v1.raydium.io/compute/swap-base-in?inputMint=${mint}&outputMint=${out.mint}&amount=${amountIn}&slippageBps=50&txVersion=V0`,
      )) as {
        success?: boolean;
        msg?: string;
        data?: { outputAmount?: string; priceImpactPct?: number; routePlan?: Array<{ poolId: string }> };
      };
      if (json?.success && json.data?.outputAmount) {
        const inHuman = fromRaw(amountIn, decimals) ?? 0;
        const outHuman = fromRaw(json.data.outputAmount, out.decimals) ?? 0;
        const exec = inHuman > 0 ? outHuman / inHuman : null;
        const route = json.data.routePlan ?? [];
        const impact = num(json.data.priceImpactPct);
        const single = route.length === 1 ? pools.find((p) => p.dex === "raydium" && p.pool === route[0].poolId) : undefined;
        if (single) {
          single.execUsd = exec;
          single.impactPct = impact;
        } else if (route.length > 0) {
          pools.unshift({
            base: out,
            dex: "raydium",
            pool: route[0].poolId,
            pair: `${symbol ?? "TOKEN"}→${out.symbol} (rute)`,
            quoteToken: out.mint,
            quoteSymbol: out.symbol,
            feePct: null,
            reserveToken: null,
            reserveQuote: null,
            liquidityUsd: null,
            midUsd: null,
            execUsd: exec,
            impactPct: impact,
            untradeable: false,
            note: `router Raydium · ${route.length} hop`,
          });
        }
      } else {
        warnings.push(`Raydium quote: ${json?.msg ?? "gagal"}`);
      }
    } catch (error) {
      warnings.push(`Raydium quote: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (pools.some((p) => p.dex === "orca")) warnings.push("Orca: tanpa API quote resmi -> harga mid + likuiditas, impact '-'");

  // ---- Ringkasan ----
  // Orca tidak punya quote eksekusi resmi, jadi supaya adil Best DEX + Gap dibandingkan pakai
  // harga mid pool TERDALAM (likuiditas terbesar) per DEX. Pool dangkal tidak ikut menentukan.
  const deepestPerDex = new Map<DexId, DexPoolInfo>();
  for (const p of pools) {
    if (p.untradeable || p.midUsd == null || p.liquidityUsd == null) continue;
    const cur = deepestPerDex.get(p.dex);
    if (!cur || p.liquidityUsd > (cur.liquidityUsd ?? 0)) deepestPerDex.set(p.dex, p);
  }
  let best: DexPoolInfo | null = null;
  let worst: DexPoolInfo | null = null;
  for (const p of deepestPerDex.values()) {
    if (!best || (p.midUsd ?? 0) > (best.midUsd ?? 0)) best = p;
    if (!worst || (p.midUsd ?? 0) < (worst.midUsd ?? 0)) worst = p;
  }
  const bestV = best?.midUsd ?? null;
  const worstV = worst?.midUsd ?? null;
  const gapPct = best && worst && best !== worst && bestV && worstV ? ((bestV - worstV) / worstV) * 100 : null;
  if (deepestPerDex.size > 0) warnings.push("Solana: Best DEX & Gap pakai harga mid pool terdalam per DEX");

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
        Number(b.execUsd != null) - Number(a.execUsd != null) ||
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
    gapPct,
    vsCowPct: null,
    dexes: (["raydium", "orca"] as DexId[]).filter((d) => dexSet.has(d)),
    fetchedAt: Date.now(),
    warnings,
  };
}
