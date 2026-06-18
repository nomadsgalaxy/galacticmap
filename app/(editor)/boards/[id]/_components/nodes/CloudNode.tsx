"use client";

// A named "cloud" group: a translucent labeled region drawn BEHIND its member nodes. Sized +
// positioned by BoardCanvas from the live bounding box of its members, so it follows them.
// pointer-events are off on the body (clicks fall through to members); only the label chip is live.
export function CloudNode({
  data,
}: {
  data: { label?: string | null; color?: string | null; tags?: string[] };
}) {
  const color = data.color || "#8b5cf6";
  const hasChrome = !!data.label || (data.tags && data.tags.length > 0);
  return (
    <div
      className="pointer-events-none relative h-full w-full rounded-modal border-2 border-dashed"
      style={{ borderColor: `${color}66`, background: `${color}14` }}
    >
      {hasChrome && (
        <div className="pointer-events-auto absolute left-2 top-2 flex max-w-[90%] flex-wrap items-center gap-1">
          {data.label && (
            <span className="rounded-md border border-outline-variant bg-surface-container px-1.5 py-0.5 text-xs font-medium text-on-surface shadow-elev-1">
              {data.label}
            </span>
          )}
          {(data.tags ?? []).map((t) => (
            <span key={t} className="rounded bg-secondary-container px-1.5 py-0.5 text-[10px] text-on-secondary-container">
              #{t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
