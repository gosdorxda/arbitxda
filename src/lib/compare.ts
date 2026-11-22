import { sortByExchangeName } from "./format";
import type { TickerRow } from "./types";

export type CompareExchangeInfo = {
  id: string;
  name: string;
  pairCount: number;
};

export type CompareExchangeCell = {
  exchange: string;
  quote: string;
  last: number | null;
  quoteVolume24h: number | null;
  change24hPct: number | null;
  rawSymbol: string;
  base: string;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  spreadPct: number | null;
  lastVsMidPct: number | null;
  fetchedAt: string | null;
  depositEnabled: number | null;
  withdrawEnabled: number | null;
  chainstatusRaw: string | null;
  stale: number | null;
  contracts: TickerRow["contracts"];
};

export type CompareCoinEntry = {
  base: string;
  exchanges: Record<string, CompareExchangeCell>;
};

export type CompareIndex = {
  exchanges: CompareExchangeInfo[];
  byBase: Record<string, CompareCoinEntry>;
};

function quoteRank(quote: string): number {
  const value = quote.trim().toUpperCase();
  if (value === "USDT") return 0;
  if (value === "USD") return 1;
  return 2;
}

function pickPreferredTicker(rows: TickerRow[]): TickerRow {
  let best = rows[0]!;
  let bestRank = quoteRank(best.quote);
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i]!;
    const rank = quoteRank(row.quote);
    if (rank < bestRank) {
      best = row;
      bestRank = rank;
    }
  }
  return best;
}

function toCell(row: TickerRow): CompareExchangeCell {
  return {
    exchange: row.exchange,
    quote: row.quote,
    last: row.last,
    quoteVolume24h: row.quote_volume_24h,
    change24hPct: row.change_24h_pct,
    rawSymbol: row.raw_symbol,
    base: row.base,
    bid: row.bid,
    ask: row.ask,
    bidSize: row.bid_size,
    askSize: row.ask_size,
    spreadPct: row.spread_pct,
    lastVsMidPct: row.last_vs_mid_pct,
    fetchedAt: row.fetched_at ?? null,
    depositEnabled: row.deposit_enabled,
    withdrawEnabled: row.withdraw_enabled,
    chainstatusRaw: row.chainstatus_raw ?? null,
    stale: row.stale ?? null,
    contracts: row.contracts ?? null,
  };
}

/**
 * Peta per base (kunci uppercase, tampilan tetap seperti di DB).
 * Kalau satu exchange punya USD dan USDT untuk base yang sama, USDT yang dipakai.
 */
export function buildCompareIndex(
  tickers: TickerRow[],
  exchanges: Array<{ id: string; name: string }>,
): CompareIndex {
  const enabled = exchanges.map((item) => item.id.toLowerCase());
  const enabledSet = new Set(enabled);
  const grouped = new Map<string, { display: string; byExchange: Map<string, TickerRow[]> }>();

  for (const ticker of tickers) {
    const exchange = ticker.exchange.toLowerCase();
    if (!enabledSet.has(exchange)) continue;
    const display = (ticker.base ?? "").trim();
    if (!display) continue;
    const key = display.toUpperCase();
    let group = grouped.get(key);
    if (!group) {
      group = { display, byExchange: new Map() };
      grouped.set(key, group);
    }
    const list = group.byExchange.get(exchange);
    if (list) list.push(ticker);
    else group.byExchange.set(exchange, [ticker]);
  }

  const byBase: Record<string, CompareCoinEntry> = {};
  const counts = new Map<string, number>(enabled.map((id) => [id, 0]));

  for (const [key, group] of grouped) {
    const cells: Record<string, CompareExchangeCell> = {};
    for (const id of enabled) {
      const list = group.byExchange.get(id);
      if (!list || list.length === 0) continue;
      cells[id] = toCell(pickPreferredTicker(list));
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    if (Object.keys(cells).length === 0) continue;
    byBase[key] = { base: group.display, exchanges: cells };
  }

  return {
    exchanges: sortByExchangeName(
      exchanges.map((item) => ({
        id: item.id,
        name: item.name,
        pairCount: counts.get(item.id.toLowerCase()) ?? 0,
      })),
      (item) => item.name || item.id,
    ),
    byBase,
  };
}
