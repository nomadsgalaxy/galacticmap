import {
  argbFromHex,
  hexFromArgb,
  themeFromSourceColor,
  sourceColorFromImage,
  Hct,
} from "@material/material-color-utilities";

// Ordered M3 system color roles (the token vocabulary; consumed as CSS vars).
export const ROLE_KEYS = [
  "primary",
  "onPrimary",
  "primaryContainer",
  "onPrimaryContainer",
  "secondary",
  "onSecondary",
  "secondaryContainer",
  "onSecondaryContainer",
  "tertiary",
  "onTertiary",
  "tertiaryContainer",
  "onTertiaryContainer",
  "error",
  "onError",
  "errorContainer",
  "onErrorContainer",
  "background",
  "onBackground",
  "surface",
  "onSurface",
  "surfaceVariant",
  "onSurfaceVariant",
  "surfaceContainer",
  "outline",
  "outlineVariant",
  "inverseSurface",
  "inverseOnSurface",
  "inversePrimary",
  "shadow",
  "scrim",
] as const;

export type RoleKey = (typeof ROLE_KEYS)[number];
export type Palette = Record<RoleKey, string>;
export type Variant = "light" | "dark";

/** --md-sys-color-on-primary, etc. */
export function cssVarName(role: RoleKey): string {
  return "--md-sys-color-" + role.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
}

const safeHex = (hex: string): string => (/^#[0-9a-fA-F]{6}$/.test(hex) ? hex : "#6d28d9");

function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (n: number, sh: number) => (n >> sh) & 255;
  const m = (x: number, y: number) => Math.round(x + (y - x) * t);
  const r = m(ch(pa, 16), ch(pb, 16));
  const g = m(ch(pa, 8), ch(pb, 8));
  const bl = m(ch(pa, 0), ch(pb, 0));
  return "#" + [r, g, bl].map((v) => v.toString(16).padStart(2, "0")).join("");
}

/** Material You: derive a full M3 palette from a single seed color. */
export function deriveScheme(seedHex: string, variant: Variant): Palette {
  const theme = themeFromSourceColor(argbFromHex(safeHex(seedHex)));
  const scheme = variant === "dark" ? theme.schemes.dark : theme.schemes.light;
  const s = scheme as unknown as Record<string, number>;
  const out = {} as Palette;
  for (const k of ROLE_KEYS) {
    if (k === "surfaceContainer") continue; // derived below (no direct role in classic Scheme)
    out[k] = hexFromArgb(s[k]);
  }
  // Elevated container tone: nudge surface toward surfaceVariant so cards/panels separate
  // from the (often near-identical) background — fixes "white on white".
  out.surfaceContainer = mixHex(out.surface, out.surfaceVariant, 0.5);
  return out;
}

// ── HCT helpers for the custom picker (hue / chroma / tone sliders) ──
export function hexToHct(hex: string): { hue: number; chroma: number; tone: number } {
  const h = Hct.fromInt(argbFromHex(safeHex(hex)));
  return { hue: h.hue, chroma: h.chroma, tone: h.tone };
}
export function hctToHex(hue: number, chroma: number, tone: number): string {
  return hexFromArgb(Hct.from(hue, chroma, tone).toInt());
}

/** Extract a Material You seed color from an image file (moodboard → theme). */
export async function seedFromImageFile(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("image load failed"));
      img.src = url;
    });
    const argb = await sourceColorFromImage(img);
    return hexFromArgb(argb);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ── WCAG contrast (ported from ThemeForge: ratio + tier) ──
function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function relLuminance(hex: string): number {
  const n = parseInt(hex.replace("#", ""), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
export function contrastRatio(fg: string, bg: string): number {
  const a = relLuminance(fg);
  const b = relLuminance(bg);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}
export type ContrastTier = "AAA" | "AA" | "AA-Large" | "FAIL";
export function contrastTier(ratio: number): ContrastTier {
  if (ratio >= 7) return "AAA";
  if (ratio >= 4.5) return "AA";
  if (ratio >= 3) return "AA-Large";
  return "FAIL";
}
