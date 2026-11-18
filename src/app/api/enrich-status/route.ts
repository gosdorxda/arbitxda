import { NextResponse } from "next/server";
import { getEnrichStatus } from "@/lib/enrich-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const exchange = (url.searchParams.get("exchange") ?? "").trim().toLowerCase();
  if (!exchange) {
    return NextResponse.json(
      { ok: false, error: "Parameter exchange wajib diisi." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    { ok: true, status: getEnrichStatus(exchange) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
