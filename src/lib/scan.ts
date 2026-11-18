/** Scanner arbitrase lintas exchange, dihitung dari data DB (tickers_latest) saja. */
import { buildAlsoOnIndex, type AlsoOnPeer } from "@/lib/also-on";
import { aggregateChainFlag } from "@/lib/chainstatus";
import type { TickerRow } from "@/lib/types";

export type ScanPriceMode = "bidask" | "last";
export type ScanFundingMode = "all" | "mark" | "hide";

export type ScanSettings = {
  priceMode: ScanPriceMode;
  minGapPct: number;
  maxGapPct: number;
  minVolUsd: number;
  funding: ScanFundingMode;
  /** Kosong = semua exchange aktif. */
  exchanges: string[];
  onlyFavorites: boolean;
};

export const DEFAULT_SCAN_SETTINGS: ScanSettings = {
  priceMode: "bidask",
  minGapPct: 0.5,
  maxGapPct: 20,
  minVolUsd: 0,
  funding: "mark",
  exchanges: [],
  onlyFavorites: false,
};

export const SCAN_RESULT_CAP = 2000;

export type ScanLeg = {
  exchange: string;
  exchangeName: string;
  rawSymbol: string;
  base: string;
  quote: string;
  price: number;
  volUsd: number | null;
  depositEnabled: number | null;
  withdrawEnabled: number | null;
  chainstatusRaw: string | null;
  fetchedAt: string;
};

export type ScanResult = {
  base: string;
  buy: ScanLeg;
  sell: ScanLeg;
  gapPct: number;
  /** Sisi beli WD tutup atau sisi jual Depo tutup (null = belum diketahui, dianggap tidak tutup). */
  fundingBlocked: boolean;
};

export type ScanResponse = {
  results: ScanResult[];
  total: number;
  capped: boolean;
  coinsScanned: number;
  /** Jumlah coin yang punya minimal 1 peluang (sebelum cap). */
  coinsFound: number;
  exchangesScanned: number;
  durationMs: number;
};

function num(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export function parseScanSettings(input: unknown): ScanSettings {
  const body = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const d = DEFAULT_SCAN_SETTINGS;
  return {
    priceMode: body.priceMode === "last" ? "last" : "bidask",
    minGapPct: num(body.minGapPct, d.minGapPct),
    maxGapPct: num(body.maxGapPct, d.maxGapPct),
    minVolUsd: Math.max(0, num(body.minVolUsd, d.minVolUsd)),
    funding: body.funding === "all" || body.funding === "hide" || body.funding === "mark" ? body.funding : d.funding,
    exchanges: Array.isArray(body.exchanges)
      ? body.exchanges.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim())
      : [],
    onlyFavorites: body.onlyFavorites === true,
  };
}

function positive(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function pairKey(exchange: string, rawSymbol: string): string {
  return `${exchange}\t${rawSymbol}`;
}

export function runScan(
  tickers: TickerRow[],
  options: {
    settings: ScanSettings;
    enabled: { id: string; name: string }[];
    blacklist: { exchange: string; raw_symbol: string }[];
    favorites: { exchange: string; raw_symbol: string }[];
  },
): ScanResponse {
  const started = Date.now();
  const { settings } = options;
  const include = new Set(settings.exchanges);
  const enabledIds = new Set(
    options.enabled.map((e) => e.id).filter((id) => include.size === 0 || include.has(id)),
  );
  const namesById: Record<string, string> = {};
  for (const e of options.enabled) namesById[e.id] = e.name;
  const blocked = new Set(options.blacklist.map((b) => pairKey(b.exchange, b.raw_symbol)));
  const favorited = new Set(options.favorites.map((f) => pairKey(f.exchange, f.raw_symbol)));

  // Index sama dengan "Ada di": 1 ticker per exchange per coin (USDT > USD), blacklist dilewati.
  // enabledIds kosong di buildAlsoOnIndex berarti "semua", jadi tangani filter kosong di sini.
  if (enabledIds.size === 0) {
    return { results: [], total: 0, capped: false, coinsScanned: 0, coinsFound: 0, exchangesScanned: 0, durationMs: Date.now() - started };
  }
  const index = buildAlsoOnIndex(tickers, { enabledIds, namesById, blocked });

  const fetchedAt = new Map<string, string>();
  for (const row of tickers) fetchedAt.set(pairKey(row.exchange, row.raw_symbol), row.fetched_at);

  const toLeg = (peer: AlsoOnPeer, price: number): ScanLeg => ({
    exchange: peer.exchange,
    exchangeName: peer.exchangeName,
    rawSymbol: peer.rawSymbol,
    base: peer.base,
    quote: peer.quote,
    price,
    volUsd: peer.quoteVolume24h,
    depositEnabled: peer.depositEnabled,
    withdrawEnabled: peer.withdrawEnabled,
    chainstatusRaw: peer.chainstatusRaw,
    fetchedAt: fetchedAt.get(pairKey(peer.exchange, peer.rawSymbol)) ?? "",
  });

  const results: ScanResult[] = [];
  let coinsScanned = 0;
  for (const [base, peers] of index) {
    if (peers.length < 2) continue;
    coinsScanned += 1;
    for (const a of peers) {
      // a = sisi beli
      const buyPrice = settings.priceMode === "last" ? positive(a.last) : positive(a.ask);
      if (buyPrice == null) continue;
      if (settings.minVolUsd > 0 && (a.quoteVolume24h ?? 0) < settings.minVolUsd) continue;
      for (const b of peers) {
        if (b.exchange === a.exchange) continue;
        const sellPrice = settings.priceMode === "last" ? positive(b.last) : positive(b.bid);
        if (sellPrice == null) continue;
        if (settings.minVolUsd > 0 && (b.quoteVolume24h ?? 0) < settings.minVolUsd) continue;
        const gap = ((sellPrice - buyPrice) / buyPrice) * 100;
        if (!Number.isFinite(gap) || gap <= 0) continue;
        if (gap < settings.minGapPct || gap > settings.maxGapPct) continue;
        if (
          settings.onlyFavorites &&
          !favorited.has(pairKey(a.exchange, a.rawSymbol)) &&
          !favorited.has(pairKey(b.exchange, b.rawSymbol))
        ) {
          continue;
        }
        const wd = a.withdrawEnabled ?? aggregateChainFlag(a.chainstatusRaw, "withdraw");
        const depo = b.depositEnabled ?? aggregateChainFlag(b.chainstatusRaw, "deposit");
        const fundingBlocked = wd === 0 || depo === 0;
        if (settings.funding === "hide" && fundingBlocked) continue;
        results.push({ base, buy: toLeg(a, buyPrice), sell: toLeg(b, sellPrice), gapPct: gap, fundingBlocked });
      }
    }
  }

  results.sort((x, y) => y.gapPct - x.gapPct);
  const total = results.length;
  // Cap per coin: coin diurutkan dari gap terbaiknya, semua peluang satu coin selalu ikut utuh.
  let kept = results;
  if (total > SCAN_RESULT_CAP) {
    const byCoin = new Map<string, ScanResult[]>();
    for (const r of results) {
      const list = byCoin.get(r.base);
      if (list) list.push(r);
      else byCoin.set(r.base, [r]);
    }
    kept = [];
    for (const list of byCoin.values()) {
      if (kept.length > 0 && kept.length + list.length > SCAN_RESULT_CAP) break;
      kept.push(...list);
    }
  }
  const coinsFound = new Set(results.map((r) => r.base)).size;
  return {
    results: kept,
    total,
    capped: kept.length < total,
    coinsScanned,
    coinsFound,
    exchangesScanned: enabledIds.size,
    durationMs: Date.now() - started,
  };
}
