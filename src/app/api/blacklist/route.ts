import { NextResponse } from "next/server";
import { addBlacklist, listBlacklist, removeBlacklist } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function noStore(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function readPair(input: unknown): { exchange: string; raw_symbol: string } | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const body = input as Record<string, unknown>;
  const exchange = typeof body.exchange === "string" ? body.exchange.trim() : "";
  const rawSymbol =
    typeof body.raw_symbol === "string"
      ? body.raw_symbol.trim()
      : typeof body.symbol === "string"
        ? body.symbol.trim()
        : "";
  if (!exchange || !rawSymbol) return null;
  return { exchange, raw_symbol: rawSymbol };
}

export async function GET() {
  return noStore({ ok: true, items: listBlacklist() });
}

export async function POST(request: Request) {
  try {
    const pair = readPair(await request.json());
    if (!pair) {
      return noStore({ ok: false, error: "exchange dan raw_symbol wajib diisi." }, 400);
    }
    addBlacklist(pair.exchange, pair.raw_symbol);
    return noStore({ ok: true, item: pair });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return noStore({ ok: false, error: message }, 400);
  }
}

export async function DELETE(request: Request) {
  try {
    let pair = readPair(await request.json().catch(() => null));
    if (!pair) {
      const url = new URL(request.url);
      pair = readPair({
        exchange: url.searchParams.get("exchange"),
        raw_symbol: url.searchParams.get("raw_symbol") ?? url.searchParams.get("symbol"),
      });
    }
    if (!pair) {
      return noStore({ ok: false, error: "exchange dan raw_symbol wajib diisi." }, 400);
    }
    removeBlacklist(pair.exchange, pair.raw_symbol);
    return noStore({ ok: true, item: pair });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return noStore({ ok: false, error: message }, 400);
  }
}
