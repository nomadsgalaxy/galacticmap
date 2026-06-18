"use client";

import { useStore } from "@xyflow/react";
import type { Peer } from "./useCollab";

// Remote collaborators' live cursors, rendered in flow space (transformed by the current pan/zoom).
// Rendered as a child of <ReactFlow> so it sits over the canvas pane.
export function PresenceCursors({ peers }: { peers: Peer[] }) {
  const tx = useStore((s) => s.transform); // [translateX, translateY, zoom]
  return (
    <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden">
      {peers
        .filter((p) => p.cursor)
        .map((p) => {
          const x = p.cursor!.x * tx[2] + tx[0];
          const y = p.cursor!.y * tx[2] + tx[1];
          return (
            <div key={p.clientId} className="absolute left-0 top-0" style={{ transform: `translate(${x}px, ${y}px)` }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill={p.color} style={{ filter: "drop-shadow(0 1px 1px rgba(0,0,0,.3))" }}>
                <path d="M3 2l6.5 18 2.6-7.4 7.4-2.6z" />
              </svg>
              <span
                className="ml-3 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium text-white shadow-elev-1"
                style={{ background: p.color }}
              >
                {p.name}
              </span>
            </div>
          );
        })}
    </div>
  );
}
