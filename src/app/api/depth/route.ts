import { NextResponse } from "next/server";
import { fetchDepthBatch, type DepthPairRequest } from "@/lib/depth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function parsePairs(body: unknown): DepthPairRequest[] | null {
  if (Array.isArray(body)) return body as DepthPairRequest[];
  if (!body || typeof body !== "object") return null;
  const record = body as { pairs?: unknown; items?: unknown };
  if (Array.isArray(record.pairs)) return record.pairs as DepthPairRequest[];
  if (Array.isArray(record.items)) return record.items as DepthPairRequest[];
  return null;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as unknown;
    const pairs = parsePairs(body);
    if (!pairs) {
      return NextResponse.json(
        { ok: false, error: "Body harus array {exchange, rawSymbol} atau { pairs: [...] }." },
        { status: 400 },
      );
    }
    const items = await fetchDepthBatch(pairs);
    return NextResponse.json({ ok: true, items }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
