/**
 * Deteksi pool DEX on-chain (server-only) untuk satu kontrak token.
 * Semua call EVM lewat RPC dari env (ETH_RPC_URL / <CHAIN>_RPC_URL) dan digabung pakai Multicall3.
 * Balancer: discovery lewat GraphQL resmi api-v3.balancer.fi lalu diverifikasi on-chain via Vault.
 * CoW: quote resmi api.cow.fi. Tidak memakai DexScreener.
 */
import { sleep } from "./rate-limit";
import { detectSolanaPools, simulateSolanaPools, SOL_RPC_ENV } from "./dex-pools-solana";
import { DEX_SIM_COW_KEY, dexPoolKey, summarizeMid } from "./dex-pools-types";
import { getSwapDex, parseUnitsStr, SWAP_CHAINS, type SwapGasRequest, type SwapQuote, type SwapQuoteRequest } from "./dex-swap-types";
import type { DexCowInfo, DexId, DexPoolInfo, DexPoolsResult, DexSimResult, DexSimRow, DexSimSide } from "./dex-pools-types";

// ---------- konfigurasi per chain ----------

type BaseToken = { symbol: string; address: string; decimals: number; stable: boolean };

type V2Dex = { id: DexId; factory: string; router: string; feePct: number };
type V3Dex = { id: DexId; factory: string; quoter: string; fees: number[] };

type ChainConfig = {
  key: string; // label kontrak di tabel (hasil shortChainLabel)
  name: string;
  rpcEnv: string;
  multicall3: string;
  v2: V2Dex[];
  v3: V3Dex[];
  /** Pool V3 native/stable untuk harga native (USD). */
  nativeUsdPool: { pool: string; usdIsToken0: boolean; usdDecimals: number } | null;
  balancerVault: string | null;
  balancerChain: string | null;
  cowNetwork: string | null;
  weth: BaseToken; // wrapped native (WETH / WBNB)
  bases: BaseToken[];
};

const MAINNET_WETH: BaseToken = { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18, stable: false };
const BSC_WBNB: BaseToken = { symbol: "WBNB", address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", decimals: 18, stable: false };

const CHAINS: Record<string, ChainConfig> = {
  ERC20: {
    key: "ERC20",
    name: "Ethereum",
    rpcEnv: "ETH_RPC_URL",
    multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
    v2: [
      { id: "univ2", factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f", router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", feePct: 0.3 },
      { id: "sushi", factory: "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac", router: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F", feePct: 0.3 },
    ],
    v3: [
      { id: "univ3", factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984", quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e", fees: [100, 500, 3000, 10000] },
    ],
    // Uniswap V3 USDC/WETH 0.05% (USDC = token0, 6 desimal)
    nativeUsdPool: { pool: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640", usdIsToken0: true, usdDecimals: 6 },
    balancerVault: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
    balancerChain: "MAINNET",
    cowNetwork: "mainnet",
    weth: MAINNET_WETH,
    bases: [
      MAINNET_WETH,
      { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, stable: true },
      { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, stable: true },
      { symbol: "DAI", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18, stable: true },
    ],
  },
  BEP20: {
    key: "BEP20",
    name: "BNB Smart Chain",
    rpcEnv: "BSC_RPC_URL",
    multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
    v2: [
      { id: "pancakev2", factory: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73", router: "0x10ED43C718714eb63d5aA57B78B54704E256024E", feePct: 0.25 },
    ],
    v3: [
      { id: "pancakev3", factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865", quoter: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997", fees: [100, 500, 2500, 10000] },
    ],
    // PancakeSwap V3 USDT/WBNB 0.01% (USDT = token0, 18 desimal di BSC)
    nativeUsdPool: { pool: "0x172fcD41E0913e95784454622d1c3724f546f849", usdIsToken0: true, usdDecimals: 18 },
    balancerVault: null,
    balancerChain: null,
    cowNetwork: null,
    weth: BSC_WBNB,
    bases: [
      BSC_WBNB,
      { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, stable: true },
      { symbol: "USDC", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18, stable: true },
      { symbol: "BUSD", address: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56", decimals: 18, stable: true },
    ],
  },
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function getDexChainConfig(chainKey: string): ChainConfig | null {
  return CHAINS[chainKey] ?? null;
}

export function getRpcUrl(chainKey: string): string | null {
  const cfg = getDexChainConfig(chainKey);
  if (!cfg) return null;
  const value = process.env[cfg.rpcEnv]?.trim();
  return value ? value : null;
}

/** Chain yang punya detektor: EVM (CHAINS) + Solana. */
export function isDexChainSupported(chainKey: string): boolean {
  return chainKey === "SOL" || Boolean(CHAINS[chainKey]);
}

/** Solana jalan lewat API resmi Raydium/Orca; SOL_RPC_URL opsional (validasi desimal). EVM wajib RPC. */
export function isDexRpcReady(chainKey: string): boolean {
  if (chainKey === "SOL") return true;
  return Boolean(getRpcUrl(chainKey));
}

export function getRpcEnvName(chainKey: string): string | null {
  if (chainKey === "SOL") return SOL_RPC_ENV;
  return getDexChainConfig(chainKey)?.rpcEnv ?? null;
}

// ---------- ABI helpers (minimal, tanpa dependency) ----------

const SEL = {
  getPair: "e6a43905",
  getReserves: "0902f1ac",
  getPool: "1698ee82",
  liquidity: "1a686502",
  slot0: "3850c7bd",
  decimals: "313ce567",
  symbol: "95d89b41",
  balanceOf: "70a08231",
  getAmountsOut: "d06ca61f",
  quoteExactInputSingle: "c6a5026a",
  getPoolTokens: "f94d4668",
  queryBatchSwap: "f84d066e",
  aggregate3: "82ad56cb",
};

const TWO_256 = BigInt(1) << BigInt(256);

function strip0x(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

function wordUint(value: bigint | number): string {
  let v = BigInt(value);
  if (v < BigInt(0)) v += TWO_256;
  return v.toString(16).padStart(64, "0");
}

function wordAddr(address: string): string {
  return strip0x(address).toLowerCase().padStart(64, "0");
}

function wordBool(value: boolean): string {
  return wordUint(value ? 1 : 0);
}

function wordBytes32(hex: string): string {
  return strip0x(hex).toLowerCase().padEnd(64, "0").slice(0, 64);
}

function encodeBytes(hex: string): string {
  const body = strip0x(hex);
  const len = body.length / 2;
  const padded = body.padEnd(Math.ceil(body.length / 64) * 64, "0");
  return wordUint(len) + padded;
}

function readWord(hex: string, index: number): string {
  return hex.slice(index * 64, index * 64 + 64);
}

function readUint(hex: string, index: number): bigint {
  const w = readWord(hex, index);
  return w.length === 64 ? BigInt("0x" + w) : BigInt(0);
}

function readAddr(hex: string, index: number): string {
  return "0x" + readWord(hex, index).slice(24);
}

/** Decode uint256[]/address[] dinamis di offset (byte) tertentu. */
function readUintArrayAt(hex: string, byteOffset: number): bigint[] {
  const start = byteOffset * 2;
  const sub = hex.slice(start);
  const len = Number(readUint(sub, 0));
  const out: bigint[] = [];
  for (let i = 0; i < len; i += 1) out.push(readUint(sub, 1 + i));
  return out;
}

function decodeString(hex: string): string | null {
  if (!hex) return null;
  try {
    if (hex.length === 64) {
      // bytes32 (mis. MKR)
      const buf = Buffer.from(hex, "hex");
      return buf.toString("utf8").replace(/\u0000+$/g, "").trim() || null;
    }
    const offset = Number(readUint(hex, 0));
    const sub = hex.slice(offset * 2);
    const len = Number(readUint(sub, 0));
    const data = sub.slice(64, 64 + len * 2);
    return Buffer.from(data, "hex").toString("utf8").replace(/\u0000+$/g, "").trim() || null;
  } catch {
    return null;
  }
}

const enc = {
  noArgs: (sel: string) => "0x" + sel,
  getPair: (a: string, b: string) => "0x" + SEL.getPair + wordAddr(a) + wordAddr(b),
  getPool: (a: string, b: string, fee: number) => "0x" + SEL.getPool + wordAddr(a) + wordAddr(b) + wordUint(fee),
  balanceOf: (owner: string) => "0x" + SEL.balanceOf + wordAddr(owner),
  getAmountsOut: (amountIn: bigint, path: string[]) =>
    "0x" + SEL.getAmountsOut + wordUint(amountIn) + wordUint(0x40) + wordUint(path.length) + path.map(wordAddr).join(""),
  quoteExactInputSingle: (tokenIn: string, tokenOut: string, amountIn: bigint, fee: number) =>
    "0x" + SEL.quoteExactInputSingle + wordAddr(tokenIn) + wordAddr(tokenOut) + wordUint(amountIn) + wordUint(fee) + wordUint(0),
  getPoolTokens: (poolId: string) => "0x" + SEL.getPoolTokens + wordBytes32(poolId),
  queryBatchSwap: (poolId: string, amountIn: bigint, assetIn: string, assetOut: string, funds: string) => {
    // head: kind, off(swaps), off(assets), funds(4 words) => 7 words
    const headWords = 7;
    const swaps =
      wordUint(1) + // length
      wordUint(0x20) + // offset elemen 0 (relatif setelah length)
      wordBytes32(poolId) +
      wordUint(0) +
      wordUint(1) +
      wordUint(amountIn) +
      wordUint(0xa0) + // offset userData relatif awal tuple
      wordUint(0); // userData length 0
    const swapsOffset = headWords * 32;
    const assetsOffset = swapsOffset + swaps.length / 2;
    const assets = wordUint(2) + wordAddr(assetIn) + wordAddr(assetOut);
    return (
      "0x" +
      SEL.queryBatchSwap +
      wordUint(0) + // GIVEN_IN
      wordUint(swapsOffset) +
      wordUint(assetsOffset) +
      wordAddr(funds) +
      wordBool(false) +
      wordAddr(funds) +
      wordBool(false) +
      swaps +
      assets
    );
  },
};

type Call = { target: string; data: string };
type CallResult = { success: boolean; data: string };

function encodeAggregate3(calls: Call[]): string {
  const n = calls.length;
  const tuples: string[] = calls.map((c) => wordAddr(c.target) + wordBool(true) + wordUint(0x60) + encodeBytes(c.data));
  let offsets = "";
  let running = n * 32;
  for (const t of tuples) {
    offsets += wordUint(running);
    running += t.length / 2;
  }
  return "0x" + SEL.aggregate3 + wordUint(0x20) + wordUint(n) + offsets + tuples.join("");
}

function decodeAggregate3(hexRaw: string): CallResult[] {
  const hex = strip0x(hexRaw);
  const arrStart = Number(readUint(hex, 0)) * 2;
  const arr = hex.slice(arrStart);
  const n = Number(readUint(arr, 0));
  const body = arr.slice(64);
  const out: CallResult[] = [];
  for (let i = 0; i < n; i += 1) {
    const off = Number(readUint(body, i)) * 2;
    const tuple = body.slice(off);
    const success = readUint(tuple, 0) === BigInt(1);
    const dataOff = Number(readUint(tuple, 1)) * 2;
    const dataPart = tuple.slice(dataOff);
    const len = Number(readUint(dataPart, 0));
    out.push({ success, data: dataPart.slice(64, 64 + len * 2) });
  }
  return out;
}

// ---------- HTTP dengan retry/backoff 429 ----------

const RETRIES = 3;

async function postJson(url: string, body: unknown, timeoutMs = 15_000): Promise<unknown> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after"));
        lastError = new Error(`HTTP ${res.status}`);
        if (attempt < RETRIES) {
          const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 600 * 2 ** attempt;
          await sleep(Math.min(wait, 8_000));
          continue;
        }
        throw lastError;
      }
      const text = await res.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`HTTP ${res.status}: respons bukan JSON`);
      }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`) as Error & { body?: unknown };
        err.body = json;
        throw err;
      }
      return json;
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

let rpcId = 1;

async function ethCall(rpcUrl: string, to: string, data: string): Promise<string> {
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    const json = (await postJson(rpcUrl, {
      jsonrpc: "2.0",
      id: rpcId++,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    })) as { result?: string; error?: { code?: number; message?: string } };
    if (json?.error) {
      const message = json.error.message ?? "RPC error";
      // beberapa provider melempar rate limit via JSON-RPC error
      if ((json.error.code === 429 || /rate|limit|too many/i.test(message)) && attempt < RETRIES) {
        await sleep(800 * 2 ** attempt);
        continue;
      }
      throw new Error(`RPC: ${message.slice(0, 160)}`);
    }
    if (typeof json?.result !== "string") throw new Error("RPC: respons tanpa result");
    return json.result;
  }
  throw new Error("RPC: rate limit");
}

async function multicall(rpcUrl: string, cfg: ChainConfig, calls: Call[]): Promise<CallResult[]> {
  if (calls.length === 0) return [];
  const out: CallResult[] = [];
  const CHUNK = 60;
  for (let i = 0; i < calls.length; i += CHUNK) {
    const chunk = calls.slice(i, i + CHUNK);
    const raw = await ethCall(rpcUrl, cfg.multicall3, encodeAggregate3(chunk));
    const decoded = decodeAggregate3(raw);
    for (let j = 0; j < chunk.length; j += 1) out.push(decoded[j] ?? { success: false, data: "" });
  }
  return out;
}

// ---------- angka ----------

function toHuman(raw: bigint, decimals: number): number {
  if (raw === BigInt(0)) return 0;
  const neg = raw < BigInt(0);
  const abs = neg ? -raw : raw;
  const s = abs.toString().padStart(decimals + 1, "0");
  const intPart = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals, s.length - decimals + 18);
  const v = Number(`${intPart}.${frac || "0"}`);
  return neg ? -v : v;
}

function fromHuman(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) return BigInt(0);
  const scaled = BigInt(Math.round(amount * 1e8));
  return (scaled * BigInt(10) ** BigInt(decimals)) / BigInt(10) ** BigInt(8);
}

/** Harga token (dalam base) dari sqrtPriceX96. */
function v3PriceInBase(sqrtPriceX96: bigint, tokenIsToken0: boolean, dt: number, db: number): number | null {
  if (sqrtPriceX96 === BigInt(0)) return null;
  const sp = Number(sqrtPriceX96) / 2 ** 96;
  const p = sp * sp; // raw token1 per raw token0
  if (!Number.isFinite(p) || p <= 0) return null;
  return tokenIsToken0 ? p * 10 ** (dt - db) : 10 ** (dt - db) / p;
}

function isLower(a: string, b: string): boolean {
  return a.toLowerCase() < b.toLowerCase();
}

function pct(a: number, b: number): number | null {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return ((a - b) / b) * 100;
}

// ---------- Balancer & CoW API ----------

type BalancerApiPool = {
  id: string;
  address: string;
  type: string;
  poolTokens: Array<{ address: string; symbol: string; decimals: number }>;
  dynamicData?: { totalLiquidity?: string; swapFee?: string };
};

async function balancerPools(cfg: ChainConfig, contract: string): Promise<BalancerApiPool[]> {
  if (!cfg.balancerChain) return [];
  const query = `query($t:[String!]){ poolGetPools(where:{tokensIn:$t, chainIn:[${cfg.balancerChain}], protocolVersionIn:[2]}, first:8, orderBy: totalLiquidity, orderDirection: desc) { id address type poolTokens { address symbol decimals } dynamicData { totalLiquidity swapFee } } }`;
  const json = (await postJson("https://api-v3.balancer.fi/", {
    query,
    variables: { t: [contract.toLowerCase()] },
  })) as { data?: { poolGetPools?: BalancerApiPool[] }; errors?: Array<{ message?: string }> };
  if (json?.errors?.length) throw new Error(`Balancer API: ${json.errors[0]?.message ?? "error"}`);
  return json?.data?.poolGetPools ?? [];
}

async function cowQuote(
  cfg: ChainConfig,
  contract: string,
  sellAmount: bigint,
  buy: BaseToken,
): Promise<{ buyAmount: bigint } | { error: string }> {
  if (!cfg.cowNetwork) return { error: "chain tidak didukung CoW" };
  try {
    const json = (await postJson(`https://api.cow.fi/${cfg.cowNetwork}/api/v1/quote`, {
      sellToken: contract,
      buyToken: buy.address,
      from: ZERO_ADDRESS,
      receiver: ZERO_ADDRESS,
      kind: "sell",
      sellAmountBeforeFee: sellAmount.toString(),
      signingScheme: "eip712",
      onchainOrder: false,
      partiallyFillable: false,
    })) as { quote?: { buyAmount?: string } };
    const buyAmount = json?.quote?.buyAmount;
    if (!buyAmount) return { error: "tanpa quote" };
    return { buyAmount: BigInt(buyAmount) };
  } catch (error) {
    const body = (error as { body?: { errorType?: string; description?: string } }).body;
    const msg = body?.errorType || body?.description || (error instanceof Error ? error.message : String(error));
    return { error: String(msg).slice(0, 120) };
  }
}

// ---------- deteksi utama ----------

type Candidate = {
  info: DexPoolInfo;
  base: BaseToken;
  fee?: number; // V3 fee raw
  kind: "v2" | "v3" | "balancer";
  /** V2: router getAmountsOut; V3: QuoterV2. */
  router?: string;
};

export type DetectOptions = {
  sizeUsd: number;
  hintUsd?: number | null;
};

export async function detectDexPools(chainKey: string, contractRaw: string, opts: DetectOptions): Promise<DexPoolsResult> {
  const cfg = getDexChainConfig(chainKey);
  if (!cfg) throw new Error(`Chain ${chainKey} belum didukung`);
  const rpcUrl = getRpcUrl(chainKey);
  if (!rpcUrl) throw new Error(`${cfg.rpcEnv} belum diisi di .env`);
  const contract = contractRaw.trim();
  const tokenLc = contract.toLowerCase();
  const warnings: string[] = [];
  const bases = cfg.bases.filter((b) => b.address.toLowerCase() !== tokenLc);

  // Balancer discovery paralel dengan ronde 1 (API off-chain, cuma discovery).
  const balancerPromise = balancerPools(cfg, contract).catch((error) => {
    warnings.push(error instanceof Error ? error.message : String(error));
    return [] as BalancerApiPool[];
  });

  // ---- Ronde 1: metadata token + getPair/getPool + harga ETH ----
  const r1: Call[] = [];
  const idx: Record<string, number> = {};
  const push = (key: string, call: Call) => {
    idx[key] = r1.length;
    r1.push(call);
  };
  push("decimals", { target: contract, data: enc.noArgs(SEL.decimals) });
  push("symbol", { target: contract, data: enc.noArgs(SEL.symbol) });
  if (cfg.nativeUsdPool) push("ethusd", { target: cfg.nativeUsdPool.pool, data: enc.noArgs(SEL.slot0) });
  for (const b of bases) {
    for (const d of cfg.v2) push(`${d.id}:${b.symbol}`, { target: d.factory, data: enc.getPair(contract, b.address) });
    for (const d of cfg.v3) {
      for (const fee of d.fees) {
        push(`${d.id}:${b.symbol}:${fee}`, { target: d.factory, data: enc.getPool(contract, b.address, fee) });
      }
    }
  }
  const res1 = await multicall(rpcUrl, cfg, r1);
  const get1 = (key: string): CallResult | null => (idx[key] == null ? null : res1[idx[key]] ?? null);

  const decRes = get1("decimals");
  const decimals = decRes?.success && decRes.data.length >= 64 ? Number(readUint(decRes.data, 0)) : null;
  if (decimals == null || decimals > 36) {
    // Bukan ERC-20 di chain ini: hasil kosong (kolom tampil "-").
    return {
      chain: chainKey,
      chainName: cfg.name,
      contract,
      symbol: null,
      decimals: null,
      sizeUsd: opts.sizeUsd,
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
      warnings: ["Bukan kontrak ERC-20 di chain ini (decimals() gagal)"],
    };
  }
  const symRes = get1("symbol");
  const symbol = symRes?.success ? decodeString(symRes.data) : null;

  let ethUsd: number | null = null;
  const ethRes = get1("ethusd");
  if (ethRes?.success && cfg.nativeUsdPool) {
    const sqrt = readUint(ethRes.data, 0);
    // native (WETH/WBNB) sebagai "token", stable sebagai base
    ethUsd = v3PriceInBase(sqrt, !cfg.nativeUsdPool.usdIsToken0, cfg.weth.decimals, cfg.nativeUsdPool.usdDecimals);
  }
  if (!ethUsd) warnings.push(`Harga ${cfg.weth.symbol} tidak terbaca; pool ${cfg.weth.symbol} dihitung tanpa USD`);
  const baseUsd = (b: BaseToken): number | null => (b.stable ? 1 : b.address.toLowerCase() === cfg.weth.address.toLowerCase() ? ethUsd : null);

  const candidates: Candidate[] = [];
  for (const b of bases) {
    for (const d of cfg.v2) {
      const dex = d.id;
      const r = get1(`${dex}:${b.symbol}`);
      if (!r?.success) continue;
      const pair = readAddr(r.data, 0);
      if (pair.toLowerCase() === ZERO_ADDRESS) continue;
      candidates.push({
        base: b,
        kind: "v2",
        router: d.router,
        info: {
          dex,
          pool: pair,
          pair: `${symbol ?? "TOKEN"}/${b.symbol}`,
          quoteToken: b.address,
          quoteSymbol: b.symbol,
          feePct: d.feePct,
          reserveToken: null,
          reserveQuote: null,
          liquidityUsd: null,
          midUsd: null,
          execUsd: null,
          impactPct: null,
          untradeable: false,
        },
      });
    }
    for (const d of cfg.v3) for (const fee of d.fees) {
      const r = get1(`${d.id}:${b.symbol}:${fee}`);
      if (!r?.success) continue;
      const pool = readAddr(r.data, 0);
      if (pool.toLowerCase() === ZERO_ADDRESS) continue;
      candidates.push({
        base: b,
        fee,
        kind: "v3",
        router: d.quoter,
        info: {
          dex: d.id,
          pool,
          pair: `${symbol ?? "TOKEN"}/${b.symbol}`,
          quoteToken: b.address,
          quoteSymbol: b.symbol,
          feePct: fee / 10_000,
          reserveToken: null,
          reserveQuote: null,
          liquidityUsd: null,
          midUsd: null,
          execUsd: null,
          impactPct: null,
          untradeable: false,
        },
      });
    }
  }

  // Balancer: pool yang berisi token + salah satu base token.
  const balApi = await balancerPromise;
  type BalCand = { api: BalancerApiPool; base: BaseToken };
  const balCands: BalCand[] = [];
  for (const p of balApi) {
    const addrs = p.poolTokens.map((t) => t.address.toLowerCase());
    if (!addrs.includes(tokenLc)) continue;
    const base = bases.find((b) => addrs.includes(b.address.toLowerCase()));
    if (!base) continue;
    balCands.push({ api: p, base });
    if (balCands.length >= 3) break;
  }

  // ---- Ronde 2: reserves / liquidity / slot0 / saldo / getPoolTokens ----
  const r2: Call[] = [];
  const r2Map: Array<{ cand: Candidate | null; bal?: BalCand; kind: string }> = [];
  const push2 = (call: Call, kind: string, cand: Candidate | null, bal?: BalCand) => {
    r2.push(call);
    r2Map.push({ cand, bal, kind });
  };
  for (const c of candidates) {
    if (c.kind === "v3") {
      push2({ target: c.info.pool, data: enc.noArgs(SEL.liquidity) }, "liq", c);
      push2({ target: c.info.pool, data: enc.noArgs(SEL.slot0) }, "slot0", c);
      push2({ target: contract, data: enc.balanceOf(c.info.pool) }, "balTok", c);
      push2({ target: c.base.address, data: enc.balanceOf(c.info.pool) }, "balBase", c);
    } else {
      push2({ target: c.info.pool, data: enc.noArgs(SEL.getReserves) }, "reserves", c);
    }
  }
  if (cfg.balancerVault) {
    for (const b of balCands) push2({ target: cfg.balancerVault, data: enc.getPoolTokens(b.api.id) }, "poolTokens", null, b);
  }
  const res2 = await multicall(rpcUrl, cfg, r2);

  const v3Sqrt = new Map<Candidate, bigint>();
  res2.forEach((r, i) => {
    const m = r2Map[i];
    if (m.bal) {
      const b = m.bal;
      const cand: Candidate = {
        base: b.base,
        kind: "balancer",
        info: {
          dex: "balancer",
          pool: b.api.address,
          poolId: b.api.id,
          pair: `${symbol ?? "TOKEN"}/${b.base.symbol}`,
          quoteToken: b.base.address,
          quoteSymbol: b.base.symbol,
          feePct: b.api.dynamicData?.swapFee != null ? Math.round(Number(b.api.dynamicData.swapFee) * 1e6) / 1e4 : null,
          reserveToken: null,
          reserveQuote: null,
          liquidityUsd: b.api.dynamicData?.totalLiquidity != null ? Number(b.api.dynamicData.totalLiquidity) : null,
          midUsd: null,
          execUsd: null,
          impactPct: null,
          untradeable: false,
          note: b.api.type,
        },
      };
      if (r.success) {
        const tokensOff = Number(readUint(r.data, 0));
        const balsOff = Number(readUint(r.data, 1));
        const tokens = readUintArrayAt(r.data, tokensOff).map((v) => "0x" + v.toString(16).padStart(40, "0"));
        const bals = readUintArrayAt(r.data, balsOff);
        const ti = tokens.findIndex((t) => t.toLowerCase() === tokenLc);
        const bi = tokens.findIndex((t) => t.toLowerCase() === b.base.address.toLowerCase());
        if (ti >= 0) cand.info.reserveToken = toHuman(bals[ti] ?? BigInt(0), decimals);
        if (bi >= 0) cand.info.reserveQuote = toHuman(bals[bi] ?? BigInt(0), b.base.decimals);
        if (!cand.info.reserveToken || !cand.info.reserveQuote) {
          cand.info.untradeable = true;
          cand.info.note = `${b.api.type} · saldo on-chain 0`;
        }
      } else {
        cand.info.untradeable = true;
        cand.info.note = "getPoolTokens gagal";
      }
      candidates.push(cand);
      return;
    }
    const c = m.cand;
    if (!c) return;
    const bu = baseUsd(c.base);
    const tokenIs0 = isLower(contract, c.base.address);
    if (m.kind === "reserves") {
      if (!r.success) {
        c.info.untradeable = true;
        return;
      }
      const r0 = readUint(r.data, 0);
      const r1v = readUint(r.data, 1);
      const rt = tokenIs0 ? r0 : r1v;
      const rb = tokenIs0 ? r1v : r0;
      c.info.reserveToken = toHuman(rt, decimals);
      c.info.reserveQuote = toHuman(rb, c.base.decimals);
      if (rt === BigInt(0) || rb === BigInt(0)) c.info.untradeable = true;
      else if (bu != null) {
        c.info.midUsd = (c.info.reserveQuote / c.info.reserveToken) * bu;
        c.info.liquidityUsd = c.info.reserveQuote * bu * 2;
      }
    } else if (m.kind === "liq") {
      const liq = r.success ? readUint(r.data, 0) : BigInt(0);
      c.info.v3Liquidity = liq.toString();
      if (liq === BigInt(0)) {
        c.info.untradeable = true;
        c.info.note = "liquidity() = 0";
      }
    } else if (m.kind === "slot0") {
      if (r.success) v3Sqrt.set(c, readUint(r.data, 0));
    } else if (m.kind === "balTok") {
      if (r.success) c.info.reserveToken = toHuman(readUint(r.data, 0), decimals);
    } else if (m.kind === "balBase") {
      if (r.success) {
        c.info.reserveQuote = toHuman(readUint(r.data, 0), c.base.decimals);
        if (bu != null) c.info.liquidityUsd = c.info.reserveQuote * bu;
      }
    }
  });
  for (const [c, sqrt] of v3Sqrt) {
    const bu = baseUsd(c.base);
    const priceInBase = v3PriceInBase(sqrt, isLower(contract, c.base.address), decimals, c.base.decimals);
    if (priceInBase != null && bu != null && !c.info.untradeable) {
      c.info.midUsd = priceInBase * bu;
      if (c.info.liquidityUsd != null && c.info.reserveToken != null) {
        c.info.liquidityUsd += c.info.reserveToken * c.info.midUsd;
      }
    }
  }

  // ---- Harga referensi untuk ukuran trade ----
  let refUsd: number | null = null;
  let refSource: string | null = null;
  let bestLiq = 0;
  for (const c of candidates) {
    if (c.info.untradeable || c.info.midUsd == null || c.info.liquidityUsd == null) continue;
    if (c.info.liquidityUsd > bestLiq) {
      bestLiq = c.info.liquidityUsd;
      refUsd = c.info.midUsd;
      refSource = `${c.info.dex} ${c.info.pair}${c.info.feePct != null ? ` ${c.info.feePct}%` : ""}`;
    }
  }
  if (refUsd == null && opts.hintUsd && opts.hintUsd > 0) {
    refUsd = opts.hintUsd;
    refSource = "harga CEX (exchange)";
  }

  const sizeUsd = opts.sizeUsd;
  const amountIn = refUsd ? fromHuman(sizeUsd / refUsd, decimals) : BigInt(0);
  const amountSmall = amountIn > BigInt(100) ? amountIn / BigInt(100) : amountIn;
  if (!refUsd) warnings.push("Harga referensi tidak ada; quote eksekusi dilewati");

  // ---- Ronde 3: quote eksekusi (size + kecil) ----
  const r3: Call[] = [];
  const r3Map: Array<{ cand: Candidate; small: boolean }> = [];
  if (amountIn > BigInt(0)) {
    for (const c of candidates) {
      if (c.info.untradeable) continue;
      for (const small of [false, true]) {
        const amt = small ? amountSmall : amountIn;
        let call: Call | null = null;
        if (c.kind === "v3" && c.router && c.fee != null) {
          call = { target: c.router, data: enc.quoteExactInputSingle(contract, c.base.address, amt, c.fee) };
        } else if (c.kind === "v2" && c.router) {
          call = { target: c.router, data: enc.getAmountsOut(amt, [contract, c.base.address]) };
        } else if (c.kind === "balancer" && cfg.balancerVault && c.info.poolId) {
          call = {
            target: cfg.balancerVault,
            data: enc.queryBatchSwap(c.info.poolId, amt, contract, c.base.address, cfg.multicall3),
          };
        }
        if (call) {
          r3.push(call);
          r3Map.push({ cand: c, small });
        }
      }
    }
  }
  const res3 = await multicall(rpcUrl, cfg, r3);
  const smallOut = new Map<Candidate, bigint>();
  const sizeOut = new Map<Candidate, bigint>();
  res3.forEach((r, i) => {
    const { cand, small } = r3Map[i];
    if (!r.success || !r.data) return;
    let out = BigInt(0);
    if (cand.kind === "v3") out = readUint(r.data, 0);
    else if (cand.kind === "balancer") {
      const deltas = readUintArrayAt(r.data, Number(readUint(r.data, 0)));
      const d1 = deltas[1] ?? BigInt(0);
      const signed = d1 >= BigInt(1) << BigInt(255) ? d1 - TWO_256 : d1;
      out = signed < BigInt(0) ? -signed : BigInt(0);
    } else {
      const amounts = readUintArrayAt(r.data, Number(readUint(r.data, 0)));
      out = amounts[amounts.length - 1] ?? BigInt(0);
    }
    (small ? smallOut : sizeOut).set(cand, out);
  });

  const inHuman = toHuman(amountIn, decimals);
  const inSmallHuman = toHuman(amountSmall, decimals);
  for (const c of candidates) {
    if (c.info.untradeable) continue;
    const bu = baseUsd(c.base);
    const o = sizeOut.get(c);
    const so0 = smallOut.get(c);
    // Mode mid: pool baru untradeable kalau quote KECIL pun gagal (quote ukuran penuh gagal = cuma likuiditas tipis).
    if (amountIn > BigInt(0) && (!so0 || so0 === BigInt(0)) && (!o || o === BigInt(0))) {
      c.info.untradeable = true;
      c.info.note = c.info.note ? `${c.info.note} · quote gagal` : "quote gagal / likuiditas kurang";
      continue;
    }
    if (o && bu != null && inHuman > 0) {
      c.info.execUsd = (toHuman(o, c.base.decimals) * bu) / inHuman;
      const so = smallOut.get(c);
      const ref =
        so && so > BigInt(0) && inSmallHuman > 0 ? (toHuman(so, c.base.decimals) * bu) / inSmallHuman : c.info.midUsd;
      if (ref && ref > 0) c.info.impactPct = Math.max(0, ((ref - c.info.execUsd) / ref) * 100);
      if (c.info.midUsd == null && so && so > BigInt(0) && inSmallHuman > 0) {
        c.info.midUsd = (toHuman(so, c.base.decimals) * bu) / inSmallHuman;
      }
    }
  }

  // ---- CoW ----
  let cow: DexCowInfo | null = null;
  if (cfg.cowNetwork && amountIn > BigInt(0)) {
    const buy = tokenLc === cfg.weth.address.toLowerCase() ? cfg.bases.find((b) => b.symbol === "USDC")! : cfg.weth;
    const q = await cowQuote(cfg, contract, amountIn, buy);
    if ("buyAmount" in q) {
      const bu = baseUsd(buy);
      cow = {
        ok: true,
        buyToken: buy.symbol,
        execUsd: bu != null && inHuman > 0 ? (toHuman(q.buyAmount, buy.decimals) * bu) / inHuman : null,
      };
    } else {
      cow = { ok: false, buyToken: buy.symbol, execUsd: null, error: q.error };
    }
  } else if (cfg.cowNetwork) {
    cow = { ok: false, buyToken: cfg.weth.symbol, execUsd: null, error: "tanpa harga referensi" };
  }

  // ---- ringkasan (semua dari harga MID) ----
  const { best, gapPct } = summarizeMid(candidates.map((c) => c.info));
  const bestMid = best?.midUsd ?? null;
  const vsCowPct = bestMid != null && cow?.ok && cow.execUsd ? pct(bestMid, cow.execUsd) : null;

  const dexSet = new Set<DexId>();
  for (const c of candidates) if (!c.info.untradeable) dexSet.add(c.info.dex);
  if (cow?.ok) dexSet.add("cow");
  const order: DexId[] = ["univ3", "univ2", "sushi", "pancakev3", "pancakev2", "balancer", "cow"];

  const pools = candidates
    .map((c) => c.info)
    .sort(
      (a, b) =>
        Number(a.untradeable) - Number(b.untradeable) ||
        (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1) ||
        (b.midUsd ?? -1) - (a.midUsd ?? -1),
    );

  return {
    chain: chainKey,
    chainName: cfg.name,
    contract,
    symbol,
    decimals,
    sizeUsd,
    refUsd,
    refSource,
    pools,
    cow,
    bestDex: best?.dex ?? null,
    bestPool: best?.pool ?? null,
    bestExecUsd: bestMid,
    bestMidUsd: bestMid,
    gapPct,
    vsCowPct,
    dexes: order.filter((d) => dexSet.has(d)),
    fetchedAt: Date.now(),
    warnings,
  };
}

// ---------- simulasi beli/jual (on-demand dari tooltip) ----------

/**
 * Simulasi per pool pakai base token pool itu sendiri:
 * Jual = token -> base pool, Beli = base pool -> token. Ukuran = amountUsd.
 * V3 (Uni/Pancake): QuoterV2 quoteExactInputSingle dua arah. V2 (Uni/Sushi/Pancake): rumus constant-product
 * dari getReserves terbaru. Balancer: Vault.queryBatchSwap dua arah. Impact = quote penuh vs quote 1/100.
 * CoW: quote indikatif arah jual saja (Beli '–').
 */
export async function simulateDexPools(result: DexPoolsResult, side: DexSimSide, amountUsd: number): Promise<DexSimResult> {
  const chainKey = result.chain;
  const cfg = getDexChainConfig(chainKey);
  if (!cfg) throw new Error(`Chain ${chainKey} belum didukung`);
  const rpcUrl = getRpcUrl(chainKey);
  if (!rpcUrl) throw new Error(`${cfg.rpcEnv} belum diisi di .env`);
  const contract = result.contract;
  const decimals = result.decimals;
  const warnings: string[] = [];
  const rows: Record<string, DexSimRow> = {};
  const out: DexSimResult = {
    chain: chainKey,
    contract,
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
  const baseByAddr = new Map(cfg.bases.map((b) => [b.address.toLowerCase(), b]));

  type Job = { key: string; p: DexPoolInfo; base: BaseToken; kind: "v2" | "v3" | "balancer"; fee?: number; feeBps?: number; quoter?: string };
  const jobs: Job[] = [];
  for (const p of result.pools) {
    if (p.untradeable) continue;
    const base = baseByAddr.get(p.quoteToken.toLowerCase());
    if (!base) continue;
    const key = dexPoolKey(p);
    const v3 = cfg.v3.find((d) => d.id === p.dex);
    const v2 = cfg.v2.find((d) => d.id === p.dex);
    if (v3 && p.feePct != null) jobs.push({ key, p, base, kind: "v3", fee: Math.round(p.feePct * 10_000), quoter: v3.quoter });
    else if (v2) jobs.push({ key, p, base, kind: "v2", feeBps: Math.round((p.feePct ?? v2.feePct) * 100) });
    else if (p.dex === "balancer" && p.poolId && cfg.balancerVault) jobs.push({ key, p, base, kind: "balancer" });
  }

  // Ronde A: harga native terbaru + reserves V2 terbaru.
  const ra: Call[] = [];
  if (cfg.nativeUsdPool) ra.push({ target: cfg.nativeUsdPool.pool, data: enc.noArgs(SEL.slot0) });
  const v2Jobs = jobs.filter((j) => j.kind === "v2");
  for (const j of v2Jobs) ra.push({ target: j.p.pool, data: enc.noArgs(SEL.getReserves) });
  const resA = await multicall(rpcUrl, cfg, ra);
  let ethUsd: number | null = null;
  let ai = 0;
  if (cfg.nativeUsdPool) {
    const r = resA[ai++];
    if (r?.success) ethUsd = v3PriceInBase(readUint(r.data, 0), !cfg.nativeUsdPool.usdIsToken0, cfg.weth.decimals, cfg.nativeUsdPool.usdDecimals);
  }
  const baseUsd = (b: BaseToken): number | null => (b.stable ? 1 : b.address.toLowerCase() === cfg.weth.address.toLowerCase() ? ethUsd : null);
  const reserves = new Map<Job, { rt: bigint; rb: bigint }>();
  for (const j of v2Jobs) {
    const r = resA[ai++];
    if (!r?.success) continue;
    const r0 = readUint(r.data, 0);
    const r1 = readUint(r.data, 1);
    const tokenIs0 = isLower(contract, j.base.address);
    reserves.set(j, { rt: tokenIs0 ? r0 : r1, rb: tokenIs0 ? r1 : r0 });
  }

  const refUsd = result.refUsd;
  if (side === "sell" && !refUsd) warnings.push("Harga referensi tidak ada; simulasi jual dilewati");
  const amountsFor = (j: Job): { full: bigint; small: bigint; inHuman: number } | null => {
    const bu = baseUsd(j.base);
    if (bu == null) return null;
    if (side === "sell") {
      if (!refUsd) return null;
      const inHuman = amountUsd / refUsd;
      const full = fromHuman(inHuman, decimals);
      return { full, small: full / BigInt(100), inHuman };
    }
    const inHuman = amountUsd / bu;
    const full = fromHuman(inHuman, j.base.decimals);
    return { full, small: full / BigInt(100), inHuman };
  };
  const tokenIn = side === "sell" ? contract : null;

  // Ronde B: quote V3 + Balancer (penuh + 1/100).
  const rb: Call[] = [];
  const rbMap: Array<{ j: Job; small: boolean }> = [];
  const outs = new Map<Job, { full?: bigint; small?: bigint }>();
  for (const j of jobs) {
    const amts = amountsFor(j);
    if (!amts || amts.full === BigInt(0)) continue;
    const inAddr = tokenIn ?? j.base.address;
    const outAddr = side === "sell" ? j.base.address : contract;
    for (const small of [false, true]) {
      const amt = small ? amts.small : amts.full;
      if (amt === BigInt(0)) continue;
      if (j.kind === "v3" && j.quoter && j.fee != null) {
        rb.push({ target: j.quoter, data: enc.quoteExactInputSingle(inAddr, outAddr, amt, j.fee) });
        rbMap.push({ j, small });
      } else if (j.kind === "balancer" && cfg.balancerVault && j.p.poolId) {
        rb.push({ target: cfg.balancerVault, data: enc.queryBatchSwap(j.p.poolId, amt, inAddr, outAddr, cfg.multicall3) });
        rbMap.push({ j, small });
      } else if (j.kind === "v2") {
        const rs = reserves.get(j);
        if (!rs || rs.rt === BigInt(0) || rs.rb === BigInt(0)) continue;
        const [rIn, rOut] = side === "sell" ? [rs.rt, rs.rb] : [rs.rb, rs.rt];
        const fee = BigInt(Math.max(0, Math.min(10_000, j.feeBps ?? 30)));
        const inWithFee = amt * (BigInt(10_000) - fee);
        const o = (inWithFee * rOut) / (rIn * BigInt(10_000) + inWithFee);
        const cur = outs.get(j) ?? {};
        cur[small ? "small" : "full"] = o;
        outs.set(j, cur);
      }
    }
  }
  const resB = await multicall(rpcUrl, cfg, rb);
  resB.forEach((r, i) => {
    const { j, small } = rbMap[i];
    if (!r.success || !r.data) return;
    let o = BigInt(0);
    if (j.kind === "v3") o = readUint(r.data, 0);
    else {
      const deltas = readUintArrayAt(r.data, Number(readUint(r.data, 0)));
      const d1 = deltas[1] ?? BigInt(0);
      const signed = d1 >= BigInt(1) << BigInt(255) ? d1 - TWO_256 : d1;
      o = signed < BigInt(0) ? -signed : BigInt(0);
    }
    const cur = outs.get(j) ?? {};
    cur[small ? "small" : "full"] = o;
    outs.set(j, cur);
  });

  for (const j of jobs) {
    const amts = amountsFor(j);
    const bu = baseUsd(j.base);
    if (!amts || bu == null) {
      rows[j.key] = { execUsd: null, impactPct: null, result: null, note: bu == null ? `harga ${j.base.symbol} tidak ada` : "tanpa harga ref" };
      continue;
    }
    const o = outs.get(j);
    if (!o?.full || o.full === BigInt(0)) {
      rows[j.key] = { execUsd: null, impactPct: null, result: null, note: "quote gagal / likuiditas kurang" };
      continue;
    }
    const smallInHuman = amts.inHuman / 100;
    if (side === "sell") {
      const usd = toHuman(o.full, j.base.decimals) * bu;
      const exec = amts.inHuman > 0 ? usd / amts.inHuman : null;
      const smallExec = o.small && o.small > BigInt(0) && smallInHuman > 0 ? (toHuman(o.small, j.base.decimals) * bu) / smallInHuman : null;
      rows[j.key] = {
        execUsd: exec,
        result: usd,
        impactPct: exec != null && smallExec ? Math.max(0, ((smallExec - exec) / smallExec) * 100) : null,
      };
    } else {
      const tokens = toHuman(o.full, decimals);
      const exec = tokens > 0 ? amountUsd / tokens : null;
      const smallTokens = o.small ? toHuman(o.small, decimals) : 0;
      const smallExec = smallTokens > 0 ? amountUsd / 100 / smallTokens : null;
      rows[j.key] = {
        execUsd: exec,
        result: tokens,
        impactPct: exec != null && smallExec ? Math.max(0, ((exec - smallExec) / smallExec) * 100) : null,
      };
    }
  }

  // CoW: indikatif, arah jual saja.
  if (cfg.cowNetwork) {
    if (side === "buy") {
      out.cow = { execUsd: null, impactPct: null, result: null, note: "CoW: indikatif, simulasi beli tidak tersedia" };
    } else if (refUsd) {
      const tokenLc = contract.toLowerCase();
      const buy = tokenLc === cfg.weth.address.toLowerCase() ? cfg.bases.find((b) => b.symbol === "USDC")! : cfg.weth;
      const inHuman = amountUsd / refUsd;
      const q = await cowQuote(cfg, contract, fromHuman(inHuman, decimals), buy);
      const bu = baseUsd(buy);
      if ("buyAmount" in q && bu != null) {
        const usd = toHuman(q.buyAmount, buy.decimals) * bu;
        out.cow = { execUsd: inHuman > 0 ? usd / inHuman : null, impactPct: null, result: usd, note: "indikatif" };
      } else {
        out.cow = { execUsd: null, impactPct: null, result: null, note: "error" in q ? q.error : "tanpa harga" };
      }
    }
  }

  let bestVal = -1;
  for (const [key, row] of Object.entries(rows)) {
    if (row.result != null && row.result > bestVal) {
      bestVal = row.result;
      out.bestKey = key;
    }
  }
  if (out.cow?.result != null && out.cow.result > bestVal) out.bestKey = DEX_SIM_COW_KEY;
  return out;
}

// ---------- antrian + cache server ----------

export const DEX_CACHE_TTL_MS = 5 * 60_000;
const DEX_ERROR_TTL_MS = 60_000;
const SERVER_CONCURRENCY = 2;
const JOB_GAP_MS = 250;

type CacheEntry = { at: number; ttl: number; result?: DexPoolsResult; error?: string };
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<DexPoolsResult>>();
let active = 0;
let lastStart = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
  while (active >= SERVER_CONCURRENCY) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  active += 1;
  const wait = lastStart + JOB_GAP_MS - Date.now();
  lastStart = Math.max(Date.now(), lastStart + JOB_GAP_MS);
  if (wait > 0) await sleep(wait);
}

function release(): void {
  active -= 1;
  waiters.shift()?.();
}

export function dexCacheKey(chain: string, contract: string, sizeUsd: number): string {
  // Mint Solana case-sensitive (base58); alamat EVM tidak.
  const addr = chain === "SOL" ? contract.trim() : contract.trim().toLowerCase();
  return `${chain}|${addr}|${Math.round(sizeUsd * 100) / 100}`;
}

export async function getDexPools(
  chain: string,
  contract: string,
  opts: DetectOptions & { force?: boolean },
): Promise<{ result: DexPoolsResult; cached: boolean }> {
  const key = dexCacheKey(chain, contract, opts.sizeUsd);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && !opts.force && now - hit.at < hit.ttl) {
    if (hit.result) return { result: hit.result, cached: true };
    throw new Error(hit.error ?? "error");
  }
  const running = inflight.get(key);
  if (running) return { result: await running, cached: false };
  const job = (async () => {
    await acquire();
    try {
      return chain === "SOL" ? await detectSolanaPools(contract, opts) : await detectDexPools(chain, contract, opts);
    } finally {
      release();
    }
  })();
  inflight.set(key, job);
  try {
    const result = await job;
    cache.set(key, { at: Date.now(), ttl: DEX_CACHE_TTL_MS, result });
    if (cache.size > 2000) {
      const cutoff = Date.now() - DEX_CACHE_TTL_MS;
      for (const [k, v] of cache) if (v.at < cutoff) cache.delete(k);
    }
    return { result, cached: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/belum diisi/.test(message)) cache.set(key, { at: Date.now(), ttl: DEX_ERROR_TTL_MS, error: message });
    throw error;
  } finally {
    inflight.delete(key);
  }
}

// ---------- simulasi: cache singkat ----------

const SIM_CACHE_TTL_MS = 30_000;
const simCache = new Map<string, { at: number; sim: DexSimResult }>();
const simInflight = new Map<string, Promise<DexSimResult>>();

export async function getDexSim(
  chain: string,
  contract: string,
  side: DexSimSide,
  amountUsd: number,
  opts: DetectOptions,
): Promise<{ sim: DexSimResult; cached: boolean }> {
  const key = `${dexCacheKey(chain, contract, opts.sizeUsd)}|${side}|${Math.round(amountUsd * 100) / 100}`;
  const hit = simCache.get(key);
  if (hit && Date.now() - hit.at < SIM_CACHE_TTL_MS) return { sim: hit.sim, cached: true };
  const running = simInflight.get(key);
  if (running) return { sim: await running, cached: false };
  const job = (async () => {
    const { result } = await getDexPools(chain, contract, opts);
    await acquire();
    try {
      return chain === "SOL" ? await simulateSolanaPools(result, side, amountUsd) : await simulateDexPools(result, side, amountUsd);
    } finally {
      release();
    }
  })();
  simInflight.set(key, job);
  try {
    const sim = await job;
    simCache.set(key, { at: Date.now(), sim });
    if (simCache.size > 500) {
      const cutoff = Date.now() - SIM_CACHE_TTL_MS;
      for (const [k, v] of simCache) if (v.at < cutoff) simCache.delete(k);
    }
    return { sim, cached: false };
  } finally {
    simInflight.delete(key);
  }
}

// ---------- swap: quote + cek allowance/saldo + estimasi gas (read-only, RPC dari env) ----------

const SEL_ALLOWANCE = "dd62ed3e";
const SEL_APPROVE = "095ea7b3";
const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;

async function rpcRaw(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const json = (await postJson(rpcUrl, { jsonrpc: "2.0", id: rpcId++, method, params })) as {
    result?: unknown;
    error?: { message?: string };
  };
  if (json?.error) throw new Error(`RPC: ${(json.error.message ?? "error").slice(0, 200)}`);
  return json?.result;
}

export async function getSwapQuote(req: SwapQuoteRequest): Promise<SwapQuote> {
  if (!req || typeof req !== "object" || typeof req.amount !== "string" || (req.side !== "buy" && req.side !== "sell")) {
    throw new Error("Permintaan swap tidak valid");
  }
  const cfg = getDexChainConfig(req.chain);
  const sw = getSwapDex(req.chain, req.dex);
  if (!cfg || !sw) throw new Error("DEX/chain ini belum didukung untuk swap");
  const rpcUrl = getRpcUrl(req.chain);
  if (!rpcUrl) throw new Error(`${cfg.rpcEnv} belum diisi di .env`);
  if (!EVM_ADDR.test(req.contract) || !EVM_ADDR.test(req.pool) || !EVM_ADDR.test(req.quoteToken)) throw new Error("Alamat tidak valid");
  const owner = req.owner && EVM_ADDR.test(req.owner) ? req.owner : null;
  const base = cfg.bases.find((b) => b.address.toLowerCase() === req.quoteToken.toLowerCase());
  if (!base) throw new Error("Base token pool tidak dikenal");
  const fee = sw.dex.kind === "v3" ? (req.feePct != null ? Math.round(req.feePct * 10_000) : null) : null;
  if (sw.dex.kind === "v3" && (fee == null || !(fee > 0))) throw new Error("Fee tier pool V3 tidak diketahui");

  // Ronde 1: metadata token + verifikasi pool via factory.
  const r1: Call[] = [
    { target: req.contract, data: enc.noArgs(SEL.decimals) },
    { target: req.contract, data: enc.noArgs(SEL.symbol) },
    sw.dex.kind === "v2"
      ? { target: sw.dex.factory, data: enc.getPair(req.contract, base.address) }
      : { target: sw.dex.factory, data: enc.getPool(req.contract, base.address, fee!) },
  ];
  if (cfg.nativeUsdPool) r1.push({ target: cfg.nativeUsdPool.pool, data: enc.noArgs(SEL.slot0) });
  const res1 = await multicall(rpcUrl, cfg, r1);
  if (!res1[0]?.success || res1[0].data.length < 64) throw new Error("decimals() token gagal");
  const decimals = Number(readUint(res1[0].data, 0));
  const symbol = (res1[1]?.success ? decodeString(res1[1].data) : null) ?? "TOKEN";
  const poolFromFactory = res1[2]?.success ? readAddr(res1[2].data, 0) : ZERO_ADDRESS;
  const poolVerified = poolFromFactory.toLowerCase() === req.pool.toLowerCase();
  let nativeUsd: number | null = null;
  if (cfg.nativeUsdPool && res1[3]?.success) {
    nativeUsd = v3PriceInBase(readUint(res1[3].data, 0), !cfg.nativeUsdPool.usdIsToken0, cfg.weth.decimals, cfg.nativeUsdPool.usdDecimals);
  }

  const token = { address: req.contract, symbol, decimals };
  const baseMeta = { address: base.address, symbol: base.symbol, decimals: base.decimals };
  const tokenIn = req.side === "sell" ? token : baseMeta;
  const tokenOut = req.side === "sell" ? baseMeta : token;
  const amountIn = parseUnitsStr(req.amount, tokenIn.decimals);
  if (amountIn == null || amountIn <= BigInt(0)) throw new Error("Jumlah tidak valid");

  // Ronde 2: quote + allowance + saldo.
  const r2: Call[] = [];
  if (sw.dex.kind === "v2") {
    r2.push({ target: sw.dex.router, data: enc.getAmountsOut(amountIn, [tokenIn.address, tokenOut.address]) });
  } else {
    const quoter = cfg.v3.find((d) => d.id === req.dex)?.quoter;
    if (!quoter) throw new Error("Quoter V3 tidak ada");
    r2.push({ target: quoter, data: enc.quoteExactInputSingle(tokenIn.address, tokenOut.address, amountIn, fee!) });
  }
  if (owner) {
    r2.push({ target: tokenIn.address, data: "0x" + SEL_ALLOWANCE + wordAddr(owner) + wordAddr(sw.dex.router) });
    r2.push({ target: tokenIn.address, data: enc.balanceOf(owner) });
  }
  const [res2, gasPrice, nativeBal] = await Promise.all([
    multicall(rpcUrl, cfg, r2),
    rpcRaw(rpcUrl, "eth_gasPrice", []).catch(() => null),
    owner ? rpcRaw(rpcUrl, "eth_getBalance", [owner, "latest"]).catch(() => null) : Promise.resolve(null),
  ]);
  let amountOut = BigInt(0);
  const q = res2[0];
  if (q?.success && q.data) {
    if (sw.dex.kind === "v3") amountOut = readUint(q.data, 0);
    else {
      const amounts = readUintArrayAt(q.data, Number(readUint(q.data, 0)));
      amountOut = amounts[amounts.length - 1] ?? BigInt(0);
    }
  }
  if (amountOut <= BigInt(0)) throw new Error("Quote gagal (likuiditas kurang / pool tidak bisa dipakai)");
  const allowance = owner && res2[1]?.success ? readUint(res2[1].data, 0) : null;
  const balance = owner && res2[2]?.success ? readUint(res2[2].data, 0) : null;

  return {
    chain: req.chain,
    kind: sw.dex.kind,
    dex: req.dex,
    pool: req.pool,
    router: sw.dex.router,
    fee,
    tokenIn,
    tokenOut,
    amountInRaw: amountIn.toString(),
    amountOutRaw: amountOut.toString(),
    poolVerified,
    allowanceRaw: allowance != null ? allowance.toString() : null,
    balanceRaw: balance != null ? balance.toString() : null,
    nativeBalanceRaw: typeof nativeBal === "string" ? BigInt(nativeBal).toString() : null,
    gasPriceWei: typeof gasPrice === "string" ? BigInt(gasPrice).toString() : null,
    nativeUsd,
    fetchedAt: Date.now(),
  };
}

/** eth_estimateGas, dibatasi ke router swap yang dikenal atau approve() ke router itu. */
export async function estimateSwapGas(req: SwapGasRequest): Promise<{ gas: string; gasPriceWei: string | null }> {
  const chain = SWAP_CHAINS[req.chain as "ERC20" | "BEP20"];
  const cfg = getDexChainConfig(req.chain);
  if (!chain || !cfg) throw new Error("Chain tidak didukung");
  const rpcUrl = getRpcUrl(req.chain);
  if (!rpcUrl) throw new Error(`${cfg.rpcEnv} belum diisi di .env`);
  if (!EVM_ADDR.test(req.from) || !EVM_ADDR.test(req.to) || !/^0x[0-9a-fA-F]*$/.test(req.data)) throw new Error("Parameter tidak valid");
  const routers = new Set(Object.values(chain.dexes).map((d) => d!.router.toLowerCase()));
  const data = strip0x(req.data).toLowerCase();
  const isRouter = routers.has(req.to.toLowerCase());
  const isApprove = data.startsWith(SEL_APPROVE) && routers.has("0x" + data.slice(8 + 24, 8 + 64));
  if (!isRouter && !isApprove) throw new Error("Target transaksi tidak diizinkan");
  const [gas, gasPrice] = await Promise.all([
    rpcRaw(rpcUrl, "eth_estimateGas", [{ from: req.from, to: req.to, data: req.data }]),
    rpcRaw(rpcUrl, "eth_gasPrice", []).catch(() => null),
  ]);
  if (typeof gas !== "string") throw new Error("Estimasi gas gagal");
  return { gas: BigInt(gas).toString(), gasPriceWei: typeof gasPrice === "string" ? BigInt(gasPrice).toString() : null };
}
