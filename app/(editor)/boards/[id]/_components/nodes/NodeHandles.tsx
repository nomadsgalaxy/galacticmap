"use client";

import { Handle, Position, type HandleProps } from "@xyflow/react";
import type { CSSProperties } from "react";

// 8 connection anchors per node: 4 side-midpoints + 4 corners. Every anchor is type="source";
// with ConnectionMode.Loose on the canvas, any anchor can START or RECEIVE a connection, so the
// source→target direction is simply decided by which anchor you drag from first (and can be
// flipped afterwards in the connector inspector). Hidden until the node is hovered.
const ANCHORS: { id: string; position: Position; style?: CSSProperties }[] = [
  { id: "t", position: Position.Top },
  { id: "b", position: Position.Bottom },
  { id: "l", position: Position.Left },
  { id: "r", position: Position.Right },
  { id: "tl", position: Position.Top, style: { left: 0 } },
  { id: "tr", position: Position.Top, style: { left: "100%" } },
  { id: "bl", position: Position.Bottom, style: { left: 0 } },
  { id: "br", position: Position.Bottom, style: { left: "100%" } },
];

// Default anchors for edges saved before per-anchor handles existed (old behaviour: right→left).
export const DEFAULT_SOURCE_HANDLE = "r";
export const DEFAULT_TARGET_HANDLE = "l";

// `selected` is passed by RESIZABLE nodes (e.g. ImageNode): when selected, the NodeResizer's corner/edge
// grips share the perimeter with these anchors, so we make the anchors invisible + non-interactive (but
// still MOUNTED, so React Flow keeps their bounds and existing edges stay attached) — the resizer wins.
export function NodeHandles(props: Pick<HandleProps, "isConnectable"> & { selected?: boolean }) {
  const visibility = props.selected ? "!opacity-0 !pointer-events-none" : "!opacity-0 group-hover:!opacity-100";
  return (
    <>
      {ANCHORS.map((a) => (
        <Handle
          key={a.id}
          id={a.id}
          type="source"
          position={a.position}
          style={a.style}
          isConnectable={props.isConnectable}
          className={`!h-2.5 !w-2.5 !rounded-full !border-2 !border-surface !bg-primary !transition-opacity ${visibility}`}
        />
      ))}
    </>
  );
}
