import type { TokenContract } from "./types";

const CHAIN_ALIASES: Record<string, string> = {
  "BEP20(BSC)": "BEP20",
  "BEP20 (BSC)": "BEP20",
  BSC: "BEP20",
  "BINANCE SMART CHAIN": "BEP20",
  BEP2: "BEP2",
  ERC20: "ERC20",
  ETH: "ERC20",
  ETHEREUM: "ERC20",
  TRC20: "TRC20",
  TRX: "TRC20",
  TRON: "TRC20",
  SOLANA: "SOL",
  SOL: "SOL",
  SPL: "SOL",
  POLYGON: "POLYGON",
  MATIC: "POLYGON",
  "ARBITRUM ONE": "ARB",
  ARBITRUM: "ARB",
  ARB: "ARB",
  "BASE MAINNET": "BASE",
  BASE: "BASE",
  OPTIMISM: "OP",
  OP: "OP",
  "C-CHAIN": "AVAX",
  "AVAX C-CHAIN": "AVAX",
  AVALANCHE: "AVAX",
  AVAX: "AVAX",
  TON: "TON",
  TONCOIN: "TON",
  NEAR: "NEAR",
  APTOS: "APTOS",
  SUI: "SUI",
  "OKC": "OKC",
  "OKT": "OKC",
};

export function shortChainLabel(chain: string): string {
  const raw = chain.trim().toUpperCase().replace(/\s+/g, " ");
  if (!raw) return "?";
  if (CHAIN_ALIASES[raw]) return CHAIN_ALIASES[raw];
  const standard = raw.match(/^(BEP20|ERC20|TRC20|BEP2|SPL)\b/);
  if (standard) return standard[1];
  return raw.replace(/\s+MAINNET$/, "").replace(/[()]/g, "").trim() || "?";
}

export function normalizeContracts(
  rows: Array<{ chain?: string | null; contract?: string | null }>,
): TokenContract[] {
  const out: TokenContract[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const contract = (row.contract ?? "").trim();
    if (!contract) continue;
    const chain = (row.chain ?? "").trim() || "?";
    const key = `${chain.toUpperCase()}|${contract}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ chain, contract });
  }
  return out;
}

/** null = belum ada data; array (boleh kosong) = exchange sudah memberi info rantai. */
export function parseContractsJson(raw: string | null | undefined): TokenContract[] | null {
  if (raw == null || raw === "") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return normalizeContracts(
      parsed.map((item) => {
        if (!item || typeof item !== "object") return {};
        const row = item as { chain?: unknown; contract?: unknown };
        return {
          chain: typeof row.chain === "string" ? row.chain : null,
          contract: typeof row.contract === "string" ? row.contract : null,
        };
      }),
    );
  } catch {
    return null;
  }
}

export function serializeContracts(contracts: TokenContract[] | undefined): string | null {
  if (contracts === undefined) return null;
  return JSON.stringify(contracts);
}
