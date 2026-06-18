"use client";

import { memo, useRef, useState } from "react";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import { Crop, Check, RotateCcw, ZoomIn } from "lucide-react";
import { NodeHandles } from "./NodeHandles";
import { useCanvasStore } from "../../_store/canvasStore";
import { updateNodeData } from "../../actions";
import { RotateHandle } from "./RotateHandle";
import { NodeVarLabel } from "./NodeVarLabel";

export const ImageNode = memo(function ImageNode({ id, data, selected }: NodeProps) {
  const d = data as { assetId?: string; alt?: string; fit?: string; zoom?: number; posX?: number; posY?: number; rotation?: number; varText?: string; showVars?: boolean };
  const rotation = Number(d.rotation ?? 0);
  const assetId = String(d.assetId ?? "");
  const alt = String(d.alt ?? "");
  const cover = d.fit === "cover"; // persistent "is this image cropped" flag (kept across edit toggles)
  const zoom = typeof d.zoom === "number" && d.zoom >= 1 ? d.zoom : 1;
  const posX = typeof d.posX === "number" ? d.posX : 50;
  const posY = typeof d.posY === "number" ? d.posY : 50;
  const varText = String(d.varText ?? "");
  const showVars = Boolean(d.showVars);

  const boardId = useCanvasStore((s) => s.boardId);
  const canEdit = useCanvasStore((s) => s.canEdit);
  const setData = useCanvasStore((s) => s.updateNodeData);

  // Crop is a deliberate EDIT MODE: enter it to pan/zoom, leave it and the crop is kept. Outside edit
  // mode the image is inert so the NODE drags normally (the bug was the pan handler eating node drags).
  const [editingCrop, setEditingCrop] = useState(false);

  const apply = (patch: Record<string, unknown>) => setData(id, patch);
  const persist = (patch: Record<string, unknown>) => {
    setData(id, patch);
    void updateNodeData(boardId, id, patch);
  };

  const startCrop = () => {
    if (!cover) persist({ fit: "cover" }); // first crop: fill the frame so there's a region to choose
    setEditingCrop(true);
  };
  const resetCrop = () => {
    setEditingCrop(false);
    persist({ fit: "contain", zoom: 1, posX: 50, posY: 50 });
  };

  // Drag-to-pan — ONLY while editing the crop. nodrag stops React Flow from moving the node so the
  // gesture repositions the visible region instead.
  const pan = useRef<{ sx: number; sy: number; bx: number; by: number; w: number; h: number; lx: number; ly: number } | null>(null);
  const onPanDown = (e: React.PointerEvent) => {
    if (!editingCrop || !canEdit) return;
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    pan.current = { sx: e.clientX, sy: e.clientY, bx: posX, by: posY, w: r.width || 1, h: r.height || 1, lx: posX, ly: posY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPanMove = (e: React.PointerEvent) => {
    const p = pan.current;
    if (!p) return;
    const dx = ((e.clientX - p.sx) / p.w) * 100 / zoom;
    const dy = ((e.clientY - p.sy) / p.h) * 100 / zoom;
    p.lx = Math.max(0, Math.min(100, p.bx - dx)); // drag right → reveal the left edge → posX decreases
    p.ly = Math.max(0, Math.min(100, p.by - dy));
    apply({ posX: p.lx, posY: p.ly });
  };
  const onPanUp = () => {
    const p = pan.current;
    if (!p) return;
    persist({ posX: p.lx, posY: p.ly });
    pan.current = null;
  };

  return (
    <div
      style={{ transform: rotation ? `rotate(${rotation}deg)` : undefined, transformOrigin: "center" }}
      className={`group relative h-full w-full rounded-panel border bg-surface shadow-elev-1 ${
        selected ? "border-primary ring-2 ring-primary/40" : "border-outline-variant"
      } ${editingCrop ? "ring-2 ring-tertiary" : ""}`}
    >
      {/* Resize handles scale the frame. Disabled mid-crop so a resize-drag isn't read as a pan. */}
      <NodeResizer isVisible={!!selected && canEdit && !editingCrop} minWidth={80} minHeight={60} />
      {/* While selected the NodeResizer owns the perimeter — yield the corner/edge anchors to it. */}
      <NodeHandles selected={!!selected && canEdit && !editingCrop} />
      {selected && canEdit && <RotateHandle nodeId={id} />}
      <div className="h-full w-full overflow-hidden rounded-panel">
        {assetId ? (
          // eslint-disable-next-line @next/next/no-img-element -- canvas tile, not a layout image
          <img
            src={`/api/assets/${assetId}`}
            alt={alt}
            draggable={false}
            decoding="async"
            {...(editingCrop ? { onPointerDown: onPanDown, onPointerMove: onPanMove, onPointerUp: onPanUp, onPointerCancel: onPanUp } : {})}
            className={`h-full w-full select-none ${cover ? "object-cover" : "object-contain"} ${editingCrop ? "nodrag cursor-move" : ""}`}
            style={cover ? { objectPosition: `${posX}% ${posY}%`, transform: `scale(${zoom})`, transformOrigin: `${posX}% ${posY}%` } : undefined}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-on-surface-variant">No image</div>
        )}
      </div>

      {/* Crop controls (selected + editable). Crop is manual: enter to pan/zoom, Done keeps it, Reset clears it. */}
      {selected && canEdit && assetId && (
        <div className="nodrag nopan absolute -bottom-10 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-control border border-outline-variant bg-surface-container/95 px-1.5 py-1 shadow-elev-2 backdrop-blur">
          {editingCrop ? (
            <>
              <button
                onClick={() => setEditingCrop(false)}
                title="Done — keep this crop"
                className="flex items-center gap-1 rounded bg-primary px-1.5 py-1 text-xs font-medium text-on-primary transition active:scale-95"
              >
                <Check size={13} /> Done
              </button>
              <label className="flex items-center gap-1 px-1 text-on-surface-variant" title="Zoom">
                <ZoomIn size={13} />
                <input
                  type="range"
                  min={1}
                  max={6}
                  step={0.1}
                  value={zoom}
                  onChange={(e) => apply({ zoom: Number(e.target.value) })}
                  onPointerUp={(e) => persist({ zoom: Number((e.target as HTMLInputElement).value) })}
                  className="nodrag h-1 w-20 cursor-pointer accent-primary"
                />
              </label>
            </>
          ) : (
            <button
              onClick={startCrop}
              title={cover ? "Adjust crop (drag the image / zoom)" : "Crop: fill the frame, then drag/zoom"}
              className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-on-surface transition hover:bg-surface-variant active:scale-95"
            >
              <Crop size={13} /> {cover ? "Edit crop" : "Crop"}
            </button>
          )}
          {cover && (
            <button
              onClick={resetCrop}
              title="Reset crop (show whole image)"
              className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-on-surface-variant transition hover:bg-surface-variant active:scale-95"
            >
              <RotateCcw size={13} /> Reset
            </button>
          )}
        </div>
      )}
      {showVars && varText && <NodeVarLabel varText={varText} />}
    </div>
  );
});
