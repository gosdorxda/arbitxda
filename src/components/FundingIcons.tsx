/** Ikon status deposit/withdrawal, dipakai tabel utama dan popover/kartu Compare. */

import { aggregateChainFlag } from "@/lib/chainstatus";

export type FundingIconValues = {
  depositEnabled?: number | null;
  withdrawEnabled?: number | null;
  chainstatusRaw?: string | null;
};

function chainFlagClass(value: number | null | undefined): string {
  if (value === 1) return "up";
  if (value === 0) return "down";
  return "muted";
}

export function fundingStatusLabel({
  depositEnabled,
  withdrawEnabled,
  chainstatusRaw,
}: FundingIconValues): string {
  const raw = (chainstatusRaw ?? "").trim();
  const key = raw.toLowerCase();
  const labels: Record<string, string> = {
    enabled: "Deposit dan withdrawal aktif",
    deposit_only: "Hanya deposit",
    withdrawal_only: "Hanya withdrawal",
    funding_temporarily_disabled: "Funding dinonaktifkan sementara",
  };
  if (labels[key]) return `${labels[key]} (${raw})`;
  if (raw) return `Status funding: ${raw}`;
  if (depositEnabled == null && withdrawEnabled == null) {
    return "Status deposit/withdrawal belum diketahui";
  }
  const depo = depositEnabled === 1 ? "aktif" : depositEnabled === 0 ? "nonaktif" : "tidak diketahui";
  const wd = withdrawEnabled === 1 ? "aktif" : withdrawEnabled === 0 ? "nonaktif" : "tidak diketahui";
  return `Deposit ${depo}, withdrawal ${wd}`;
}

function ArrowDownIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" className="shrink-0">
      <path
        fill="currentColor"
        d="M8 2a1 1 0 0 1 1 1v6.6l2.3-2.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4L7 9.6V3a1 1 0 0 1 1-1z"
      />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" className="shrink-0">
      <path
        fill="currentColor"
        d="M8 14a1 1 0 0 1-1-1V6.4L4.7 8.7a1 1 0 1 1-1.4-1.4l4-4a1 1 0 0 1 1.4 0l4 4a1 1 0 1 1-1.4 1.4L9 6.4V13a1 1 0 0 1-1 1z"
      />
    </svg>
  );
}

export function FundingIcons({ depositEnabled: depoRaw, withdrawEnabled: wdRaw, chainstatusRaw }: FundingIconValues) {
  // Kolom level koin kosong (mis. data lama BTSE/Phemex) → hitung dari status per jaringan.
  const depositEnabled = depoRaw ?? aggregateChainFlag(chainstatusRaw, "deposit");
  const withdrawEnabled = wdRaw ?? aggregateChainFlag(chainstatusRaw, "withdraw");
  if (depositEnabled == null && withdrawEnabled == null) {
    return <span className="muted">-</span>;
  }
  const label = fundingStatusLabel({ depositEnabled, withdrawEnabled, chainstatusRaw });
  return (
    <span className="inline-flex items-center gap-1" title={label} aria-label={label}>
      <span className={chainFlagClass(depositEnabled)} title="Deposit">
        <ArrowDownIcon />
      </span>
      <span className={chainFlagClass(withdrawEnabled)} title="Withdrawal">
        <ArrowUpIcon />
      </span>
    </span>
  );
}
