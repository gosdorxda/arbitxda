import { deviationColor } from "@/lib/calc";

export function formatWib(iso: string | null | undefined): string {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const text = date.toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return `${text} WIB`;
}

/** Waktu singkat di zona Asia/Jakarta, mis. 12/11 10:06:00 WIB. */
export function formatWibShort(iso: string | null | undefined): string {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("day")}/${get("month")} ${get("hour")}:${get("minute")}:${get("second")} WIB`;
}

/** Parse ISO (with Z/offset) or SQLite UTC `YYYY-MM-DD HH:MM:SS` into a Date. */
export function parseTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const utcish = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(utcish)) {
    const date = new Date(`${utcish}Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Relative time in Indonesian, e.g. "baru saja", "12 detik lalu", "5 menit lalu". */
export function formatRelativeId(value: string | null | undefined, now: number = Date.now()): string {
  const date = parseTimestamp(value);
  if (!date) return "-";
  const diffMs = now - date.getTime();
  if (diffMs < 5000) return "baru saja";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds} detik lalu`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} menit lalu`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} jam lalu`;
  const days = Math.floor(hours / 24);
  return `${days} hari lalu`;
}

export function formatNumber(value: number | null | undefined, digits = 8): string {
  if (value == null || !Number.isFinite(value)) return "-";
  const abs = Math.abs(value);
  const maxFrac = abs >= 1000 ? 2 : abs >= 1 ? 6 : digits;
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: maxFrac,
    minimumFractionDigits: 0,
  }).format(value);
}

export function formatPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return `${value.toFixed(2)}%`;
}

/** Harga: >= 1 -> 4 desimal; < 1 -> 4 digit signifikan; >= 4 nol di belakang titik -> 0.(n)xxxx */
export function formatPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  if (value === 0) return "0.0000";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1) {
    return sign + new Intl.NumberFormat("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(abs);
  }
  const zeros = Math.max(0, -Math.floor(Math.log10(abs)) - 1);
  const fixed = abs.toFixed(zeros + 4); // 4 digit signifikan
  const digits = fixed.split(".")[1] ?? "";
  if (digits.length > zeros + 4 || !digits.startsWith("0".repeat(zeros))) return sign + fixed;
  const sig = digits.slice(zeros);
  if (zeros >= 4) return `${sign}0.(${zeros})${sig}`;
  return sign + fixed;
}

/** Jumlah koin / size: 0.12, 1,234.5, 1.23K, 4.56M */
export function formatAmountCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  const abs = Math.abs(value);
  if (abs === 0) return "0";
  if (abs < 1000) {
    return new Intl.NumberFormat("en-US", {
      maximumFractionDigits: abs >= 1 ? 4 : 6,
      minimumFractionDigits: 0,
    }).format(value);
  }
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

/** Angka input filter: 1500, 10k, 1.5m, 2b (k/m/b). */
export function parseCompactNumber(raw: string): number | null {
  const text = raw.trim().replace(/[$\s_]/g, "");
  if (!text) return null;
  const normalized = text.replace(",", ".");
  const match = normalized.match(/^(-?\d+(?:\.\d+)?)(k|m|b)?$/i);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  const suffix = (match[2] ?? "").toLowerCase();
  const mul = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : suffix === "b" ? 1_000_000_000 : 1;
  return n * mul;
}

/** Volume USD: $500, $1.2K, $3.45M, $1.1B */
export function formatUsdCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  if (Math.abs(value) < 1000) return `$${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)}`;
  return "$" + new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

export function colorClass(value: number | null): string {
  const color = deviationColor(value);
  if (color === "green") return "spread-green";
  if (color === "yellow") return "spread-yellow";
  if (color === "red") return "spread-red";
  return "muted";
}

export type MarketStatusTone = "ok" | "warn" | "bad" | "neutral";

export type MarketStatusMeta = {
  key: string;
  label: string;
  tone: MarketStatusTone;
  active: boolean;
};

/**
 * Status aktif dari berbagai exchange (sudah tersimpan di DB, tanpa perlu fetch ulang).
 * Contoh: online, trading, enable, 1, tradable, normal.
 */
const ACTIVE_MARKET_STATUS = new Set([
  "online",
  "trading",
  "enable",
  "enabled",
  "1",
  "active",
  "open",
  "normal",
  "tradable",
]);

const RESTRICTED_MARKET_STATUS = new Set([
  "cancel_only",
  "delisted",
  "post_only",
  "limit_only",
  "reduce_only",
  "maintenance",
  "work_in_progress",
  "pre_open",
  "pre-open",
  "accessed",
  "10",
  "suspended",
  "pre_delisted",
  "pre-delisted",
  "offline",
  "inactive",
  "0",
]);

function normalizeMarketStatus(status?: string | null): string {
  return (status ?? "").trim().toLowerCase();
}

/** Pair aktif jika status dikenal sebagai trading, atau (kalau status kosong/tak dikenal) flag active = 1. */
export function isMarketActive(status?: string | null, active?: number | null): boolean {
  const key = normalizeMarketStatus(status);
  if (key) {
    if (ACTIVE_MARKET_STATUS.has(key)) return true;
    if (RESTRICTED_MARKET_STATUS.has(key)) return false;
    if (active != null) return active === 1;
    return false;
  }
  if (active != null) return active === 1;
  return true;
}

export function marketStatusMeta(status?: string | null, active?: number | null): MarketStatusMeta {
  const key = normalizeMarketStatus(status);
  if (!key) {
    const activeFlag = isMarketActive(status, active);
    return {
      key: activeFlag ? "online" : "inactive",
      label: activeFlag ? "Aktif" : "Non-aktif",
      tone: activeFlag ? "ok" : "bad",
      active: activeFlag,
    };
  }
  if (ACTIVE_MARKET_STATUS.has(key)) {
    return { key, label: "Aktif", tone: "ok", active: true };
  }
  switch (key) {
    case "cancel_only":
      return { key, label: "Cancel only", tone: "bad", active: false };
    case "delisted":
      return { key, label: "Delist", tone: "bad", active: false };
    case "post_only":
      return { key, label: "Post only", tone: "warn", active: false };
    case "limit_only":
      return { key, label: "Limit only", tone: "warn", active: false };
    case "reduce_only":
      return { key, label: "Reduce only", tone: "warn", active: false };
    case "maintenance":
      return { key, label: "Maintenance", tone: "warn", active: false };
    case "work_in_progress":
      return { key, label: "Dalam proses", tone: "warn", active: false };
    case "pre_open":
    case "pre-open":
      return { key: "pre_open", label: "Pre-open", tone: "warn", active: false };
    case "accessed":
    case "10":
      return { key: "accessed", label: "Accessed", tone: "warn", active: false };
    case "suspended":
      return { key, label: "Suspended", tone: "bad", active: false };
    case "pre_delisted":
    case "pre-delisted":
      return { key: "pre_delisted", label: "Pre-delist", tone: "warn", active: false };
    case "offline":
    case "inactive":
    case "0":
      return { key, label: "Offline", tone: "bad", active: false };
    default: {
      const activeFlag = isMarketActive(status, active);
      return {
        key,
        label: activeFlag ? "Aktif" : (status ?? "").trim() || "Non-aktif",
        tone: activeFlag ? "ok" : "warn",
        active: activeFlag,
      };
    }
  }
}
