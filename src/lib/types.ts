export type TokenContract = {
  chain: string;
  contract: string;
};

export type MarketInfo = {
  rawSymbol: string;
  base: string;
  quote: string;
  active: boolean;
  status?: string | null;
  depositEnabled?: number | null;
  withdrawEnabled?: number | null;
  chainstatusRaw?: string | null;
  /** undefined = tidak diubah saat upsert; [] = rantai ada tapi tanpa kontrak (native). */
  contracts?: TokenContract[];
  /** Token saham / xStock / rToken / Ondo. Filter bersama di fetch-service akan membuangnya. */
  isStock?: boolean;
  /** Token leverage (3L/3S, 5L/5S, UP/DOWN, BULL/BEAR). Filter bersama akan membuangnya. */
  isLeveraged?: boolean;
  /** Nama tampilan / fullName dari exchange, untuk cadangan deteksi token saham / leverage. */
  displayName?: string | null;
};

export type NormalizedTicker = {
  exchange: string;
  rawSymbol: string;
  base: string;
  quote: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  baseVolume24h: number | null;
  quoteVolume24h: number | null;
  change24hPct: number | null;
  exchangeTimestamp: string | null;
  fetchedAt: string;
};

export type DerivedTicker = NormalizedTicker & {
  spreadPct: number | null;
  lastVsMidPct: number | null;
  stale: boolean;
  staleReasons: string[];
};

export type OrderBookLevel = {
  price: number;
  volume: number;
  timestamp?: number | null;
};

export type NormalizedOrderBook = {
  exchange: string;
  rawSymbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  fetchedAt: string;
};

export type RawResponse = {
  endpoint: string;
  rawJson: string;
};

export type TickerFetchResult = {
  tickers: DerivedTicker[];
  markets: MarketInfo[];
  rawResponses: RawResponse[];
};

export type OrderBookFetchResult = {
  orderbook: NormalizedOrderBook;
  rawJson: string;
  endpoint: string;
};

export type ExchangeAdapter = {
  id: string;
  name: string;
  fetchTickers: () => Promise<TickerFetchResult>;
  fetchOrderBook: (rawSymbol: string, count?: number) => Promise<OrderBookFetchResult>;
  /** URL halaman spot pair, memakai base/quote yang sudah dinormalisasi. */
  spotUrl?: (base: string, quote: string) => string | null;
  /** Jumlah request paralel untuk langkah enrich opsional (default di enrich-service). */
  enrichConcurrency?: number;
  /** Rencana antrian bid/ask + deposit setelah fetch utama. */
  buildEnrichPlan?: (input: { tickers: DerivedTicker[]; markets: MarketInfo[] }) => EnrichPlan;
  enrichBidAsk?: (rawSymbol: string, signal: AbortSignal) => Promise<EnrichBidAskResult>;
  enrichDeposit?: (base: string, signal: AbortSignal) => Promise<EnrichDepositResult>;
};

export type EnrichPhase = "bidask" | "deposit" | "done";

export type EnrichPlan = {
  bidAsk: Array<{ rawSymbol: string; quoteVolume24h?: number | null }>;
  deposits: Array<{ base: string; quoteVolume24h?: number | null }>;
};

export type EnrichBidAskResult = {
  rawSymbol: string;
  bid: number | null;
  ask: number | null;
  bidSize?: number | null;
  askSize?: number | null;
};

export type EnrichNetworkStatus = {
  name: string;
  deposit: boolean | null;
  withdraw?: boolean | null;
};

export type EnrichDepositResult = {
  base: string;
  depositEnabled: number | null;
  /** Kalau tidak diisi, dihitung dari jaringan (terbuka kalau ada satu jaringan W✓). */
  withdrawEnabled?: number | null;
  networks: EnrichNetworkStatus[];
  /** undefined = jangan patch kontrak; [] = native / tanpa alamat. */
  contracts?: TokenContract[];
};

export type EnrichStatus = {
  exchange: string;
  running: boolean;
  done: number;
  total: number;
  phase: EnrichPhase | null;
  errors: number;
  startedAt: string | null;
  finishedAt: string | null;
};

export type FetchLogRow = {
  id: number;
  exchange: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  error_message: string | null;
  row_count: number | null;
};

export type TickerRow = {
  exchange: string;
  raw_symbol: string;
  base: string;
  quote: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
  bid_size: number | null;
  ask_size: number | null;
  base_volume_24h: number | null;
  quote_volume_24h: number | null;
  change_24h_pct: number | null;
  spread_pct: number | null;
  last_vs_mid_pct: number | null;
  stale: number;
  stale_reasons: string | null;
  deposit_enabled: number | null;
  withdraw_enabled: number | null;
  exchange_timestamp: string | null;
  fetched_at: string;
  status?: string | null;
  active?: number | null;
  chainstatus_raw?: string | null;
  contracts_json?: string | null;
  /** null = belum ada data; [] = native (ada info rantai, tanpa alamat). */
  contracts?: TokenContract[] | null;
};

export type OrderBookRow = {
  id: number;
  exchange: string;
  raw_symbol: string;
  bids: string;
  asks: string;
  fetched_at: string;
};
