"use client";

import { BaseEdge, getSmoothStepPath, type EdgeProps } from "@xyflow/react";

// Derived mind-map tree edge (from Node.parentId). Muted, non-animated, not stored.
export function TreeEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }: EdgeProps) {
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 12,
  });
  return <BaseEdge id={id} path={path} style={{ stroke: "var(--md-sys-color-outline)", strokeWidth: 1.5 }} />;
}
