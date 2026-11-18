import type { EnrichNetworkStatus } from "./types";

type ChainFlags = {
  deposit: boolean | null;
  withdraw: boolean | null;
};

function parseFlag(token: string | undefined): boolean | null {
  if (!token) return null;
  if (token === "✓") return true;
  if (token === "✗") return false;
  return null;
}

function formatFlag(prefix: "D" | "W", value: boolean | null): string {
  if (value == null) return "";
  return ` ${prefix}${value ? "✓" : "✗"}`;
}

export function parseChainStatus(raw: string | null | undefined): Map<string, ChainFlags> {
  const map = new Map<string, ChainFlags>();
  if (!raw) return map;
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const matched = trimmed.match(/^(.+?):\s*(?:D([✓✗?\-]))?\s*(?:W([✓✗?\-]))?\s*$/i);
    if (!matched) continue;
    const name = matched[1].trim().toUpperCase();
    if (!name) continue;
    map.set(name, {
      deposit: parseFlag(matched[2]),
      withdraw: parseFlag(matched[3]),
    });
  }
  return map;
}

export function formatChainStatus(map: Map<string, ChainFlags>): string {
  const parts: string[] = [];
  for (const [name, flags] of map) {
    const text = `${name}:${formatFlag("D", flags.deposit)}${formatFlag("W", flags.withdraw)}`;
    if (text.endsWith(":")) continue;
    parts.push(text);
  }
  return parts.join(", ");
}

export function mergeChainStatus(
  existingRaw: string | null | undefined,
  networks: EnrichNetworkStatus[],
): string {
  const map = parseChainStatus(existingRaw);
  for (const network of networks) {
    const name = (network.name || "?").trim().toUpperCase() || "?";
    const previous = map.get(name) ?? { deposit: null, withdraw: null };
    if (network.deposit != null) previous.deposit = network.deposit;
    if (network.withdraw != null) previous.withdraw = network.withdraw;
    map.set(name, previous);
  }
  return formatChainStatus(map);
}

/** Status level koin dari daftar jaringan: 1 kalau ada jaringan terbuka, 0 kalau semua tertutup, null kalau tidak ada data. */
export function aggregateChainFlag(raw: string | null | undefined, side: "deposit" | "withdraw"): number | null {
  let sawClosed = false;
  for (const flags of parseChainStatus(raw).values()) {
    const value = flags[side];
    if (value === true) return 1;
    if (value === false) sawClosed = true;
  }
  return sawClosed ? 0 : null;
}
