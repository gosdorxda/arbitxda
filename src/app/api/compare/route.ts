import { NextResponse } from "next/server";
import { buildCompareIndex } from "@/lib/compare";
import { getLatestTickers, listBlacklist } from "@/lib/db";
import { getEnabledExchanges } from "@/lib/env";
import { getAdapter, hasAdapter } from "@/lib/exchanges/registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function listEnabledExchanges() {
  return getEnabledExchanges().map((id) => ({
    id,
    name: hasAdapter(id) ? getAdapter(id).name : id,
  }));
}

export async function GET() {
  const blocked = new Set(listBlacklist().map((row) => `${row.exchange}\t${row.raw_symbol}`));
  const tickers = getLatestTickers().filter((row) => !blocked.has(`${row.exchange}\t${row.raw_symbol}`));
  const index = buildCompareIndex(tickers, listEnabledExchanges());
  return NextResponse.json(
    { ok: true, exchanges: index.exchanges, byBase: index.byBase },
    { headers: { "Cache-Control": "no-store" } },
  );
}
