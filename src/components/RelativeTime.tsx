"use client";

import { useEffect, useState } from "react";
import { formatRelativeId, formatWib } from "@/lib/format";

type RelativeTimeProps = {
  value: string | null | undefined;
  prefix?: string;
  className?: string;
};

export function RelativeTime({ value, prefix, className }: RelativeTimeProps) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

  const absolute = formatWib(value);
  const label = now == null ? "" : formatRelativeId(value, now);

  return (
    <span className={className} title={absolute} suppressHydrationWarning>
      {prefix}
      {now == null ? "…" : label}
    </span>
  );
}
