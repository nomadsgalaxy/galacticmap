import { create } from "zustand";
import {
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
} from "@xyflow/react";

type Graph = { nodes: Node[]; edges: Edge[] };
export type JumpStyle = "none" | "arc" | "gap";
const JUMP_KEY = "gb:jumps";
const initialJumpStyle = (): JumpStyle => {
  try {
    const v = localStorage.getItem(JUMP_KEY);
    if (v === "arc" || v === "gap") return v;
  } catch {
    /* SSR / no storage */
  }
  return "none";
};
const HISTORY_CAP = 60;
const clone = (g: Graph): Graph => ({
  nodes: structuredClone(g.nodes),
  edges: structuredClone(g.edges),
});

type CanvasState = {
  boardId: string;
  canEdit: boolean;
  nodes: Node[];
  edges: Edge[];
  initialized: boolean;
  past: Graph[];
  future: Graph[];
  editingNodeId: string | null; // transient: a just-created text node to open in edit mode (auto-focus)
  setEditingNode: (id: string | null) => void;
  init: (boardId: string, canEdit: boolean, nodes: Node[], edges: Edge[]) => void;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  addNode: (node: Node) => void;
  addEdge: (edge: Edge) => void;
  updateNodeData: (id: string, data: Record<string, unknown>) => void;
  updateEdge: (id: string, patch: Partial<Edge> & { data?: Record<string, unknown> }) => void;
  setCollapsed: (id: string, collapsed: boolean) => void;
  setParent: (id: string, parentId: string | null) => void;
  setNodePositions: (positions: Record<string, { x: number; y: number }>) => void;
  removeNodes: (ids: string[]) => void;
  bringToFront: (ids: string[]) => void;
  sendToBack: (ids: string[]) => void;
  pushHistory: () => void;
  undo: () => Graph | null;
  redo: () => Graph | null;
  jumpStyle: JumpStyle;
  setJumpStyle: (j: JumpStyle) => void;
};

export const useCanvasStore = create<CanvasState>((set, get) => {
  // Merge a patch into a node's client-only _tree metadata (used by setCollapsed/setParent).
  const patchTree = (id: string, patch: Record<string, unknown>) =>
    set({
      nodes: get().nodes.map((n) => {
        if (n.id !== id) return n;
        const d = n.data as { _tree?: Record<string, unknown> };
        return { ...n, data: { ...d, _tree: { ...(d._tree ?? {}), ...patch } } };
      }),
    });
  // Move one history entry between the stacks (undo: past->future, redo: future->past).
  const step = (from: "past" | "future", to: "past" | "future"): Graph | null => {
    const s = get();
    const src = s[from];
    if (src.length === 0) return null;
    const target = src[src.length - 1];
    set({
      [from]: src.slice(0, -1),
      [to]: [...s[to], clone({ nodes: s.nodes, edges: s.edges })],
      nodes: target.nodes,
      edges: target.edges,
    } as Partial<CanvasState>);
    return target;
  };
  return {
  boardId: "",
  canEdit: false,
  nodes: [],
  edges: [],
  initialized: false,
  past: [],
  future: [],
  editingNodeId: null,
  setEditingNode: (id) => set({ editingNodeId: id }),
  init: (boardId, canEdit, nodes, edges) => {
    // The store is a module singleton that survives client-side navigation. Re-init when the BOARD
    // changes (switching boards must load the new board's graph) but skip a same-board re-render so we
    // don't clobber live/collab edits with the server's initial snapshot.
    if (get().initialized && get().boardId === boardId) return;
    set({ boardId, canEdit, nodes, edges, initialized: true, past: [], future: [] });
  },
  onNodesChange: (changes) => set({ nodes: applyNodeChanges(changes, get().nodes) }),
  onEdgesChange: (changes) => set({ edges: applyEdgeChanges(changes, get().edges) }),
  addNode: (node) => set({ nodes: [...get().nodes, node] }),
  addEdge: (edge) => set({ edges: [...get().edges, edge] }),
  updateNodeData: (id, data) =>
    set({
      nodes: get().nodes.map((n) =>
        n.id === id ? { ...n, data: { ...(n.data as object), ...data } } : n,
      ),
    }),
  updateEdge: (id, patch) =>
    set({
      edges: get().edges.map((e) =>
        e.id === id
          ? { ...e, ...patch, ...(patch.data ? { data: { ...(e.data as object), ...patch.data } } : {}) }
          : e,
      ),
    }),
  setCollapsed: (id, collapsed) => patchTree(id, { collapsed }),
  setParent: (id, parentId) => patchTree(id, { parentId }),
  setNodePositions: (positions) =>
    set({
      nodes: get().nodes.map((n) =>
        positions[n.id] ? { ...n, position: positions[n.id] } : n,
      ),
    }),
  removeNodes: (ids) =>
    set({
      nodes: get().nodes.filter((n) => !ids.includes(n.id)),
      edges: get().edges.filter((e) => !ids.includes(e.source) && !ids.includes(e.target)),
    }),
  bringToFront: (ids) => {
    const max = Math.max(0, ...get().nodes.map((n) => n.zIndex ?? 0));
    set({ nodes: get().nodes.map((n) => (ids.includes(n.id) ? { ...n, zIndex: max + 1 } : n)) });
  },
  sendToBack: (ids) => {
    const min = Math.min(0, ...get().nodes.map((n) => n.zIndex ?? 0));
    set({ nodes: get().nodes.map((n) => (ids.includes(n.id) ? { ...n, zIndex: min - 1 } : n)) });
  },
  pushHistory: () => {
    const { nodes, edges, past } = get();
    const next = [...past, clone({ nodes, edges })];
    if (next.length > HISTORY_CAP) next.shift();
    set({ past: next, future: [] });
  },
  undo: () => step("past", "future"),
  redo: () => step("future", "past"),
  jumpStyle: initialJumpStyle(),
  setJumpStyle: (jumpStyle) => {
    set({ jumpStyle });
    try {
      localStorage.setItem(JUMP_KEY, jumpStyle);
    } catch {
      /* ignore */
    }
  },
  };
});
