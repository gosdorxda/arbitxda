import { NextResponse } from "next/server";
import { fetchDepthBatch, type DepthPairRequest } from "@/lib/depth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function parseBody(body: unknown): { pairs: DepthPairRequest[]; includeLevels: boolean } | null {
  if (Array.isArray(body)) return { pairs: body as DepthPairRequest[], includeLevels: false };
  if (!body || typeof body !== "object") return null;
  const record = body as { pairs?: unknown; items?: unknown; includeLevels?: unknown };
  const includeLevels = record.includeLevels === true;
  if (Array.isArray(record.pairs)) return { pairs: record.pairs as DepthPairRequest[], includeLevels };
  if (Array.isArray(record.items)) return { pairs: record.items as DepthPairRequest[], includeLevels };
  return null;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as unknown;
    const parsed = parseBody(body);
    if (!parsed) {
      return NextResponse.json(
        { ok: false, error: "Body harus array {exchange, rawSymbol} atau { pairs: [...] }." },
        { status: 400 },
      );
    }
    const items = await fetchDepthBatch(parsed.pairs, { includeLevels: parsed.includeLevels });
    return NextResponse.json({ ok: true, items }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
