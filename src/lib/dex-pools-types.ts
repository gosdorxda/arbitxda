/** Tipe bersama (server + client) untuk kolom DEX Pools. */

export type DexId =
  | "univ2"
  | "univ3"
  | "sushi"
  | "balancer"
  | "cow"
  | "pancakev2"
  | "pancakev3"
  | "raydium"
  | "orca";

export const DEX_LABELS: Record<DexId, string> = {
  univ2: "Uni V2",
  univ3: "Uni V3",
  sushi: "Sushi",
  balancer: "Balancer",
  cow: "CoW",
  pancakev2: "Pancake V2",
  pancakev3: "Pancake V3",
  raydium: "Raydium",
  orca: "Orca",
};

export type DexPoolInfo = {
  dex: DexId;
  /** Alamat pool (V2 pair / V3 pool / Balancer pool). */
  pool: string;
  /** Balancer poolId (bytes32), kalau ada. */
  poolId?: string;
  /** Label pair, mis. "UNI/WETH". */
  pair: string;
  /** Alamat kontrak lawan (base token: WETH/USDC/USDT/DAI). */
  quoteToken: string;
  quoteSymbol: string;
  /** Fee tier dalam persen (0.3 = 0.3%). */
  feePct: number | null;
  /** Reserve/saldo token di pool (unit manusia). */
  reserveToken: number | null;
  /** Reserve/saldo base token di pool (unit manusia). */
  reserveQuote: number | null;
  /** Estimasi likuiditas sisi base dalam USD. */
  liquidityUsd: number | null;
  /** V3: liquidity() mentah (string). */
  v3Liquidity?: string;
  /** Harga mid pool (USD per token), kalau bisa dihitung. */
  midUsd: number | null;
  /** Harga eksekusi riil jual token sebesar sizeUsd (USD per token). */
  execUsd: number | null;
  /** Price impact % (positif = lebih buruk) dibanding quote kecil. */
  impactPct: number | null;
  untradeable: boolean;
  note?: string;
};

export type DexCowInfo = {
  ok: boolean;
  execUsd: number | null;
  buyToken: string;
  error?: string;
};

export type DexPoolsResult = {
  chain: string;
  /** Nama chain untuk tampilan (Ethereum / BNB Smart Chain / Solana). */
  chainName?: string;
  contract: string;
  symbol: string | null;
  decimals: number | null;
  sizeUsd: number;
  /** Harga referensi token (USD) untuk menentukan ukuran trade. */
  refUsd: number | null;
  refSource: string | null;
  pools: DexPoolInfo[];
  cow: DexCowInfo | null;
  /** DEX dengan harga mid terbaik (tertinggi) antar DEX. */
  bestDex: DexId | null;
  bestPool: string | null;
  /** Harga mid pool terbaik (USD). Nama lama dipertahankan untuk kompatibilitas. */
  bestExecUsd: number | null;
  bestMidUsd?: number | null;
  /** Selisih % harga mid terbaik vs terburuk antar DEX. */
  gapPct: number | null;
  /** Selisih % mid DEX terbaik vs quote CoW (positif = DEX lebih tinggi). */
  vsCowPct: number | null;
  /** DEX yang punya pool/quote tradable. */
  dexes: DexId[];
  fetchedAt: number;
  warnings: string[];
};

export type DexPoolsResponse =
  | { ok: true; result: DexPoolsResult; cached: boolean }
  | { ok: false; code: "no-rpc" | "unsupported-chain" | "bad-request" | "error"; error: string };

/** Pool di bawah likuiditas ini tidak ikut menentukan Best DEX / Gap (mid pool kering sering ngaco). */
const SUMMARY_MIN_LIQ_USD = 1_000;

/**
 * Best-per-DEX dari harga MID: per DEX ambil mid tertinggi di antara pool tradable yang likuiditasnya
 * >= SUMMARY_MIN_LIQ_USD (kalau tidak ada, pakai pool terdalam DEX itu). Lalu bandingkan antar DEX.
 */
export function summarizeMid(pools: DexPoolInfo[]): { best: DexPoolInfo | null; gapPct: number | null } {
  const byDex = new Map<DexId, DexPoolInfo[]>();
  for (const p of pools) {
    if (p.untradeable || p.midUsd == null || !(p.midUsd > 0)) continue;
    const list = byDex.get(p.dex) ?? [];
    list.push(p);
    byDex.set(p.dex, list);
  }
  const reps: DexPoolInfo[] = [];
  for (const list of byDex.values()) {
    const deep = list.filter((p) => (p.liquidityUsd ?? 0) >= SUMMARY_MIN_LIQ_USD);
    const pick = deep.length
      ? deep.reduce((a, b) => ((b.midUsd ?? 0) > (a.midUsd ?? 0) ? b : a))
      : list.reduce((a, b) => ((b.liquidityUsd ?? -1) > (a.liquidityUsd ?? -1) ? b : a));
    reps.push(pick);
  }
  let best: DexPoolInfo | null = null;
  let worst: DexPoolInfo | null = null;
  for (const p of reps) {
    if (!best || (p.midUsd ?? 0) > (best.midUsd ?? 0)) best = p;
    if (!worst || (p.midUsd ?? 0) < (worst.midUsd ?? 0)) worst = p;
  }
  const gapPct = best && worst && best !== worst ? ((best.midUsd! - worst.midUsd!) / worst.midUsd!) * 100 : null;
  return { best, gapPct };
}

// ---------- simulasi beli/jual (on-demand dari tooltip) ----------

export type DexSimSide = "buy" | "sell";

export type DexSimRow = {
  /** Harga eksekusi riil (USD per token) untuk ukuran simulasi. */
  execUsd: number | null;
  /** Price impact % (positif = lebih buruk) vs quote 1/100 ukuran. */
  impactPct: number | null;
  /** Jual: USD diterima; Beli: jumlah token diterima. */
  result: number | null;
  note?: string;
};

export type DexSimResult = {
  chain: string;
  contract: string;
  side: DexSimSide;
  amountUsd: number;
  resultUnit: "USD" | "TOKEN";
  /** Key = dexPoolKey(pool). */
  rows: Record<string, DexSimRow>;
  cow: DexSimRow | null;
  bestKey: string | null;
  fetchedAt: number;
  warnings: string[];
};

export type DexSimResponse =
  | { ok: true; sim: DexSimResult; cached: boolean }
  | { ok: false; code: "no-rpc" | "unsupported-chain" | "bad-request" | "error"; error: string };

export const DEX_SIM_COW_KEY = "cow";

export function dexPoolKey(p: Pick<DexPoolInfo, "dex" | "pool" | "pair">): string {
  return `${p.dex}:${p.pool}:${p.pair}`;
}

/** Label chain (hasil shortChainLabel) yang punya detektor. */
export const DEX_SUPPORTED_CHAINS = ["ERC20", "BEP20", "SOL"] as const;

export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const SOLANA_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isValidDexAddress(chain: string, address: string): boolean {
  return chain === "SOL" ? SOLANA_MINT_RE.test(address) : EVM_ADDRESS_RE.test(address);
}
