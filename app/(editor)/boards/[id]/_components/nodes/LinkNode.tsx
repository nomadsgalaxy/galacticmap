"use client";

import { memo } from "react";
import { type NodeProps } from "@xyflow/react";
import { NodeHandles } from "./NodeHandles";
import { useCanvasStore } from "../../_store/canvasStore";
import { RotateHandle } from "./RotateHandle";
import { NodeVarLabel } from "./NodeVarLabel";

export const LinkNode = memo(function LinkNode({ id, data, selected }: NodeProps) {
  const d = data as {
    url?: string;
    title?: string;
    description?: string;
    image?: string;
    favicon?: string;
    rotation?: number;
    varText?: string;
    showVars?: boolean;
  };
  const url = d.url ?? "";
  const rotation = Number(d.rotation ?? 0);
  const varText = String(d.varText ?? "");
  const showVars = Boolean(d.showVars);
  const canEdit = useCanvasStore((s) => s.canEdit);
  let domain = url;
  try {
    domain = new URL(url).hostname;
  } catch {
    /* keep raw */
  }

  // Open on DOUBLE-click only, so a single click / drag just moves & selects the node. The dblclick
  // is a user gesture, so window.open isn't popup-blocked; noopener,noreferrer prevents tabnabbing.
  const open = () => {
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <div
      onDoubleClick={(e) => {
        e.stopPropagation();
        open();
      }}
      title={url ? "Double-click to open" : undefined}
      style={{ transform: rotation ? `rotate(${rotation}deg)` : undefined, transformOrigin: "center" }}
      className={`group relative w-[260px] cursor-default rounded-panel border bg-surface shadow-elev-1 ${
        selected ? "border-primary ring-2 ring-primary/40" : "border-outline-variant"
      }`}
    >
      <NodeHandles />
      {selected && canEdit && <RotateHandle nodeId={id} />}
      <div className="overflow-hidden rounded-panel">
        {d.image && (
          // eslint-disable-next-line @next/next/no-img-element -- external thumbnail
          <img src={d.image} alt="" draggable={false} className="h-28 w-full object-cover" />
        )}
        <div className="block p-2">
          <div className="flex items-center gap-1">
            {d.favicon && (
              // eslint-disable-next-line @next/next/no-img-element -- external favicon
              <img src={d.favicon} alt="" draggable={false} className="h-3.5 w-3.5" />
            )}
            <span className="truncate text-[11px] text-on-surface-variant">{domain}</span>
          </div>
          <div className="truncate text-sm font-medium text-on-surface">{d.title || url || "Link"}</div>
          {d.description && (
            <div className="mt-0.5 line-clamp-2 text-xs text-on-surface-variant">{d.description}</div>
          )}
        </div>
      </div>
      {showVars && varText && <NodeVarLabel varText={varText} />}
    </div>
  );
});
