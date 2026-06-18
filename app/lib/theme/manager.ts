import { ROLE_KEYS, cssVarName, deriveScheme, type Variant } from "./derive";

export type VariantPref = Variant | "system";
export type ThemeConfig = { seed: string; variant: VariantPref };

export const DEFAULT_SEED = "#6d28d9";
const LS_KEY = "gb:theme";

export function loadTheme(): ThemeConfig {
  if (typeof window === "undefined") return { seed: DEFAULT_SEED, variant: "system" };
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const t = JSON.parse(raw) as Partial<ThemeConfig>;
      if (t && typeof t.seed === "string" && t.variant) return { seed: t.seed, variant: t.variant };
    }
  } catch {
    /* ignore */
  }
  return { seed: DEFAULT_SEED, variant: "system" };
}

export function saveTheme(t: ThemeConfig) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(t));
  } catch {
    /* ignore */
  }
}

export function resolveVariant(v: VariantPref): Variant {
  if (v !== "system") return v;
  return typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** Apply a theme live: set data-theme-variant + write derived role vars (custom seed only). */
export function applyTheme(t: ThemeConfig) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const variant = resolveVariant(t.variant);
  root.setAttribute("data-theme-variant", variant);

  const isDefaultSeed = t.seed.toLowerCase() === DEFAULT_SEED.toLowerCase();
  if (isDefaultSeed) {
    // Fall back to the static CSS defaults.
    for (const k of ROLE_KEYS) root.style.removeProperty(cssVarName(k));
    return;
  }
  const palette = deriveScheme(t.seed, variant);
  for (const k of ROLE_KEYS) root.style.setProperty(cssVarName(k), palette[k]);
}
