import Link from "next/link";

type AppNavProps = {
  current: "tabel" | "compare" | "favorites" | "scanner";
};

function segmentClass(active: boolean): string {
  return active
    ? "inline-flex h-7 items-center rounded-full bg-foreground px-3 text-[13px] font-medium text-background"
    : "inline-flex h-7 items-center rounded-full px-3 text-[13px] font-medium text-muted hover:text-foreground";
}

export function AppNav({ current }: AppNavProps) {
  return (
    <nav
      className="inline-flex h-8 shrink-0 items-center rounded-full border border-border bg-panel-2 p-0.5"
      aria-label="Halaman"
    >
      <Link href="/" className={segmentClass(current === "tabel")}>
        Tabel
      </Link>
      <Link href="/compare" className={segmentClass(current === "compare")}>
        Compare
      </Link>
      <Link href="/favorites" className={segmentClass(current === "favorites")}>
        Favorit
      </Link>
      <Link href="/scanner" className={segmentClass(current === "scanner")}>
        Scanner
      </Link>
    </nav>
  );
}
