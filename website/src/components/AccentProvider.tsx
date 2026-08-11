"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  ACCENTS,
  ACCENT_STORAGE_KEY,
  DEFAULT_ACCENT_ID,
  type Accent,
} from "@/data/accents";

type AccentContextValue = {
  accent: Accent;
  setAccentId: (id: string) => void;
  accents: Accent[];
};

const AccentContext = createContext<AccentContextValue | null>(null);

function applyAccent(accent: Accent) {
  const root = document.documentElement;
  root.style.setProperty("--accent", accent.rgb);
  root.style.setProperty("--accent-solid", accent.solid);
}

export function AccentProvider({ children }: { children: React.ReactNode }) {
  const [accentId, setAccentIdState] = useState<string>(DEFAULT_ACCENT_ID);

  // Restore persisted accent on mount.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(ACCENT_STORAGE_KEY);
      if (saved && ACCENTS.some((a) => a.id === saved)) {
        setAccentIdState(saved);
      }
    } catch {
      /* localStorage may be unavailable — default accent is fine. */
    }
  }, []);

  const accent = useMemo(
    () => ACCENTS.find((a) => a.id === accentId) ?? ACCENTS[0],
    [accentId],
  );

  // Re-tint the document whenever the accent changes.
  useEffect(() => {
    applyAccent(accent);
  }, [accent]);

  const setAccentId = useCallback((id: string) => {
    setAccentIdState(id);
    try {
      localStorage.setItem(ACCENT_STORAGE_KEY, id);
    } catch {
      /* ignore persistence failures */
    }
  }, []);

  const value = useMemo(
    () => ({ accent, setAccentId, accents: ACCENTS }),
    [accent, setAccentId],
  );

  return (
    <AccentContext.Provider value={value}>{children}</AccentContext.Provider>
  );
}

export function useAccent() {
  const ctx = useContext(AccentContext);
  if (!ctx) throw new Error("useAccent must be used within an AccentProvider");
  return ctx;
}
