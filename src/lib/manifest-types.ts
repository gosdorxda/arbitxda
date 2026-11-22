/** Shared types for the Manifest Trade page (safe to import from client components). */

export const MANIFEST_TRADE_URL = "https://app.manifest.trade/market";
export const MANIFEST_STATS_BASE = "https://mfx-stats-mainnet.fly.dev";
export const MANIFEST_DUST_USD = 100;
export const MANIFEST_PAGE_SIZE = 50;

/** Quotes that are already ~1 USD, so last/bid/ask need no SOL-style conversion. */
export const USD_LIKE_QUOTES = new Set([
  "USD",
  "USDT",
  "USDC",
  "PYUSD",
  "USDG",
  "USD1",
  "USDV",
  "HYUSD",
  "CASH",
  "JUPUSD",
  "RLUSD",
  "DAI",
  "USDS",
]);

export function isUsdLikeQuote(symbol?: string | null, quoteUsd?: number | null): boolean {
  const value = (symbol ?? "").trim().toUpperCase();
  if (value && USD_LIKE_QUOTES.has(value)) return true;
  if (quoteUsd != null && Number.isFinite(quoteUsd) && quoteUsd >= 0.98 && quoteUsd <= 1.02) return true;
  return false;
}

export type ManifestSolRate = {
  price: number;
  source: string;
  fetchedAt: string;
};

export type ManifestCexGap = {
  symbol: string;
  exchange: string;
  quote: string;
  rawSymbol: string;
  spotUrl: string | null;
  cexPriceUsd: number;
  manifestPriceUsd: number;
  gapPct: number;
  /** Harga CEX dipasangkan hanya lewat symbol, bukan mint/kontrak. */
  symbolMatchOnly: true;
};

export type ManifestMarket = {
  tickerId: string;
  baseMint: string;
  quoteMint: string;
  baseSymbol: string;
  quoteSymbol: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
  spreadPct: number | null;
  lastUsd: number | null;
  bidUsd: number | null;
  askUsd: number | null;
  quoteUsd: number | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  tradeUrl: string;
};

export type ManifestTokenGroup = {
  baseMint: string;
  symbol: string;
  name: string | null;
  marketCount: number;
  volume24hUsd: number;
  priceUsd: number | null;
  cexGap: ManifestCexGap | null;
  markets: ManifestMarket[];
};

export type ManifestSnapshotOk = {
  ok: true;
  fetchedAt: string;
  cached: boolean;
  stale: boolean;
  /** True when a background refresh of the official Manifest API is in flight. */
  refreshing: boolean;
  warning: string | null;
  source: string;
  solRate: ManifestSolRate | null;
  stats: {
    rawMarkets: number;
    keptMarkets: number;
    droppedStockMarkets: number;
    tokens: number;
    stockFilterApplied: boolean;
  };
  tokens: ManifestTokenGroup[];
};

export type ManifestSnapshotErr = {
  ok: false;
  error: string;
  status: number | null;
  fetchedAt: string;
  source: string;
};

export type ManifestSnapshot = ManifestSnapshotOk | ManifestSnapshotErr;

export type ManifestDepthItem = {
  tickerId: string;
  bidUsd: number | null;
  askUsd: number | null;
  ok: boolean;
};

export type ManifestOrderBookLevel = {
  price: number;
  volume: number;
};

export type ManifestOrderBook = {
  tickerId: string;
  bids: ManifestOrderBookLevel[];
  asks: ManifestOrderBookLevel[];
  baseSymbol: string;
  quoteSymbol: string;
  quoteMint: string | null;
  quoteUsd: number | null;
  fetchedAt: string;
};
