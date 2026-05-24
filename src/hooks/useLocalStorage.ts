import { useEffect, useState } from "react";

/**
 * useState backed by localStorage — survives page reloads.
 *
 * Supports any JSON-serializable value (string, number, boolean, object).
 * Strings are stored as-is for backward compat with values written before
 * this hook was JSON-aware; non-strings are JSON-encoded.
 *
 * Falls back to `def` on read/parse errors (incognito, quota, malformed JSON).
 */
export function useLocalStorage<T>(key: string, def: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return def;
      if (typeof def === "string") {
        // Backward-compat: stored as plain string.
        return raw as unknown as T;
      }
      try {
        return JSON.parse(raw) as T;
      } catch {
        // Legacy plain-string value for a non-string default; fall back.
        return def;
      }
    } catch {
      return def;
    }
  });

  useEffect(() => {
    try {
      const out = typeof v === "string" ? v : JSON.stringify(v);
      localStorage.setItem(key, out);
    } catch {
      /* quota / incognito */
    }
  }, [key, v]);

  return [v, setV];
}
