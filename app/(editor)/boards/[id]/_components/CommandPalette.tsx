"use client";

import { Command } from "cmdk";
import type { ReactNode } from "react";
import { useModKey } from "@/app/_components/useModKey";

export type PaletteItem = {
  id: string;
  label: string;
  hint?: string;
  keywords?: string;
  icon?: ReactNode;
  run: () => void;
};
export type PaletteGroup = { heading: string; items: PaletteItem[] };

// ⌘K command palette (Linear/Raycast-style). Aggregates existing editor actions + node navigation.
// We render our own accessible overlay around cmdk's <Command> (not Command.Dialog) so we don't
// pull in Radix Dialog's required DialogTitle — the wrapper carries role/aria itself.
export function CommandPalette({
  open,
  onOpenChange,
  groups,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: PaletteGroup[];
}) {
  const { mod } = useModKey();
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      className="fixed inset-0 z-50 flex items-start justify-center"
    >
      <button
        aria-label="Close command palette"
        onClick={() => onOpenChange(false)}
        className="absolute inset-0 cursor-default"
        style={{ background: "color-mix(in srgb, var(--md-sys-color-scrim) 32%, transparent)" }}
      />
      <Command
        label="Command palette"
        onKeyDown={(e) => {
          if (e.key === "Escape") onOpenChange(false);
        }}
        className="gb-pop-in relative mt-[12vh] w-[min(92vw,560px)] overflow-hidden rounded-modal border border-outline-variant bg-surface-container shadow-elev-4"
      >
        <div className="flex items-center gap-2 border-b border-outline-variant px-3">
          <span className="shrink-0 text-xs text-on-surface-variant">{mod}</span>
          <Command.Input
            autoFocus
            placeholder="Type a command or search nodes…"
            className="w-full bg-transparent py-3 text-sm text-on-surface outline-none placeholder:text-on-surface-variant"
          />
        </div>
        <Command.List className="max-h-[52vh] overflow-y-auto p-1.5">
          <Command.Empty className="px-3 py-6 text-center text-sm text-on-surface-variant">
            No matches.
          </Command.Empty>
          {groups.map((g) =>
            g.items.length === 0 ? null : (
              <Command.Group
                key={g.heading}
                heading={g.heading}
                className="px-1.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-on-surface-variant [&_[cmdk-group-items]]:mt-1"
              >
                {g.items.map((item) => (
                  <Command.Item
                    key={item.id}
                    value={`${item.label} ${item.keywords ?? ""}`}
                    onSelect={() => {
                      onOpenChange(false);
                      item.run();
                    }}
                    className="flex cursor-pointer items-center gap-2.5 rounded-control px-2.5 py-2 text-sm text-on-surface transition-colors data-[selected=true]:bg-secondary-container data-[selected=true]:text-on-secondary-container"
                  >
                    {item.icon && <span className="shrink-0 text-on-surface-variant">{item.icon}</span>}
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.hint && <span className="shrink-0 text-xs text-on-surface-variant">{item.hint}</span>}
                  </Command.Item>
                ))}
              </Command.Group>
            ),
          )}
        </Command.List>
      </Command>
    </div>
  );
}
