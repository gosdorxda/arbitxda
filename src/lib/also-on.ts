import type { TickerRow } from "@/lib/types";

export type AlsoOnPeer = {
  exchange: string;
  exchangeName: string;
  rawSymbol: string;
  base: string;
  quote: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
  change24hPct: number | null;
  spreadPct: number | null;
  quoteVolume24h: number | null;
  depositEnabled: number | null;
  withdrawEnabled: number | null;
  chainstatusRaw: string | null;
  contracts: TickerRow["contracts"];
  gapPct: number | null;
};

export type AlsoOnIndex = Map<string, AlsoOnPeer[]>;

export type TickerTableRow = TickerRow & {
  alsoOnCount: number;
  alsoOnPeers: AlsoOnPeer[];
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

function tickerBlacklistKey(exchange: string, rawSymbol: string): string {
  return `${exchange}\t${rawSymbol}`;
}

export function gapPct(primaryLast: number | null, otherLast: number | null): number | null {
  if (primaryLast == null || otherLast == null) return null;
  if (!Number.isFinite(primaryLast) || !Number.isFinite(otherLast) || primaryLast <= 0 || otherLast <= 0) {
    return null;
  }
  return ((otherLast - primaryLast) / primaryLast) * 100;
}

/** Satu peta per base: 1 ticker terpilih per exchange (USDT > USD), tanpa N+1 query. */
export function buildAlsoOnIndex(
  tickers: TickerRow[],
  options: {
    enabledIds: ReadonlySet<string>;
    namesById: Readonly<Record<string, string>>;
    blocked: ReadonlySet<string>;
  },
): AlsoOnIndex {
  const byBase = new Map<string, Map<string, TickerRow[]>>();
  for (const row of tickers) {
    const exchange = row.exchange;
    if (options.enabledIds.size > 0 && !options.enabledIds.has(exchange)) continue;
    if (options.blocked.has(tickerBlacklistKey(exchange, row.raw_symbol))) continue;
    const base = (row.base ?? "").trim().toUpperCase();
    if (!base) continue;
    let byExchange = byBase.get(base);
    if (!byExchange) {
      byExchange = new Map();
      byBase.set(base, byExchange);
    }
    const list = byExchange.get(exchange);
    if (list) list.push(row);
    else byExchange.set(exchange, [row]);
  }

  const index: AlsoOnIndex = new Map();
  for (const [base, byExchange] of byBase) {
    const peers: AlsoOnPeer[] = [];
    for (const [exchange, rows] of byExchange) {
      const picked = pickPreferredTicker(rows);
      peers.push({
        exchange,
        exchangeName: options.namesById[exchange] ?? exchange,
        rawSymbol: picked.raw_symbol,
        base: picked.base,
        quote: picked.quote,
        last: picked.last,
        bid: picked.bid,
        ask: picked.ask,
        change24hPct: picked.change_24h_pct,
        spreadPct: picked.spread_pct,
        quoteVolume24h: picked.quote_volume_24h,
        depositEnabled: picked.deposit_enabled,
        withdrawEnabled: picked.withdraw_enabled,
        chainstatusRaw: picked.chainstatus_raw ?? null,
        contracts: picked.contracts ?? null,
        gapPct: null,
      });
    }
    index.set(base, peers);
  }
  return index;
}

export function peersForRow(index: AlsoOnIndex, row: TickerRow): AlsoOnPeer[] {
  const base = (row.base ?? "").trim().toUpperCase();
  const list = index.get(base);
  if (!list) return [];
  const peers: AlsoOnPeer[] = [];
  for (const peer of list) {
    if (peer.exchange === row.exchange) continue;
    peers.push({ ...peer, gapPct: gapPct(row.last, peer.last) });
  }
  peers.sort((a, b) => {
    const aAbs = a.gapPct == null ? null : Math.abs(a.gapPct);
    const bAbs = b.gapPct == null ? null : Math.abs(b.gapPct);
    if (aAbs == null && bAbs == null) {
      const volumeA = a.quoteVolume24h;
      const volumeB = b.quoteVolume24h;
      if (volumeA == null && volumeB == null) return a.exchangeName.localeCompare(b.exchangeName);
      if (volumeA == null) return 1;
      if (volumeB == null) return -1;
      return volumeB - volumeA;
    }
    if (aAbs == null) return 1;
    if (bAbs == null) return -1;
    return bAbs - aAbs;
  });
  return peers;
}
