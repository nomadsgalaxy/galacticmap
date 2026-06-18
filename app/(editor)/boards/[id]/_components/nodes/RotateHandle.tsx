"use client";

import { memo, useCallback } from "react";
import { RotateCw } from "lucide-react";
import { useCanvasStore } from "../../_store/canvasStore";
import { updateNodeData } from "../../actions";

// Snap to the nearest multiple of 45deg when the pointer is within this many degrees of it, so
// 0/45/90/... lock magnetically while small intentional tilts (e.g. 7deg) are preserved.
const SNAP_TARGET = 45;
const SNAP_THRESHOLD = 3;

function snapAngle(deg: number): number {
  // Normalize into [0, 360) so the snap math is stable for negative atan2 results.
  const norm = ((deg % 360) + 360) % 360;
  const nearest = Math.round(norm / SNAP_TARGET) * SNAP_TARGET;
  if (Math.abs(norm - nearest) <= SNAP_THRESHOLD) return nearest % 360;
  return Math.round(norm);
}

export const RotateHandle = memo(function RotateHandle({ nodeId }: { nodeId: string }) {
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Don't let the gesture start a node drag / canvas pan.
      e.stopPropagation();
      e.preventDefault();

      // The handle lives inside the rotated root, but the React Flow node wrapper keeps its
      // axis-aligned bounding-box center fixed under rotation, so its rect center is the node center.
      const wrapper = e.currentTarget.closest(".react-flow__node");
      if (!wrapper) return;
      const rect = wrapper.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;

      const setData = useCanvasStore.getState().updateNodeData;

      const angleFor = (clientX: number, clientY: number) =>
        snapAngle((Math.atan2(clientY - cy, clientX - cx) * 180) / Math.PI + 90);

      let latest = 0;

      const onMove = (ev: PointerEvent) => {
        latest = angleFor(ev.clientX, ev.clientY);
        setData(nodeId, { rotation: latest });
      };

      const onUp = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        latest = angleFor(ev.clientX, ev.clientY);
        setData(nodeId, { rotation: latest });
        const { boardId } = useCanvasStore.getState();
        void updateNodeData(boardId, nodeId, { rotation: latest });
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [nodeId],
  );

  const onDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.stopPropagation();
      e.preventDefault();
      const { updateNodeData: setData, boardId } = useCanvasStore.getState();
      setData(nodeId, { rotation: 0 });
      void updateNodeData(boardId, nodeId, { rotation: 0 });
    },
    [nodeId],
  );

  return (
    <div
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      title="Drag to rotate · double-click to reset"
      className="nodrag nopan absolute left-1/2 -top-7 -translate-x-1/2 flex h-5 w-5 cursor-grab items-center justify-center rounded-full border border-outline-variant bg-surface text-on-surface-variant shadow-elev-1"
    >
      <RotateCw size={12} />
    </div>
  );
});
