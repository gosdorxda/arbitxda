"use client";

type FavoriteStarProps = {
  active: boolean;
  symbol: string;
  onToggle: () => void;
  disabled?: boolean;
};

export function FavoriteStar({ active, symbol, onToggle, disabled }: FavoriteStarProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      title={active ? "Hapus dari favorit" : "Tambah ke favorit"}
      aria-label={active ? `Hapus ${symbol} dari favorit` : `Tambah ${symbol} ke favorit`}
      aria-pressed={active}
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded"
      style={{
        color: active ? "#f5c14a" : "var(--muted)",
        background: "transparent",
        border: "none",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        {active ? (
          <path
            fill="currentColor"
            d="M8 1.35 9.94 5.3l4.36.64-3.15 3.07.74 4.34L8 11.3l-3.89 2.05.74-4.34L1.7 5.94l4.36-.64L8 1.35z"
          />
        ) : (
          <path
            fill="none"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinejoin="round"
            d="M8 1.35 9.94 5.3l4.36.64-3.15 3.07.74 4.34L8 11.3l-3.89 2.05.74-4.34L1.7 5.94l4.36-.64L8 1.35z"
          />
        )}
      </svg>
    </button>
  );
}
