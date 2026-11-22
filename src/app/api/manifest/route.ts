import { NextResponse } from "next/server";
import { loadManifestSnapshot } from "@/lib/manifest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const refreshSol =
    url.searchParams.get("refreshSol") === "1" || url.searchParams.get("syncSol") === "1";
  const snapshot = await loadManifestSnapshot({ refreshSol });
  if (!snapshot.ok) {
    return NextResponse.json(snapshot, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
}
