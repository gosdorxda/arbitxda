import { NextResponse } from "next/server";
import { fetchAllEnabledTickers, fetchExchangeTickers } from "@/lib/fetch-service";
import { getEnabledExchanges } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const url = new URL(request.url);
    let exchange = url.searchParams.get("exchange");

    if (!exchange) {
      try {
        const body = (await request.json()) as { exchange?: string };
        exchange = body.exchange ?? null;
      } catch {
        exchange = null;
      }
    }

    const target = (exchange || "all").toLowerCase();
    if (target === "all") {
      const results = await fetchAllEnabledTickers();
      const failed = results.filter((item) => item.status === "error");
      return NextResponse.json(
        { ok: failed.length === 0, results },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const enabled = getEnabledExchanges();
    if (!enabled.includes(target)) {
      return NextResponse.json(
        { ok: false, error: `Exchange "${target}" tidak aktif di ENABLED_EXCHANGES.` },
        { status: 400 },
      );
    }

    const result = await fetchExchangeTickers(target);
    return NextResponse.json(
      { ok: result.status === "success", results: [result] },
      {
        status: result.status === "success" ? 200 : 502,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
