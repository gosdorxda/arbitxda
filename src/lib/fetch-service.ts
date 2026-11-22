import {
  finishFetchLog,
  getEnabledExchangeRows,
  pruneMissingPairs,
  saveOrderBook,
  saveRawResponse,
  saveTickers,
  startFetchLog,
  upsertMarkets,
} from "./db";
import { cancelEnrichment, hasEnrichment, startEnrichment } from "./enrich-service";
import { getEnabledExchanges } from "./env";
import { getAdapter, hasAdapter } from "./exchanges/registry";
import { filterStockTokens } from "./exchanges/stock-filter";
import { sortByExchangeName } from "./format";

/**
 * Satu pair per base per exchange: kalau base punya pair USDT dan USD (mis. BTSE BTC-USDT & BTC-USD),
 * simpan USDT saja supaya tabel tidak dobel. Pair USD tetap dipakai kalau base itu tidak punya USDT.
 */
function dedupeQuotePerBase<M extends { rawSymbol: string; base: string; quote: string }, T extends { rawSymbol: string }>(
  markets: M[],
  tickers: T[],
): { markets: M[]; tickers: T[]; dropped: number } {
  const basesWithUsdt = new Set<string>();
  for (const market of markets) {
    if (market.quote.trim().toUpperCase() === "USDT") basesWithUsdt.add(market.base.trim().toUpperCase());
  }
  const dropSymbols = new Set<string>();
  for (const market of markets) {
    if (market.quote.trim().toUpperCase() === "USD" && basesWithUsdt.has(market.base.trim().toUpperCase())) {
      dropSymbols.add(market.rawSymbol);
    }
  }
  if (dropSymbols.size === 0) return { markets, tickers, dropped: 0 };
  return {
    markets: markets.filter((market) => !dropSymbols.has(market.rawSymbol)),
    tickers: tickers.filter((ticker) => !dropSymbols.has(ticker.rawSymbol)),
    dropped: dropSymbols.size,
  };
}

export type ExchangeFetchOutcome = {
  exchange: string;
  status: "success" | "error";
  rowCount: number;
  error: string | null;
};

export async function fetchExchangeTickers(exchangeId: string): Promise<ExchangeFetchOutcome> {
  const id = exchangeId.toLowerCase();
  const logId = startFetchLog(id);
  const started = Date.now();
  cancelEnrichment(id);

  try {
    if (!hasAdapter(id)) {
      throw new Error(`Adapter "${id}" belum tersedia.`);
    }
    const adapter = getAdapter(id);
    const result = await adapter.fetchTickers();
    const stockFiltered = filterStockTokens(result.markets, result.tickers);
    const deduped = dedupeQuotePerBase(stockFiltered.markets, stockFiltered.tickers);
    const filtered = { ...stockFiltered, markets: deduped.markets, tickers: deduped.tickers };
    if (deduped.dropped > 0) {
      console.log(`[${id}] lewati ${deduped.dropped} pair USD karena base yang sama sudah ada pair USDT`);
    }
    if (filtered.excludedStocks.length > 0) {
      console.log(`[${id}] lewati ${filtered.excludedStocks.length} pair token saham`);
    } else if (result.markets.length >= 1000) {
      console.warn(
        `[${id}] PERINGATAN: tidak ada token saham yang disaring dari ${result.markets.length} pair — cek flag isStock / metadata; saham mungkin masih masuk DB`,
      );
    }
    if (filtered.excludedLeveraged.length > 0) {
      console.log(`[${id}] lewati ${filtered.excludedLeveraged.length} pair token leverage`);
    }

    const dbStarted = Date.now();
    for (const raw of result.rawResponses) {
      saveRawResponse(logId, id, raw.endpoint, raw.rawJson);
    }
    upsertMarkets(id, filtered.markets);
    saveTickers(id, filtered.tickers);
    const pruned = pruneMissingPairs(
      id,
      filtered.markets.map((market) => market.rawSymbol),
    );
    finishFetchLog(logId, "success", filtered.tickers.length, null);
    console.log(`[${id}] DB save ${Date.now() - dbStarted}ms`);
    if (pruned > 0) {
      console.log(`[${id}] hapus ${pruned} pair lama yang tidak ada di fetch ini`);
    }
    console.log(`[${id}] total ${((Date.now() - started) / 1000).toFixed(1)}s`);

    if (hasEnrichment(adapter)) {
      startEnrichment(id, adapter, filtered.tickers, filtered.markets);
    }

    return { exchange: id, status: "success", rowCount: filtered.tickers.length, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishFetchLog(logId, "error", 0, message);
    console.log(`[${id}] gagal setelah ${((Date.now() - started) / 1000).toFixed(1)}s: ${message}`);
    return { exchange: id, status: "error", rowCount: 0, error: message };
  }
}

export async function fetchAllEnabledTickers(): Promise<ExchangeFetchOutcome[]> {
  const enabled = getEnabledExchanges();
  const outcomes: ExchangeFetchOutcome[] = [];
  // Satu per satu supaya error satu exchange tidak menghentikan yang lain.
  for (const id of enabled) {
    outcomes.push(await fetchExchangeTickers(id));
  }
  return outcomes;
}

export async function fetchPairOrderBook(exchangeId: string, rawSymbol: string) {
  const id = exchangeId.toLowerCase();
  if (!hasAdapter(id)) {
    throw new Error(`Adapter "${id}" belum tersedia.`);
  }
  const adapter = getAdapter(id);
  const result = await adapter.fetchOrderBook(rawSymbol, 5);
  saveRawResponse(null, id, result.endpoint, result.rawJson);
  const snapshotId = saveOrderBook(result.orderbook);
  return { snapshotId, orderbook: result.orderbook };
}

export function listUiExchanges() {
  const fromDb = getEnabledExchangeRows();
  const rows = fromDb.length > 0 ? fromDb : getEnabledExchanges().map((id) => ({ id, name: id, enabled: 1 }));
  return sortByExchangeName(rows, (row) => row.name || row.id);
}
