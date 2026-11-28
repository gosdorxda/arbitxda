import { NextResponse } from "next/server";
import { getDexPools, getRpcEnvName, isDexChainSupported, isDexRpcReady } from "@/lib/dex-pools";
import { isValidDexAddress, type DexPoolsResponse } from "@/lib/dex-pools-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function reply(body: DexPoolsResponse, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  let body: { chain?: unknown; contract?: unknown; sizeUsd?: unknown; hintUsd?: unknown; force?: unknown } = {};
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
  try {
    const { result, cached } = await getDexPools(chain, contract, { sizeUsd, hintUsd, force: body.force === true });
    return reply({ ok: true, result, cached });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply({ ok: false, code: "error", error: message.slice(0, 240) });
  }
}
