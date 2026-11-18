"use client";

import { useEffect, useRef, useState } from "react";

export const FONT_OPTIONS = [
  { id: "geist", label: "Geist (default)" },
  { id: "inter", label: "Inter" },
  { id: "ibm-plex", label: "IBM Plex" },
  { id: "jakarta", label: "Plus Jakarta" },
] as const;

export type FontId = (typeof FONT_OPTIONS)[number]["id"];

const FONT_STORAGE_KEY = "arbit-font";
const FONT_IDS = new Set<string>(FONT_OPTIONS.map((item) => item.id));

function isFontId(value: string | null | undefined): value is FontId {
  return Boolean(value && FONT_IDS.has(value));
}

function applyFont(id: FontId) {
  document.documentElement.setAttribute("data-font", id);
  try {
    window.localStorage.setItem(FONT_STORAGE_KEY, id);
  } catch {
    // storage diblokir
  }
}

function FontIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path
        fill="currentColor"
        d="M3.2 13h1.6l.7-2h3.8l.7 2h1.6L8.6 3H6.4L3.2 13zm3-3.4h2.6L7.55 5.1h-.1L6.2 9.6zM12.2 13V7.15h-.05L11 8.4l-.9-.75 2.15-2.15h1.35V13h-1.4z"
      />
    </svg>
  );
}

export function FontToggle() {
  const [font, setFont] = useState<FontId>("geist");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const current = document.documentElement.getAttribute("data-font");
    if (isFontId(current)) setFont(current);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const currentLabel = FONT_OPTIONS.find((item) => item.id === font)?.label ?? "Geist (default)";

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="btn-ghost inline-flex h-8 items-center gap-1.5 !px-2.5"
        title={`Font: ${currentLabel}`}
        aria-label="Pilih font tampilan"
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <FontIcon />
        <span className="hidden text-[12px] sm:inline">Font</span>
      </button>
      {open ? (
        <div className="absolute right-0 z-30 mt-1 w-52 rounded-lg border border-border bg-panel-2 p-2 shadow-xl">
          <p className="muted px-1 pb-1 text-[11px] uppercase tracking-wide">Font tampilan</p>
          <div role="listbox" aria-label="Pilihan font">
            {FONT_OPTIONS.map((option) => {
              const selected = option.id === font;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    applyFont(option.id);
                    setFont(option.id);
                    setOpen(false);
                  }}
                  className={`font-option font-option-${option.id} flex w-full flex-col items-start rounded px-2 py-1.5 text-left hover:bg-hover ${
                    selected ? "bg-hover" : ""
                  }`}
                >
                  <span className="text-[13px] font-medium text-foreground">{option.label}</span>
                  <span className={`font-option-num font-option-${option.id}-num muted text-[12px]`}>
                    1,234.56 USDT
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
