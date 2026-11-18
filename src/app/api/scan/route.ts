import { NextResponse } from "next/server";
import { getLatestTickers, listBlacklist, listFavorites } from "@/lib/db";
import { listUiExchanges } from "@/lib/fetch-service";
import { parseScanSettings, runScan } from "@/lib/scan";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const settings = parseScanSettings(await request.json().catch(() => null));
    const enabled = listUiExchanges().map((e) => ({ id: e.id, name: e.name }));
    const data = runScan(getLatestTickers(), {
      settings,
      enabled,
      blacklist: listBlacklist(),
      favorites: listFavorites(),
    });
    return NextResponse.json(
      { ok: true, settings, ...data, favorites: listFavorites() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
