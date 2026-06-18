"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import {
  applyTheme,
  DEFAULT_SEED,
  loadTheme,
  saveTheme,
  type ThemeConfig,
} from "@/app/lib/theme/manager";

type ThemeCtx = { theme: ThemeConfig; setTheme: (t: ThemeConfig) => void };
const Ctx = createContext<ThemeCtx | null>(null);

export function useTheme(): ThemeCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useTheme must be used inside <ThemeProvider>");
  return c;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeConfig>({ seed: DEFAULT_SEED, variant: "system" });

  // Hydrate the persisted theme on mount and apply it.
  useEffect(() => {
    const t = loadTheme();
    setThemeState(t);
    applyTheme(t);
  }, []);

  // Live-respond to OS theme changes while in "system" mode.
  useEffect(() => {
    if (theme.variant !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme(theme);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = useCallback((t: ThemeConfig) => {
    setThemeState(t);
    saveTheme(t);
    applyTheme(t);
  }, []);

  return <Ctx.Provider value={{ theme, setTheme }}>{children}</Ctx.Provider>;
}
