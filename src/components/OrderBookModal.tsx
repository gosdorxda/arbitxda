"use client";

import { useMemo, useState, type ReactNode } from "react";
import { formatAmountCompact, formatPct, formatPrice, formatUsdCompact, formatWib } from "@/lib/format";
import { isUsdLikeQuote } from "@/lib/manifest-types";

export type OrderBookLevel = { price: number; volume: number; timestamp?: number | null };

export type OrderBookView = {
  id?: number;
  exchange: string;
  rawSymbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  fetchedAt: string;
  /** Quote ticker, e.g. USDC or SOL. When set, the book shows quote + USD columns. */
  quoteSymbol?: string;
  /** USD per 1 quote token. undefined = treat price as already USD; null = unknown. */
  quoteUsd?: number | null;
  /** How many levels to show per side. Default 5 (main CEX table). */
  levelCount?: number;
  /** False for live DEX books that are not written to the scanner DB. Default true. */
  savedToDb?: boolean;
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

/** Orderbook Manifest: POST /api/manifest/depth { tickerId, book: true }, modal yang sama. */
export function useManifestOrderBook(): {
  openOrderBook: (input: {
    tickerId: string;
    baseSymbol: string;
    quoteSymbol: string;
  }) => Promise<void>;
  orderBookModal: ReactNode;
} {
  const [orderbook, setOrderbook] = useState<OrderBookView | null>(null);
  const [orderbookLoading, setOrderbookLoading] = useState(false);
  const [orderbookError, setOrderbookError] = useState<string | null>(null);
  const [orderbookPair, setOrderbookPair] = useState<{
    tickerId: string;
    baseSymbol: string;
    quoteSymbol: string;
  } | null>(null);

  const openOrderBook = async (input: {
    tickerId: string;
    baseSymbol: string;
    quoteSymbol: string;
  }) => {
    setOrderbookPair(input);
    setOrderbook(null);
    setOrderbookError(null);
    setOrderbookLoading(true);
    try {
      const response = await fetch("/api/manifest/depth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ tickerId: input.tickerId, book: true }),
      });
      const data = (await response.json()) as {
        ok?: boolean;
        error?: string;
        orderbook?: {
          tickerId: string;
          bids: OrderBookLevel[];
          asks: OrderBookLevel[];
          baseSymbol?: string;
          quoteSymbol?: string;
          quoteUsd?: number | null;
          fetchedAt: string;
        };
      };
      if (!response.ok || !data.ok || !data.orderbook) {
        throw new Error(data.error || "Gagal mengambil orderbook Manifest");
      }
      setOrderbook({
        exchange: "Manifest",
        rawSymbol: data.orderbook.tickerId,
        bids: data.orderbook.bids,
        asks: data.orderbook.asks,
        fetchedAt: data.orderbook.fetchedAt,
        quoteSymbol: data.orderbook.quoteSymbol ?? input.quoteSymbol,
        quoteUsd: data.orderbook.quoteUsd,
        levelCount: 20,
        savedToDb: false,
      });
    } catch (error) {
      setOrderbookError(error instanceof Error ? error.message : String(error));
    } finally {
      setOrderbookLoading(false);
    }
  };

  const titleBase = orderbookPair?.baseSymbol ?? "Token";
  const titleQuote = orderbook?.quoteSymbol ?? orderbookPair?.quoteSymbol ?? "QUOTE";
  const orderBookModal = orderbookPair ? (
    <OrderBookModal
      title={`Manifest · ${titleBase}/${titleQuote}`}
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
        className={`flex max-h-[100dvh] w-full flex-col overflow-hidden rounded-t-xl border border-border bg-panel shadow-2xl sm:max-h-[90vh] sm:rounded-xl ${book?.levelCount && book.levelCount > 5 ? "max-w-lg" : "max-w-md"}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold">Orderbook</h2>
            <p className="muted truncate text-[13px]">{title}</p>
            {book ? (
              <p className="muted mt-1 text-xs">
                Diambil {formatWib(book.fetchedAt)}
                {book.savedToDb === false ? " dari API resmi Manifest" : " dan disimpan ke database"}
              </p>
            ) : null}
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

type BookRow = { price: number; volume: number; usd: number | null; cumulative: number | null };

function usdRate(book: OrderBookView): number | null | undefined {
  return book.quoteUsd;
}

function levelUsd(price: number, volume: number, rate: number | null | undefined): number | null {
  const notional = (Number(price) || 0) * (Number(volume) || 0);
  if (rate === undefined) return notional;
  if (rate == null) return null;
  return notional * rate;
}

function buildSide(
  rows: OrderBookLevel[],
  fromBest: "ask" | "bid",
  levelCount: number,
  rate: number | null | undefined,
): BookRow[] {
  const sorted =
    fromBest === "ask"
      ? [...rows].sort((a, b) => a.price - b.price)
      : [...rows].sort((a, b) => b.price - a.price);
  let cumulative = 0;
  let hasUsd = false;
  return sorted.slice(0, levelCount).map((row) => {
    const volume = Number(row.volume) || 0;
    const usd = levelUsd(row.price, volume, rate);
    if (usd != null) {
      cumulative += usd;
      hasUsd = true;
    }
    return { price: row.price, volume, usd, cumulative: hasUsd ? cumulative : null };
  });
}

export function OkxOrderBook({ book }: { book: OrderBookView }) {
  const levelCount = book.levelCount ?? 5;
  const rate = usdRate(book);
  const quoteSymbol = book.quoteSymbol;
  const wide = Boolean(quoteSymbol);
  const convertToUsdt =
    Boolean(quoteSymbol) && !isUsdLikeQuote(quoteSymbol, rate ?? null) && rate != null && rate > 0;
  const priceLabel = convertToUsdt ? "Harga (USDT)" : quoteSymbol ? `Harga (${quoteSymbol})` : "Harga";
  const asksFromBest = useMemo(
    () => buildSide(book.asks, "ask", levelCount, rate),
    [book.asks, levelCount, rate],
  );
  const bidsFromBest = useMemo(
    () => buildSide(book.bids, "bid", levelCount, rate),
    [book.bids, levelCount, rate],
  );
  const asksDisplay = useMemo(() => [...asksFromBest].reverse(), [asksFromBest]);
  const maxCumulative = Math.max(
    0,
    ...asksFromBest.map((row) => row.cumulative ?? 0),
    ...bidsFromBest.map((row) => row.cumulative ?? 0),
  );
  const bestAsk = asksFromBest[0]?.price ?? null;
  const bestBid = bidsFromBest[0]?.price ?? null;
  const mid = bestAsk != null && bestBid != null ? (bestAsk + bestBid) / 2 : (bestAsk ?? bestBid);
  const spread = bestAsk != null && bestBid != null && mid ? ((bestAsk - bestBid) / mid) * 100 : null;
  const midUsd = mid != null ? levelUsd(mid, 1, rate) : null;
  const cols = wide ? "grid-cols-4" : "grid-cols-3";

  return (
    <div>
      <div className={`muted mb-1 grid ${cols} px-2 text-[11px] uppercase tracking-wide`}>
        <span>{priceLabel}</span>
        <span className="text-right">Jumlah</span>
        <span className="text-right">{wide ? "USD" : "Total USD"}</span>
        {wide ? <span className="text-right">Kumulatif</span> : null}
      </div>
      <div>
        {asksDisplay.map((row) => (
          <DepthRow
            key={`a-${row.price}`}
            row={row}
            side="ask"
            maxCumulative={maxCumulative}
            wide={wide}
            convertToUsdt={convertToUsdt}
            quoteUsd={convertToUsdt ? rate ?? null : null}
            quoteSymbol={quoteSymbol}
          />
        ))}
        {asksDisplay.length === 0 ? <p className="muted px-2 py-3 text-center text-xs">Asks kosong</p> : null}
      </div>
      <div className="my-1 flex items-baseline justify-between rounded-md bg-panel-2 px-2 py-2">
        <div>
          <p className="num text-lg font-semibold text-foreground">
            {formatPrice(convertToUsdt && mid != null && rate != null ? mid * rate : (mid ?? null))}
            {convertToUsdt ? (
              <span className="ml-1 text-[11px] font-normal text-muted">USDT</span>
            ) : quoteSymbol ? (
              <span className="ml-1 text-[11px] font-normal text-muted">{quoteSymbol}</span>
            ) : null}
          </p>
          <p className="muted text-[11px]">
            Harga tengah
            {convertToUsdt && mid != null && quoteSymbol
              ? ` · ${formatPrice(mid)} ${quoteSymbol}`
              : midUsd != null && quoteSymbol
                ? ` · $${formatPrice(midUsd)}`
                : ""}
          </p>
        </div>
        <p className="muted num text-[13px]">{spread != null ? `Spread ${formatPct(spread)}` : ""}</p>
      </div>
      <div>
        {bidsFromBest.map((row) => (
          <DepthRow
            key={`b-${row.price}`}
            row={row}
            side="bid"
            maxCumulative={maxCumulative}
            wide={wide}
            convertToUsdt={convertToUsdt}
            quoteUsd={convertToUsdt ? rate ?? null : null}
            quoteSymbol={quoteSymbol}
          />
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
  wide,
  convertToUsdt = false,
  quoteUsd = null,
  quoteSymbol,
}: {
  row: BookRow;
  side: "ask" | "bid";
  maxCumulative: number;
  wide: boolean;
  convertToUsdt?: boolean;
  quoteUsd?: number | null;
  quoteSymbol?: string;
}) {
  const width = maxCumulative > 0 && row.cumulative != null ? Math.min(100, (row.cumulative / maxCumulative) * 100) : 0;
  const bar = side === "ask" ? "var(--depth-ask)" : "var(--depth-bid)";
  const displayPrice = convertToUsdt && quoteUsd != null ? row.price * quoteUsd : row.price;
  return (
    <div className={`relative grid ${convertToUsdt ? "min-h-10 py-0.5" : "h-8"} ${wide ? "grid-cols-4" : "grid-cols-3"} items-center px-2 text-[12px]`}>
      <div
        className="pointer-events-none absolute inset-y-0 right-0"
        style={{ width: `${width}%`, background: bar }}
      />
      <span className={`num relative leading-tight ${side === "ask" ? "down" : "up"}`}>
        <span className="block">{formatPrice(displayPrice)}</span>
        {convertToUsdt && quoteSymbol ? (
          <span className="block text-[10px] font-normal text-muted">
            {formatPrice(row.price)} {quoteSymbol}
          </span>
        ) : null}
      </span>
      <span className="num relative text-right text-foreground">{formatAmountCompact(row.volume)}</span>
      <span className="num muted relative text-right">{wide ? formatUsdCompact(row.usd) : formatUsdCompact(row.cumulative)}</span>
      {wide ? <span className="num muted relative text-right">{formatUsdCompact(row.cumulative)}</span> : null}
    </div>
  );
}
