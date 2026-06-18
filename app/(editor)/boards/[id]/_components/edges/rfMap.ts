import { MarkerType, type Edge } from "@xyflow/react";
import { DEFAULT_SOURCE_HANDLE, DEFAULT_TARGET_HANDLE } from "../nodes/NodeHandles";

type EdgeInput = {
  id: string;
  source: string;
  target: string;
  type: string;
  label?: string | null;
  data?: Record<string, unknown> | null;
  kind?: string; // ignored (present on stored/collab edges)
  animated?: boolean; // ignored — AnimatedEdge animates itself
};

// Map a stored/projected connector → a React Flow edge for AnimatedEdge: resolve the anchors and
// arrowhead markers from edge.data; animated:false (AnimatedEdge runs its own comet animation, and
// React Flow's built-in `.animated` dashdraw would otherwise clobber it). Shared by the editor and
// the public view so connectors render identically in both.
export function toRFEdge(e: EdgeInput): Edge {
  const d = (e.data ?? {}) as { arrow?: string; color?: string; sourceHandle?: string; targetHandle?: string };
  const arrow = d.arrow ?? "end";
  // Default arrowhead color follows the global color scheme (this RF version applies the marker color
  // via inline style, so the CSS var resolves and tracks the theme). Per-edge color still overrides.
  const color = d.color ?? "var(--md-sys-color-primary)";
  const marker = { type: MarkerType.ArrowClosed, color, width: 16, height: 16 };
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: d.sourceHandle ?? DEFAULT_SOURCE_HANDLE,
    targetHandle: d.targetHandle ?? DEFAULT_TARGET_HANDLE,
    type: e.type,
    animated: false,
    label: e.label ?? undefined,
    data: e.data ?? {},
    ...(arrow === "end" || arrow === "both" ? { markerEnd: marker } : {}),
    ...(arrow === "start" || arrow === "both" ? { markerStart: marker } : {}),
  };
}
