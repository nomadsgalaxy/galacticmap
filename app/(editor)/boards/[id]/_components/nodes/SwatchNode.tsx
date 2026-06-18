"use client";

import { memo } from "react";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import { NodeHandles } from "./NodeHandles";
import { useCanvasStore } from "../../_store/canvasStore";
import { updateNodeData } from "../../actions";
import { RotateHandle } from "./RotateHandle";
import { NodeVarLabel } from "./NodeVarLabel";

export const SwatchNode = memo(function SwatchNode({ id, data, selected }: NodeProps) {
  const hex = String((data as { hex?: string }).hex ?? "#6d28d9");
  const rotation = Number((data as { rotation?: number }).rotation ?? 0);
  const varText = String((data as { varText?: string }).varText ?? "");
  const showVars = Boolean((data as { showVars?: boolean }).showVars);
  const boardId = useCanvasStore((s) => s.boardId);
  const canEdit = useCanvasStore((s) => s.canEdit);
  const setData = useCanvasStore((s) => s.updateNodeData);

  return (
    <div
      className={`group relative h-full w-full rounded-panel shadow-elev-1 ${selected ? "ring-2 ring-primary" : ""}`}
      style={{ transform: rotation ? `rotate(${rotation}deg)` : undefined, transformOrigin: "center", background: hex, minWidth: 48, minHeight: 48 }}
    >
      <NodeResizer isVisible={!!selected && canEdit} minWidth={48} minHeight={48} />
      <NodeHandles />
      {selected && canEdit && <RotateHandle nodeId={id} />}
      <span className="absolute left-1 top-1 rounded bg-black/40 px-1 text-[10px] font-mono text-white">
        {hex}
      </span>
      {selected && canEdit && (
        <input
          type="color"
          value={hex}
          onChange={(e) => {
            const v = e.target.value;
            setData(id, { hex: v });
            void updateNodeData(boardId, id, { hex: v });
          }}
          className="nodrag absolute bottom-1 right-1 h-6 w-6 cursor-pointer rounded border-0 bg-transparent p-0"
        />
      )}
      {showVars && varText && <NodeVarLabel varText={varText} />}
    </div>
  );
});
