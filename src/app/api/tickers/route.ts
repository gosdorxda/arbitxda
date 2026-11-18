import { NextResponse } from "next/server";
import { getLatestTickers, getTickerCount, listBlacklist, listFavorites } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const tickers = getLatestTickers();
  return NextResponse.json(
    { ok: true, count: getTickerCount(), tickers, blacklist: listBlacklist(), favorites: listFavorites() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
