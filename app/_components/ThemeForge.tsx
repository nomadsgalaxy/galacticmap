"use client";

import { useEffect, useRef, useState } from "react";
import { Palette as PaletteIcon, X } from "lucide-react";
import { useTheme } from "./ThemeProvider";
import {
  applyTheme,
  DEFAULT_SEED,
  resolveVariant,
  type ThemeConfig,
  type VariantPref,
} from "@/app/lib/theme/manager";
import { contrastRatio, contrastTier, deriveScheme, hctToHex, hexToHct, seedFromImageFile } from "@/app/lib/theme/derive";

const VARIANTS: VariantPref[] = ["system", "light", "dark"];
const WCAG_PAIRS: Array<[string, keyof ReturnType<typeof deriveScheme>, keyof ReturnType<typeof deriveScheme>]> = [
  ["Button text", "onPrimary", "primary"],
  ["Body text", "onSurface", "surface"],
  ["Muted text", "onSurfaceVariant", "surface"],
  ["Accent on bg", "primary", "surface"],
];

export function ThemeForge() {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ThemeConfig>(theme);
  const snapshot = useRef<ThemeConfig>(theme);
  const raf = useRef<number | null>(null);
  const imgInput = useRef<HTMLInputElement>(null);

  // Keep draft in sync when opening.
  useEffect(() => {
    if (open) {
      snapshot.current = theme;
      setDraft(theme);
    }
  }, [open, theme]);

  // Live-apply the draft (throttled), without persisting.
  useEffect(() => {
    if (!open) return;
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => applyTheme(draft));
  }, [draft, open]);

  // Esc reverts to the snapshot.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const cancel = () => {
    applyTheme(snapshot.current);
    setOpen(false);
  };
  const save = () => {
    setTheme(draft);
    setOpen(false);
  };
  const reset = () => setDraft({ seed: DEFAULT_SEED, variant: draft.variant });

  const variant = resolveVariant(draft.variant);
  const palette = deriveScheme(draft.seed, variant);
  const hct = hexToHct(draft.seed);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="Customize theme"
        className="fixed bottom-4 right-4 z-50 flex h-11 w-11 items-center justify-center rounded-full bg-primary text-on-primary shadow-elev-3 transition hover:opacity-90 active:scale-[.97]"
      >
        <PaletteIcon className="h-5 w-5" />
      </button>
    );
  }

  return (
    <div className="gb-pop-in fixed bottom-4 right-4 z-50 w-80 rounded-modal border border-outline-variant bg-surface-container p-4 text-on-surface shadow-elev-3">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Customize theme</h2>
        <button onClick={cancel} aria-label="Close" className="rounded p-1 text-on-surface-variant transition hover:bg-surface-variant" title="Close (Esc)">
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Seed color */}
      <label className="mb-1 block text-xs font-medium text-on-surface-variant">Seed color</label>
      <div className="mb-3 flex items-center gap-2">
        <input
          type="color"
          value={draft.seed}
          onChange={(e) => setDraft({ ...draft, seed: e.target.value })}
          className="h-9 w-9 cursor-pointer rounded border-0 bg-transparent p-0"
        />
        <input
          type="text"
          value={draft.seed}
          onChange={(e) => setDraft({ ...draft, seed: e.target.value })}
          className="w-24 rounded-control border border-outline-variant bg-surface px-2 py-1 font-mono text-sm outline-none focus-visible:border-primary"
        />
        <button
          onClick={() => imgInput.current?.click()}
          className="rounded-control border border-outline-variant px-2 py-1 text-xs text-on-surface-variant transition hover:bg-surface-variant hover:text-on-surface active:scale-[.98]"
          title="Extract a palette from an image"
        >
          From image
        </button>
        <input
          ref={imgInput}
          type="file"
          accept="image/*"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            try {
              const hex = await seedFromImageFile(f);
              setDraft({ ...draft, seed: hex });
            } catch {
              /* ignore */
            }
          }}
        />
      </div>

      {/* HCT sliders */}
      <div className="mb-3 space-y-2">
        <Slider label="Hue" min={0} max={360} value={hct.hue} onChange={(h) => setDraft({ ...draft, seed: hctToHex(h, hct.chroma, hct.tone) })} />
        <Slider label="Chroma" min={0} max={120} value={hct.chroma} onChange={(c) => setDraft({ ...draft, seed: hctToHex(hct.hue, c, hct.tone) })} />
        <Slider label="Tone" min={0} max={100} value={hct.tone} onChange={(t) => setDraft({ ...draft, seed: hctToHex(hct.hue, hct.chroma, t) })} />
      </div>

      {/* Variant */}
      <div className="mb-3 flex gap-1 rounded-control border border-outline-variant p-1">
        {VARIANTS.map((v) => (
          <button
            key={v}
            onClick={() => setDraft({ ...draft, variant: v })}
            className={`flex-1 rounded px-2 py-1 text-xs capitalize ${
              draft.variant === v ? "bg-primary text-on-primary" : "hover:bg-surface-variant"
            }`}
          >
            {v}
          </button>
        ))}
      </div>

      {/* WCAG readout */}
      <div className="mb-3 rounded-control bg-surface-variant p-2 text-on-surface-variant">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide">Contrast</div>
        <ul className="space-y-0.5">
          {WCAG_PAIRS.map(([label, fg, bg]) => {
            const ratio = contrastRatio(palette[fg], palette[bg]);
            const tier = contrastTier(ratio);
            const color = tier === "FAIL" ? "text-error" : tier === "AA-Large" ? "text-tertiary" : "text-on-surface-variant";
            return (
              <li key={label} className="flex items-center justify-between text-[11px]">
                <span>{label}</span>
                <span className={`font-mono ${color}`}>
                  {ratio.toFixed(1)} · {tier}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex items-center justify-between">
        <button onClick={reset} className="rounded-control px-2 py-1 text-xs text-on-surface-variant transition hover:bg-surface-variant active:scale-[.98]">
          Reset
        </button>
        <div className="flex gap-2">
          <button onClick={cancel} className="rounded-control px-3 py-1.5 text-sm text-on-surface-variant transition hover:bg-surface-variant hover:text-on-surface active:scale-[.98]">
            Cancel
          </button>
          <button onClick={save} className="rounded-control bg-primary px-3 py-1.5 text-sm font-medium text-on-primary shadow-elev-1 transition hover:opacity-90 active:scale-[.98]">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function Slider({
  label,
  min,
  max,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 text-[11px] text-on-surface-variant">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={Math.round(value)}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-primary"
      />
      <span className="w-8 text-right font-mono text-[11px] text-on-surface-variant">{Math.round(value)}</span>
    </div>
  );
}
