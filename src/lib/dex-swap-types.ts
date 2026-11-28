/**
 * Konfigurasi + tipe bersama (server + client) untuk fitur Swap langsung ke satu pool DEX.
 * Single-pool saja (tanpa routing): V2 = swapExactTokensForTokens path [tokenIn, tokenOut],
 * V3 = exactInputSingle dengan fee tier pool (dibungkus multicall(deadline, data)).
 * Semua tanda tangan di MetaMask; app tidak pernah memegang private key.
 */
import type { DexId, DexSimSide } from "./dex-pools-types";

export type SwapKind = "v2" | "v3";

export type SwapDexConfig = { kind: SwapKind; router: string; factory: string };

export type SwapChainConfig = {
  key: "ERC20" | "BEP20";
  name: string;
  chainIdHex: string;
  chainId: number;
  nativeSymbol: string;
  explorer: string;
  dexes: Partial<Record<DexId, SwapDexConfig>>;
};

/** Alamat router resmi (dokumentasi Uniswap / Sushi / PancakeSwap). Factory sama dengan dex-pools.ts. */
export const SWAP_CHAINS: Record<"ERC20" | "BEP20", SwapChainConfig> = {
  ERC20: {
    key: "ERC20",
    name: "Ethereum",
    chainIdHex: "0x1",
    chainId: 1,
    nativeSymbol: "ETH",
    explorer: "https://etherscan.io",
    dexes: {
      univ2: { kind: "v2", router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f" },
      sushi: { kind: "v2", router: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F", factory: "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac" },
      // Uniswap SwapRouter02 (exactInputSingle tanpa deadline di struct; deadline via multicall)
      univ3: { kind: "v3", router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984" },
    },
  },
  BEP20: {
    key: "BEP20",
    name: "BNB Smart Chain",
    chainIdHex: "0x38",
    chainId: 56,
    nativeSymbol: "BNB",
    explorer: "https://bscscan.com",
    dexes: {
      pancakev2: { kind: "v2", router: "0x10ED43C718714eb63d5aA57B78B54704E256024E", factory: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73" },
      // PancakeSwap V3 SmartRouter (antarmuka IV3SwapRouter sama dengan SwapRouter02)
      pancakev3: { kind: "v3", router: "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4", factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865" },
    },
  },
};

/** Parameter wallet_addEthereumChain (hanya dipakai kalau MetaMask belum punya BSC). RPC publik resmi BNB Chain. */
export const ADD_CHAIN_PARAMS: Record<string, unknown> = {
  "0x38": {
    chainId: "0x38",
    chainName: "BNB Smart Chain",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: ["https://bsc-dataseed.bnbchain.org"],
    blockExplorerUrls: ["https://bscscan.com"],
  },
};

export function getSwapDex(chain: string, dex: DexId): { chain: SwapChainConfig; dex: SwapDexConfig } | null {
  const c = SWAP_CHAINS[chain as "ERC20" | "BEP20"];
  const d = c?.dexes[dex];
  return c && d ? { chain: c, dex: d } : null;
}

export function isSwapEligible(chain: string, dex: DexId): boolean {
  return getSwapDex(chain, dex) != null;
}

export type SwapQuoteRequest = {
  chain: string;
  contract: string;
  dex: DexId;
  pool: string;
  quoteToken: string;
  feePct: number | null;
  side: DexSimSide;
  /** Jumlah tokenIn dalam unit manusia (string desimal). Jual = token, Beli = base pool. */
  amount: string;
  owner?: string | null;
};

export type SwapTokenMeta = { address: string; symbol: string; decimals: number };

export type SwapQuote = {
  chain: string;
  kind: SwapKind;
  dex: DexId;
  pool: string;
  router: string;
  fee: number | null;
  tokenIn: SwapTokenMeta;
  tokenOut: SwapTokenMeta;
  amountInRaw: string;
  amountOutRaw: string;
  /** Pool hasil factory.getPair / getPool cocok dengan pool yang dipilih. */
  poolVerified: boolean;
  allowanceRaw: string | null;
  balanceRaw: string | null;
  nativeBalanceRaw: string | null;
  gasPriceWei: string | null;
  nativeUsd: number | null;
  fetchedAt: number;
};

export type SwapQuoteResponse = { ok: true; quote: SwapQuote } | { ok: false; error: string };

export type SwapGasRequest = { chain: string; from: string; to: string; data: string };
export type SwapGasResponse = { ok: true; gas: string; gasPriceWei: string | null } | { ok: false; error: string };

/** "1.5" -> raw bigint dengan desimal tertentu (tanpa pembulatan float). */
export function parseUnitsStr(value: string, decimals: number): bigint | null {
  const v = value.trim().replace(",", ".");
  if (!/^\d*\.?\d*$/.test(v) || v === "" || v === ".") return null;
  const [i, f = ""] = v.split(".");
  if (f.length > decimals) return BigInt((i || "0") + f.slice(0, decimals));
  return BigInt((i || "0") + f.padEnd(decimals, "0"));
}

export function formatUnitsStr(raw: string | bigint, decimals: number, maxFrac = 8): string {
  const big = typeof raw === "bigint" ? raw : BigInt(raw);
  const neg = big < BigInt(0);
  const s = (neg ? -big : big).toString().padStart(decimals + 1, "0");
  const i = s.slice(0, s.length - decimals);
  let f = s.slice(s.length - decimals).replace(/0+$/, "");
  if (f.length > maxFrac) {
    // pertahankan angka signifikan untuk nilai kecil
    const lead = f.match(/^0*/)?.[0].length ?? 0;
    f = f.slice(0, Math.max(maxFrac, Math.min(lead + 4, decimals)));
    f = f.replace(/0+$/, "");
  }
  return `${neg ? "-" : ""}${i}${f ? "." + f : ""}`;
}
