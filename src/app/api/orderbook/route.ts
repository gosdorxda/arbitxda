import { NextResponse } from "next/server";
import { getLatestOrderBook, getOrderBookById } from "@/lib/db";
import { fetchPairOrderBook } from "@/lib/fetch-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function parseBook(row: { id: number; exchange: string; raw_symbol: string; bids: string; asks: string; fetched_at: string }) {
  return {
    id: row.id,
    exchange: row.exchange,
    rawSymbol: row.raw_symbol,
    bids: JSON.parse(row.bids) as Array<{ price: number; volume: number; timestamp?: number | null }>,
    asks: JSON.parse(row.asks) as Array<{ price: number; volume: number; timestamp?: number | null }>,
    fetchedAt: row.fetched_at,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const exchange = url.searchParams.get("exchange");
  const rawSymbol = url.searchParams.get("pair") || url.searchParams.get("rawSymbol");

  if (id) {
    const row = getOrderBookById(Number(id));
    if (!row) return NextResponse.json({ ok: false, error: "Orderbook tidak ditemukan." }, { status: 404 });
    return NextResponse.json({ ok: true, orderbook: parseBook(row) }, { headers: { "Cache-Control": "no-store" } });
  }

  if (!exchange || !rawSymbol) {
    return NextResponse.json({ ok: false, error: "Parameter exchange dan pair wajib diisi." }, { status: 400 });
  }

  const row = getLatestOrderBook(exchange, rawSymbol);
  if (!row) return NextResponse.json({ ok: true, orderbook: null }, { headers: { "Cache-Control": "no-store" } });
  return NextResponse.json({ ok: true, orderbook: parseBook(row) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  try {
    const url = new URL(request.url);
    let exchange = url.searchParams.get("exchange");
    let rawSymbol = url.searchParams.get("pair") || url.searchParams.get("rawSymbol");

    if (!exchange || !rawSymbol) {
      const body = (await request.json()) as { exchange?: string; pair?: string; rawSymbol?: string };
      exchange = exchange || body.exchange || null;
      rawSymbol = rawSymbol || body.pair || body.rawSymbol || null;
    }

    if (!exchange || !rawSymbol) {
      return NextResponse.json({ ok: false, error: "Parameter exchange dan pair wajib diisi." }, { status: 400 });
    }

    const result = await fetchPairOrderBook(exchange, rawSymbol);
    return NextResponse.json(
      {
        ok: true,
        snapshotId: result.snapshotId,
        orderbook: result.orderbook,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
