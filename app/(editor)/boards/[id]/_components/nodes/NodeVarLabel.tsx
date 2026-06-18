"use client";

import { memo } from "react";
import { stripVarTokens } from "../../../../../lib/variables";

// Tiny presentational label that renders a node's variable template with each $name(content) token
// collapsed to its content VERBATIM (non-numeric tokens stay literal). Pinned below the node as an
// unobtrusive pill. Purely visual: pointer-events-none + nodrag so it never intercepts canvas gestures.
// Original work, OpenCommunityLicense.
export const NodeVarLabel = memo(function NodeVarLabel({ varText }: { varText: string }) {
  const label = stripVarTokens(varText ?? "").trim();
  if (!label) return null;
  return (
    <div className="nodrag pointer-events-none absolute -bottom-6 left-1/2 -translate-x-1/2 select-none whitespace-nowrap rounded-control bg-surface-container/95 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-on-surface-variant shadow-elev-1 ring-1 ring-outline-variant">
      {label}
    </div>
  );
});
