import { NextResponse } from "next/server";
import { fetchManifestDepth, fetchManifestOrderBook, isSolanaAddress } from "@/lib/manifest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function parseIds(body: unknown): string[] | null {
  if (Array.isArray(body)) return body.map((item) => String(item));
  if (!body || typeof body !== "object") return null;
  const record = body as { markets?: unknown; tickerIds?: unknown; items?: unknown };
  const raw = record.markets ?? record.tickerIds ?? record.items;
  if (!Array.isArray(raw)) return null;
  return raw.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object") {
      const row = item as { tickerId?: unknown; ticker_id?: unknown };
      return String(row.tickerId ?? row.ticker_id ?? "");
    }
    return "";
  });
}

function singleBookId(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as {
    book?: unknown;
    tickerId?: unknown;
    ticker_id?: unknown;
    market?: unknown;
    markets?: unknown;
  };
  if (Array.isArray(record.markets)) return null;
  const raw = record.tickerId ?? record.ticker_id ?? record.market;
  if (typeof raw !== "string") return null;
  if (record.book === false) return null;
  return raw.trim();
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as unknown;
    const bookId = singleBookId(body);
    if (bookId) {
      if (!isSolanaAddress(bookId)) {
        return NextResponse.json({ ok: false, error: "ticker_id Manifest tidak valid." }, { status: 400 });
      }
      const orderbook = await fetchManifestOrderBook(bookId);
      return NextResponse.json({ ok: true, orderbook }, { headers: { "Cache-Control": "no-store" } });
    }
    const ids = parseIds(body);
    if (!ids) {
      return NextResponse.json(
        { ok: false, error: "Body harus { markets: string[] }, atau { tickerId, book: true } untuk orderbook penuh." },
        { status: 400 },
      );
    }
    const tickerIds = ids.filter((id) => isSolanaAddress(id.trim()));
    const items = await fetchManifestDepth(tickerIds);
    return NextResponse.json({ ok: true, items }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
