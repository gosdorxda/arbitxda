"use client";

import type { ReactNode } from "react";
import { AppNav } from "@/components/AppNav";
import { GlobalSearch } from "@/components/GlobalSearch";
import { ExchangeSettingsButton } from "@/components/ExchangeSettings";
import { FontToggle } from "@/components/FontToggle";
import { ThemeToggle } from "@/components/ThemeToggle";

type AppHeaderProps = {
  current: "tabel" | "compare" | "favorites" | "scanner" | "manifest";
  children?: ReactNode;
};

export function AppHeader({ current, children }: AppHeaderProps) {
  return (
    <header className="app-header flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-background px-4 py-2 sm:px-5">
      <div className="flex min-w-0 shrink-0 items-center gap-3">
        <h1 className="truncate text-[15px] font-semibold tracking-tight">Arbit Scanner</h1>
        <AppNav current={current} />
      </div>
      <div className="order-last flex min-w-[16rem] flex-[1_1_16rem] justify-center sm:order-none">
        <GlobalSearch />
      </div>
      <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
        <ExchangeSettingsButton />
        <FontToggle />
        <ThemeToggle />
        {children}
      </div>
    </header>
  );
}
