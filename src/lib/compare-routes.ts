import { aggregateChainFlag } from "./chainstatus";
import type { CompareCoinEntry, CompareExchangeCell } from "./compare";
import { parseTimestamp } from "./format";
import type { OrderBookLevel, TokenContract } from "./types";

export type ContractMatchStatus = "match" | "mismatch" | "unknown";

export type FundingRouteStatus = "open" | "suspended" | "unknown";

export type CompareSafetyFilters = {
  hideContractMismatch: boolean;
  hideStale: boolean;
  maxAgeMinutes: number | null;
  minSpreadPct: number | null;
  minVolumeUsd: number | null;
};

export type CompareRoute = {
  id: string;
  base: string;
  buy: CompareExchangeCell;
  sell: CompareExchangeCell;
  buyExchangeName: string;
  sellExchangeName: string;
  buyAsk: number;
  sellBid: number;
  grossSpreadPct: number;
  buyFeePct: number;
  sellFeePct: number;
  netProfitPct: number;
  estProfitUsd: number;
  buyVolumeUsd: number | null;
  sellVolumeUsd: number | null;
  minVolumeUsd: number | null;
  filterVolumeUsd: number;
  oldestFetchedAt: string | null;
  ageMs: number | null;
  buyWithdraw: 0 | 1 | null;
  sellDeposit: 0 | 1 | null;
  fundingClosed: boolean;
  fundingUnknown: boolean;
  fundingStatus: FundingRouteStatus;
  contractStatus: ContractMatchStatus;
  isStale: boolean;
  isAgeStale: boolean;
};

export type CompareCoinGroup = {
  base: string;
  activeExchangeCount: number;
  bestRoute: CompareRoute;
  otherRoutes: CompareRoute[];
  totalRoutes: number;
};

export type DepthRouteMetrics = {
  ready: boolean;
  error: boolean;
  modalUsd: number;
  filledModalUsd: number;
  partial: boolean;
  vwapBuy: number | null;
  vwapSell: number | null;
  realisticProfitUsd: number | null;
  realisticProfitPct: number | null;
  maxFillableUsd: number;
  maxNetFillableUsd: number;
  buyTop5Usd: number;
  sellTop5Usd: number;
};

const CHAIN_ALIASES: Record<string, string> = {
  ERC20: "ETH",
  ETH: "ETH",
  ETHEREUM: "ETH",
  BEP20: "BSC",
  BEP20BSC: "BSC",
  BSC: "BSC",
  BNB: "BSC",
  BNBSMARTCHAIN: "BSC",
  SOL: "SOL",
  SOLANA: "SOL",
  TRC20: "TRX",
  TRX: "TRX",
  TRON: "TRX",
  MATIC: "POLYGON",
  POLYGON: "POLYGON",
  POL: "POLYGON",
  ARB: "ARB",
  ARBITRUM: "ARB",
  ARBITRUMONE: "ARB",
  ARBONE: "ARB",
  OP: "OP",
  OPTIMISM: "OP",
  AVAX: "AVAX",
  AVAXC: "AVAX",
  AVALANCHE: "AVAX",
  AVALANCHECCHAIN: "AVAX",
  BASE: "BASE",
  TON: "TON",
  THEOPENNETWORK: "TON",
  SUI: "SUI",
  APT: "APT",
  APTOS: "APT",
  NEAR: "NEAR",
  FANTOM: "FTM",
  FTM: "FTM",
  LINEA: "LINEA",
  SCROLL: "SCROLL",
  ZKSYNC: "ZKSYNC",
  ZKSYNCERA: "ZKSYNC",
  MANTANETWORK: "MANTA",
  MANTA: "MANTA",
  STARKNET: "STARKNET",
};

export function canonicalChain(chain: string): string {
  const cleaned = chain.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return CHAIN_ALIASES[cleaned] ?? cleaned;
}

export function normalizeContractAddress(contract: string): string {
  const trimmed = contract.trim();
  if (/^0x/i.test(trimmed)) return trimmed.toLowerCase();
  return trimmed;
}

export function compareContracts(
  buyContracts: TokenContract[] | null | undefined,
  sellContracts: TokenContract[] | null | undefined,
): ContractMatchStatus {
  if (!buyContracts?.length || !sellContracts?.length) return "unknown";
  const buyNorm = buyContracts
    .map((item) => ({
      chain: canonicalChain(item.chain ?? ""),
      contract: normalizeContractAddress(item.contract ?? ""),
    }))
    .filter((item) => item.contract.length > 0);
  const sellNorm = sellContracts
    .map((item) => ({
      chain: canonicalChain(item.chain ?? ""),
      contract: normalizeContractAddress(item.contract ?? ""),
    }))
    .filter((item) => item.contract.length > 0);

  if (buyNorm.length === 0 || sellNorm.length === 0) return "unknown";

  for (const left of buyNorm) {
    for (const right of sellNorm) {
      if (left.contract !== right.contract) continue;
      if (!left.chain || !right.chain || left.chain === right.chain) {
        return "match";
      }
    }
  }
  return "mismatch";
}

function parseTimestampMs(iso: string | null | undefined): number | null {
  const d = parseTimestamp(iso);
  return d ? d.getTime() : null;
}

function toFundingFlag(value: number | null | undefined): 0 | 1 | null {
  if (value === 1) return 1;
  if (value === 0) return 0;
  return null;
}

/** Suspend if buy WD or sell Depo is closed; unknown if either is null and none closed; otherwise open. */
export function routeFundingStatus(
  buyWithdraw: 0 | 1 | null,
  sellDeposit: 0 | 1 | null,
): FundingRouteStatus {
  if (buyWithdraw === 0 || sellDeposit === 0) return "suspended";
  if (buyWithdraw === null || sellDeposit === null) return "unknown";
  return "open";
}

function isValidQuote(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function computeCompareCoinGroups(params: {
  byBase: Record<string, CompareCoinEntry>;
  activeExchangeIds: Set<string>;
  exchangeNames: Record<string, string>;
  defaultFeePct: number;
  exchangeFees: Record<string, number>;
  modalUsd: number;
  filters: CompareSafetyFilters;
  nowMs?: number;
}): CompareCoinGroup[] {
  const {
    byBase,
    activeExchangeIds,
    exchangeNames,
    defaultFeePct,
    exchangeFees,
    modalUsd,
    filters,
    nowMs = Date.now(),
  } = params;

  const baseFee = Number.isFinite(defaultFeePct) && defaultFeePct >= 0 ? defaultFeePct : 0.1;
  const effectiveModal = Number.isFinite(modalUsd) && modalUsd > 0 ? modalUsd : 100;
  const maxAgeMs =
    filters.maxAgeMinutes != null && Number.isFinite(filters.maxAgeMinutes) && filters.maxAgeMinutes > 0
      ? filters.maxAgeMinutes * 60_000
      : null;

  const groups: CompareCoinGroup[] = [];

  for (const entry of Object.values(byBase)) {
    const cells: CompareExchangeCell[] = [];
    for (const cell of Object.values(entry.exchanges)) {
      const exId = cell.exchange.toLowerCase();
      if (!activeExchangeIds.has(exId)) continue;
      if (!isValidQuote(cell.bid) || !isValidQuote(cell.ask)) continue;
      cells.push(cell);
    }
    if (cells.length < 2) continue;

    const routes: CompareRoute[] = [];

    for (let i = 0; i < cells.length; i += 1) {
      const buy = cells[i]!;
      const buyId = buy.exchange.toLowerCase();
      const buyAsk = buy.ask as number;
      const buyFee = exchangeFees[buyId];
      const buyFeePct = typeof buyFee === "number" && Number.isFinite(buyFee) && buyFee >= 0 ? buyFee : baseFee;
      const buyWithdraw = toFundingFlag(buy.withdrawEnabled ?? aggregateChainFlag(buy.chainstatusRaw, "withdraw"));
      const buyFetchedMs = parseTimestampMs(buy.fetchedAt);

      for (let j = 0; j < cells.length; j += 1) {
        if (i === j) continue;
        const sell = cells[j]!;
        const sellId = sell.exchange.toLowerCase();
        const sellBid = sell.bid as number;
        const sellFee = exchangeFees[sellId];
        const sellFeePct =
          typeof sellFee === "number" && Number.isFinite(sellFee) && sellFee >= 0 ? sellFee : baseFee;
        const sellDeposit = toFundingFlag(sell.depositEnabled ?? aggregateChainFlag(sell.chainstatusRaw, "deposit"));
        const sellFetchedMs = parseTimestampMs(sell.fetchedAt);

        const grossSpreadPct = ((sellBid - buyAsk) / buyAsk) * 100;
        const fBuy = buyFeePct / 100;
        const fSell = sellFeePct / 100;
        const netMultiplier = (sellBid / buyAsk) * (1 - fBuy) * (1 - fSell);
        const netProfitPct = (netMultiplier - 1) * 100;
        const estProfitUsd = effectiveModal * (netMultiplier - 1);

        const buyVolumeUsd =
          typeof buy.quoteVolume24h === "number" && Number.isFinite(buy.quoteVolume24h)
            ? buy.quoteVolume24h
            : null;
        const sellVolumeUsd =
          typeof sell.quoteVolume24h === "number" && Number.isFinite(sell.quoteVolume24h)
            ? sell.quoteVolume24h
            : null;
        const minVolumeUsd =
          buyVolumeUsd != null && sellVolumeUsd != null
            ? Math.min(buyVolumeUsd, sellVolumeUsd)
            : (buyVolumeUsd ?? sellVolumeUsd);
        const filterVolumeUsd = Math.min(buyVolumeUsd ?? 0, sellVolumeUsd ?? 0);

        let oldestFetchedAt: string | null = null;
        let oldestMs: number | null = null;
        if (buyFetchedMs != null && sellFetchedMs != null) {
          if (buyFetchedMs <= sellFetchedMs) {
            oldestMs = buyFetchedMs;
            oldestFetchedAt = buy.fetchedAt;
          } else {
            oldestMs = sellFetchedMs;
            oldestFetchedAt = sell.fetchedAt;
          }
        } else if (buyFetchedMs != null) {
          oldestMs = buyFetchedMs;
          oldestFetchedAt = buy.fetchedAt;
        } else if (sellFetchedMs != null) {
          oldestMs = sellFetchedMs;
          oldestFetchedAt = sell.fetchedAt;
        }
        const ageMs = oldestMs != null ? Math.max(0, nowMs - oldestMs) : null;

        const fundingStatus = routeFundingStatus(buyWithdraw, sellDeposit);
        const fundingClosed = fundingStatus === "suspended";
        const fundingUnknown = fundingStatus === "unknown";
        const contractStatus = compareContracts(buy.contracts, sell.contracts);
        const isAgeStale = maxAgeMs != null && ageMs != null && ageMs > maxAgeMs;
        const isStale = buy.stale === 1 || sell.stale === 1 || isAgeStale;

        if (filters.hideContractMismatch && contractStatus === "mismatch") continue;
        if (filters.hideStale && isStale) continue;
        if (filters.minSpreadPct != null && Number.isFinite(filters.minSpreadPct) && grossSpreadPct < filters.minSpreadPct) {
          continue;
        }
        if (filters.minVolumeUsd != null && Number.isFinite(filters.minVolumeUsd) && filterVolumeUsd < filters.minVolumeUsd) {
          continue;
        }

        routes.push({
          id: `${entry.base}:${buyId}->${sellId}`,
          base: entry.base,
          buy,
          sell,
          buyExchangeName: exchangeNames[buyId] ?? buy.exchange,
          sellExchangeName: exchangeNames[sellId] ?? sell.exchange,
          buyAsk,
          sellBid,
          grossSpreadPct,
          buyFeePct,
          sellFeePct,
          netProfitPct,
          estProfitUsd,
          buyVolumeUsd,
          sellVolumeUsd,
          minVolumeUsd,
          filterVolumeUsd,
          oldestFetchedAt,
          ageMs,
          buyWithdraw,
          sellDeposit,
          fundingClosed,
          fundingUnknown,
          fundingStatus,
          contractStatus,
          isStale,
          isAgeStale,
        });
      }
    }

    if (routes.length === 0) continue;

    routes.sort((left, right) => {
      if (right.netProfitPct !== left.netProfitPct) return right.netProfitPct - left.netProfitPct;
      if (right.grossSpreadPct !== left.grossSpreadPct) return right.grossSpreadPct - left.grossSpreadPct;
      return right.filterVolumeUsd - left.filterVolumeUsd;
    });

    groups.push({
      base: entry.base,
      activeExchangeCount: cells.length,
      bestRoute: routes[0]!,
      otherRoutes: routes.slice(1),
      totalRoutes: routes.length,
    });
  }

  return groups;
}

function buyFromAsksByUsd(asks: OrderBookLevel[], budgetUsd: number): { spentUsd: number; boughtQty: number } {
  let remaining = Math.max(0, budgetUsd);
  let spentUsd = 0;
  let boughtQty = 0;
  for (const level of asks) {
    if (remaining <= 1e-12) break;
    const price = level.price;
    const volume = level.volume;
    if (price <= 0 || volume <= 0) continue;
    const levelUsd = price * volume;
    if (levelUsd <= remaining) {
      spentUsd += levelUsd;
      boughtQty += volume;
      remaining -= levelUsd;
    } else {
      const qty = remaining / price;
      spentUsd += remaining;
      boughtQty += qty;
      remaining = 0;
      break;
    }
  }
  return { spentUsd, boughtQty };
}

function buyFromAsksByQty(asks: OrderBookLevel[], targetQty: number): { spentUsd: number; boughtQty: number } {
  let remaining = Math.max(0, targetQty);
  let spentUsd = 0;
  let boughtQty = 0;
  for (const level of asks) {
    if (remaining <= 1e-12) break;
    const price = level.price;
    const volume = level.volume;
    if (price <= 0 || volume <= 0) continue;
    const take = Math.min(remaining, volume);
    spentUsd += take * price;
    boughtQty += take;
    remaining -= take;
  }
  return { spentUsd, boughtQty };
}

function sellToBidsByQty(bids: OrderBookLevel[], targetQty: number): { receivedUsd: number; soldQty: number } {
  let remaining = Math.max(0, targetQty);
  let receivedUsd = 0;
  let soldQty = 0;
  for (const level of bids) {
    if (remaining <= 1e-12) break;
    const price = level.price;
    const volume = level.volume;
    if (price <= 0 || volume <= 0) continue;
    const take = Math.min(remaining, volume);
    receivedUsd += take * price;
    soldQty += take;
    remaining -= take;
  }
  return { receivedUsd, soldQty };
}

export function computeDepthRouteMetrics(params: {
  buyAsks: OrderBookLevel[] | undefined;
  sellBids: OrderBookLevel[] | undefined;
  modalUsd: number;
  buyFeePct: number;
  sellFeePct: number;
  error?: boolean;
}): DepthRouteMetrics {
  const effectiveModal = Number.isFinite(params.modalUsd) && params.modalUsd > 0 ? params.modalUsd : 100;
  if (params.error) {
    return {
      ready: false,
      error: true,
      modalUsd: effectiveModal,
      filledModalUsd: 0,
      partial: false,
      vwapBuy: null,
      vwapSell: null,
      realisticProfitUsd: null,
      realisticProfitPct: null,
      maxFillableUsd: 0,
      maxNetFillableUsd: 0,
      buyTop5Usd: 0,
      sellTop5Usd: 0,
    };
  }

  const asks = [...(params.buyAsks ?? [])]
    .filter((l) => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.volume) && l.volume > 0)
    .sort((a, b) => a.price - b.price)
    .slice(0, 5);
  const bids = [...(params.sellBids ?? [])]
    .filter((l) => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.volume) && l.volume > 0)
    .sort((a, b) => b.price - a.price)
    .slice(0, 5);

  const buyTop5Usd = asks.reduce((sum, l) => sum + l.price * l.volume, 0);
  const sellTop5Usd = bids.reduce((sum, l) => sum + l.price * l.volume, 0);

  if (asks.length === 0 || bids.length === 0) {
    return {
      ready: true,
      error: false,
      modalUsd: effectiveModal,
      filledModalUsd: 0,
      partial: true,
      vwapBuy: null,
      vwapSell: null,
      realisticProfitUsd: null,
      realisticProfitPct: null,
      maxFillableUsd: 0,
      maxNetFillableUsd: 0,
      buyTop5Usd,
      sellTop5Usd,
    };
  }

  const fBuy = Math.max(0, params.buyFeePct) / 100;
  const fSell = Math.max(0, params.sellFeePct) / 100;
  const buyKeepRatio = Math.max(1e-9, 1 - fBuy);
  const sellKeepRatio = Math.max(0, 1 - fSell);

  const totalBidQty = bids.reduce((sum, l) => sum + l.volume, 0);
  const initialBuy = buyFromAsksByUsd(asks, effectiveModal);
  const desiredSellQty = initialBuy.boughtQty * buyKeepRatio;

  let filledBuyUsd = initialBuy.spentUsd;
  let filledBuyQty = initialBuy.boughtQty;
  let partial = initialBuy.spentUsd + 1e-4 < effectiveModal;

  let sellResult: { receivedUsd: number; soldQty: number };
  if (desiredSellQty <= totalBidQty + 1e-12) {
    sellResult = sellToBidsByQty(bids, desiredSellQty);
  } else {
    const matchedBuyQty = totalBidQty / buyKeepRatio;
    const reBuy = buyFromAsksByQty(asks, matchedBuyQty);
    filledBuyUsd = reBuy.spentUsd;
    filledBuyQty = reBuy.boughtQty;
    sellResult = sellToBidsByQty(bids, totalBidQty);
    partial = true;
  }

  const vwapBuy = filledBuyQty > 0 ? filledBuyUsd / filledBuyQty : null;
  const vwapSell = sellResult.soldQty > 0 ? sellResult.receivedUsd / sellResult.soldQty : null;
  const netProceedsUsd = sellResult.receivedUsd * sellKeepRatio;
  const realisticProfitUsd = filledBuyUsd > 0 ? netProceedsUsd - filledBuyUsd : null;
  const realisticProfitPct =
    filledBuyUsd > 0 && realisticProfitUsd != null ? (realisticProfitUsd / filledBuyUsd) * 100 : null;

  // Two-pointer walk for max fillable USD within top 5 before spread goes negative
  let i = 0;
  let j = 0;
  let askRem = asks[0]!.volume;
  let bidRem = bids[0]!.volume;
  let maxFillableUsd = 0;
  let maxNetFillableUsd = 0;

  while (i < asks.length && j < bids.length) {
    const askPrice = asks[i]!.price;
    const bidPrice = bids[j]!.price;
    if (bidPrice < askPrice) break;

    const maxBuyFromBid = bidRem / buyKeepRatio;
    const dBuyQty = Math.min(askRem, maxBuyFromBid);
    if (dBuyQty <= 1e-15) break;

    const dUsd = dBuyQty * askPrice;
    maxFillableUsd += dUsd;
    if (bidPrice * sellKeepRatio * buyKeepRatio >= askPrice) {
      maxNetFillableUsd += dUsd;
    }

    askRem -= dBuyQty;
    bidRem -= dBuyQty * buyKeepRatio;

    if (askRem <= 1e-12) {
      i += 1;
      askRem = i < asks.length ? asks[i]!.volume : 0;
    }
    if (bidRem <= 1e-12) {
      j += 1;
      bidRem = j < bids.length ? bids[j]!.volume : 0;
    }
  }

  return {
    ready: true,
    error: false,
    modalUsd: effectiveModal,
    filledModalUsd: filledBuyUsd,
    partial,
    vwapBuy,
    vwapSell,
    realisticProfitUsd,
    realisticProfitPct,
    maxFillableUsd,
    maxNetFillableUsd,
    buyTop5Usd,
    sellTop5Usd,
  };
}
