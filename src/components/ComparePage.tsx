"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  createColumnHelper,
  createPaginatedRowModel,
  createSortedRowModel,
  flexRender,
  metaHelper,
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnVisibilityState,
  type SortingState,
} from "@tanstack/react-table";
import { AppHeader } from "@/components/AppHeader";
import { ExchangeMarketBar } from "@/components/ExchangeMarketBar";
import { FundingIcons } from "@/components/FundingIcons";
import type { CompareCoinEntry, CompareExchangeCell, CompareExchangeInfo } from "@/lib/compare";
import { getSpotUrl } from "@/lib/exchanges/spot-urls";
import { formatAmountCompact, formatPct, formatPrice, formatUsdCompact, formatWib, formatWibShort } from "@/lib/format";
import { usePersistedState } from "@/lib/persist";

const FILTERS_KEY = "arbit-compare-filters";
const CARD_FIELDS_KEY = "arbit-compare-card-fields";
const COLUMN_VISIBILITY_KEY = "arbit-compare-column-visibility";
const PAGE_SIZE_OPTIONS = [25, 50, 100];
const ALWAYS_VISIBLE_COLUMNS = ["base", "otherCount"] as const;
const HIDDEN_BY_DEFAULT_COLUMNS = [
  "bid",
  "ask",
  "bidSize",
  "askSize",
  "spreadPct",
  "funding",
  "pair",
  "fetchedAt",
] as const;
const DEFAULT_COLUMN_VISIBILITY: ColumnVisibilityState = Object.fromEntries(
  HIDDEN_BY_DEFAULT_COLUMNS.map((id) => [id, false]),
);
const FILTER_INPUT =
  "h-8 rounded-md border border-border bg-panel-2 px-2 text-[13px] text-foreground outline-none placeholder:text-muted focus:border-border-strong";

type CompareFilters = {
  search: string;
  minExchanges: number;
  primary: string;
};

const DEFAULT_FILTERS: CompareFilters = {
  search: "",
  minExchanges: 1,
  primary: "",
};

function parseCompareFilters(raw: unknown): CompareFilters | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const min = Number(value.minExchanges);
  return {
    search: typeof value.search === "string" ? value.search : DEFAULT_FILTERS.search,
    minExchanges: Number.isInteger(min) && min >= 1 ? min : DEFAULT_FILTERS.minExchanges,
    primary: typeof value.primary === "string" ? value.primary : DEFAULT_FILTERS.primary,
  };
}

const CARD_FIELD_OPTIONS = [
  { id: "price", label: "Harga" },
  { id: "volume", label: "Volume" },
  { id: "gap", label: "Gap %" },
  { id: "bid", label: "Bid" },
  { id: "ask", label: "Ask" },
  { id: "bidSize", label: "Bid size" },
  { id: "askSize", label: "Ask size" },
  { id: "spread", label: "Spread" },
  { id: "change24h", label: "24h %" },
  { id: "funding", label: "Depo/WD" },
  { id: "fetchedAt", label: "Waktu fetch" },
] as const;

type CardFieldId = (typeof CARD_FIELD_OPTIONS)[number]["id"];
type CompareCardFields = Record<CardFieldId, boolean>;

const DEFAULT_CARD_FIELDS: CompareCardFields = {
  price: true,
  volume: true,
  gap: true,
  bid: false,
  ask: false,
  bidSize: false,
  askSize: false,
  spread: false,
  change24h: false,
  funding: false,
  fetchedAt: false,
};

function parseCardFields(raw: unknown): CompareCardFields | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const next = { ...DEFAULT_CARD_FIELDS };
  let seen = false;
  for (const option of CARD_FIELD_OPTIONS) {
    const flag = value[option.id];
    if (typeof flag === "boolean") {
      next[option.id] = flag;
      seen = true;
    }
  }
  return seen ? next : null;
}

function parseColumnVisibility(raw: unknown): ColumnVisibilityState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const state: ColumnVisibilityState = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "boolean") state[key] = value;
  }
  for (const id of HIDDEN_BY_DEFAULT_COLUMNS) {
    if (state[id] === undefined) state[id] = false;
  }
  for (const id of ALWAYS_VISIBLE_COLUMNS) state[id] = true;
  return state;
}

function sortNullsLast(
  rowA: { getValue: (id: string) => unknown },
  rowB: { getValue: (id: string) => unknown },
  columnId: string,
  desc: boolean,
): number {
  const a = rowA.getValue(columnId);
  const b = rowB.getValue(columnId);
  if (a == null && b == null) return 0;
  if (a == null) return desc ? -1 : 1;
  if (b == null) return desc ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" });
}

function isUsdQuote(quote: string): boolean {
  return quote.trim().toUpperCase() === "USD";
}

function diffPct(primaryLast: number | null | undefined, otherLast: number | null | undefined): number | null {
  if (primaryLast == null || otherLast == null) return null;
  if (!Number.isFinite(primaryLast) || !Number.isFinite(otherLast) || primaryLast <= 0 || otherLast <= 0) {
    return null;
  }
  return ((otherLast - primaryLast) / primaryLast) * 100;
}

function pctClass(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "muted";
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "";
}

type CompareTableRow = {
  base: string;
  primary: CompareExchangeCell;
  others: Array<{ info: CompareExchangeInfo; cell: CompareExchangeCell; diff: number | null }>;
  exchangeCount: number;
  otherCount: number;
  last: number | null;
  quoteVolume24h: number | null;
  change24hPct: number | null;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  spreadPct: number | null;
  fundingSort: number | null;
  pair: string;
  fetchedAt: string | null;
  maxAbsDiff: number | null;
  maxAbsDiffSigned: number | null;
};

function fundingSortValue(cell: CompareExchangeCell): number | null {
  const deposit = cell.depositEnabled;
  const withdraw = cell.withdrawEnabled;
  if (deposit == null && withdraw == null) return null;
  const flag = (value: number | null) => (value === 1 ? 2 : value === 0 ? 0 : 1);
  return flag(deposit) * 3 + flag(withdraw);
}

const features = tableFeatures({
  columnVisibilityFeature,
  rowSortingFeature,
  rowPaginationFeature,
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  columnMeta: metaHelper<{ align?: "left" | "right"; sticky?: "coin" }>(),
  tableMeta: metaHelper<{ cardFields: CompareCardFields }>(),
});

const columnHelper = createColumnHelper<typeof features, CompareTableRow>();

const ExternalLinkIcon = memo(function ExternalLinkIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="opacity-60">
      <path
        d="M14 5h5v5M19 5l-9 9"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
});

const CoinCell = memo(function CoinCell({ row }: { row: CompareTableRow }) {
  const href = getSpotUrl(row.primary.exchange, row.primary.base, row.primary.quote, row.primary.rawSymbol);
  const text = <span className="font-medium text-foreground">{row.base}</span>;
  if (!href) return text;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-foreground hover:opacity-80"
      title={`Buka ${row.primary.base}/${row.primary.quote} di ${row.primary.exchange}`}
    >
      {text}
      <ExternalLinkIcon />
    </a>
  );
});

const PriceWithQuote = memo(function PriceWithQuote({ last, quote, href, title }: { last: number | null; quote: string; href: string | null; title?: string }) {
  const price = formatPrice(last);
  const tag = isUsdQuote(quote) ? <span className="muted ml-1 text-[10px] font-normal">USD</span> : null;
  const content = (
    <>
      <span className="num">{price}</span>
      {tag}
    </>
  );
  if (!href) return <span className="inline-flex items-baseline">{content}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-baseline hover:opacity-80"
      title={title}
    >
      {content}
    </a>
  );
});

function ChipField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="compare-chip-field">
      <span className="compare-chip-field-label">{label}</span>
      <span className="compare-chip-field-value">{children}</span>
    </div>
  );
}

function PopoverRow({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td className={className}>{children}</td>
    </tr>
  );
}

const ExchangeChip = memo(function ExchangeChip({
  item,
  fields,
}: {
  item: CompareTableRow["others"][number];
  fields: CompareCardFields;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, placeAbove: false });
  const href = getSpotUrl(item.cell.exchange, item.cell.base, item.cell.quote, item.cell.rawSymbol);
  const cell = item.cell;

  const showPopover = () => {
    const el = bodyRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = 260;
    const estimatedHeight = 280;
    const margin = 8;
    const spaceBelow = window.innerHeight - rect.bottom;
    const placeAbove = spaceBelow < estimatedHeight && rect.top > spaceBelow;
    let left = rect.left;
    if (left + width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - width - margin);
    }
    if (left < margin) left = margin;
    setPos({
      top: placeAbove ? rect.top - 6 : rect.bottom + 6,
      left,
      placeAbove,
    });
    setOpen(true);
  };

  const hidePopover = () => setOpen(false);

  return (
    <div className="compare-chip">
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="compare-chip-link"
          title={`Buka ${cell.base}/${cell.quote} di ${item.info.name}`}
          aria-label={`Buka ${cell.base}/${cell.quote} di ${item.info.name}`}
          onMouseEnter={(event) => {
            event.stopPropagation();
            hidePopover();
          }}
          onMouseOver={(event) => event.stopPropagation()}
          onPointerEnter={(event) => {
            event.stopPropagation();
            hidePopover();
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <ExternalLinkIcon />
        </a>
      ) : null}
      <div
        ref={bodyRef}
        className="compare-chip-body"
        onMouseEnter={showPopover}
        onMouseLeave={hidePopover}
      >
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted">{item.info.name}</div>
        {fields.price ? <PriceWithQuote last={cell.last} quote={cell.quote} href={null} /> : null}
        {fields.volume ? <div className="num muted text-[11px]">{formatUsdCompact(cell.quoteVolume24h)}</div> : null}
        {fields.gap ? (
          <div className={`num text-[11px] font-medium ${pctClass(item.diff)}`}>
            {item.diff == null ? "-" : formatPct(item.diff)}
          </div>
        ) : null}
        {fields.bid ? (
          <ChipField label="Bid">
            <span className="num">{formatPrice(cell.bid)}</span>
          </ChipField>
        ) : null}
        {fields.ask ? (
          <ChipField label="Ask">
            <span className="num">{formatPrice(cell.ask)}</span>
          </ChipField>
        ) : null}
        {fields.bidSize ? (
          <ChipField label="Bid size">
            <span className="num">{formatAmountCompact(cell.bidSize)}</span>
          </ChipField>
        ) : null}
        {fields.askSize ? (
          <ChipField label="Ask size">
            <span className="num">{formatAmountCompact(cell.askSize)}</span>
          </ChipField>
        ) : null}
        {fields.spread ? (
          <ChipField label="Spread">
            <span className="num">{formatPct(cell.spreadPct)}</span>
          </ChipField>
        ) : null}
        {fields.change24h ? (
          <ChipField label="24h">
            <span className={`num ${pctClass(cell.change24hPct)}`}>{formatPct(cell.change24hPct)}</span>
          </ChipField>
        ) : null}
        {fields.funding ? (
          <ChipField label="Depo/WD">
            <FundingIcons
              depositEnabled={cell.depositEnabled}
              withdrawEnabled={cell.withdrawEnabled}
              chainstatusRaw={cell.chainstatusRaw}
            />
          </ChipField>
        ) : null}
        {fields.fetchedAt ? (
          <ChipField label="Fetch">
            {formatWibShort(cell.fetchedAt)}
          </ChipField>
        ) : null}
      </div>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              className="compare-chip-pop"
              style={{
                top: pos.top,
                left: pos.left,
                transform: pos.placeAbove ? "translateY(-100%)" : undefined,
              }}
              role="tooltip"
            >
              <div className="compare-chip-pop-title">{item.info.name}</div>
              <table className="compare-chip-pop-table">
                <tbody>
                  <PopoverRow label="Bid">
                    <span className="num">{formatPrice(cell.bid)}</span>
                  </PopoverRow>
                  <PopoverRow label="Ask">
                    <span className="num">{formatPrice(cell.ask)}</span>
                  </PopoverRow>
                  <PopoverRow label="Bid size">
                    <span className="num">{formatAmountCompact(cell.bidSize)}</span>
                  </PopoverRow>
                  <PopoverRow label="Ask size">
                    <span className="num">{formatAmountCompact(cell.askSize)}</span>
                  </PopoverRow>
                  <PopoverRow label="Spread">
                    <span className="num">{formatPct(cell.spreadPct)}</span>
                  </PopoverRow>
                  <PopoverRow label="Last vs mid">
                    <span className="num">{formatPct(cell.lastVsMidPct)}</span>
                  </PopoverRow>
                  <PopoverRow label="24h %" className={`num ${pctClass(cell.change24hPct)}`}>
                    {formatPct(cell.change24hPct)}
                  </PopoverRow>
                  <PopoverRow label="Waktu fetch">{formatWibShort(cell.fetchedAt)}</PopoverRow>
                  <PopoverRow label="Depo/WD">
                    <span className="compare-chip-pop-icons">
                      <FundingIcons
                        depositEnabled={cell.depositEnabled}
                        withdrawEnabled={cell.withdrawEnabled}
                        chainstatusRaw={cell.chainstatusRaw}
                      />
                    </span>
                  </PopoverRow>
                  <PopoverRow label="Pair">{`${cell.base}/${cell.quote}`}</PopoverRow>
                  {cell.stale === 1 ? (
                    <PopoverRow label="Stale" className="down">
                      ya
                    </PopoverRow>
                  ) : null}
                </tbody>
              </table>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
});

const OthersCell = memo(function OthersCell({
  row,
  fields,
}: {
  row: CompareTableRow;
  fields: CompareCardFields;
}) {
  if (row.others.length === 0) return <span className="muted">-</span>;
  return (
    <div className="flex flex-wrap gap-1.5 py-1">
      {row.others.map((item) => (
        <ExchangeChip key={item.info.id} item={item} fields={fields} />
      ))}
    </div>
  );
});

const columns = columnHelper.columns([
  columnHelper.accessor("base", {
    header: "Coin",
    enableHiding: false,
    meta: { align: "left", sticky: "coin" },
    cell: (info) => <CoinCell row={info.row.original} />,
  }),
  columnHelper.accessor("last", {
    header: "Last",
    sortDescFirst: true,
    meta: { align: "right" },
    cell: (info) => {
      const row = info.row.original;
      return (
        <PriceWithQuote
          last={row.last}
          quote={row.primary.quote}
          href={null}
        />
      );
    },
  }),
  columnHelper.accessor("quoteVolume24h", {
    header: "Vol USD 24h",
    sortDescFirst: true,
    meta: { align: "right" },
    cell: (info) => <span className="num">{formatUsdCompact(info.getValue())}</span>,
  }),
  columnHelper.accessor("change24hPct", {
    header: "24h %",
    sortDescFirst: true,
    meta: { align: "right" },
    cell: (info) => {
      const value = info.getValue();
      return <span className={`num ${pctClass(value)}`}>{formatPct(value)}</span>;
    },
  }),
  columnHelper.accessor("bid", {
    header: "Bid",
    sortDescFirst: true,
    meta: { align: "right" },
    cell: (info) => <span className="num">{formatPrice(info.getValue())}</span>,
  }),
  columnHelper.accessor("ask", {
    header: "Ask",
    sortDescFirst: true,
    meta: { align: "right" },
    cell: (info) => <span className="num">{formatPrice(info.getValue())}</span>,
  }),
  columnHelper.accessor("bidSize", {
    header: "Bid size",
    sortDescFirst: true,
    meta: { align: "right" },
    cell: (info) => <span className="num">{formatAmountCompact(info.getValue())}</span>,
  }),
  columnHelper.accessor("askSize", {
    header: "Ask size",
    sortDescFirst: true,
    meta: { align: "right" },
    cell: (info) => <span className="num">{formatAmountCompact(info.getValue())}</span>,
  }),
  columnHelper.accessor("spreadPct", {
    header: "Spread",
    sortDescFirst: true,
    meta: { align: "right" },
    cell: (info) => <span className="num">{formatPct(info.getValue())}</span>,
  }),
  columnHelper.accessor("fundingSort", {
    id: "funding",
    header: "Depo/WD",
    sortDescFirst: true,
    meta: { align: "left" },
    cell: (info) => {
      const cell = info.row.original.primary;
      return (
        <FundingIcons
          depositEnabled={cell.depositEnabled}
          withdrawEnabled={cell.withdrawEnabled}
          chainstatusRaw={cell.chainstatusRaw}
        />
      );
    },
  }),
  columnHelper.accessor("pair", {
    header: "Pair",
    meta: { align: "left" },
    cell: (info) => <span>{info.getValue()}</span>,
  }),
  columnHelper.accessor("fetchedAt", {
    header: "Waktu fetch",
    sortDescFirst: true,
    meta: { align: "left" },
    cell: (info) => {
      const value = info.getValue();
      if (!value) return <span className="muted">-</span>;
      return (
        <span className="num muted whitespace-nowrap" title={formatWib(value)}>
          {formatWibShort(value)}
        </span>
      );
    },
  }),
  columnHelper.accessor("otherCount", {
    header: "Ada juga di",
    sortDescFirst: true,
    enableHiding: false,
    meta: { align: "left" },
    cell: (info) => (
      <OthersCell
        row={info.row.original}
        fields={info.table.options.meta?.cardFields ?? DEFAULT_CARD_FIELDS}
      />
    ),
  }),
  columnHelper.accessor("maxAbsDiff", {
    header: "Max Δ",
    sortDescFirst: true,
    meta: { align: "right" },
    cell: (info) => {
      const signed = info.row.original.maxAbsDiffSigned;
      if (signed == null) return <span className="muted">-</span>;
      return <span className={`num ${pctClass(signed)}`}>{formatPct(signed)}</span>;
    },
  }),
]);

function buildRows(
  byBase: Record<string, CompareCoinEntry>,
  exchanges: CompareExchangeInfo[],
  primaryId: string,
): CompareTableRow[] {
  const othersInfo = exchanges.filter((item) => item.id !== primaryId);
  const rows: CompareTableRow[] = [];
  for (const entry of Object.values(byBase)) {
    const primary = entry.exchanges[primaryId];
    if (!primary) continue;
    const others = othersInfo
      .map((info) => {
        const cell = entry.exchanges[info.id];
        if (!cell) return null;
        return { info, cell, diff: diffPct(primary.last, cell.last) };
      })
      .filter((item): item is CompareTableRow["others"][number] => item != null);

    others.sort((a, b) => {
      const aAbs = a.diff == null ? null : Math.abs(a.diff);
      const bAbs = b.diff == null ? null : Math.abs(b.diff);
      if (aAbs == null && bAbs == null) return 0;
      if (aAbs == null) return 1;
      if (bAbs == null) return -1;
      return bAbs - aAbs;
    });

    let maxAbsDiff: number | null = null;
    let maxAbsDiffSigned: number | null = null;
    for (const item of others) {
      if (item.diff == null) continue;
      const abs = Math.abs(item.diff);
      if (maxAbsDiff == null || abs > maxAbsDiff) {
        maxAbsDiff = abs;
        maxAbsDiffSigned = item.diff;
      }
    }

    rows.push({
      base: entry.base,
      primary,
      others,
      exchangeCount: 1 + others.length,
      otherCount: others.length,
      last: primary.last,
      quoteVolume24h: primary.quoteVolume24h,
      change24hPct: primary.change24hPct,
      bid: primary.bid,
      ask: primary.ask,
      bidSize: primary.bidSize,
      askSize: primary.askSize,
      spreadPct: primary.spreadPct,
      fundingSort: fundingSortValue(primary),
      pair: `${primary.base}/${primary.quote}`,
      fetchedAt: primary.fetchedAt,
      maxAbsDiff,
      maxAbsDiffSigned,
    });
  }
  return rows;
}

export function ComparePage() {
  const [exchanges, setExchanges] = useState<CompareExchangeInfo[]>([]);
  const [byBase, setByBase] = useState<Record<string, CompareCoinEntry>>({});
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<string | null>(null);
  const [filters, setFilters] = usePersistedState<CompareFilters>(
    FILTERS_KEY,
    DEFAULT_FILTERS,
    parseCompareFilters,
  );
  const [cardFields, setCardFields] = usePersistedState<CompareCardFields>(
    CARD_FIELDS_KEY,
    DEFAULT_CARD_FIELDS,
    parseCardFields,
  );
  const [columnVisibility, setColumnVisibility] = usePersistedState<ColumnVisibilityState>(
    COLUMN_VISIBILITY_KEY,
    DEFAULT_COLUMN_VISIBILITY,
    parseColumnVisibility,
  );
  const [columnVisibilityOpen, setColumnVisibilityOpen] = useState(false);
  const visibilityRef = useRef<HTMLDivElement>(null);
  const [sorting, setSorting] = useState<SortingState>([{ id: "otherCount", desc: true }]);
  const sortingRef = useRef(sorting);
  sortingRef.current = sorting;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/compare", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Gagal memuat perbandingan");
      setExchanges(data.exchanges ?? []);
      setByBase(data.byBase ?? {});
      setBanner(null);
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const primaryId = useMemo(() => {
    if (exchanges.length === 0) return "";
    if (filters.primary && exchanges.some((item) => item.id === filters.primary)) return filters.primary;
    return exchanges[0]!.id;
  }, [exchanges, filters.primary]);

  const maxExchanges = Math.max(1, exchanges.length);
  const minExchanges = Math.min(Math.max(1, filters.minExchanges), maxExchanges);

  const allRows = useMemo(() => buildRows(byBase, exchanges, primaryId), [byBase, exchanges, primaryId]);

  const visibleRows = useMemo(() => {
    const needle = filters.search.trim().toLowerCase();
    return allRows.filter((row) => {
      if (row.exchangeCount < minExchanges) return false;
      if (needle && !row.base.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [allRows, filters.search, minExchanges]);

  const sortFn = useMemo(
    () =>
      (
        rowA: { getValue: (id: string) => unknown },
        rowB: { getValue: (id: string) => unknown },
        columnId: string,
      ) => {
        const desc = sortingRef.current.find((item) => item.id === columnId)?.desc ?? false;
        return sortNullsLast(rowA, rowB, columnId, desc);
      },
    [],
  );

  useEffect(() => {
    if (!columnVisibilityOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (visibilityRef.current && !visibilityRef.current.contains(target)) {
        setColumnVisibilityOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setColumnVisibilityOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [columnVisibilityOpen]);

  const table = useTable({
    features,
    columns,
    data: visibleRows,
    getRowId: (row) => row.base.toUpperCase(),
    enableMultiSort: true,
    enableSortingRemoval: false,
    state: { sorting, columnVisibility },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    initialState: { pagination: { pageIndex: 0, pageSize: 50 } },
    defaultColumn: { sortFn },
    meta: { cardFields },
  });

  const hideableColumns = table.getAllLeafColumns().filter((column) => column.getCanHide());

  const tableRef = useRef(table);
  tableRef.current = table;
  useEffect(() => {
    tableRef.current.setPageIndex(0);
  }, [filters.search, minExchanges, primaryId]);

  const filteredCount = visibleRows.length;
  const { pageIndex, pageSize } = table.state.pagination;
  const from = filteredCount === 0 ? 0 : pageIndex * pageSize + 1;
  const to = Math.min(filteredCount, (pageIndex + 1) * pageSize);
  const pageCount = table.getPageCount();

  return (
    <div className="app-shell flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
      <AppHeader current="compare">
        <button type="button" onClick={() => void load()} disabled={loading} className="btn-ghost">
          {loading ? "Memuat..." : "Muat ulang"}
        </button>
      </AppHeader>

      {banner ? (
        <div className="border-b border-border bg-panel px-4 py-2 text-[13px] text-muted sm:px-5">{banner}</div>
      ) : null}

      <ExchangeMarketBar
        loading={loading}
        totalCount={exchanges.reduce((sum, item) => sum + item.pairCount, 0)}
        items={exchanges.map((exchange) => ({
          id: exchange.id,
          name: exchange.name,
          count: exchange.pairCount,
          selected: primaryId === exchange.id,
          onSelect: () => setFilters((prev) => ({ ...prev, primary: exchange.id })),
        }))}
      />

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background p-3 sm:p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2 sm:gap-3">
          <input
            type="search"
            value={filters.search}
            onChange={(event) => setFilters((prev) => ({ ...prev, search: event.target.value }))}
            placeholder="Cari coin..."
            className={`${FILTER_INPUT} w-full min-w-0 py-1.5 sm:w-56`}
          />
          <label className="flex items-center gap-2 text-[13px] text-foreground">
            <span className="muted whitespace-nowrap">Min. exchange</span>
            <select
              value={minExchanges}
              onChange={(event) =>
                setFilters((prev) => ({ ...prev, minExchanges: Number(event.target.value) }))
              }
              className={FILTER_INPUT}
            >
              {Array.from({ length: maxExchanges }, (_, index) => index + 1).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <div className="relative" ref={visibilityRef}>
            <button
              type="button"
              onClick={() => setColumnVisibilityOpen((open) => !open)}
              className="btn-ghost"
            >
              Kolom
            </button>
            {columnVisibilityOpen ? (
              <div className="absolute left-0 z-30 mt-1 w-56 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-panel-2 p-2 shadow-xl">
                <p className="muted px-1 pb-1 text-[11px] uppercase tracking-wide">Kolom tabel</p>
                <div className="max-h-[min(10rem,40vh)] overflow-auto">
                  {hideableColumns.map((column) => (
                    <label
                      key={column.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 text-xs text-foreground hover:bg-hover"
                    >
                      <input
                        type="checkbox"
                        checked={column.getIsVisible()}
                        onChange={column.getToggleVisibilityHandler()}
                        className="accent-foreground"
                      />
                      {typeof column.columnDef.header === "string" ? column.columnDef.header : column.id}
                    </label>
                  ))}
                </div>
                <p className="muted mt-2 border-t border-border px-1 pb-1 pt-2 text-[11px] uppercase tracking-wide">
                  Kartu Ada juga di
                </p>
                <div className="max-h-[min(16rem,50vh)] overflow-auto">
                  {CARD_FIELD_OPTIONS.map((option) => (
                    <label
                      key={option.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 text-xs text-foreground hover:bg-hover"
                    >
                      <input
                        type="checkbox"
                        checked={cardFields[option.id]}
                        onChange={(event) =>
                          setCardFields((prev) => ({ ...prev, [option.id]: event.target.checked }))
                        }
                        className="accent-foreground"
                      />
                      {option.label}
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
          <span className="muted text-xs sm:text-[13px]">{filteredCount} pair</span>
        </div>

        <div className="tickers-scroll min-h-0 flex-1 overflow-auto">
          <table className="tickers-table compare-table w-full min-w-[52rem] border-separate border-spacing-0 text-left">
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => {
                    const sticky = header.column.columnDef.meta?.sticky;
                    const align = header.column.columnDef.meta?.align === "right" ? "text-right" : "text-left";
                    const canSort = header.column.getCanSort();
                    const sorted = header.column.getIsSorted();
                    const sortIndex = header.column.getSortIndex();
                    const showIndex = sorted && sorting.length > 1;
                    return (
                      <th key={header.id} className={sticky ? `sticky-col sticky-${sticky}` : ""}>
                        {canSort ? (
                          <button
                            type="button"
                            onClick={header.column.getToggleSortingHandler()}
                            className={`flex w-full items-center gap-1 ${align === "text-right" ? "justify-end" : "justify-start"}`}
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            <span className="inline-flex min-w-3 items-center text-[10px] text-foreground">
                              {sorted === "asc" ? "↑" : sorted === "desc" ? "↓" : ""}
                              {showIndex ? sortIndex + 1 : ""}
                            </span>
                          </button>
                        ) : (
                          <span className={align}>{flexRender(header.column.columnDef.header, header.getContext())}</span>
                        )}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr key={row.id}>
                  {row.getVisibleCells().map((cell) => {
                    const sticky = cell.column.columnDef.meta?.sticky;
                    const align =
                      cell.column.columnDef.meta?.align === "right" ? "text-right num whitespace-nowrap" : "";
                    return (
                      <td key={cell.id} className={`${align} ${sticky ? `sticky-col sticky-${sticky}` : ""}`}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {!loading && allRows.length === 0 ? (
                <tr>
                  <td colSpan={Math.max(1, table.getVisibleLeafColumns().length)} className="muted !h-24 px-4 text-center">
                    {exchanges.length === 0
                      ? "Belum ada data. Fetch ticker di halaman Tabel dulu."
                      : "Exchange ini belum punya pair di database."}
                  </td>
                </tr>
              ) : null}
              {!loading && allRows.length > 0 && visibleRows.length === 0 ? (
                <tr>
                  <td colSpan={Math.max(1, table.getVisibleLeafColumns().length)} className="muted !h-24 px-4 text-center">
                    Tidak ada pair yang cocok dengan pencarian atau min. exchange.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[13px]">
          <span className="muted">
            {loading && exchanges.length === 0
              ? "Memuat tabel..."
              : `Menampilkan ${from}-${to} dari ${filteredCount}`}
          </span>
          <div className="flex flex-wrap items-center gap-3">
            <label className="muted flex items-center gap-2">
              <span>Baris per halaman</span>
              <select
                value={String(pageSize)}
                onChange={(event) => table.setPageSize(Number(event.target.value))}
                className={`${FILTER_INPUT} py-1`}
              >
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
                className="btn-ghost !px-2 !py-1"
              >
                Sebelumnya
              </button>
              <span className="muted px-2">
                {pageCount === 0 ? 0 : pageIndex + 1} / {pageCount}
              </span>
              <button
                type="button"
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}
                className="btn-ghost !px-2 !py-1"
              >
                Berikutnya
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
