"use client";

import { useMemo, useState, type ReactNode } from "react";
import { formatAmountCompact, formatPct, formatPrice, formatUsdCompact, formatWib } from "@/lib/format";

export type OrderBookLevel = { price: number; volume: number; timestamp?: number | null };

export type OrderBookView = {
  id?: number;
  exchange: string;
  rawSymbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  fetchedAt: string;
};

/** State + fetch orderbook (POST /api/orderbook) dan modalnya; dipakai Dashboard dan Scanner. */
export function useOrderBook(): {
  openOrderBook: (exchange: string, rawSymbol: string, label?: string) => Promise<void>;
  orderBookModal: ReactNode;
} {
  const [orderbook, setOrderbook] = useState<OrderBookView | null>(null);
  const [orderbookLoading, setOrderbookLoading] = useState(false);
  const [orderbookError, setOrderbookError] = useState<string | null>(null);
  const [orderbookPair, setOrderbookPair] = useState<{ exchange: string; rawSymbol: string; label?: string } | null>(null);

  const openOrderBook = async (exchange: string, rawSymbol: string, label?: string) => {
    setOrderbookPair({ exchange, rawSymbol, label });
    setOrderbook(null);
    setOrderbookError(null);
    setOrderbookLoading(true);
    try {
      const response = await fetch("/api/orderbook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exchange, pair: rawSymbol }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Gagal mengambil orderbook");
      setOrderbook({
        id: data.snapshotId,
        exchange: data.orderbook.exchange,
        rawSymbol: data.orderbook.rawSymbol,
        bids: data.orderbook.bids,
        asks: data.orderbook.asks,
        fetchedAt: data.orderbook.fetchedAt,
      });
    } catch (error) {
      setOrderbookError(error instanceof Error ? error.message : String(error));
    } finally {
      setOrderbookLoading(false);
    }
  };

  const orderBookModal = orderbookPair ? (
    <OrderBookModal
      title={`${orderbookPair.label ?? orderbookPair.exchange} · ${orderbookPair.rawSymbol}`}
      loading={orderbookLoading}
      error={orderbookError}
      book={orderbook}
      onClose={() => {
        setOrderbookPair(null);
        setOrderbook(null);
        setOrderbookError(null);
      }}
    />
  ) : null;

  return { openOrderBook, orderBookModal };
}

export function OrderBookModal({
  title,
  loading,
  error,
  book,
  onClose,
}: {
  title: string;
  loading: boolean;
  error: string | null;
  book: OrderBookView | null;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-overlay sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="flex max-h-[100dvh] w-full max-w-md flex-col overflow-hidden rounded-t-xl border border-border bg-panel shadow-2xl sm:max-h-[90vh] sm:rounded-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold">Orderbook</h2>
            <p className="muted truncate text-[13px]">{title}</p>
            {book ? <p className="muted mt-1 text-xs">Diambil {formatWib(book.fetchedAt)} dan disimpan ke database</p> : null}
          </div>
          <button onClick={onClose} className="btn-ghost !px-3 !py-1 shrink-0">
            Tutup
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-3 py-3 sm:px-4">
          {loading ? <p className="muted text-[13px]">Mengambil depth dari API resmi...</p> : null}
          {error ? <p className="down text-[13px]">{error}</p> : null}
          {book ? <OkxOrderBook book={book} /> : null}
        </div>
      </div>
    </div>
  );
}

type BookRow = { price: number; volume: number; usd: number; cumulative: number };

function buildSide(rows: OrderBookLevel[], fromBest: "ask" | "bid"): BookRow[] {
  const sorted =
    fromBest === "ask"
      ? [...rows].sort((a, b) => a.price - b.price)
      : [...rows].sort((a, b) => b.price - a.price);
  let cumulative = 0;
  return sorted.slice(0, 5).map((row) => {
    const volume = Number(row.volume) || 0;
    const usd = volume * (Number(row.price) || 0);
    cumulative += usd;
    return { price: row.price, volume, usd, cumulative };
  });
}

export function OkxOrderBook({ book }: { book: OrderBookView }) {
  const asksFromBest = useMemo(() => buildSide(book.asks, "ask"), [book.asks]);
  const bidsFromBest = useMemo(() => buildSide(book.bids, "bid"), [book.bids]);
  const asksDisplay = useMemo(() => [...asksFromBest].reverse(), [asksFromBest]);
  const maxCumulative = Math.max(
    0,
    ...asksFromBest.map((row) => row.cumulative),
    ...bidsFromBest.map((row) => row.cumulative),
  );
  const bestAsk = asksFromBest[0]?.price ?? null;
  const bestBid = bidsFromBest[0]?.price ?? null;
  const mid = bestAsk != null && bestBid != null ? (bestAsk + bestBid) / 2 : (bestAsk ?? bestBid);
  const spread = bestAsk != null && bestBid != null && mid ? ((bestAsk - bestBid) / mid) * 100 : null;

  return (
    <div>
      <div className="muted mb-1 grid grid-cols-3 px-2 text-[11px] uppercase tracking-wide">
        <span>Harga</span>
        <span className="text-right">Jumlah</span>
        <span className="text-right">Total USD</span>
      </div>
      <div>
        {asksDisplay.map((row) => (
          <DepthRow key={`a-${row.price}`} row={row} side="ask" maxCumulative={maxCumulative} />
        ))}
        {asksDisplay.length === 0 ? <p className="muted px-2 py-3 text-center text-xs">Asks kosong</p> : null}
      </div>
      <div className="my-1 flex items-baseline justify-between rounded-md bg-panel-2 px-2 py-2">
        <div>
          <p className="num text-lg font-semibold text-foreground">
            {formatPrice(mid ?? null)}
          </p>
          <p className="muted text-[11px]">Harga tengah</p>
        </div>
        <p className="muted num text-[13px]">{spread != null ? `Spread ${formatPct(spread)}` : ""}</p>
      </div>
      <div>
        {bidsFromBest.map((row) => (
          <DepthRow key={`b-${row.price}`} row={row} side="bid" maxCumulative={maxCumulative} />
        ))}
        {bidsFromBest.length === 0 ? <p className="muted px-2 py-3 text-center text-xs">Bids kosong</p> : null}
      </div>
    </div>
  );
}

function DepthRow({
  row,
  side,
  maxCumulative,
}: {
  row: BookRow;
  side: "ask" | "bid";
  maxCumulative: number;
}) {
  const width = maxCumulative > 0 ? Math.min(100, (row.cumulative / maxCumulative) * 100) : 0;
  const bar = side === "ask" ? "var(--depth-ask)" : "var(--depth-bid)";
  return (
    <div className="relative grid h-8 grid-cols-3 items-center px-2 text-[12px]">
      <div
        className="pointer-events-none absolute inset-y-0 right-0"
        style={{ width: `${width}%`, background: bar }}
      />
      <span className={`num relative ${side === "ask" ? "down" : "up"}`}>{formatPrice(row.price)}</span>
      <span className="num relative text-right text-foreground">{formatAmountCompact(row.volume)}</span>
      <span className="num muted relative text-right">{formatUsdCompact(row.cumulative)}</span>
    </div>
  );
}
