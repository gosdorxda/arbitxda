"use client";

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

/**
 * Persist state to localStorage without clobbering saved values during SSR/hydration.
 * Reads after mount (before any write), and only writes once the hydration flag is true.
 */
export function usePersistedState<T>(
  key: string,
  fallback: T,
  parse: (raw: unknown) => T | null,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(fallback);
  const [ready, setReady] = useState(false);
  const parseRef = useRef(parse);
  parseRef.current = parse;

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw != null && raw !== "") {
        const parsed = parseRef.current(JSON.parse(raw));
        if (parsed != null) setValue(parsed);
      }
    } catch {
      // storage rusak atau diblokir
    }
    setReady(true);
  }, [key]);

  useEffect(() => {
    if (!ready) return;
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage penuh atau diblokir
    }
  }, [key, ready, value]);

  return [value, setValue];
}
