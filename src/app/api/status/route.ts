import { NextResponse } from "next/server";
import { getLatestFetchLogs, getTickerCount } from "@/lib/db";
import { listUiExchanges } from "@/lib/fetch-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const exchanges = listUiExchanges();
  const logs = getLatestFetchLogs();
  const logByExchange = Object.fromEntries(logs.map((log) => [log.exchange, log]));

  return NextResponse.json(
    {
      ok: true,
      exchanges: exchanges.map((exchange) => ({
        ...exchange,
        tickerCount: getTickerCount(exchange.id),
        lastFetch: logByExchange[exchange.id] ?? null,
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
