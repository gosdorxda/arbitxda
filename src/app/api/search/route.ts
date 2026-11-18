import { NextResponse } from "next/server";
import { listBlacklist, searchLatestTickers } from "@/lib/db";
import { getAdapter, hasAdapter } from "@/lib/exchanges/registry";
import { getSpotUrl } from "@/lib/exchanges/spot-urls";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export type SearchTickerHit = {
  exchange: string;
  exchangeName: string;
  base: string;
  quote: string;
  rawSymbol: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
  quoteVolume24h: number | null;
  change24hPct: number | null;
  depositEnabled: number | null;
  withdrawEnabled: number | null;
  chainstatusRaw: string | null;
  fetchedAt: string | null;
  stale: number | null;
  blacklisted: boolean;
  spotUrl: string | null;
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const limitRaw = Number(url.searchParams.get("limit"));
  // Number(null) === 0, jadi param kosong tidak boleh dianggap limit 0.
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : 80;

  try {
    const blocked = new Set(listBlacklist().map((row) => `${row.exchange}\t${row.raw_symbol}`));
    const results: SearchTickerHit[] = searchLatestTickers(q, limit).map((row) => ({
      exchange: row.exchange,
      exchangeName: hasAdapter(row.exchange) ? getAdapter(row.exchange).name : row.exchange,
      base: row.base,
      quote: row.quote,
      rawSymbol: row.raw_symbol,
      last: row.last,
      bid: row.bid,
      ask: row.ask,
      quoteVolume24h: row.quote_volume_24h,
      change24hPct: row.change_24h_pct,
      depositEnabled: row.deposit_enabled,
      withdrawEnabled: row.withdraw_enabled,
      chainstatusRaw: row.chainstatus_raw ?? null,
      fetchedAt: row.fetched_at ?? null,
      stale: row.stale ?? null,
      blacklisted: blocked.has(`${row.exchange}\t${row.raw_symbol}`),
      spotUrl: getSpotUrl(row.exchange, row.base, row.quote, row.raw_symbol),
    }));
    return NextResponse.json(
      { ok: true, q: q.trim(), results },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
