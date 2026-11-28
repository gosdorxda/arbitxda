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
  /** DEX dengan harga eksekusi jual terbaik. */
  bestDex: DexId | null;
  bestPool: string | null;
  bestExecUsd: number | null;
  /** Selisih % harga eksekusi terbaik vs terburuk antar pool DEX tradable. */
  gapPct: number | null;
  /** Selisih % DEX terbaik vs CoW (positif = DEX lebih bagus). */
  vsCowPct: number | null;
  /** DEX yang punya pool/quote tradable. */
  dexes: DexId[];
  fetchedAt: number;
  warnings: string[];
};

export type DexPoolsResponse =
  | { ok: true; result: DexPoolsResult; cached: boolean }
  | { ok: false; code: "no-rpc" | "unsupported-chain" | "bad-request" | "error"; error: string };

/** Label chain (hasil shortChainLabel) yang punya detektor. */
export const DEX_SUPPORTED_CHAINS = ["ERC20", "BEP20", "SOL"] as const;

export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const SOLANA_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isValidDexAddress(chain: string, address: string): boolean {
  return chain === "SOL" ? SOLANA_MINT_RE.test(address) : EVM_ADDRESS_RE.test(address);
}
