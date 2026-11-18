import type { DerivedTicker, NormalizedTicker } from "./types";

export function midPrice(bid: number | null, ask: number | null): number | null {
  if (bid == null || ask == null) return null;
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  // Bid/ask 0 dianggap tidak ada harga, supaya spread 200% palsu tidak muncul.
  if (bid === 0 || ask === 0) return null;
  return (ask + bid) / 2;
}

export function spreadPct(bid: number | null, ask: number | null): number | null {
  const mid = midPrice(bid, ask);
  if (mid == null || mid === 0) return null;
  return ((ask as number) - (bid as number)) / mid * 100;
}

export function lastVsMidPct(
  last: number | null,
  bid: number | null,
  ask: number | null,
): number | null {
  const mid = midPrice(bid, ask);
  if (mid == null || mid === 0 || last == null || !Number.isFinite(last)) return null;
  return (last - mid) / mid * 100;
}

export function staleInfo(ticker: Pick<NormalizedTicker, "last" | "bid" | "ask" | "baseVolume24h">): {
  stale: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (ticker.bid == null || ticker.bid === 0) reasons.push("bid kosong/0");
  if (ticker.ask == null || ticker.ask === 0) reasons.push("ask kosong/0");
  if (ticker.baseVolume24h == null || ticker.baseVolume24h === 0) reasons.push("volume 0");
  if (ticker.last == null) reasons.push("last kosong");
  return { stale: reasons.length > 0, reasons };
}

export function withDerivedFields(ticker: NormalizedTicker): DerivedTicker {
  const { stale, reasons } = staleInfo(ticker);
  return {
    ...ticker,
    spreadPct: spreadPct(ticker.bid, ticker.ask),
    lastVsMidPct: lastVsMidPct(ticker.last, ticker.bid, ticker.ask),
    stale,
    staleReasons: reasons,
  };
}

/** Warna selisih: hijau < 0,5%, kuning <= 2%, merah > 2%. Pakai nilai absolut. */
export function deviationColor(value: number | null): "green" | "yellow" | "red" | "none" {
  if (value == null || !Number.isFinite(value)) return "none";
  const abs = Math.abs(value);
  if (abs < 0.5) return "green";
  if (abs <= 2) return "yellow";
  return "red";
}
