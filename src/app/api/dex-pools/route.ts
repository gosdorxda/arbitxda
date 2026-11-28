import { NextResponse } from "next/server";
import { getDexPools, getDexSim, getRpcEnvName, isDexChainSupported, isDexRpcReady } from "@/lib/dex-pools";
import { isValidDexAddress, type DexPoolsResponse, type DexSimResponse } from "@/lib/dex-pools-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function reply(body: DexPoolsResponse | DexSimResponse, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  let body: {
    chain?: unknown;
    contract?: unknown;
    sizeUsd?: unknown;
    hintUsd?: unknown;
    force?: unknown;
    mode?: unknown;
    side?: unknown;
    amountUsd?: unknown;
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return reply({ ok: false, code: "bad-request", error: "Body JSON tidak valid" }, 400);
  }
  const chain = typeof body.chain === "string" ? body.chain.trim().toUpperCase() : "";
  const contract = typeof body.contract === "string" ? body.contract.trim() : "";
  if (!isDexChainSupported(chain)) {
    return reply({ ok: false, code: "unsupported-chain", error: `Chain ${chain || "?"} belum didukung` });
  }
  if (!isValidDexAddress(chain, contract)) {
    return reply({ ok: false, code: "bad-request", error: "Alamat kontrak tidak valid untuk chain ini" }, 400);
  }
  if (!isDexRpcReady(chain)) {
    return reply({ ok: false, code: "no-rpc", error: `${getRpcEnvName(chain)} belum diisi di .env` });
  }
  const sizeRaw = Number(body.sizeUsd);
  const sizeUsd = Number.isFinite(sizeRaw) && sizeRaw > 0 ? Math.min(sizeRaw, 10_000_000) : 100;
  const hintRaw = Number(body.hintUsd);
  const hintUsd = Number.isFinite(hintRaw) && hintRaw > 0 ? hintRaw : null;
  if (body.mode === "sim") {
    // Simulasi on-demand (tooltip): side buy/sell + amountUsd, pakai base token tiap pool.
    const side = body.side === "buy" ? "buy" : body.side === "sell" ? "sell" : null;
    const amountRaw = Number(body.amountUsd);
    if (!side || !Number.isFinite(amountRaw) || amountRaw <= 0) {
      return reply({ ok: false, code: "bad-request", error: "side (buy/sell) dan amountUsd > 0 wajib" }, 400);
    }
    const amountUsd = Math.min(amountRaw, 10_000_000);
    try {
      const { sim, cached } = await getDexSim(chain, contract, side, amountUsd, { sizeUsd, hintUsd });
      return reply({ ok: true, sim, cached });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply({ ok: false, code: "error", error: message.slice(0, 240) });
    }
  }
  try {
    const { result, cached } = await getDexPools(chain, contract, { sizeUsd, hintUsd, force: body.force === true });
    return reply({ ok: true, result, cached });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply({ ok: false, code: "error", error: message.slice(0, 240) });
  }
}
