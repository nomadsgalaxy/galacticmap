"use client";

import { useCallback, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Telescope, ArrowLeft } from "lucide-react";
import { createCrossBoardLink, deleteCrossBoardLink } from "@/app/lib/galaxy-actions";
import { useColorMode } from "@/app/_components/useColorMode";
import type { GalaxyBoard, GalaxyLink } from "@/app/lib/galaxy";

// "Galaxy" meta-canvas: each board is a star, each cross-board link a hyperlane (#11).
// Double-click a board to dive in (inception). Drag star→star to forge a hyperlane.

function BoardStar({ data }: { data: { title: string; nodeCount: number; role: string } }) {
  return (
    <div className="w-52 rounded-panel border border-outline-variant bg-surface-container px-4 py-3 shadow-elev-2 transition hover:-translate-y-0.5 hover:border-primary hover:shadow-elev-3">
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-primary" />
      <div className="mb-1 flex items-center justify-between">
        <span className="rounded bg-secondary-container px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-on-secondary-container">
          {data.role}
        </span>
        <span className="text-xs tabular-nums text-on-surface-variant">{data.nodeCount} items</span>
      </div>
      <div className="truncate font-medium text-on-surface">{data.title}</div>
      <div className="mt-1 text-[11px] text-primary">Double-click to open →</div>
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-primary" />
    </div>
  );
}

const nodeTypes = { board: BoardStar };

const EDGE_LABEL_STYLE = { fill: "var(--md-sys-color-on-surface)", fontSize: 11 };
const EDGE_LABEL_BG = { fill: "var(--md-sys-color-surface-container)" };

function Galaxy({ boards, links }: { boards: GalaxyBoard[]; links: GalaxyLink[] }) {
  const router = useRouter();
  const colorMode = useColorMode();

  const initialNodes: Node[] = useMemo(
    () =>
      boards.map((b, i) => {
        // arrange the stars on a ring
        const a = (i / Math.max(boards.length, 1)) * 2 * Math.PI - Math.PI / 2;
        const r = Math.max(260, boards.length * 60);
        return {
          id: b.id,
          type: "board",
          position: { x: Math.cos(a) * r + r, y: Math.sin(a) * r + r },
          data: { title: b.title, nodeCount: b.nodeCount, role: b.role },
        };
      }),
    [boards],
  );

  const initialEdges: Edge[] = useMemo(
    () =>
      links.map((l) => ({
        id: l.id,
        source: l.source,
        target: l.target,
        label: l.label ?? undefined,
        animated: true,
        style: { stroke: "var(--md-sys-color-primary)", strokeWidth: 2 },
        labelStyle: EDGE_LABEL_STYLE,
        labelBgStyle: EDGE_LABEL_BG,
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 4,
      })),
    [links],
  );

  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  const onConnect = useCallback(
    async (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return;
      const res = await createCrossBoardLink(c.source, c.target);
      if (res.ok) {
        setEdges((es) => [
          ...es.filter((e) => e.id !== res.id),
          { id: res.id, source: c.source!, target: c.target!, animated: true, style: { stroke: "var(--md-sys-color-primary)", strokeWidth: 2 } },
        ]);
      }
    },
    [setEdges],
  );

  const onEdgesDelete = useCallback((deleted: Edge[]) => {
    for (const e of deleted) void deleteCrossBoardLink(e.id);
  }, []);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onEdgesDelete={onEdgesDelete}
      onNodeDoubleClick={(_, n) => router.push(`/boards/${n.id}`)}
      deleteKeyCode={["Backspace", "Delete"]}
      colorMode={colorMode}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={16} color="var(--md-sys-color-outline-variant)" />
      <Controls />
    </ReactFlow>
  );
}

export function GalaxyCanvas({ boards, links }: { boards: GalaxyBoard[]; links: GalaxyLink[] }) {
  return (
    <div className="relative h-full w-full">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-2 p-3">
        <Link
          href="/"
          className="pointer-events-auto flex items-center gap-1.5 rounded-control border border-outline-variant bg-surface-container/95 px-3 py-1.5 text-sm text-on-surface-variant shadow-elev-1 backdrop-blur transition hover:text-on-surface active:scale-[.97]"
        >
          <ArrowLeft size={15} /> Dashboard
        </Link>
        <div className="pointer-events-auto flex items-center gap-1.5 rounded-control border border-outline-variant bg-surface-container/95 px-3 py-1.5 text-sm font-medium text-on-surface shadow-elev-1 backdrop-blur">
          <Telescope size={15} className="text-primary" /> Galaxy
        </div>
        <div className="pointer-events-auto rounded-control border border-outline-variant bg-surface-container/95 px-3 py-1.5 text-xs text-on-surface-variant shadow-elev-1 backdrop-blur">
          Drag star → star to link · double-click to dive in
        </div>
      </div>

      {boards.length === 0 ? (
        <div className="flex h-full w-full items-center justify-center">
          <div className="flex max-w-sm flex-col items-center gap-3 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary-container text-on-secondary-container">
              <Telescope size={22} />
            </div>
            <h2 className="text-base font-semibold text-on-surface">Your galaxy is empty</h2>
            <p className="text-sm text-on-surface-variant">
              Create a couple of boards, then come back here to link them into hyperlanes and
              navigate between them.
            </p>
            <Link href="/" className="rounded-control bg-primary px-4 py-2 text-sm font-medium text-on-primary transition hover:opacity-90 active:scale-[.98]">
              Go to boards
            </Link>
          </div>
        </div>
      ) : (
        <ReactFlowProvider>
          <Galaxy boards={boards} links={links} />
        </ReactFlowProvider>
      )}
    </div>
  );
}
