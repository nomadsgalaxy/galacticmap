"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft, ArrowUp, ArrowRight, ArrowDown, Type, Palette, Image as ImageIcon, Link2, Table2, Undo2, Redo2, Check, Command as CommandIcon,
  Sparkles, Loader2, History, Tags, Group as GroupIcon, Spline, Trash2, MessageSquare, X, ShieldCheck, Tv, Sigma,
  Plus, Search, Hash, MoreHorizontal, Share2, Users, Download,
} from "lucide-react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  ViewportPortal,
  useReactFlow,
  ConnectionMode,
  type Node,
  type Edge,
  type Connection,
  type FinalConnectionState,
  type NodeChange,
  type EdgeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCanvasStore } from "../_store/canvasStore";
import { TextNode } from "./nodes/TextNode";
import { SwatchNode } from "./nodes/SwatchNode";
import { ImageNode } from "./nodes/ImageNode";
import { LinkNode } from "./nodes/LinkNode";
import { CloudNode } from "./nodes/CloudNode";
import { SpreadsheetNode } from "./nodes/SpreadsheetNode";
import { TrackerNode } from "./nodes/TrackerNode";
import { VariablesProvider, useVariables } from "./VariablesContext";
import { aggregate, renderTrackerLine } from "../../../../lib/variables";
import { AnimatedEdge } from "./edges/AnimatedEdge";
import { TreeEdge } from "./edges/TreeEdge";
import { toRFEdge } from "./edges/rfMap";
import { Inspector } from "./Inspector";
import { TagPanel } from "./TagPanel";
import { CommandPalette, type PaletteGroup } from "./CommandPalette";
import { useCollab, collabEnabled } from "../_collab/useCollab";
import { PresenceCursors } from "../_collab/PresenceCursors";
import { useModKey } from "@/app/_components/useModKey";
import { useColorMode } from "@/app/_components/useColorMode";
import { exportPdf, exportPng, exportSvg } from "./exportImage";
import { createNode, createEdge, deleteElements, reconnectEdge, setNodeParent, syncBoardGraph, toggleCollapse, updateNodeData, updateEdgeStyle } from "../actions";
import { generateMap, expandNodeAI, summarizeBranch } from "@/app/lib/ai-actions";
import { saveVersion } from "@/app/lib/version-actions";
import { addTagsToNodes, createGroup, deleteGroup, updateGroup, type GroupDTO } from "@/app/lib/tag-actions";
import { renameBoard } from "@/app/lib/board-actions";
import { acceptSuggestion, discardSuggestionItems } from "@/app/lib/share-actions";
import type { SnapshotNode, SnapshotEdge } from "@/app/lib/types";

// A live public suggestion overlaid as ghosts: one anonymous author's working sub-graph (inert; never
// enters the canvas store / persistence / export). tempId refs resolve to a sibling ghost or a real node.
export type SuggestionDTO = {
  id: string;
  authorName: string | null;
  payload: {
    nodes: Array<{ tempId: string; type: string; x: number; y: number; width?: number | null; height?: number | null; data: Record<string, unknown> }>;
    edges: Array<{ source: string; target: string }>;
  };
  votes?: Record<string, { up: number; down: number }>; // per-item tally (tempId -> {up,down})
};

const nodeTypes = { text: TextNode, swatch: SwatchNode, image: ImageNode, link: LinkNode, cloud: CloudNode, spreadsheet: SpreadsheetNode, tracker: TrackerNode };

// Node types the hover connect-arrows can spawn (image needs an upload, so it's excluded). The default
// data each new node starts with — see createConnectedNode / addTile.
const SPAWN_KINDS = [
  { kind: "text", label: "Text", Icon: Type, data: { text: "" } },
  { kind: "swatch", label: "Color", Icon: Palette, data: { hex: "#22d3ee" } },
  { kind: "link", label: "Link", Icon: Link2, data: { url: "" } },
  { kind: "spreadsheet", label: "Spreadsheet", Icon: Table2, data: { rows: 4, cols: 4, cells: {} } },
  { kind: "tracker", label: "Tracker", Icon: Sigma, data: { lines: [] } },
] as const;
type SpawnKind = (typeof SPAWN_KINDS)[number]["kind"];
const SPAWN_DATA: Record<string, Record<string, unknown>> = Object.fromEntries(SPAWN_KINDS.map((k) => [k.kind, k.data]));
const edgeTypes = { animated: AnimatedEdge, tree: TreeEdge };
const CLOUD_PAD = 28;
// Stable inline-prop identities (hoisted so they don't churn React Flow on every render).
const SNAP_GRID: [number, number] = [4, 4]; // gentle grid; alignment guides do the heavy lifting
const ALIGN_THRESHOLD = 6; // flow-unit distance within which a dragged node snaps to a neighbor's edge/center
const DEFAULT_EDGE_OPTIONS = { type: "animated", animated: false } as const;
const PRO_OPTIONS = { hideAttribution: true } as const;

type Tree = { parentId: string | null; collapsed: boolean; order: number; hasChildren?: boolean };
const treeOf = (n: Node): Tree => ((n.data as { _tree?: Tree })?._tree ?? { parentId: null, collapsed: false, order: 0 });

// Connect-arrow direction → which anchor handle the source leaves from / the new node enters on.
const SIDE_HANDLE = { top: "t", right: "r", bottom: "b", left: "l" } as const;
const OPP_HANDLE = { top: "b", right: "l", bottom: "t", left: "r" } as const;
// Keyboard directional spawn: hold a node-type key + an arrow key → spawn that type in that direction
// from the selected node. Mnemonic keys (also listed in the ⌘K palette): Tab=text, C=color swatch,
// L=link, S=spreadsheet, V=variable tracker. SPAWN_KEY is the displayed label; KEY_TO_SPAWN maps the
// actual keydown (letters matched case-insensitively, so the held key needn't be shifted).
const DIR_FOR_ARROW: Record<string, "top" | "right" | "bottom" | "left" | undefined> = {
  ArrowUp: "top", ArrowRight: "right", ArrowDown: "bottom", ArrowLeft: "left",
};
const SPAWN_KEY: Record<SpawnKind, string> = { text: "Tab", swatch: "C", link: "L", spreadsheet: "S", tracker: "V" };
const KEY_TO_SPAWN: Record<string, SpawnKind> = { Tab: "text", c: "swatch", l: "link", s: "spreadsheet", v: "tracker" };
const spawnKeyType = (key: string): SpawnKind | undefined => KEY_TO_SPAWN[key] ?? KEY_TO_SPAWN[key.toLowerCase()];

// A node's rendered size: explicit dims if set, else the measured size, else a sensible default.
const nodeSize = (n: Node): { w: number; h: number } => ({
  w: typeof n.width === "number" ? n.width : n.measured?.width ?? 180,
  h: typeof n.height === "number" ? n.height : n.measured?.height ?? 70,
});

// Downscale + recompress an oversized image in the browser BEFORE upload, so the canvas serves lean
// assets (big phone photos → ~web-sized WebP). Skips GIFs (would lose animation) and anything already
// small. Falls back to the original on any failure or if re-encoding wouldn't actually shrink it.
const IMG_MAX_DIM = 2048; // longest edge after downscale
async function optimizeImage(file: File): Promise<File> {
  if (typeof document === "undefined" || file.type === "image/gif") return file;
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const big = Math.max(bmp.width, bmp.height);
    if (big <= IMG_MAX_DIM && file.size <= 1_000_000) { bmp.close(); return file; } // already lean
    const scale = Math.min(1, IMG_MAX_DIM / big);
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) { bmp.close(); return file; }
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/webp", 0.85));
    if (!blob || blob.size >= file.size) return file; // keep original if re-encoding didn't help
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".webp", { type: "image/webp" });
  } catch {
    return file;
  }
}

// draw.io-style alignment guides. For the dragged node's proposed position, compare its left/right/
// centerX against every OTHER node's left/right/centerX (and top/bottom/centerY). When within
// ALIGN_THRESHOLD flow units, snap that axis to the neighbor and record the guide-line coordinate.
// Pure: takes the proposed position + size and the full node list; returns a possibly-snapped position
// plus the vertical (x) / horizontal (y) guide coords to draw. Independent on each axis.
type HelperLines = { snapPosition: { x: number; y: number }; vertical?: number; horizontal?: number };
function getHelperLines(
  dragged: { id: string; position: { x: number; y: number }; w: number; h: number },
  nodes: Node[],
): HelperLines {
  const { position, w, h } = dragged;
  let snapX = position.x;
  let snapY = position.y;
  let vertical: number | undefined;
  let horizontal: number | undefined;
  // Track the closest match per axis so the nearest neighbor wins when several are in range.
  let bestX = ALIGN_THRESHOLD;
  let bestY = ALIGN_THRESHOLD;

  // The dragged node's candidate edges/centers on each axis.
  const dLeft = position.x;
  const dRight = position.x + w;
  const dCenterX = position.x + w / 2;
  const dTop = position.y;
  const dBottom = position.y + h;
  const dCenterY = position.y + h / 2;

  for (const n of nodes) {
    if (n.id === dragged.id || n.type === "cloud" || n.hidden) continue;
    const { w: nw, h: nh } = nodeSize(n);
    const nLeft = n.position.x;
    const nRight = n.position.x + nw;
    const nCenterX = n.position.x + nw / 2;
    const nTop = n.position.y;
    const nBottom = n.position.y + nh;
    const nCenterY = n.position.y + nh / 2;

    // Vertical guides (align an x-coordinate). Each pair: [draggedEdge, neighborEdge, newLeftX].
    const xPairs: Array<[number, number, number]> = [
      [dLeft, nLeft, nLeft], [dLeft, nRight, nRight], [dLeft, nCenterX, nCenterX],
      [dRight, nLeft, nLeft - w], [dRight, nRight, nRight - w], [dRight, nCenterX, nCenterX - w],
      [dCenterX, nLeft, nLeft - w / 2], [dCenterX, nRight, nRight - w / 2], [dCenterX, nCenterX, nCenterX - w / 2],
    ];
    for (const [edge, target, newLeft] of xPairs) {
      const d = Math.abs(edge - target);
      if (d < bestX) { bestX = d; snapX = newLeft; vertical = target; }
    }

    // Horizontal guides (align a y-coordinate). Each pair: [draggedEdge, neighborEdge, newTopY].
    const yPairs: Array<[number, number, number]> = [
      [dTop, nTop, nTop], [dTop, nBottom, nBottom], [dTop, nCenterY, nCenterY],
      [dBottom, nTop, nTop - h], [dBottom, nBottom, nBottom - h], [dBottom, nCenterY, nCenterY - h],
      [dCenterY, nTop, nTop - h / 2], [dCenterY, nBottom, nBottom - h / 2], [dCenterY, nCenterY, nCenterY - h / 2],
    ];
    for (const [edge, target, newTop] of yPairs) {
      const d = Math.abs(edge - target);
      if (d < bestY) { bestY = d; snapY = newTop; horizontal = target; }
    }
  }

  return { snapPosition: { x: snapX, y: snapY }, vertical, horizontal };
}

// Focus reachability: everything downstream of `rootId` following BOTH mind-map child links
// (parent→child) AND connector lines in their arrow direction (end: source→target, start:
// target→source, both/none: either way). Used by Focus Mode to highlight the whole branch.
function reachableFrom(rootId: string, nodes: Node[], edges: Edge[]): Set<string> {
  const adj = new Map<string, string[]>();
  const add = (a: string, b: string) => {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
  };
  for (const n of nodes) {
    const pid = (n.data as { _tree?: Tree })?._tree?.parentId;
    if (pid) add(pid, n.id);
  }
  for (const e of edges) {
    const arrow = (e.data as { arrow?: string })?.arrow ?? "end";
    if (arrow === "end") add(e.source, e.target);
    else if (arrow === "start") add(e.target, e.source);
    else {
      add(e.source, e.target);
      add(e.target, e.source);
    }
  }
  const seen = new Set<string>([rootId]);
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const nb of adj.get(id) ?? []) if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
  }
  return seen;
}

// Undirected adjacency over the whole graph: every connector line AND every mind-map parent/child
// link becomes a bidirectional edge. Shared by the chain-select (BFS shortest path) and the
// branch-select (connected component) click gestures — "everything attached", direction-agnostic.
function buildUndirectedAdjacency(nodes: Node[], edges: Edge[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  };
  for (const n of nodes) {
    const pid = (n.data as { _tree?: Tree })?._tree?.parentId;
    if (pid) link(pid, n.id);
  }
  for (const e of edges) link(e.source, e.target);
  return adj;
}

// Shortest path of node ids between `from` and `to` over the undirected graph (BFS). Inclusive of
// both endpoints. Returns null when no path connects them.
function shortestPath(from: string, to: string, adj: Map<string, string[]>): string[] | null {
  if (from === to) return [from];
  const prev = new Map<string, string>();
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length) {
    const id = queue.shift()!;
    for (const nb of adj.get(id) ?? []) {
      if (seen.has(nb)) continue;
      seen.add(nb);
      prev.set(nb, id);
      if (nb === to) {
        const path = [to];
        let cur = to;
        while (cur !== from) { cur = prev.get(cur)!; path.push(cur); }
        return path.reverse();
      }
      queue.push(nb);
    }
  }
  return null;
}

// The full undirected connected component containing `rootId` (every node reachable along
// connectors + parent/child links, ignoring direction). Used by the branch-select gesture.
function connectedComponent(rootId: string, adj: Map<string, string[]>): Set<string> {
  const seen = new Set<string>([rootId]);
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const nb of adj.get(id) ?? []) if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
  }
  return seen;
}

function toRFNode(n: SnapshotNode): Node {
  return {
    id: n.id,
    type: n.type,
    position: { x: n.x, y: n.y },
    zIndex: n.zIndex,
    data: { ...n.data, _tree: { parentId: n.parentId, collapsed: n.collapsed, order: n.order } },
    // Any node with explicit dimensions renders at that size (swatch/image always; text once resized).
    ...(n.width != null && n.height != null
      ? { width: n.width, height: n.height, style: { width: n.width, height: n.height } }
      : {}),
  };
}
const syncNode = (n: Node) => {
  const raw = (n.data as Record<string, unknown>) ?? {};
  const { _tree, ...data } = raw; // never persist client-only tree metadata into data column
  void _tree;
  return {
    id: n.id,
    type: (n.type as string) ?? "text",
    x: n.position.x,
    y: n.position.y,
    width: typeof n.width === "number" ? n.width : null,
    height: typeof n.height === "number" ? n.height : null,
    zIndex: typeof n.zIndex === "number" ? n.zIndex : 0,
    data,
  };
};
const syncEdge = (e: Edge) => ({
  id: e.id,
  source: e.source,
  target: e.target,
  type: (e.type as string) ?? "animated",
  animated: e.animated ?? true,
  label: typeof e.label === "string" ? e.label : null,
  data: (e.data as Record<string, unknown>) ?? {},
});

type SaveStatus = "idle" | "saving" | "saved" | "error";
type Menu = { x: number; y: number; flowX: number; flowY: number; nodeId: string | null } | null;
type Props = {
  boardId: string;
  title: string;
  canEdit: boolean;
  canManageMembers: boolean;
  aiEnabled: boolean;
  meName: string;
  initialNodes: SnapshotNode[];
  initialEdges: SnapshotEdge[];
  initialGroups: GroupDTO[];
  initialSuggestions: SuggestionDTO[];
};

function Canvas({ boardId, title, canEdit, canManageMembers, aiEnabled, meName, initialNodes, initialEdges, initialGroups, initialSuggestions }: Props) {
  const init = useCanvasStore((s) => s.init);
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const onNodesChange = useCanvasStore((s) => s.onNodesChange);
  const onEdgesChange = useCanvasStore((s) => s.onEdgesChange);
  const addNode = useCanvasStore((s) => s.addNode);
  const addEdgeToStore = useCanvasStore((s) => s.addEdge);
  const jumpStyle = useCanvasStore((s) => s.jumpStyle);
  const setJumpStyle = useCanvasStore((s) => s.setJumpStyle);
  const { screenToFlowPosition, setCenter, fitView, getNodes } = useReactFlow();
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  // Where a context-menu / popover-driven node should be created (flow coords); null = board center.
  const pendingPos = useRef<{ x: number; y: number } | null>(null);
  const { isMac, k } = useModKey();
  const colorMode = useColorMode();
  const collabOn = collabEnabled() && canEdit;
  const { handle: collab, peers, connected: collabConnected } = useCollab(boardId, collabOn, { name: meName });
  const applyingRemote = useRef(false);
  const cursorThrottle = useRef(0);
  const [save, setSave] = useState<SaveStatus>("idle");
  const [menu, setMenu] = useState<Menu>(null);
  // Compact icon-rail: which single dropdown/popover is open (Add / More / Search / Tag-filter).
  const [railMenu, setRailMenu] = useState<ToolbarMenuKey>(null);
  const toggleRailMenu = useCallback((key: Exclude<ToolbarMenuKey, null>) => setRailMenu((cur) => (cur === key ? null : key)), []);
  const closeRailMenu = useCallback(() => setRailMenu(null), []);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null); // node whose connect-arrows are shown
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draggingNode = useRef(false);
  // draw.io-style alignment guides: the flow-coordinate x (vertical line) / y (horizontal line) a
  // dragged node is currently snapped to. Cleared when not dragging / on drag stop.
  const [guides, setGuides] = useState<{ vertical?: number; horizontal?: number }>({});
  // Which node type the hover connect-arrows spawn. Persists across hovers; chosen on the arrow strip.
  // The ref is the source of truth at SPAWN time (set synchronously on pick) so the spawned type can
  // never lag the highlight due to a stale render/closure; the state drives the strip's highlight.
  const [spawnKind, setSpawnKind] = useState<SpawnKind>("text");
  const spawnKindRef = useRef<SpawnKind>("text");
  const pickSpawnKind = useCallback((k: SpawnKind) => { spawnKindRef.current = k; setSpawnKind(k); }, []);
  // Node type armed by a held creation shortcut (Tab = text); an arrow key then spawns it directionally.
  const heldSpawnType = useRef<SpawnKind | null>(null);
  // Live public suggestions overlaid as hazy ghosts (editors only). Inert — never enters the canvas
  // store, persistence, or export. `revealed` is the single ghost a moderator has dwelt on / clicked.
  const [suggestions, setSuggestions] = useState<SuggestionDTO[]>(initialSuggestions);
  const [revealed, setRevealed] = useState<{ sugId: string; tempId: string } | null>(null);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null); // show after a short dwell
  const revealHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null); // hide after leaving (grace)
  const [reviewOpen, setReviewOpen] = useState(false); // the always-available suggestions review panel
  // View mode: "moderation" (default) shows pending suggestions + accept/discard; "stream" hides them
  // for a clean broadcast (only approved/materialized content shows). Per-tab, so a streamer and a mod
  // can each pick their own view of the same board.
  const [streamView, setStreamView] = useState(false);
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkImg, setLinkImg] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [groups, setGroups] = useState<GroupDTO[]>(initialGroups);
  const [tagPanelOpen, setTagPanelOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const tagTargetIds = useRef<string[]>([]);
  const [boardTitle, setBoardTitle] = useState(title);
  const [editingTitle, setEditingTitle] = useState(false);
  // Global variable tracker HUD: a toggleable fixed panel listing every board variable's aggregates.
  // The toggle persists per-board in localStorage so a board you track stays tracked across reloads.
  const trackerKey = `gb-tracker-hud:${boardId}`;
  const [trackerOpen, setTrackerOpen] = useState(false);
  useEffect(() => {
    try { setTrackerOpen(localStorage.getItem(trackerKey) === "1"); } catch { /* no storage */ }
  }, [trackerKey]);
  const toggleTracker = useCallback(() => {
    setTrackerOpen((o) => {
      const next = !o;
      try { localStorage.setItem(trackerKey, next ? "1" : "0"); } catch { /* no storage */ }
      return next;
    });
  }, [trackerKey]);
  const matchIdx = useRef(0);
  // Pending first node of a Ctrl/⌘-click chain selection (behavior 3). The next Ctrl/⌘-click resolves
  // the shortest path to it and clears this. Cleared on a plain click so a stale start never lingers.
  const chainStart = useRef<string | null>(null);

  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markSaving = useCallback(() => setSave("saving"), []);
  const markSaved = useCallback(() => {
    setSave("saved");
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSave("idle"), 1500);
  }, []);

  // Fire-and-forget live broadcast to public spectators (drag positions + refresh pings). The server
  // no-ops when nobody's watching, so this is cheap when no one has the share open.
  const liveThrottle = useRef(0);
  const broadcastLive = useCallback(
    (body: { type: "pos"; nodes: { id: string; x: number; y: number }[] } | { type: "refresh" }) => {
      if (!canEdit) return;
      void fetch(`/api/boards/${boardId}/live`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(() => {});
    },
    [boardId, canEdit],
  );

  const runSaving = useCallback(
    async <T,>(p: Promise<T>): Promise<T | undefined> => {
      markSaving();
      try {
        const r = await p;
        markSaved();
        broadcastLive({ type: "refresh" }); // tell spectators a change committed
        return r;
      } catch {
        setSave("error");
        return undefined;
      }
    },
    [markSaving, markSaved, broadcastLive],
  );

  useEffect(() => {
    init(boardId, canEdit, initialNodes.map(toRFNode), initialEdges.map(toRFEdge));
  }, [init, boardId, canEdit, initialNodes, initialEdges]);

  // Live suggestions: subscribe to the authenticated editor stream and keep the ghost layer in sync.
  useEffect(() => {
    if (!canEdit) return;
    const dropItems = (list: SuggestionDTO[], sugId: string, tempIds: Set<string>) =>
      list.flatMap((x) => {
        if (x.id !== sugId) return [x];
        const nodes = (x.payload?.nodes ?? []).filter((n) => !tempIds.has(n.tempId));
        const edges = (x.payload?.edges ?? []).filter((e) => !tempIds.has(String(e.source)) && !tempIds.has(String(e.target)));
        return nodes.length ? [{ ...x, payload: { nodes, edges } }] : [];
      });
    let es: EventSource | null = null;
    try {
      es = new EventSource(`/api/boards/${boardId}/suggest-stream`);
      es.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data) as { type: string; op?: string; suggestion?: SuggestionDTO; suggestionId?: string; tempIds?: string[]; tempId?: string; up?: number; down?: number };
          if (m.type === "sug" && m.op === "upsert" && m.suggestion) {
            const s = m.suggestion;
            setSuggestions((prev) => {
              const i = prev.findIndex((x) => x.id === s.id);
              if (i === -1) return [...prev, s];
              const next = prev.slice();
              next[i] = s;
              return next;
            });
          } else if (m.type === "sug" && m.op === "remove" && m.suggestionId) {
            const id = m.suggestionId;
            setSuggestions((prev) => prev.filter((x) => x.id !== id));
          } else if (m.type === "sug-resolved" && m.suggestionId) {
            const id = m.suggestionId;
            const ids = new Set(m.tempIds ?? []);
            setSuggestions((prev) => dropItems(prev, id, ids));
          } else if (m.type === "sug-vote" && m.suggestionId && m.tempId) {
            const { suggestionId: id, tempId, up = 0, down = 0 } = m;
            setSuggestions((prev) =>
              prev.map((x) => (x.id === id ? { ...x, votes: { ...(x.votes ?? {}), [tempId]: { up, down } } } : x)),
            );
          }
        } catch {
          /* ignore malformed frame */
        }
      };
    } catch {
      /* SSE unsupported — ghosts still render from the initial server load */
    }
    return () => es?.close();
  }, [canEdit, boardId]);

  // Real-time graph sync: mirror the store <-> the shared Yjs maps. Entirely gated on `collab`
  // (no collab server → this effect never runs → editor behaves exactly as single-user).
  useEffect(() => {
    if (!collab) return;
    const { doc, provider, yNodes, yEdges } = collab;
    const LOCAL = "gb-local";

    const serNode = (n: Node) => {
      const raw = (n.data as Record<string, unknown>) ?? {};
      const { _tree, ...data } = raw as { _tree?: Tree };
      return {
        type: (n.type as string) ?? "text",
        x: n.position.x,
        y: n.position.y,
        width: typeof n.width === "number" ? n.width : null,
        height: typeof n.height === "number" ? n.height : null,
        zIndex: typeof n.zIndex === "number" ? n.zIndex : 0,
        data,
        parentId: _tree?.parentId ?? null,
        collapsed: _tree?.collapsed ?? false,
        order: _tree?.order ?? 0,
      };
    };
    const serEdge = (e: Edge) => ({
      source: e.source,
      target: e.target,
      type: (e.type as string) ?? "animated",
      animated: e.animated ?? true,
      label: typeof e.label === "string" ? e.label : null,
      data: (e.data as Record<string, unknown>) ?? {},
    });

    const applyRemoteToStore = () => {
      applyingRemote.current = true;
      const sel = new Set(useCanvasStore.getState().nodes.filter((n) => n.selected).map((n) => n.id));
      const nodes: Node[] = [...yNodes.entries()].map(([id, v]) => {
        const rf = toRFNode({
          id, type: String(v.type ?? "text"), parentId: (v.parentId as string) ?? null,
          layout: "manual", collapsed: !!v.collapsed, order: Number(v.order ?? 0),
          x: Number(v.x ?? 0), y: Number(v.y ?? 0),
          width: (v.width as number | null) ?? null, height: (v.height as number | null) ?? null,
          zIndex: Number(v.zIndex ?? 0), data: (v.data as Record<string, unknown>) ?? {},
        });
        return sel.has(id) ? { ...rf, selected: true } : rf;
      });
      const edges: Edge[] = [...yEdges.entries()].map(([id, v]) =>
        toRFEdge({
          id, source: String(v.source), target: String(v.target), kind: "connector",
          type: String(v.type ?? "animated"), animated: v.animated !== false,
          label: (v.label as string | null) ?? null, data: (v.data as Record<string, unknown>) ?? {},
        }),
      );
      useCanvasStore.setState({ nodes, edges });
      applyingRemote.current = false;
    };

    const flushToYjs = () => {
      if (applyingRemote.current) return;
      const st = useCanvasStore.getState();
      doc.transact(() => {
        const nodeIds = new Set(st.nodes.map((n) => n.id));
        const edgeIds = new Set(st.edges.map((e) => e.id));
        for (const n of st.nodes) {
          const next = serNode(n);
          if (JSON.stringify(yNodes.get(n.id)) !== JSON.stringify(next)) yNodes.set(n.id, next);
        }
        for (const e of st.edges) {
          const next = serEdge(e);
          if (JSON.stringify(yEdges.get(e.id)) !== JSON.stringify(next)) yEdges.set(e.id, next);
        }
        for (const id of [...yNodes.keys()]) if (!nodeIds.has(id)) yNodes.delete(id);
        for (const id of [...yEdges.keys()]) if (!edgeIds.has(id)) yEdges.delete(id);
      }, LOCAL);
    };

    const onSync = (isSynced: boolean) => {
      if (!isSynced) return;
      if (yNodes.size === 0 && yEdges.size === 0) flushToYjs(); // first client seeds the room
      else applyRemoteToStore(); // later clients adopt the shared state
    };
    provider.on("sync", onSync);

    const obs = (_e: unknown, txn: { origin: unknown }) => {
      if (txn.origin === LOCAL) return; // skip our own writes (no echo loop)
      applyRemoteToStore();
    };
    yNodes.observe(obs);
    yEdges.observe(obs);

    let t: ReturnType<typeof setTimeout> | null = null;
    const unsub = useCanvasStore.subscribe((s, prev) => {
      if (applyingRemote.current) return;
      if (s.nodes === prev.nodes && s.edges === prev.edges) return;
      if (t) clearTimeout(t);
      t = setTimeout(flushToYjs, 150);
    });

    return () => {
      provider.off("sync", onSync);
      yNodes.unobserve(obs);
      yEdges.unobserve(obs);
      unsub();
      if (t) clearTimeout(t);
    };
  }, [collab]);

  // ── Derived display: tree edges + folding + focus-ghosting ──
  const nodesById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const { displayNodes, displayEdges } = useMemo(() => {
    const childrenOf = new Map<string, string[]>();
    for (const n of nodes) {
      const pid = treeOf(n).parentId;
      if (pid) {
        const arr = childrenOf.get(pid) ?? [];
        arr.push(n.id);
        childrenOf.set(pid, arr);
      }
    }
    const hidden = new Set<string>();
    const collapse = (id: string) => {
      for (const c of childrenOf.get(id) ?? []) {
        if (hidden.has(c)) continue; // guard against a malformed parent cycle
        hidden.add(c);
        collapse(c);
      }
    };
    for (const n of nodes) if (treeOf(n).collapsed) collapse(n.id);

    // Focus highlights the whole branch: tree descendants + everything reachable along
    // connector lines in their direction (see reachableFrom).
    const focusSet: Set<string> | null =
      focusedId && nodesById.has(focusedId) ? reachableFrom(focusedId, nodes, edges) : null;

    const tag = tagFilter.trim().toLowerCase();
    const dNodes: Node[] = nodes.map((n) => {
      const t = treeOf(n);
      const focusGhost = focusSet ? !focusSet.has(n.id) : false;
      const tagGhost = tag
        ? !(((n.data as { tags?: string[] })?.tags ?? []).some((x) => x.toLowerCase().includes(tag)))
        : false;
      const ghost = focusGhost || tagGhost;
      return {
        ...n,
        hidden: hidden.has(n.id),
        data: { ...n.data, _tree: { ...t, hasChildren: (childrenOf.get(n.id)?.length ?? 0) > 0 } },
        // keep the original style identity when not ghosting so node memoization isn't defeated
        style: ghost ? { ...(n.style as object), opacity: 0.18 } : n.style,
      };
    });

    const treeEdges: Edge[] = [];
    for (const n of nodes) {
      const pid = treeOf(n).parentId;
      if (pid && nodesById.has(pid)) {
        treeEdges.push({ id: `tree:${n.id}`, source: pid, target: n.id, type: "tree", selectable: false });
      }
    }
    const dEdges: Edge[] = [...edges, ...treeEdges].map((e) => ({
      ...e,
      hidden: hidden.has(e.source) || hidden.has(e.target),
      ...(focusSet && (!focusSet.has(e.source) || !focusSet.has(e.target))
        ? { style: { ...(e.style as object), opacity: 0.12 } }
        : {}),
    }));

    // Cloud groups: a translucent background node sized to the live bbox of its (visible) members.
    const cloudNodes: Node[] = [];
    for (const g of groups) {
      const members = g.nodeIds
        .map((id) => nodesById.get(id))
        .filter((n): n is Node => !!n && !hidden.has(n.id));
      if (members.length === 0) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const m of members) {
        const { w, h } = nodeSize(m);
        minX = Math.min(minX, m.position.x);
        minY = Math.min(minY, m.position.y);
        maxX = Math.max(maxX, m.position.x + w);
        maxY = Math.max(maxY, m.position.y + h);
      }
      const width = maxX - minX + CLOUD_PAD * 2;
      const height = maxY - minY + CLOUD_PAD * 2 + 22; // extra top room for the label chip
      cloudNodes.push({
        id: `cloud:${g.id}`,
        type: "cloud",
        position: { x: minX - CLOUD_PAD, y: minY - CLOUD_PAD - 22 },
        data: { label: g.label, color: g.color, tags: g.tags },
        width,
        height,
        style: { width, height },
        zIndex: -1000,
        selectable: false,
        draggable: false,
        deletable: false,
        connectable: false,
      });
    }

    return { displayNodes: [...cloudNodes, ...dNodes], displayEdges: dEdges };
  }, [nodes, edges, focusedId, nodesById, tagFilter, groups]);

  // ── Ghost overlay: live public suggestions rendered hazy + non-interactive (editors only). Kept in
  //    its OWN layer, appended after displayNodes/displayEdges, so it never touches the store/persistence.
  const ghostNodes = useMemo<Node[]>(() => {
    if (!canEdit || streamView || suggestions.length === 0) return []; // stream view = no pending ghosts
    // Crash-proof: a throw in a render memo (no error boundary here) would unmount the WHOLE canvas →
    // blank board. A malformed suggestion must never do that — degrade to "no ghosts" instead.
    try {
    const out: Node[] = [];
    let placed = 0; // legacy suggestions can lack positions — spread them so they never collide / NaN
    for (const s of suggestions) {
      for (const pn of (s.payload?.nodes ?? [])) {
        const isRevealed = revealed?.sugId === s.id && revealed?.tempId === pn.tempId;
        // A NaN/undefined position poisons React Flow's whole viewport transform (freezes pan/zoom),
        // so every ghost MUST have a finite position. Positionless legacy rows get a tidy fallback grid.
        const x = Number.isFinite(pn.x) ? pn.x : 60 + (placed % 6) * 210;
        const y = Number.isFinite(pn.y) ? pn.y : 60 + Math.floor(placed / 6) * 130;
        placed += 1;
        out.push({
          id: `sug:${s.id}:${pn.tempId}`,
          type: pn.type,
          position: { x, y },
          data: { ...pn.data },
          draggable: true, // a moderator can move a ghost out of the way before deciding (local, not persisted)
          selectable: false,
          deletable: false,
          connectable: false,
          focusable: false,
          className: `gb-suggested${isRevealed ? " gb-revealed" : ""}`,
          zIndex: isRevealed ? 1600 : 1,
          ...(pn.type === "swatch" && pn.width != null && pn.height != null
            ? { width: pn.width, height: pn.height, style: { width: pn.width, height: pn.height } }
            : {}),
        });
      }
    }
    return out;
    } catch {
      return [];
    }
  }, [canEdit, streamView, suggestions, revealed]);

  const ghostEdges = useMemo<Edge[]>(() => {
    if (!canEdit || streamView || suggestions.length === 0) return [];
    try {
      const out: Edge[] = [];
      for (const s of suggestions) {
        const temp = new Set((s.payload?.nodes ?? []).map((n) => n.tempId));
        const resolve = (ref: string) => (temp.has(ref) ? `sug:${s.id}:${ref}` : nodesById.has(ref) ? ref : null);
        (s.payload?.edges ?? []).forEach((pe, i) => {
          const src = resolve(String(pe.source));
          const tgt = resolve(String(pe.target));
          if (!src || !tgt || src === tgt) return; // only draw when both ends resolve to a rendered node
          out.push({ id: `suge:${s.id}:${i}`, source: src, target: tgt, type: "animated", className: "gb-suggested", selectable: false, deletable: false, data: {} });
        });
      }
      return out;
    } catch {
      return [];
    }
  }, [canEdit, streamView, suggestions, nodesById]);

  const allNodes = useMemo(() => (ghostNodes.length ? [...displayNodes, ...ghostNodes] : displayNodes), [displayNodes, ghostNodes]);
  const allEdges = useMemo(() => (ghostEdges.length ? [...displayEdges, ...ghostEdges] : displayEdges), [displayEdges, ghostEdges]);

  // The ghost (suggestion item) a moderator has dwelt on / clicked, with its node payload for the popover.
  const revealedInfo = useMemo(() => {
    if (!revealed) return null;
    const s = suggestions.find((x) => x.id === revealed.sugId);
    const pn = s?.payload?.nodes?.find((n) => n.tempId === revealed.tempId);
    return s && pn ? { s, pn } : null;
  }, [revealed, suggestions]);

  const parseGhost = useCallback((id: string) => {
    const m = /^sug:([^:]+):(.+)$/.exec(id);
    return m ? { sugId: m[1], tempId: m[2] } : null;
  }, []);
  const clearRevealTimers = useCallback(() => {
    if (revealTimer.current) { clearTimeout(revealTimer.current); revealTimer.current = null; }
    if (revealHideTimer.current) { clearTimeout(revealHideTimer.current); revealHideTimer.current = null; }
  }, []);
  // Tooltip-style: a brief dwell reveals the Accept/Discard controls right on the ghost; leaving hides
  // them after a short grace (so the cursor can travel from the ghost to the popover without flicker).
  // Hold to reveal: for text/link the content focuses in over ~3s (a deliberate vetting gate), so the
  // Accept/Discard popover appears only once it's legible. Swatches aren't gated, so they reveal at once.
  const scheduleReveal = useCallback((g: { sugId: string; tempId: string }, type?: string) => {
    clearRevealTimers();
    const delay = type === "swatch" ? 200 : 2800;
    revealTimer.current = setTimeout(() => setRevealed(g), delay);
  }, [clearRevealTimers]);
  const keepReveal = useCallback(() => clearRevealTimers(), [clearRevealTimers]);
  const scheduleHideReveal = useCallback(() => {
    if (revealTimer.current) { clearTimeout(revealTimer.current); revealTimer.current = null; }
    if (revealHideTimer.current) clearTimeout(revealHideTimer.current);
    revealHideTimer.current = setTimeout(() => setRevealed(null), 240);
  }, []);

  const acceptGhost = useCallback(
    async (sugId: string, tempId: string) => {
      clearRevealTimers();
      setRevealed(null);
      // Materialize at wherever the moderator dragged the ghost to (its current local position).
      const pn = suggestions.find((x) => x.id === sugId)?.payload?.nodes?.find((n) => n.tempId === tempId);
      const posOverride = pn && Number.isFinite(pn.x) && Number.isFinite(pn.y) ? { [tempId]: { x: pn.x, y: pn.y } } : undefined;
      const res = await acceptSuggestion(sugId, [tempId], posOverride);
      if (!res?.ok) return;
      for (const n of res.nodes) addNode(toRFNode(n));
      for (const e of res.edges) addEdgeToStore(toRFEdge(e));
      setSuggestions((prev) =>
        prev.flatMap((x) => {
          if (x.id !== sugId) return [x];
          const nodes = (x.payload?.nodes ?? []).filter((n) => n.tempId !== tempId);
          const edges = (x.payload?.edges ?? []).filter((e) => String(e.source) !== tempId && String(e.target) !== tempId);
          return nodes.length ? [{ ...x, payload: { nodes, edges } }] : [];
        }),
      );
    },
    [clearRevealTimers, addNode, addEdgeToStore, suggestions],
  );
  const discardGhost = useCallback(
    async (sugId: string, tempId: string) => {
      clearRevealTimers();
      setRevealed(null);
      await discardSuggestionItems(sugId, [tempId]);
      setSuggestions((prev) =>
        prev.flatMap((x) => {
          if (x.id !== sugId) return [x];
          const nodes = (x.payload?.nodes ?? []).filter((n) => n.tempId !== tempId);
          const edges = (x.payload?.edges ?? []).filter((e) => String(e.source) !== tempId && String(e.target) !== tempId);
          return nodes.length ? [{ ...x, payload: { nodes, edges } }] : [];
        }),
      );
    },
    [clearRevealTimers],
  );

  // Total pending suggestion items (for the toolbar badge) + jump-to-ghost from the review panel.
  const pendingCount = useMemo(() => suggestions.reduce((a, s) => a + (s.payload?.nodes?.length ?? 0), 0), [suggestions]);
  const locateGhost = useCallback(
    (sugId: string, tempId: string, x: number, y: number) => {
      setCenter(x + 90, y + 35, { zoom: 1.1, duration: 400 });
      setRevealed({ sugId, tempId });
    },
    [setCenter],
  );

  const selectedNode = useMemo(() => nodes.find((n) => n.selected) ?? null, [nodes]);
  const selectedEdge = useMemo(() => edges.find((e) => e.selected) ?? null, [edges]);

  // Dynamic zoom range: a big sprawling board should zoom out far enough to see everything; a
  // small board shouldn't over-zoom into empty space. minZoom scales with the content bounding box.
  const { minZoom, maxZoom } = useMemo(() => {
    if (nodes.length === 0) return { minZoom: 0.4, maxZoom: 4 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      const { w, h } = nodeSize(n);
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + w);
      maxY = Math.max(maxY, n.position.y + h);
    }
    const cw = Math.max(1, maxX - minX);
    const ch = Math.max(1, maxY - minY);
    const vw = typeof window !== "undefined" ? window.innerWidth : 1440;
    const vh = typeof window !== "undefined" ? window.innerHeight : 900;
    const fit = Math.min(vw / cw, vh / ch); // zoom that exactly frames the whole board
    // allow zooming out to ~60% of "fit everything" (board + breathing room); never above 0.5 so
    // even tiny boards can still zoom out a bit, and floored low so huge boards stay reachable.
    const minZoom = Math.max(0.02, Math.min(0.5, Number((fit * 0.6).toFixed(3))));
    return { minZoom, maxZoom: 4 };
  }, [nodes]);

  // ── Debounced position/size/z-order persistence ──
  const dirty = useRef<Set<string>>(new Set());
  // Edges whose custom waypoints were translated during the current drag (both endpoints moved together);
  // persisted on drag stop so hand-placed bends ride along with a moved group / multi-selection.
  const shiftedEdges = useRef<Set<string>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bursting = useRef(false);

  // Deleting selected nodes also removes their connecting edges — and React Flow fires those edge
  // removals through onEdgesChange (no history push) separately from the node removals. Capture ONE
  // history snapshot at the FIRST removal of a delete burst, BEFORE anything is applied, so undo
  // restores both the nodes AND the arrows between them. Reset on the next tick for the next delete.
  const removeBurst = useRef(false);
  const captureRemoveHistory = useCallback(() => {
    if (removeBurst.current) return;
    removeBurst.current = true;
    useCanvasStore.getState().pushHistory();
    setTimeout(() => { removeBurst.current = false; }, 0);
  }, []);

  const flush = useCallback(() => {
    bursting.current = false;
    if (dirty.current.size === 0) return;
    const ids = dirty.current;
    dirty.current = new Set();
    const positions = useCanvasStore
      .getState()
      .nodes.filter((n) => ids.has(n.id))
      .map((n) => ({
        id: n.id,
        x: n.position.x,
        y: n.position.y,
        ...(typeof n.width === "number" ? { width: n.width } : {}),
        ...(typeof n.height === "number" ? { height: n.height } : {}),
        ...(typeof n.zIndex === "number" ? { zIndex: n.zIndex } : {}),
      }));
    if (positions.length === 0) return;
    markSaving();
    void fetch(`/api/boards/${boardId}/graph`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ positions }),
      keepalive: true,
    })
      .then((r) => {
        if (r.ok) {
          markSaved();
          broadcastLive({ type: "refresh" }); // sync spectators to the persisted positions
        } else setSave("error");
      })
      .catch(() => setSave("error"));
  }, [boardId, markSaving, markSaved, broadcastLive]);

  const scheduleFlush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 500);
  }, [flush]);

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // Suggestion ghosts live in `suggestions` state, NOT the canvas store — handle their drags here so a
      // moderator can shove them out of the way without persisting them as real nodes.
      const isGhost = (id: unknown): id is string => typeof id === "string" && id.startsWith("sug:");
      const ghostChanges = changes.filter((c) => "id" in c && isGhost(c.id));
      if (ghostChanges.length) {
        setSuggestions((prev) => {
          let next = prev;
          for (const c of ghostChanges) {
            if (c.type !== "position" || !c.position) continue;
            const mm = /^sug:([^:]+):(.+)$/.exec(c.id);
            if (!mm) continue;
            const [, sugId, tempId] = mm;
            const pos = c.position;
            next = next.map((s) =>
              s.id !== sugId
                ? s
                : { ...s, payload: { ...s.payload, nodes: s.payload.nodes.map((n) => (n.tempId === tempId ? { ...n, x: pos.x, y: pos.y } : n)) } },
            );
          }
          return next === prev ? prev : next;
        });
      }
      const realChanges = ghostChanges.length ? changes.filter((c) => !("id" in c && isGhost(c.id))) : changes;
      if (realChanges.length === 0) return;
      changes = realChanges;

      // draw.io alignment guides: on a single live node drag, snap the proposed position to nearby
      // neighbors' edges/centers and surface the matched guide coords. The 4px grid still applies to
      // any axis not captured by alignment (React Flow grid-snaps the position we hand back).
      const dragChanges = changes.filter(
        (c): c is NodeChange & { id: string; position: { x: number; y: number }; dragging?: boolean } =>
          c.type === "position" && !!c.position && c.dragging === true,
      );
      if (dragChanges.length === 1) {
        const c = dragChanges[0];
        const moving = useCanvasStore.getState().nodes.find((n) => n.id === c.id);
        if (moving) {
          const { w, h } = nodeSize(moving);
          const { snapPosition, vertical, horizontal } = getHelperLines(
            { id: c.id, position: c.position, w, h },
            useCanvasStore.getState().nodes,
          );
          c.position = snapPosition; // overwrite the proposed drag position with the aligned one
          setGuides({ vertical, horizontal });
        }
      } else if (!changes.some((c) => c.type === "position" && c.dragging)) {
        setGuides({}); // not a drag → no guides
      }

      if (canEdit) {
        const hasRemove = changes.some((c) => c.type === "remove");
        const hasMove = changes.some(
          (c) => c.type === "position" || (c.type === "dimensions" && "resizing" in c && c.resizing),
        );
        const store = useCanvasStore.getState();
        if (hasRemove) captureRemoveHistory(); // snapshot (nodes+edges) before any removal applies
        else if (hasMove && !bursting.current) {
          bursting.current = true;
          store.pushHistory();
        }
        for (const c of changes) {
          if (c.type === "position") dirty.current.add(c.id);
          else if (c.type === "dimensions" && "resizing" in c && c.resizing) dirty.current.add(c.id);
        }
        // Custom waypoints ride along when an edge's BOTH endpoints move by the SAME delta (group /
        // multi-select drag) — translate them so hand-placed bends don't stay behind. A single-endpoint
        // move leaves the waypoints (the connector reshapes), matching draw.io. (`store` holds the OLD
        // positions here; onNodesChange below applies the new ones.)
        const deltas = new Map<string, { dx: number; dy: number }>();
        for (const c of changes) {
          if (c.type !== "position" || !c.position) continue;
          const old = store.nodes.find((n) => n.id === c.id);
          if (old) deltas.set(c.id, { dx: c.position.x - old.position.x, dy: c.position.y - old.position.y });
        }
        if (deltas.size > 1) {
          for (const e of store.edges) {
            const wp = (e.data as { waypoints?: { x: number; y: number }[] } | undefined)?.waypoints;
            if (!wp || wp.length === 0) continue;
            const ds = deltas.get(e.source), dt = deltas.get(e.target);
            if (!ds || !dt) continue; // need BOTH endpoints in the move
            if (Math.abs(ds.dx - dt.dx) > 0.01 || Math.abs(ds.dy - dt.dy) > 0.01) continue; // same delta only
            if (ds.dx === 0 && ds.dy === 0) continue;
            store.updateEdge(e.id, { data: { waypoints: wp.map((p) => ({ x: p.x + ds.dx, y: p.y + ds.dy })) } });
            shiftedEdges.current.add(e.id);
          }
        }
        if (hasMove) scheduleFlush();
      }
      onNodesChange(changes);
      // Stream drag positions to public spectators (throttled) so they see nodes move in real time.
      if (canEdit && changes.some((c) => c.type === "position")) {
        const now = Date.now();
        if (now - liveThrottle.current >= 70) {
          liveThrottle.current = now;
          const ids = new Set(changes.filter((c) => c.type === "position").map((c) => c.id));
          const moved = useCanvasStore
            .getState()
            .nodes.filter((n) => ids.has(n.id))
            .map((n) => ({ id: n.id, x: n.position.x, y: n.position.y }));
          if (moved.length) broadcastLive({ type: "pos", nodes: moved });
        }
      }
    },
    [onNodesChange, scheduleFlush, canEdit, broadcastLive, captureRemoveHistory],
  );

  // Edge removals (incl. those that ride along with a node delete) push history too, so undo restores
  // deleted connectors. captureRemoveHistory dedups so a node+edge delete only snapshots once.
  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (canEdit && changes.some((c) => c.type === "remove")) captureRemoveHistory();
      onEdgesChange(changes);
    },
    [canEdit, onEdgesChange, captureRemoveHistory],
  );

  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", onHidden);
      flush();
    };
  }, [flush]);

  // Apply an exact selection set to the canvas store, overriding React Flow's default click selection.
  // Nodes are a controlled prop sourced from this store, so writing the `selected` flags here is the
  // controlled-flow equivalent of instance.setNodes — it wins on the resulting render. Edges are
  // deselected so the chain/branch selection reads cleanly as a node group.
  const applyNodeSelection = useCallback((ids: Set<string>) => {
    useCanvasStore.setState((s) => ({
      nodes: s.nodes.map((n) => {
        const want = ids.has(n.id);
        return n.selected === want ? n : { ...n, selected: want };
      }),
      edges: s.edges.some((e) => e.selected) ? s.edges.map((e) => (e.selected ? { ...e, selected: false } : e)) : s.edges,
    }));
  }, []);

  const onConnect = useCallback(
    async (c: Connection) => {
      if (!canEdit || !c.source || !c.target) return;
      useCanvasStore.getState().pushHistory();
      // which anchor on each node the user grabbed — persisted so the trail keeps its endpoints
      const created = await runSaving(
        createEdge(boardId, c.source, c.target, { sourceHandle: c.sourceHandle, targetHandle: c.targetHandle }),
      );
      if (created) addEdgeToStore(toRFEdge(created));
    },
    [boardId, addEdgeToStore, canEdit, runSaving],
  );

  // Re-point an existing connector when the user drags one of its endpoints onto another node/anchor.
  const onReconnect = useCallback(
    (oldEdge: Edge, c: Connection) => {
      if (!canEdit || !c.source || !c.target) return;
      useCanvasStore.getState().pushHistory();
      useCanvasStore.getState().updateEdge(oldEdge.id, {
        source: c.source,
        target: c.target,
        sourceHandle: c.sourceHandle ?? undefined,
        targetHandle: c.targetHandle ?? undefined,
        data: { ...(oldEdge.data ?? {}), sourceHandle: c.sourceHandle ?? undefined, targetHandle: c.targetHandle ?? undefined },
      });
      void runSaving(
        reconnectEdge(boardId, oldEdge.id, { source: c.source, target: c.target, sourceHandle: c.sourceHandle, targetHandle: c.targetHandle }),
      );
    },
    [boardId, canEdit, runSaving],
  );

  // Create a new node of `kind` at `pos` and connect `sourceId` → it. Shared by the hover connect-arrows
  // (kind picked from the arrow type strip) and the drag-to-empty (onConnectEnd) gesture (defaults text).
  const createConnectedNode = useCallback(
    async (sourceId: string, kind: string, pos: { x: number; y: number }, sourceHandle?: string, targetHandle?: string) => {
      useCanvasStore.getState().pushHistory();
      const created = await runSaving(createNode(boardId, kind, pos, { ...(SPAWN_DATA[kind] ?? { text: "" }) }));
      if (!created) return;
      addNode(toRFNode(created));
      if (kind === "text") useCanvasStore.getState().setEditingNode(created.id); // blank text box opens focused
      const edge = await runSaving(createEdge(boardId, sourceId, created.id, { sourceHandle, targetHandle }));
      if (edge) addEdgeToStore(toRFEdge(edge));
    },
    [boardId, runSaving, addNode, addEdgeToStore],
  );

  // Hover connect-arrows: spawn a connected node offset in `dir` from `source`, anchored on the
  // facing sides (source's `dir` side → new node's opposite side).
  const spawnConnected = useCallback(
    (source: Node, dir: "top" | "right" | "bottom" | "left", kind?: SpawnKind) => {
      const { w, h } = nodeSize(source);
      const GAP = 90;
      let pos =
        dir === "right" ? { x: source.position.x + w + GAP, y: source.position.y }
        : dir === "left" ? { x: source.position.x - 200 - GAP, y: source.position.y }
        : dir === "bottom" ? { x: source.position.x, y: source.position.y + h + GAP }
        : { x: source.position.x, y: source.position.y - 90 - GAP };
      // Place beyond the ROTATED side of a tilted source (its handle is rotated too), so the new node
      // and its connector line up with where the arrow visually points.
      const rot = Number((source.data as { rotation?: number }).rotation ?? 0) || 0;
      if (rot) {
        const cx = source.position.x + w / 2, cy = source.position.y + h / 2;
        const rad = (rot * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
        pos = { x: cx + (pos.x - cx) * cos - (pos.y - cy) * sin, y: cy + (pos.x - cx) * sin + (pos.y - cy) * cos };
      }
      setHoveredNodeId(null);
      void createConnectedNode(source.id, kind ?? spawnKindRef.current, pos, SIDE_HANDLE[dir], OPP_HANDLE[dir]);
    },
    [createConnectedNode],
  );

  // Keep the connect-arrows visible across the small gap between the node and the arrows.
  const keepHover = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  }, []);
  const scheduleHideHover = useCallback(() => {
    keepHover();
    hoverTimer.current = setTimeout(() => setHoveredNodeId(null), 300); // grace to reach the arrows
  }, [keepHover]);

  // Drag from a handle and release on empty canvas → create a connected node there (draw.io style).
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, conn: FinalConnectionState) => {
      if (!canEdit || conn.toNode || !conn.fromNode) return; // landed on a node → onConnect handles it
      const pt = "changedTouches" in event ? event.changedTouches[0] : event;
      const pos = screenToFlowPosition({ x: pt.clientX, y: pt.clientY });
      void createConnectedNode(conn.fromNode.id, "text", { x: pos.x - 90, y: pos.y - 20 }, conn.fromHandle?.id ?? undefined);
    },
    [canEdit, screenToFlowPosition, createConnectedNode],
  );

  // Unified node-click handler. Branch on the modifier keys FIRST (and return early) so the custom
  // chain/branch gestures never collide with the existing ghost-reveal behavior or React Flow's native
  // plain-click / Shift multi-select. Selection for the custom gestures is written through the store
  // (see applyNodeSelection), which overrides React Flow's default click selection.
  const onNodeClick = useCallback(
    (e: React.MouseEvent, n: Node) => {
      const mod = e.ctrlKey || e.metaKey;
      const ghost = parseGhost(n.id);

      // Ghosts (live suggestions) aren't real graph nodes — keep the existing click-to-reveal path and
      // never let them participate in chain/branch selection.
      if (ghost) {
        if (canEdit) { clearRevealTimers(); setRevealed(ghost); }
        return;
      }

      // Behavior 4: Shift+Ctrl/⌘ click → select the entire undirected connected component (branch/tree).
      if (mod && e.shiftKey) {
        const adj = buildUndirectedAdjacency(nodes, edges);
        applyNodeSelection(connectedComponent(n.id, adj));
        chainStart.current = null;
        return;
      }

      // Behavior 3: Ctrl/⌘ click → chain select. First click arms the chain start (and selects just
      // that node); the second resolves the shortest path between them (inclusive) and clears the start.
      if (mod) {
        const start = chainStart.current;
        if (!start || start === n.id || !nodesById.has(start)) {
          chainStart.current = n.id;
          applyNodeSelection(new Set([n.id]));
          return;
        }
        const adj = buildUndirectedAdjacency(nodes, edges);
        const path = shortestPath(start, n.id, adj);
        applyNodeSelection(new Set(path ?? [start, n.id])); // no path → just select the two endpoints
        chainStart.current = null;
        return;
      }

      // Plain or Shift click → React Flow's native single-/multi-select handles it; just drop any
      // pending chain start so a later Ctrl-click begins a fresh chain.
      chainStart.current = null;
    },
    [canEdit, parseGhost, clearRevealTimers, nodes, edges, nodesById, applyNodeSelection],
  );

  const onDelete = useCallback(
    ({ nodes: dn, edges: de }: { nodes: Node[]; edges: Edge[] }) => {
      if (!canEdit || (dn.length === 0 && de.length === 0)) return;
      void runSaving(
        deleteElements(
          boardId,
          dn.map((n) => n.id),
          de.filter((e) => !e.id.startsWith("tree:")).map((e) => e.id),
        ),
      );
    },
    [boardId, canEdit, runSaving],
  );

  const centerPos = useCallback(
    () => screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }),
    [screenToFlowPosition],
  );

  const addTile = useCallback(
    async (
      type: SpawnKind,
      pos?: { x: number; y: number },
      parentId?: string | null,
      data?: Record<string, unknown>,
    ) => {
      useCanvasStore.getState().pushHistory();
      const payload = data ?? { ...(SPAWN_DATA[type] ?? { text: "" }) };
      const created = await runSaving(createNode(boardId, type, pos ?? centerPos(), payload, parentId));
      if (created) {
        addNode(toRFNode(created));
        // A blank text box opens in edit mode; tiles created WITH content (paste, AI) don't.
        if (type === "text" && !String((payload as { text?: string }).text ?? "").trim()) {
          useCanvasStore.getState().setEditingNode(created.id);
        }
      }
    },
    [boardId, centerPos, addNode, runSaving],
  );

  const addImageFile = useCallback(
    async (file: File, pos: { x: number; y: number }) => {
      if (!file.type.startsWith("image/")) return;
      const alt = file.name; // keep the original name for alt text even if we re-encode to .webp
      const upload = await optimizeImage(file);
      const fd = new FormData();
      fd.append("file", upload);
      fd.append("boardId", boardId);
      const res = await runSaving(fetch("/api/assets", { method: "POST", body: fd }));
      if (!res || !res.ok) return;
      const { id: assetId } = (await res.json()) as { id: string };
      useCanvasStore.getState().pushHistory();
      const created = await runSaving(createNode(boardId, "image", pos, { assetId, alt }));
      if (created) addNode(toRFNode(created));
    },
    [boardId, addNode, runSaving],
  );

  const addLink = useCallback(
    async (url: string, pos: { x: number; y: number }, image?: string) => {
      useCanvasStore.getState().pushHistory();
      const created = await runSaving(createNode(boardId, "link", pos, { url, ...(image ? { image } : {}) }));
      if (!created) return;
      addNode(toRFNode(created));
      try {
        const res = await fetch(`/api/unfurl?url=${encodeURIComponent(url)}`);
        if (res.ok) {
          const meta = (await res.json()) as Record<string, unknown>;
          // if the user supplied a custom image up front, don't let the unfurl overwrite it
          const patch = { title: meta.title, description: meta.description, favicon: meta.favicon, ...(image ? {} : { image: meta.image }) };
          useCanvasStore.getState().updateNodeData(created.id, patch as Record<string, unknown>);
          void updateNodeData(boardId, created.id, patch as Record<string, unknown>);
        }
      } catch {
        /* leave bare link */
      }
    },
    [boardId, addNode, runSaving],
  );

  const addTextNodeAt = useCallback(
    (text: string, pos: { x: number; y: number }) => addTile("text", pos, null, { text: text.slice(0, 5000) }),
    [addTile],
  );
  const addSwatchAt = useCallback(
    (hex: string, pos: { x: number; y: number }) => addTile("swatch", pos, null, { hex }),
    [addTile],
  );

  // Consume the pending creation position (set by a right-click / context handler), else board center.
  const consumePos = useCallback(() => { const p = pendingPos.current; pendingPos.current = null; return p ?? centerPos(); }, [centerPos]);
  // Open the (hidden) image file picker; an optional pos drops the image where the user right-clicked.
  const openImagePicker = useCallback((pos?: { x: number; y: number }) => { pendingPos.current = pos ?? null; fileInput.current?.click(); }, []);

  const onPickImage = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (file) await addImageFile(file, consumePos());
    },
    [addImageFile, consumePos],
  );

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      if (!canEdit) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
      let i = 0;
      for (const f of files) {
        await addImageFile(f, screenToFlowPosition({ x: e.clientX + i * 24, y: e.clientY + i * 24 }));
        i++;
      }
    },
    [canEdit, screenToFlowPosition, addImageFile],
  );

  const duplicateNodes = useCallback(
    async (ids: string[]) => {
      const sel = useCanvasStore.getState().nodes.filter((n) => ids.includes(n.id));
      if (sel.length === 0) return;
      useCanvasStore.getState().pushHistory();
      for (const n of sel) {
        const { _tree, ...data } = (n.data as Record<string, unknown>) ?? {};
        void _tree;
        const created = await runSaving(
          createNode(boardId, (n.type as string) ?? "text", { x: n.position.x + 28, y: n.position.y + 28 }, data),
        );
        if (created) addNode(toRFNode(created));
      }
    },
    [boardId, addNode, runSaving],
  );

  const syncNow = useCallback(() => {
    // Under live collab the Yjs flush is the source of truth; a destructive full-graph reconcile
    // here would resurrect remotely-deleted nodes and delete peers' concurrent additions.
    if (collabOn) return;
    const { nodes: ns, edges: es } = useCanvasStore.getState();
    void runSaving(syncBoardGraph(boardId, ns.map(syncNode), es.map(syncEdge)));
  }, [boardId, runSaving, collabOn]);

  const doUndo = useCallback(() => {
    if (useCanvasStore.getState().undo()) syncNow();
  }, [syncNow]);
  const doRedo = useCallback(() => {
    if (useCanvasStore.getState().redo()) syncNow();
  }, [syncNow]);

  const setCollapsedFor = useCallback(
    (id: string, collapsed: boolean) => {
      useCanvasStore.getState().setCollapsed(id, collapsed);
      void runSaving(toggleCollapse(boardId, id, collapsed));
    },
    [boardId, runSaving],
  );

  const focusBranch = useCallback(
    (id: string) => {
      setFocusedId(id);
      const { nodes: st, edges: ed } = useCanvasStore.getState();
      const ids = reachableFrom(id, st, ed); // tree children + connector lines (directional)
      setTimeout(() => fitView({ nodes: [...ids].map((i) => ({ id: i })), duration: 400, padding: 0.25 }), 30);
    },
    [fitView],
  );


  // Clipboard paste + keyboard shortcuts.
  useEffect(() => {
    if (!canEdit) return;
    // Contextual paste: paste anything onto the canvas (nothing focused) and we create the right
    // node — image→image, other file→note, URL→link card, #hex→swatch, plain text→text node.
    const onPaste = (e: ClipboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement | null)?.isContentEditable) return;
      const dt = e.clipboardData;
      if (!dt) return;
      let files = Array.from(dt.files);
      if (files.length === 0) {
        // screenshots / copied images arrive as items, not files
        files = Array.from(dt.items ?? [])
          .filter((it) => it.kind === "file")
          .map((it) => it.getAsFile())
          .filter((f): f is File => !!f);
      }
      if (files.length) {
        e.preventDefault();
        const base = centerPos();
        files.forEach((f, i) => {
          const pos = { x: base.x + i * 24, y: base.y + i * 24 };
          if (f.type.startsWith("image/")) void addImageFile(f, pos);
          else void addTextNodeAt(`📎 ${f.name}`, pos); // only images are hosted; drop a note
        });
        return;
      }
      const text = dt.getData("text/plain")?.trim();
      if (!text) return;
      e.preventDefault();
      const pos = centerPos();
      if (/^https?:\/\/\S+$/i.test(text)) void addLink(text, pos);
      else if (/^#[0-9a-fA-F]{6}$/.test(text)) void addSwatchAt(text.toLowerCase(), pos);
      else void addTextNodeAt(text, pos);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault(); // block the browser "save page" dialog
        if (canEdit) {
          (document.activeElement as HTMLElement | null)?.blur?.(); // commit any open text editor first
          flush(); // persist pending positions now
          syncNow(); // full graph reconcile (no-op under live collab)
        }
        return;
      }
      if (e.key === "Escape") {
        setMenu(null);
        setFocusedId(null);
        setLinkOpen(false);
        setAiOpen(false);
        return;
      }
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement | null)?.isContentEditable) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? doRedo() : doUndo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        doRedo();
      } else if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        void duplicateNodes(useCanvasStore.getState().nodes.filter((n) => n.selected).map((n) => n.id));
      } else if (!mod && !e.altKey && spawnKeyType(e.key) && useCanvasStore.getState().nodes.some((n) => n.selected)) {
        // Arm directional spawn: hold a type key (Tab/C/L/S/V), then press an arrow to drop a CONNECTED
        // node of that type in that direction from the selected node (keyboard twin of the hover
        // connect-arrows). Requires NO Ctrl/Cmd/Alt (so Ctrl+C/V/S/L are untouched) and a selected node
        // (so plain Tab/letters pass through otherwise).
        e.preventDefault();
        heldSpawnType.current = spawnKeyType(e.key)!;
      } else if (heldSpawnType.current && DIR_FOR_ARROW[e.key]) {
        e.preventDefault();
        e.stopPropagation(); // capture-phase: keep React Flow from also nudging the focused node
        const sel = useCanvasStore.getState().nodes.find((n) => n.selected);
        if (sel) spawnConnected(sel, DIR_FOR_ARROW[e.key]!, heldSpawnType.current);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const held = heldSpawnType.current;
      if (held && e.key.toLowerCase() === SPAWN_KEY[held].toLowerCase()) heldSpawnType.current = null;
    };
    const disarm = () => { heldSpawnType.current = null; };
    window.addEventListener("paste", onPaste);
    // Capture phase so the armed arrow-spawn preempts React Flow's built-in arrow-key node nudging.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", disarm);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", disarm);
    };
  }, [canEdit, addImageFile, centerPos, doUndo, doRedo, duplicateNodes, spawnConnected, addLink, addTextNodeAt, addSwatchAt, flush, syncNow]);

  // ── Search ──
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as Node[];
    return nodes.filter((n) => {
      const { _tree, ...d } = (n.data as Record<string, unknown>) ?? {};
      void _tree;
      return JSON.stringify(d).toLowerCase().includes(q);
    });
  }, [query, nodes]);

  const jumpToMatch = useCallback(() => {
    if (matches.length === 0) return;
    matchIdx.current = matchIdx.current % matches.length;
    const n = matches[matchIdx.current];
    matchIdx.current += 1;
    setCenter(n.position.x + 60, n.position.y + 40, { zoom: 1.2, duration: 400 });
  }, [matches, setCenter]);

  const zOrder = useCallback(
    (id: string, front: boolean) => {
      const s = useCanvasStore.getState();
      s.pushHistory();
      if (front) s.bringToFront([id]);
      else s.sendToBack([id]);
      dirty.current.add(id);
      flush();
    },
    [flush],
  );
  const deleteNode = useCallback(
    (id: string) => {
      useCanvasStore.getState().pushHistory();
      useCanvasStore.getState().removeNodes([id]);
      void runSaving(deleteElements(boardId, [id], []));
    },
    [boardId, runSaving],
  );

  const openLinkPopover = useCallback((pos?: { x: number; y: number }) => {
    pendingPos.current = pos ?? null; // optional: drop the link where the user right-clicked
    setLinkUrl("");
    setLinkImg("");
    setLinkOpen(true);
  }, []);
  const submitLink = useCallback(() => {
    const u = linkUrl.trim();
    const img = linkImg.trim();
    setLinkOpen(false);
    if (u) void addLink(u, consumePos(), img || undefined);
  }, [linkUrl, linkImg, addLink, consumePos]);

  const jumpToNode = useCallback(
    (id: string) => {
      const n = useCanvasStore.getState().nodes.find((x) => x.id === id);
      if (n) setCenter(n.position.x + 60, n.position.y + 40, { zoom: 1.2, duration: 400 });
    },
    [setCenter],
  );

  // ── In-app AI (env-gated; hidden when !aiEnabled) ──
  const openAi = useCallback(() => {
    setAiPrompt("");
    setAiError(null);
    setAiOpen(true);
  }, []);
  const runGenerateMap = useCallback(async () => {
    const p = aiPrompt.trim();
    if (!p || aiBusy) return;
    setAiBusy(true);
    setAiError(null);
    try {
      const created = await generateMap(boardId, p, centerPos());
      if (created.length) useCanvasStore.getState().pushHistory();
      for (const n of created) addNode(toRFNode(n));
      setAiOpen(false);
      setTimeout(() => fitView({ duration: 500, padding: 0.2 }), 60);
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "AI request failed.");
    } finally {
      setAiBusy(false);
    }
  }, [aiPrompt, aiBusy, boardId, centerPos, addNode, fitView]);

  const runExpandNode = useCallback(
    async (nodeId: string) => {
      setAiBusy(true);
      try {
        const created = await expandNodeAI(boardId, nodeId);
        if (created.length) useCanvasStore.getState().pushHistory();
        for (const n of created) addNode(toRFNode(n));
      } catch {
        setSave("error");
      } finally {
        setAiBusy(false);
      }
    },
    [boardId, addNode],
  );

  const runSummarize = useCallback(
    async (nodeId: string) => {
      setAiBusy(true);
      try {
        const node = await summarizeBranch(boardId, nodeId);
        useCanvasStore.getState().pushHistory();
        addNode(toRFNode(node));
        setTimeout(() => jumpToNode(node.id), 60);
      } catch {
        setSave("error");
      } finally {
        setAiBusy(false);
      }
    },
    [boardId, addNode, jumpToNode],
  );

  const saveVersionNow = useCallback(() => {
    void runSaving(saveVersion(boardId));
  }, [boardId, runSaving]);

  // ── Tags + groups ──
  const selectedIds = useMemo(() => nodes.filter((n) => n.selected).map((n) => n.id), [nodes]);

  const branchIds = useCallback((rootId: string): string[] => {
    const st = useCanvasStore.getState().nodes;
    const childrenOf = new Map<string, string[]>();
    for (const n of st) {
      const pid = treeOf(n).parentId;
      if (pid) (childrenOf.get(pid) ?? childrenOf.set(pid, []).get(pid)!).push(n.id);
    }
    const ids: string[] = [];
    const stack = [rootId];
    const seen = new Set<string>();
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue; // defensive: tolerate a malformed self/cyclic parent ref
      seen.add(id);
      ids.push(id);
      for (const c of childrenOf.get(id) ?? []) stack.push(c);
    }
    return ids;
  }, []);

  // Detach a child from its parent (becomes a free node). Its own children stay attached to it.
  const detachNode = useCallback(
    (id: string) => {
      useCanvasStore.getState().pushHistory();
      useCanvasStore.getState().setParent(id, null);
      void runSaving(setNodeParent(boardId, id, null));
    },
    [boardId, runSaving],
  );
  // Re-parent the right-clicked node under the currently-selected node (cycle-guarded).
  const attachToSelected = useCallback(
    (childId: string) => {
      const sel = useCanvasStore.getState().nodes.find((n) => n.selected && n.id !== childId);
      if (!sel) return;
      if (branchIds(childId).includes(sel.id)) return; // would create a cycle
      useCanvasStore.getState().pushHistory();
      useCanvasStore.getState().setParent(childId, sel.id);
      void runSaving(setNodeParent(boardId, childId, sel.id));
    },
    [boardId, runSaving, branchIds],
  );

  const openTagPopover = useCallback((ids: string[]) => {
    tagTargetIds.current = ids;
    setTagInput("");
    setTagOpen(true);
  }, []);

  const submitTags = useCallback(() => {
    const ids = tagTargetIds.current;
    const newTags = tagInput.split(",").map((t) => t.trim()).filter(Boolean);
    setTagOpen(false);
    if (!ids.length || !newTags.length) return;
    const store = useCanvasStore.getState();
    store.pushHistory();
    for (const id of ids) {
      const n = store.nodes.find((x) => x.id === id);
      if (!n) continue;
      const cur = ((n.data as { tags?: string[] })?.tags ?? []) as string[];
      store.updateNodeData(id, { tags: [...new Set([...cur, ...newTags])] });
    }
    void runSaving(addTagsToNodes(boardId, ids, newTags));
  }, [tagInput, boardId, runSaving]);

  const groupSelection = useCallback(async () => {
    const ids = useCanvasStore.getState().nodes.filter((n) => n.selected).map((n) => n.id);
    if (ids.length === 0) return;
    const g = await runSaving(createGroup(boardId, ids));
    if (g) {
      setGroups((gs) => [...gs, g]);
      setTagPanelOpen(true);
    }
  }, [boardId, runSaving]);

  const patchGroup = useCallback(
    async (groupId: string, patch: { label?: string | null; color?: string | null; tags?: string[]; nodeIds?: string[] }) => {
      const g = await runSaving(updateGroup(boardId, groupId, patch));
      if (g) setGroups((gs) => gs.map((x) => (x.id === groupId ? g : x)));
    },
    [boardId, runSaving],
  );
  const removeGroup = useCallback(
    async (groupId: string) => {
      const ok = await runSaving(deleteGroup(boardId, groupId));
      if (ok) setGroups((gs) => gs.filter((x) => x.id !== groupId));
    },
    [boardId, runSaving],
  );
  const addSelectionToGroup = useCallback(
    (groupId: string) => {
      const sel = useCanvasStore.getState().nodes.filter((n) => n.selected).map((n) => n.id);
      const g = groups.find((x) => x.id === groupId);
      if (!g || sel.length === 0) return;
      void patchGroup(groupId, { nodeIds: [...new Set([...g.nodeIds, ...sel])] });
    },
    [groups, patchGroup],
  );
  const focusGroup = useCallback(
    (groupId: string) => {
      const g = groups.find((x) => x.id === groupId);
      if (!g || g.nodeIds.length === 0) return;
      fitView({ nodes: g.nodeIds.map((id) => ({ id })), duration: 400, padding: 0.3 });
    },
    [groups, fitView],
  );

  // Distinct tags across nodes + groups, with counts (for the tag panel + palette).
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of nodes) {
      for (const t of ((n.data as { tags?: string[] })?.tags ?? [])) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    for (const g of groups) for (const t of g.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => a.tag.localeCompare(b.tag));
  }, [nodes, groups]);

  const selectTag = useCallback(
    (tag: string) => {
      setTagFilter(tag);
      const match = useCanvasStore.getState().nodes.find((n) => ((n.data as { tags?: string[] })?.tags ?? []).includes(tag));
      if (match) setCenter(match.position.x + 60, match.position.y + 40, { zoom: 1.1, duration: 400 });
    },
    [setCenter],
  );

  const renameTitle = useCallback(
    (t: string) => {
      const next = t.trim().slice(0, 200) || boardTitle;
      setBoardTitle(next);
      setEditingTitle(false);
      if (next !== boardTitle) void runSaving(renameBoard(boardId, next));
    },
    [boardId, boardTitle, runSaving],
  );

  // ── ⌘K command palette items (aggregates existing actions + node navigation) ──
  const paletteGroups = useMemo<PaletteGroup[]>(() => {
    const labelOf = (n: Node): string => {
      const d = (n.data as Record<string, unknown>) ?? {};
      if (n.type === "text") return (String(d.text ?? "").split("\n")[0] || "Empty text").slice(0, 60);
      if (n.type === "swatch") return `Swatch ${String(d.hex ?? "")}`;
      if (n.type === "link") return String(d.title ?? d.url ?? "Link").slice(0, 60);
      if (n.type === "image") return String(d.alt ?? "Image");
      return n.type ?? "Node";
    };
    const groups: PaletteGroup[] = [];
    if (canEdit) {
      groups.push({
        heading: "Create",
        items: [
          { id: "add-text", label: "Add text node", hint: `${SPAWN_KEY.text} + arrow`, keywords: "shortcut directional", icon: <Type size={16} />, run: () => void addTile("text") },
          { id: "add-swatch", label: "Add color swatch", hint: `${SPAWN_KEY.swatch} + arrow`, keywords: "shortcut directional", icon: <Palette size={16} />, run: () => void addTile("swatch") },
          { id: "add-image", label: "Add image…", icon: <ImageIcon size={16} />, run: () => openImagePicker() },
          { id: "add-link", label: "Add link…", hint: `${SPAWN_KEY.link} + arrow`, keywords: "shortcut directional", icon: <Link2 size={16} />, run: openLinkPopover },
          { id: "add-spreadsheet", label: "Add spreadsheet", hint: `${SPAWN_KEY.spreadsheet} + arrow`, keywords: "table grid calc cells formula shortcut directional", icon: <Table2 size={16} />, run: () => void addTile("spreadsheet") },
          { id: "add-tracker", label: "Add variable tracker", hint: `${SPAWN_KEY.tracker} + arrow`, keywords: "sum avg variables totals hud shortcut directional", icon: <Sigma size={16} />, run: () => void addTile("tracker") },
        ],
      });
      if (aiEnabled) {
        groups.push({
          heading: "AI",
          items: [
            { id: "ai-generate", label: "Generate mind-map from a prompt…", keywords: "ai claude create", icon: <Sparkles size={16} />, run: openAi },
            ...(selectedNode
              ? [
                  { id: "ai-expand", label: "Expand selected node with AI", keywords: "ai children ideas", icon: <Sparkles size={16} />, run: () => void runExpandNode(selectedNode.id) },
                  { id: "ai-summarize", label: "Summarize selected branch with AI", keywords: "ai summary", icon: <Sparkles size={16} />, run: () => void runSummarize(selectedNode.id) },
                ]
              : []),
          ],
        });
      }
      groups.push({
        heading: "Arrange",
        items: [
          { id: "undo", label: "Undo", hint: k("Z"), icon: <Undo2 size={16} />, run: doUndo },
          { id: "redo", label: "Redo", hint: k("⇧Z"), icon: <Redo2 size={16} />, run: doRedo },
          ...(selectedNode
            ? [{ id: "focus-sel", label: "Focus selected branch", keywords: "focus mode", run: () => focusBranch(selectedNode.id) }]
            : []),
          ...(focusedId ? [{ id: "exit-focus", label: "Exit focus mode", run: () => setFocusedId(null) }] : []),
        ],
      });
    }
    if (canEdit) {
      groups.push({
        heading: "Tags & groups",
        items: [
          ...(selectedIds.length
            ? [
                { id: "tag-sel", label: `Tag ${selectedIds.length} selected node(s)…`, keywords: "label", icon: <Tags size={16} />, run: () => openTagPopover(selectedIds) },
                { id: "group-sel", label: `Group ${selectedIds.length} selected into a cloud`, keywords: "cluster region", icon: <GroupIcon size={16} />, run: () => void groupSelection() },
              ]
            : []),
          { id: "tag-panel", label: "Open tags & groups panel", keywords: "search browse", icon: <Tags size={16} />, run: () => setTagPanelOpen(true) },
          ...tagCounts.slice(0, 12).map((t) => ({
            id: `tagf-${t.tag}`,
            label: `Filter by #${t.tag}`,
            hint: String(t.count),
            keywords: "tag search",
            run: () => selectTag(t.tag),
          })),
        ],
      });
      groups.push({
        heading: "Versions",
        items: [
          { id: "save-version", label: "Save a version (snapshot)", keywords: "history backup", icon: <History size={16} />, run: saveVersionNow },
          { id: "open-history", label: "Open version history…", keywords: "restore time travel", icon: <History size={16} />, run: () => router.push(`/boards/${boardId}/history`) },
        ],
      });
    }
    groups.push({
      heading: "View & export",
      items: [
        { id: "fit", label: "Fit view to content", run: () => fitView({ duration: 400, padding: 0.2 }) },
        { id: "png", label: "Export as PNG", run: () => void exportPng(getNodes(), title) },
        { id: "svg", label: "Export as SVG", run: () => void exportSvg(getNodes(), title) },
        { id: "pdf", label: "Export as PDF", run: () => void exportPdf(getNodes(), title) },
      ],
    });
    // Only build the (potentially large) node-navigation list while the palette is actually open;
    // otherwise this recomputes the whole projection on every drag tick for nothing.
    const nodeItems = paletteOpen
      ? nodes.slice(0, 500).map((n) => ({
          id: `goto-${n.id}`,
          label: labelOf(n),
          keywords: n.type ?? "",
          run: () => jumpToNode(n.id),
        }))
      : [];
    groups.push({ heading: "Go to node", items: nodeItems });
    return groups;
  }, [canEdit, aiEnabled, nodes, paletteOpen, selectedNode, selectedIds, focusedId, addTile, openImagePicker, openLinkPopover, openAi, runExpandNode, runSummarize, doUndo, doRedo, focusBranch, fitView, getNodes, title, jumpToNode, saveVersionNow, router, boardId, openTagPopover, groupSelection, selectTag, tagCounts, k]);

  const menuNode = menu?.nodeId ? displayNodes.find((n) => n.id === menu.nodeId) : null;
  const menuTree = menuNode ? treeOf(menuNode) : null;

  return (
    <VariablesProvider nodes={nodes}>
    <div
      className="relative h-full w-full"
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
      onMouseMove={
        collab
          ? (e) => {
              const now = Date.now();
              if (now - cursorThrottle.current < 50) return;
              cursorThrottle.current = now;
              const f = screenToFlowPosition({ x: e.clientX, y: e.clientY });
              collab.setCursor({ x: f.x, y: f.y });
            }
          : undefined
      }
      onMouseLeave={collab ? () => collab.setCursor(null) : undefined}
    >
      <ReactFlow
        nodes={allNodes}
        edges={allEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        onReconnect={onReconnect}
        onDelete={onDelete}
        onNodeMouseEnter={(_e, n) => {
          if (!canEdit) return;
          const g = parseGhost(n.id);
          if (g) { scheduleReveal(g, n.type); return; } // hold to reveal (gradual de-blur) → Accept/Discard
          if (draggingNode.current || n.type === "cloud") return;
          keepHover();
          setHoveredNodeId(n.id);
        }}
        onNodeMouseLeave={(_e, n) => {
          if (n && parseGhost(n.id)) { scheduleHideReveal(); return; }
          scheduleHideHover();
        }}
        onNodeClick={onNodeClick}
        onNodeDragStart={() => {
          draggingNode.current = true;
          setHoveredNodeId(null);
          clearRevealTimers();
          setRevealed(null);
        }}
        onNodeDragStop={() => {
          draggingNode.current = false;
          setGuides({}); // clear alignment guide lines
          // Persist any waypoints that rode along with the moved group/selection during this drag.
          if (shiftedEdges.current.size) {
            const st = useCanvasStore.getState();
            for (const id of shiftedEdges.current) {
              const wp = (st.edges.find((x) => x.id === id)?.data as { waypoints?: { x: number; y: number }[] } | undefined)?.waypoints;
              if (wp) void updateEdgeStyle(boardId, id, { data: { waypoints: wp } });
            }
            shiftedEdges.current = new Set();
          }
        }}
        onNodeContextMenu={(e, n) => {
          if (!canEdit) return;
          e.preventDefault();
          const f = screenToFlowPosition({ x: e.clientX, y: e.clientY });
          setMenu({ x: e.clientX, y: e.clientY, flowX: f.x, flowY: f.y, nodeId: n.id });
        }}
        onPaneContextMenu={(e) => {
          if (!canEdit) return;
          e.preventDefault();
          const f = screenToFlowPosition({ x: e.clientX, y: e.clientY });
          setMenu({ x: e.clientX, y: e.clientY, flowX: f.x, flowY: f.y, nodeId: null });
        }}
        onClick={() => { setMenu(null); setRevealed(null); }}
        nodesDraggable={canEdit}
        nodesConnectable={canEdit}
        edgesReconnectable={canEdit}
        connectOnClick={canEdit}
        connectionMode={ConnectionMode.Loose}
        // Selection gestures. Shift activates the marquee (box select) and overrides panning while held,
        // so a plain drag still pans the canvas and Shift+drag rubber-bands a group (behavior 1).
        selectionKeyCode="Shift"
        selectionOnDrag
        panOnDrag
        // Shift is also the multi-select modifier (Shift+click toggles a node in/out of the selection,
        // behavior 2), deliberately NOT Ctrl so Ctrl/⌘ stays free for the chain/branch gestures.
        multiSelectionKeyCode="Shift"
        deleteKeyCode={canEdit ? ["Backspace", "Delete"] : null}
        defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
        onlyRenderVisibleElements={nodes.length > 150}
        snapToGrid
        snapGrid={SNAP_GRID}
        minZoom={minZoom}
        maxZoom={maxZoom}
        colorMode={colorMode}
        fitView
        proOptions={PRO_OPTIONS}
      >
        <Background gap={16} color="var(--md-sys-color-outline-variant)" />
        {/* lift the minimap so it doesn't sit under the global ThemeForge FAB (bottom-right) */}
        <MiniMap pannable zoomable style={{ bottom: 76 }} />
        <Controls />
        {collab && <PresenceCursors peers={peers} />}
        {canEdit && (guides.vertical != null || guides.horizontal != null) && (
          <AlignmentGuides vertical={guides.vertical} horizontal={guides.horizontal} />
        )}
        {canEdit && hoveredNodeId && (() => {
          const hn = nodes.find((n) => n.id === hoveredNodeId);
          return hn ? <ConnectArrows node={hn} onSpawn={spawnConnected} spawnKind={spawnKind} onPickKind={pickSpawnKind} onEnter={keepHover} onLeave={scheduleHideHover} /> : null;
        })()}
        {canEdit && !streamView && revealedInfo && (
          <SuggestionReveal
            authorName={revealedInfo.s.authorName}
            node={revealedInfo.pn}
            tally={revealedInfo.s.votes?.[revealedInfo.pn.tempId]}
            onAccept={() => void acceptGhost(revealedInfo.s.id, revealedInfo.pn.tempId)}
            onDiscard={() => void discardGhost(revealedInfo.s.id, revealedInfo.pn.tempId)}
            onKeepOpen={keepReveal}
            onLeave={scheduleHideReveal}
          />
        )}
      </ReactFlow>

      {/* Compact icon rail. desktop: a single nowrap row over the canvas. mobile: same row, horizontally
          scrollable (children kept shrink-0 so they never squash). */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-nowrap items-center gap-2 overflow-x-auto overflow-y-visible p-3 max-sm:pointer-events-auto max-sm:pb-2 [&>*]:shrink-0 [&>*]:h-9 [&>*]:flex [&>*]:items-center">
        {/* LEFT: back · title · save */}
        <Link href="/" aria-label="Back to dashboard" title="Back to dashboard" className="pointer-events-auto flex items-center rounded-control border border-outline-variant bg-surface-container/95 p-2 text-on-surface-variant shadow-elev-1 backdrop-blur transition hover:text-on-surface active:scale-[.97]"><ArrowLeft size={16} /></Link>
        {editingTitle && canEdit ? (
          <input
            autoFocus
            defaultValue={boardTitle}
            onBlur={(e) => renameTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") renameTitle((e.target as HTMLInputElement).value);
              if (e.key === "Escape") setEditingTitle(false);
            }}
            maxLength={200}
            className="pointer-events-auto w-56 rounded-control border border-primary bg-surface px-3 py-1.5 text-sm font-medium text-on-surface shadow-elev-1 outline-none"
          />
        ) : (
          <button
            onDoubleClick={() => canEdit && setEditingTitle(true)}
            title={canEdit ? "Double-click to rename" : undefined}
            className="pointer-events-auto rounded-control border border-outline-variant bg-surface-container/95 px-3 py-1.5 text-sm font-medium text-on-surface shadow-elev-1 backdrop-blur transition hover:border-outline"
          >
            {boardTitle}
          </button>
        )}
        <SaveBadge status={save} />

        {/* RAIL: grouped icon pills */}
        {canEdit && (
          <RailGroup>
            <ToolbarMenu
              label="Add node"
              open={railMenu === "add"}
              onToggle={() => toggleRailMenu("add")}
              onClose={closeRailMenu}
              trigger={<Plus size={16} />}
            >
              <ul role="menu" className="py-1">
                <MenuItem onClick={() => { void addTile("text"); closeRailMenu(); }}><span className="flex items-center gap-2"><Type size={15} /> Text</span></MenuItem>
                <MenuItem onClick={() => { void addTile("swatch"); closeRailMenu(); }}><span className="flex items-center gap-2"><Palette size={15} /> Swatch</span></MenuItem>
                <MenuItem onClick={() => { openImagePicker(); closeRailMenu(); }}><span className="flex items-center gap-2"><ImageIcon size={15} /> Image</span></MenuItem>
                <MenuItem onClick={() => { openLinkPopover(); closeRailMenu(); }}><span className="flex items-center gap-2"><Link2 size={15} /> Link</span></MenuItem>
                <MenuItem onClick={() => { void addTile("spreadsheet"); closeRailMenu(); }}><span className="flex items-center gap-2"><Table2 size={15} /> Spreadsheet</span></MenuItem>
                <MenuItem onClick={() => { void addTile("tracker"); closeRailMenu(); }}><span className="flex items-center gap-2"><Sigma size={15} /> Tracker</span></MenuItem>
              </ul>
            </ToolbarMenu>
          </RailGroup>
        )}

        {canEdit && (
          <RailGroup>
            <IconButton label={`Undo (${k("Z")})`} onClick={doUndo}><Undo2 size={16} /></IconButton>
            <IconButton label={`Redo (${k("⇧Z")})`} onClick={doRedo}><Redo2 size={16} /></IconButton>
          </RailGroup>
        )}

        {canEdit && (
          <RailGroup>
            <IconButton label="Tags & groups" onClick={() => setTagPanelOpen((o) => !o)}><Tags size={16} /></IconButton>
            <IconButton label={selectedIds.length ? `Group ${selectedIds.length} selected into a cloud` : "Select nodes to group them"} onClick={() => void groupSelection()} disabled={selectedIds.length === 0}><GroupIcon size={16} /></IconButton>
            <IconButton
              label={`Line jumps where trails cross: ${jumpStyle === "none" ? "off" : jumpStyle} (click to cycle off / arc / gap)`}
              onClick={() => setJumpStyle(jumpStyle === "none" ? "arc" : jumpStyle === "arc" ? "gap" : "none")}
              active={jumpStyle !== "none"}
            >
              <Spline size={16} />
            </IconButton>
            <IconButton label="Toggle the variable tracker ($name(value) aggregates)" onClick={toggleTracker} active={trackerOpen} pressed={trackerOpen}><Sigma size={16} /></IconButton>
          </RailGroup>
        )}

        {aiEnabled && canEdit && (
          <button onClick={openAi} aria-label="Generate a mind-map with AI" className="pointer-events-auto flex items-center justify-center rounded-control border border-primary/40 bg-primary-container p-2 font-medium text-on-primary-container shadow-elev-1 backdrop-blur transition hover:opacity-90 active:scale-[.97]" title="Generate a mind-map with AI">
            <Sparkles size={16} />
          </button>
        )}

        {/* Search popover */}
        <RailGroup>
          <ToolbarMenu
            label="Search nodes"
            open={railMenu === "search"}
            onToggle={() => toggleRailMenu("search")}
            onClose={closeRailMenu}
            highlight={!!query}
            trigger={<Search size={16} />}
            panelClassName="p-2"
          >
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                value={query}
                onChange={(e) => { setQuery(e.target.value); matchIdx.current = 0; }}
                onKeyDown={(e) => e.key === "Enter" && jumpToMatch()}
                placeholder="Search…"
                className="w-44 rounded-control border border-outline-variant bg-surface px-2 py-1 text-sm text-on-surface outline-none focus:border-primary"
              />
              {query && <span className="text-xs tabular-nums text-on-surface-variant">{matches.length}</span>}
            </div>
          </ToolbarMenu>
        </RailGroup>

        {/* Tag-filter popover */}
        <RailGroup>
          <ToolbarMenu
            label="Filter by tag"
            open={railMenu === "tagfilter"}
            onToggle={() => toggleRailMenu("tagfilter")}
            onClose={closeRailMenu}
            highlight={!!tagFilter}
            trigger={<Hash size={16} />}
            panelClassName="p-2"
          >
            <input
              autoFocus
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
              placeholder="tag filter"
              className="w-44 rounded-control border border-outline-variant bg-surface px-2 py-1 text-sm text-on-surface outline-none focus:border-primary"
            />
          </ToolbarMenu>
        </RailGroup>

        {/* More dropdown: Share · Members · History · Export */}
        <RailGroup>
          <ToolbarMenu
            label="More actions"
            align="right"
            open={railMenu === "more"}
            onToggle={() => toggleRailMenu("more")}
            onClose={closeRailMenu}
            trigger={<MoreHorizontal size={16} />}
          >
            <ul role="menu" className="py-1">
              {canEdit && (
                <li role="none">
                  <Link role="menuitem" href={`/boards/${boardId}/share`} onClick={closeRailMenu} className="block w-full px-3 py-1.5 text-left transition-colors hover:bg-surface-variant"><span className="flex items-center gap-2"><Share2 size={15} /> Share</span></Link>
                </li>
              )}
              {canManageMembers && (
                <li role="none">
                  <Link role="menuitem" href={`/boards/${boardId}/members`} onClick={closeRailMenu} className="block w-full px-3 py-1.5 text-left transition-colors hover:bg-surface-variant"><span className="flex items-center gap-2"><Users size={15} /> Members</span></Link>
                </li>
              )}
              {canEdit && (
                <li role="none">
                  <Link role="menuitem" href={`/boards/${boardId}/history`} onClick={closeRailMenu} className="block w-full px-3 py-1.5 text-left transition-colors hover:bg-surface-variant"><span className="flex items-center gap-2"><History size={15} /> History</span></Link>
                </li>
              )}
              <li role="none" className="my-1 border-t border-outline-variant" aria-hidden />
              <MenuItem onClick={() => { void exportPng(getNodes(), title); closeRailMenu(); }}><span className="flex items-center gap-2"><Download size={15} /> Export PNG</span></MenuItem>
              <MenuItem onClick={() => { void exportSvg(getNodes(), title); closeRailMenu(); }}><span className="flex items-center gap-2"><Download size={15} /> Export SVG</span></MenuItem>
              <MenuItem onClick={() => { void exportPdf(getNodes(), title); closeRailMenu(); }}><span className="flex items-center gap-2"><Download size={15} /> Export PDF</span></MenuItem>
            </ul>
          </ToolbarMenu>
        </RailGroup>

        <button onClick={() => setPaletteOpen(true)} aria-label={`Command palette (${k("K")})`} className="pointer-events-auto flex items-center gap-1 rounded-control border border-outline-variant bg-surface-container/95 px-2 py-1.5 text-xs text-on-surface-variant shadow-elev-1 backdrop-blur transition hover:text-on-surface active:scale-[.97]" title={`Command palette (${k("K")})`}>
          {isMac ? <><CommandIcon size={14} /> K</> : k("K")}
        </button>

        {/* RIGHT: moderate/stream · suggestions · collab · focused · view-only */}
        {canEdit && (
          <div className="pointer-events-auto ml-auto flex items-center gap-0.5 rounded-control border border-outline-variant bg-surface-container/95 p-0.5 shadow-elev-1 backdrop-blur" title="Moderation: review pending suggestions. Stream: clean board for broadcast (only approved show).">
            <button
              onClick={() => setStreamView(false)}
              className={`flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition active:scale-[.97] ${!streamView ? "bg-tertiary-container text-on-tertiary-container" : "text-on-surface-variant hover:bg-surface-variant"}`}
            >
              <ShieldCheck size={14} /> Moderate
            </button>
            <button
              onClick={() => { setStreamView(true); setReviewOpen(false); setRevealed(null); }}
              className={`flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition active:scale-[.97] ${streamView ? "bg-primary text-on-primary" : "text-on-surface-variant hover:bg-surface-variant"}`}
            >
              <Tv size={14} /> Stream
            </button>
          </div>
        )}
        {canEdit && !streamView && (
          <button
            onClick={() => setReviewOpen((o) => !o)}
            className={`pointer-events-auto relative flex items-center gap-1 rounded-control border px-2.5 py-1.5 text-sm shadow-elev-1 backdrop-blur transition active:scale-[.97] ${reviewOpen || pendingCount > 0 ? "border-tertiary/50 bg-tertiary-container/90 text-on-tertiary-container" : "border-outline-variant bg-surface-container/95 text-on-surface-variant hover:text-on-surface"} ${canEdit ? "" : "ml-auto"}`}
            title="Review public suggestions"
          >
            <MessageSquare size={15} /> Suggestions
            {pendingCount > 0 && (
              <span className="ml-0.5 rounded-full bg-tertiary px-1.5 text-[11px] font-semibold leading-5 text-on-tertiary">{pendingCount}</span>
            )}
          </button>
        )}
        {collabOn && (
          <div className="pointer-events-auto flex items-center gap-1.5 rounded-control border border-outline-variant bg-surface-container/95 px-2 py-1.5 shadow-elev-1 backdrop-blur" title={collabConnected ? "Live · realtime collaboration on" : "Connecting…"}>
            <span className={`h-2 w-2 rounded-full ${collabConnected ? "bg-green-500" : "bg-outline animate-pulse"}`} />
            {peers.length > 0 ? (
              <div className="flex -space-x-1.5">
                {peers.slice(0, 5).map((p) => (
                  <span key={p.clientId} title={p.name} className="flex h-5 w-5 items-center justify-center rounded-full border border-surface-container text-[10px] font-medium text-white" style={{ background: p.color }}>
                    {p.name.slice(0, 1).toUpperCase()}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-[11px] text-on-surface-variant">only you</span>
            )}
          </div>
        )}
        {focusedId && (
          <button onClick={() => setFocusedId(null)} className="pointer-events-auto rounded-control border border-primary/40 bg-primary-container px-2 py-1 text-xs font-medium text-on-primary-container shadow-elev-1 backdrop-blur transition hover:opacity-90 active:scale-[.97]">
            Focused · Esc to exit
          </button>
        )}
        {!canEdit && (
          <div className="pointer-events-auto ml-auto rounded-control border border-tertiary/40 bg-tertiary-container/90 px-2 py-1 text-xs font-medium text-on-tertiary-container shadow-elev-1 backdrop-blur">View only</div>
        )}
      </div>

      {menu && canEdit && (
        <ul role="menu" className="gb-pop-in absolute z-20 min-w-44 overflow-hidden rounded-panel border border-outline-variant bg-surface-container py-1 text-sm text-on-surface shadow-elev-3" style={{ left: menu.x, top: menu.y }} onMouseLeave={() => setMenu(null)}>
          {menu.nodeId ? (
            <>
              {menuTree?.hasChildren && (
                <MenuItem onClick={() => { setCollapsedFor(menu.nodeId!, !menuTree.collapsed); setMenu(null); }}>
                  {menuTree.collapsed ? "Expand branch" : "Collapse branch"}
                </MenuItem>
              )}
              <MenuItem onClick={() => { focusBranch(menu.nodeId!); setMenu(null); }}>Focus branch</MenuItem>
              <MenuItem onClick={() => { openTagPopover(branchIds(menu.nodeId!)); setMenu(null); }}>Tag branch…</MenuItem>
              {selectedIds.length > 1 && <MenuItem onClick={() => { openTagPopover(selectedIds); setMenu(null); }}>Tag selection ({selectedIds.length})…</MenuItem>}
              {menuTree?.parentId && <MenuItem onClick={() => { detachNode(menu.nodeId!); setMenu(null); }}>Detach from parent</MenuItem>}
              {selectedNode && selectedNode.id !== menu.nodeId && <MenuItem onClick={() => { attachToSelected(menu.nodeId!); setMenu(null); }}>Make child of selected node</MenuItem>}
              {aiEnabled && <MenuItem onClick={() => { void runExpandNode(menu.nodeId!); setMenu(null); }}>✨ Expand with AI</MenuItem>}
              {aiEnabled && <MenuItem onClick={() => { void runSummarize(menu.nodeId!); setMenu(null); }}>✨ Summarize branch</MenuItem>}
              <MenuItem onClick={() => { void duplicateNodes([menu.nodeId!]); setMenu(null); }}>Duplicate</MenuItem>
              <MenuItem onClick={() => { zOrder(menu.nodeId!, true); setMenu(null); }}>Bring to front</MenuItem>
              <MenuItem onClick={() => { zOrder(menu.nodeId!, false); setMenu(null); }}>Send to back</MenuItem>
              <MenuItem danger onClick={() => { deleteNode(menu.nodeId!); setMenu(null); }}>Delete</MenuItem>
            </>
          ) : (
            <>
              <li role="none" className="px-3 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-on-surface-variant">Create here</li>
              <MenuItem onClick={() => { void addTile("text", { x: menu.flowX, y: menu.flowY }); setMenu(null); }}><span className="flex items-center gap-2"><Type size={15} /> Text</span></MenuItem>
              <MenuItem onClick={() => { void addTile("swatch", { x: menu.flowX, y: menu.flowY }); setMenu(null); }}><span className="flex items-center gap-2"><Palette size={15} /> Swatch</span></MenuItem>
              <MenuItem onClick={() => { openImagePicker({ x: menu.flowX, y: menu.flowY }); setMenu(null); }}><span className="flex items-center gap-2"><ImageIcon size={15} /> Image</span></MenuItem>
              <MenuItem onClick={() => { openLinkPopover({ x: menu.flowX, y: menu.flowY }); setMenu(null); }}><span className="flex items-center gap-2"><Link2 size={15} /> Link</span></MenuItem>
              <MenuItem onClick={() => { void addTile("spreadsheet", { x: menu.flowX, y: menu.flowY }); setMenu(null); }}><span className="flex items-center gap-2"><Table2 size={15} /> Spreadsheet</span></MenuItem>
              <MenuItem onClick={() => { void addTile("tracker", { x: menu.flowX, y: menu.flowY }); setMenu(null); }}><span className="flex items-center gap-2"><Sigma size={15} /> Tracker</span></MenuItem>
            </>
          )}
        </ul>
      )}

      {canEdit && <Inspector boardId={boardId} node={selectedNode} edge={selectedEdge} />}

      {aiEnabled && aiBusy && !aiOpen && (
        <div role="status" aria-live="polite" className="gb-fade-in pointer-events-none absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-control border border-primary/40 bg-primary-container px-3 py-1.5 text-sm font-medium text-on-primary-container shadow-elev-2">
          <Loader2 size={15} className="animate-spin" /> AI working…
        </div>
      )}

      {canEdit && linkOpen && (
        <div className="absolute left-1/2 top-20 z-30 -translate-x-1/2">
          <div className="gb-pop-in w-[min(92vw,420px)] rounded-panel border border-outline-variant bg-surface-container p-3 shadow-elev-3">
            <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-on-surface">
              <Link2 size={16} className="text-on-surface-variant" /> Add link
            </div>
            <input
              autoFocus
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitLink();
                if (e.key === "Escape") setLinkOpen(false);
              }}
              placeholder="Paste a link URL…"
              className="mb-2 w-full rounded-control border border-outline-variant bg-surface px-2.5 py-1.5 text-sm text-on-surface outline-none focus-visible:border-primary"
            />
            <input
              value={linkImg}
              onChange={(e) => setLinkImg(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitLink();
                if (e.key === "Escape") setLinkOpen(false);
              }}
              placeholder="Image URL (optional — overrides the preview)"
              className="mb-3 w-full rounded-control border border-outline-variant bg-surface px-2.5 py-1.5 text-sm text-on-surface outline-none focus-visible:border-primary"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-on-surface-variant">Auto-fetches a preview; image overrides it.</span>
              <div className="flex gap-2">
                <button onClick={() => setLinkOpen(false)} className="rounded-control px-3 py-1.5 text-sm text-on-surface-variant transition hover:bg-surface-variant active:scale-[.97]">Cancel</button>
                <button onClick={submitLink} className="rounded-control bg-primary px-3 py-1.5 text-sm font-medium text-on-primary transition hover:opacity-90 active:scale-[.97]">Add</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {canEdit && aiEnabled && aiOpen && (
        <div className="absolute left-1/2 top-20 z-30 -translate-x-1/2">
          <div className="gb-pop-in w-[min(92vw,440px)] rounded-panel border border-outline-variant bg-surface-container p-3 shadow-elev-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-on-surface">
              <Sparkles size={16} className="text-primary" /> Generate a mind-map
            </div>
            <textarea
              autoFocus
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void runGenerateMap();
                if (e.key === "Escape") setAiOpen(false);
              }}
              rows={2}
              placeholder="e.g. A launch plan for an indie mobile game"
              className="mb-2 w-full resize-none rounded-control border border-outline-variant bg-surface px-2.5 py-2 text-sm text-on-surface outline-none focus-visible:border-primary"
            />
            {aiError && <p className="mb-2 text-xs text-error">{aiError}</p>}
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-on-surface-variant">Inserts a linked tree. {k("↵")} to run.</span>
              <div className="flex gap-2">
                <button onClick={() => setAiOpen(false)} className="rounded-control px-3 py-1.5 text-sm text-on-surface-variant transition hover:bg-surface-variant active:scale-[.97]">Cancel</button>
                <button
                  onClick={() => void runGenerateMap()}
                  disabled={aiBusy || !aiPrompt.trim()}
                  className="flex items-center gap-1.5 rounded-control bg-primary px-3 py-1.5 text-sm font-medium text-on-primary transition hover:opacity-90 active:scale-[.97] disabled:opacity-50"
                >
                  {aiBusy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                  {aiBusy ? "Generating…" : "Generate"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {canEdit && tagOpen && (
        <div className="absolute left-1/2 top-20 z-30 -translate-x-1/2">
          <div className="gb-pop-in flex items-center gap-2 rounded-panel border border-outline-variant bg-surface-container p-2 shadow-elev-3">
            <Tags size={16} className="ml-1 text-on-surface-variant" />
            <input
              autoFocus
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitTags();
                if (e.key === "Escape") setTagOpen(false);
              }}
              list="gb-known-tags"
              placeholder="tags, comma, separated"
              className="w-64 rounded-control bg-surface px-2.5 py-1.5 text-sm text-on-surface outline-none focus-visible:border-primary"
            />
            <datalist id="gb-known-tags">
              {tagCounts.map((t) => <option key={t.tag} value={t.tag} />)}
            </datalist>
            <button onClick={submitTags} className="rounded-control bg-primary px-3 py-1.5 text-sm font-medium text-on-primary transition hover:opacity-90 active:scale-[.97]">
              Tag {tagTargetIds.current.length}
            </button>
            <button onClick={() => setTagOpen(false)} aria-label="Cancel" className="rounded-control px-2 py-1.5 text-sm text-on-surface-variant transition hover:bg-surface-variant active:scale-[.97]">✕</button>
          </div>
        </div>
      )}

      {canEdit && tagPanelOpen && (
        <TagPanel
          tags={tagCounts}
          groups={groups}
          activeTag={tagFilter}
          selectionCount={selectedIds.length}
          onSelectTag={selectTag}
          onClearTag={() => setTagFilter("")}
          onClose={() => setTagPanelOpen(false)}
          onCreateGroup={() => void groupSelection()}
          onTagSelection={() => openTagPopover(selectedIds)}
          onUpdateGroup={(id, patch) => void patchGroup(id, patch)}
          onDeleteGroup={(id) => void removeGroup(id)}
          onAddSelectionToGroup={addSelectionToGroup}
          onFocusGroup={focusGroup}
        />
      )}

      {canEdit && reviewOpen && !streamView && (
        <SuggestionsReviewPanel
          suggestions={suggestions}
          onAccept={acceptGhost}
          onDiscard={discardGhost}
          onLocate={locateGhost}
          onClose={() => setReviewOpen(false)}
        />
      )}

      {canEdit && <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} groups={paletteGroups} />}

      {trackerOpen && <TrackerHud onClose={toggleTracker} boardId={boardId} />}

      {canEdit && <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={onPickImage} />}
    </div>
    </VariablesProvider>
  );
}

// Global tracker HUD: a toggleable panel pinned to the bottom-left screen corner (fixed, NOT a
// ViewportPortal — it stays put as you pan/zoom) auto-listing every board variable with its
// Sum / Avg / Count / Min / Max. Reads the live registry via useVariables() (must render inside the
// VariablesProvider). Empty state hints how to define a variable.
const hudFmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1e6) / 1e6));
// Board-global variable HUD. Like the tracker NODE it shows custom template lines ("Price: $sum(cost)" →
// "Price: $60") when you add any, and auto-lists every variable's aggregates otherwise. Lines are board-UI
// (not graph data), so they persist in localStorage per board. Positioned left-16 to clear the zoom controls.
function TrackerHud({ onClose, boardId }: { onClose: () => void; boardId: string }) {
  const { vars, names } = useVariables();
  const linesKey = `gb-tracker-hud-lines:${boardId}`;
  const [lines, setLines] = useState<string[]>([]);
  const [editingLine, setEditingLine] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    try { const raw = localStorage.getItem(linesKey); if (raw) setLines(JSON.parse(raw) as string[]); } catch { /* no storage */ }
  }, [linesKey]);
  const saveLines = useCallback((next: string[]) => {
    setLines(next);
    try { localStorage.setItem(linesKey, JSON.stringify(next)); } catch { /* no storage */ }
  }, [linesKey]);

  const rows = useMemo(() => names.map((name) => ({ name, agg: aggregate(vars[name] ?? []) })), [names, vars]);
  const computed = useMemo(() => lines.map((tpl) => ({ tpl, text: renderTrackerLine(tpl, vars) })), [lines, vars]);

  const addLine = () => { const next = [...lines, ""]; saveLines(next); setDraft(""); setEditingLine(next.length - 1); };
  const removeLine = (i: number) => saveLines(lines.filter((_, j) => j !== i));
  const commitLine = (i: number) => {
    setEditingLine(null);
    if (draft === (lines[i] ?? "")) return;
    if (draft.trim() === "") removeLine(i);
    else { const next = lines.slice(); next[i] = draft; saveLines(next); }
  };
  const beginEdit = (i: number) => { setDraft(lines[i] ?? ""); setEditingLine(i); };

  return (
    <div className="gb-pop-in fixed bottom-4 left-16 z-40 flex max-h-[60vh] w-72 flex-col rounded-panel border border-outline-variant bg-surface-container/95 text-on-surface shadow-elev-3 backdrop-blur">
      <div className="flex items-center justify-between border-b border-outline-variant px-3 py-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold"><Sigma size={14} /> Variables</h2>
        <button onClick={onClose} aria-label="Hide tracker" className="rounded p-0.5 text-on-surface-variant transition hover:bg-surface-variant"><X size={15} /></button>
      </div>
      <div className="overflow-y-auto p-1.5">
        {lines.length > 0 ? (
          <ul className="space-y-0.5 px-1 py-0.5">
            {computed.map(({ tpl, text }, i) => (
              <li key={i} className="group/line flex items-center gap-1 text-xs">
                {editingLine === i ? (
                  <input
                    autoFocus
                    className="w-full rounded bg-primary/5 px-1 py-0.5 text-xs text-on-surface outline-none"
                    value={draft}
                    spellCheck={false}
                    placeholder="Price: $sum(cost)"
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => commitLine(i)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); commitLine(i); }
                      else if (e.key === "Escape") { e.preventDefault(); setEditingLine(null); }
                    }}
                  />
                ) : (
                  <>
                    <span className="min-w-0 flex-1 cursor-text truncate font-medium text-on-surface" onDoubleClick={() => beginEdit(i)} title={`${tpl} — double-click to edit`}>
                      {text || "(empty — double-click)"}
                    </span>
                    <button onClick={() => removeLine(i)} aria-label="Remove line" className="shrink-0 rounded p-0.5 text-on-surface-variant opacity-0 transition hover:bg-error-container hover:text-on-error-container group-hover/line:opacity-100"><X size={11} /></button>
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : rows.length === 0 ? (
          <p className="px-2 py-3 text-xs leading-snug text-on-surface-variant">
            No variables yet. Type <code className="rounded bg-surface px-1">$name(value)</code> in a note or spreadsheet cell
            (e.g. <code className="rounded bg-surface px-1">$cost(30)</code>), then add a line like <code className="rounded bg-surface px-1">Price: $sum(cost)</code> below.
          </p>
        ) : (
          <table className="w-full border-collapse text-xs tabular-nums">
            <thead>
              <tr className="text-on-surface-variant">
                <th className="px-1.5 py-1 text-left font-medium">name</th>
                <th className="px-1 py-1 text-right font-medium" title="Sum">Σ</th>
                <th className="px-1 py-1 text-right font-medium" title="Average">x̄</th>
                <th className="px-1 py-1 text-right font-medium" title="Count">n</th>
                <th className="px-1 py-1 text-right font-medium" title="Min">min</th>
                <th className="px-1 py-1 text-right font-medium" title="Max">max</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ name, agg }) => (
                <tr key={name} className="border-t border-outline-variant/50">
                  <td className="px-1.5 py-1 text-left font-medium text-on-surface">${name}</td>
                  <td className="px-1 py-1 text-right">{hudFmt(agg.sum)}</td>
                  <td className="px-1 py-1 text-right">{hudFmt(agg.avg)}</td>
                  <td className="px-1 py-1 text-right text-on-surface-variant">{agg.count}</td>
                  <td className="px-1 py-1 text-right text-on-surface-variant">{hudFmt(agg.min)}</td>
                  <td className="px-1 py-1 text-right text-on-surface-variant">{hudFmt(agg.max)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <button onClick={addLine} className="mt-1 flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-on-surface-variant transition hover:bg-surface-variant active:scale-[.98]" title="Add a custom expression line">
          <Plus size={11} /> line
        </button>
      </div>
    </div>
  );
}

// draw.io-style alignment guides: thin 1px lines at the matched x (vertical) / y (horizontal) the
// dragged node has snapped to. Rendered in flow coordinates via ViewportPortal so they track pan/zoom;
// each line spans a huge extent so it reads as edge-to-edge across the visible canvas.
const GUIDE_EXTENT = 100000;
function AlignmentGuides({ vertical, horizontal }: { vertical?: number; horizontal?: number }) {
  return (
    <ViewportPortal>
      {vertical != null && (
        <div
          className="pointer-events-none absolute"
          style={{
            transform: `translate(${vertical}px, ${-GUIDE_EXTENT}px)`,
            width: 1,
            height: GUIDE_EXTENT * 2,
            background: "var(--md-sys-color-primary)",
            zIndex: 1500,
          }}
        />
      )}
      {horizontal != null && (
        <div
          className="pointer-events-none absolute"
          style={{
            transform: `translate(${-GUIDE_EXTENT}px, ${horizontal}px)`,
            width: GUIDE_EXTENT * 2,
            height: 1,
            background: "var(--md-sys-color-primary)",
            zIndex: 1500,
          }}
        />
      )}
    </ViewportPortal>
  );
}

// Hover connect-arrows: four directional buttons just outside a hovered node; click one to spawn a
// connected node in that direction. Rendered in flow coordinates via ViewportPortal.
function ConnectArrows({
  node,
  onSpawn,
  spawnKind,
  onPickKind,
  onEnter,
  onLeave,
}: {
  node: Node;
  onSpawn: (node: Node, dir: "top" | "right" | "bottom" | "left") => void;
  spawnKind: SpawnKind;
  onPickKind: (kind: SpawnKind) => void;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const { w, h } = nodeSize(node);
  const { x, y } = node.position;
  const OFF = 18;
  // Follow a tilted node: rotate each arrow's position around the node center, and spin the glyph by the
  // same angle so e.g. the "right" arrow points down-right when the node is turned 45°.
  const rot = Number((node.data as { rotation?: number }).rotation ?? 0) || 0;
  const ccx = x + w / 2, ccy = y + h / 2;
  const rad = (rot * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const spin = (px: number, py: number) => rot
    ? { x: ccx + (px - ccx) * cos - (py - ccy) * sin, y: ccy + (px - ccx) * sin + (py - ccy) * cos }
    : { x: px, y: py };
  type Dir = "top" | "right" | "bottom" | "left";
  const arrows: { dir: Dir; cx: number; cy: number; Icon: typeof ArrowUp }[] = (
    [
      { dir: "top", px: x + w / 2, py: y - OFF, Icon: ArrowUp },
      { dir: "right", px: x + w + OFF, py: y + h / 2, Icon: ArrowRight },
      { dir: "bottom", px: x + w / 2, py: y + h + OFF, Icon: ArrowDown },
      { dir: "left", px: x - OFF, py: y + h / 2, Icon: ArrowLeft },
    ] as const
  ).map((a) => { const p = spin(a.px, a.py); return { dir: a.dir, cx: p.x, cy: p.y, Icon: a.Icon }; });
  // The type strip is NOT shown by default (that read as "change this node's type"). It appears only
  // while an arrow (or the strip itself) is hovered, anchored just BEYOND that arrow — clearly a
  // "what will I create here" chooser tied to the spawn direction, never floating over the node.
  const [openDir, setOpenDir] = useState<Dir | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  const arm = (dir: Dir) => { if (closeTimer.current) clearTimeout(closeTimer.current); setOpenDir(dir); onEnter(); };
  const disarmSoon = () => {
    onLeave();
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpenDir(null), 220); // grace to cross arrow ↔ strip
  };
  // Strip anchor + transform per direction (just outside the hovered arrow, pointing away from the node).
  const stripBase = openDir && ({
    top: { ax: x + w / 2, ay: y - OFF - 12, t: "translate(-50%, -100%)" },
    bottom: { ax: x + w / 2, ay: y + h + OFF + 12, t: "translate(-50%, 0%)" },
    right: { ax: x + w + OFF + 12, ay: y + h / 2, t: "translate(0%, -50%)" },
    left: { ax: x - OFF - 12, ay: y + h / 2, t: "translate(-100%, -50%)" },
  } as const)[openDir];
  const strip = stripBase ? { t: stripBase.t, ...spin(stripBase.ax, stripBase.ay) } : null;
  return (
    <ViewportPortal>
      {arrows.map((a) => (
        <button
          key={a.dir}
          onMouseEnter={() => arm(a.dir)}
          onMouseLeave={disarmSoon}
          // Spawn on pointerDOWN, not click: inside React Flow's ViewportPortal the pane's pointer
          // handling + the hover-hide can swallow a click (mousedown→mouseup), so the click "did
          // nothing". stopPropagation keeps the pane from treating it as a pan/drag. A bare arrow click
          // quick-spawns the last-used type; the strip lets you pick a different one for THIS spawn.
          onPointerDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onSpawn(node, a.dir);
          }}
          title={`Add a connected ${spawnKind} node ${a.dir} — hover to pick a type`}
          className="nodrag nopan pointer-events-auto absolute z-50 flex h-5 w-5 items-center justify-center rounded-full border border-primary/40 bg-surface-container text-primary shadow-elev-1 transition hover:bg-primary hover:text-on-primary active:scale-90"
          style={{ transform: `translate(-50%, -50%) translate(${a.cx}px, ${a.cy}px) rotate(${rot}deg)` }}
        >
          <a.Icon size={13} />
        </button>
      ))}
      {strip && openDir && (
        <div
          onMouseEnter={() => arm(openDir)}
          onMouseLeave={disarmSoon}
          className="nodrag nopan pointer-events-auto gb-pop-in absolute z-50 flex items-center gap-0.5 rounded-control border border-outline-variant bg-surface-container p-0.5 shadow-elev-2"
          style={{ transform: `${strip.t} translate(${strip.x}px, ${strip.y}px) rotate(${rot}deg)` }}
        >
          {SPAWN_KINDS.map((k) => (
            <button
              key={k.kind}
              // Click a type → set it as the default AND spawn it in the hovered direction (one click).
              onPointerDown={(e) => { e.stopPropagation(); onPickKind(k.kind); onSpawn(node, openDir); }}
              title={`Create a ${k.label} node ${openDir}`}
              className={`nodrag nopan pointer-events-auto flex h-5 w-5 items-center justify-center rounded-control transition ${spawnKind === k.kind ? "bg-primary text-on-primary" : "text-on-surface-variant hover:bg-surface-variant"}`}
            >
              <k.Icon size={13} />
            </button>
          ))}
        </div>
      )}
    </ViewportPortal>
  );
}

// Accept/Discard popover for a revealed suggestion ghost. Rendered in flow coordinates (ViewportPortal)
// just above the ghost node, so it tracks pan/zoom like the connect-arrows do.
function SuggestionReveal({
  authorName,
  node,
  tally,
  onAccept,
  onDiscard,
  onKeepOpen,
  onLeave,
}: {
  authorName: string | null;
  node: { tempId: string; type: string; x: number; y: number; width?: number | null };
  tally?: { up: number; down: number };
  onAccept: () => void;
  onDiscard: () => void;
  onKeepOpen: () => void;
  onLeave: () => void;
}) {
  // Center the popover over the node: match each type's rendered width (LinkNode is a fixed 260px card,
  // swatches default 120, text ~180) so it sits centered for swatches and links too.
  const w = typeof node.width === "number" ? node.width : node.type === "swatch" ? 120 : node.type === "link" ? 260 : 180;
  return (
    <ViewportPortal>
      <div
        className="nodrag nopan gb-pop-in pointer-events-auto absolute flex items-center gap-1.5 rounded-control border border-tertiary/50 bg-surface-container px-2 py-1.5 shadow-elev-3"
        style={{ transform: `translate(-50%, -100%) translate(${node.x + w / 2}px, ${node.y - 10}px)` }}
        onMouseEnter={onKeepOpen}
        onMouseLeave={onLeave}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="max-w-32 truncate text-[11px] text-on-surface-variant" title={`Suggested by ${authorName ?? "anonymous"}`}>
          {authorName ?? "anonymous"}
        </span>
        {tally && (tally.up > 0 || tally.down > 0) && (
          <span className="flex items-center gap-0.5 text-[11px] tabular-nums text-on-surface-variant" title="Community votes">
            <ArrowUp size={11} className="text-primary" />{tally.up}
            <ArrowDown size={11} className="ml-1 text-error" />{tally.down}
          </span>
        )}
        <button
          onClick={onAccept}
          className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-xs font-medium text-on-primary transition hover:opacity-90 active:scale-[.97]"
          title="Adopt this item into the board (keeps credit)"
        >
          <Check size={13} /> Accept
        </button>
        <button
          onClick={onDiscard}
          className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-error transition hover:bg-error-container hover:text-on-error-container active:scale-[.97]"
          title="Discard this suggestion"
        >
          <Trash2 size={13} />
        </button>
      </div>
    </ViewportPortal>
  );
}

// Always-available review surface: lists every pending suggestion item with Accept/Discard + a "locate"
// jump (a ghost can sit anywhere on the canvas, so the owner needs a list, not just on-canvas hovering).
function SuggestionsReviewPanel({
  suggestions,
  onAccept,
  onDiscard,
  onLocate,
  onClose,
}: {
  suggestions: SuggestionDTO[];
  onAccept: (sugId: string, tempId: string) => void;
  onDiscard: (sugId: string, tempId: string) => void;
  onLocate: (sugId: string, tempId: string, x: number, y: number) => void;
  onClose: () => void;
}) {
  const items: Array<{ sugId: string; author: string | null; node: SuggestionDTO["payload"]["nodes"][number]; tally?: { up: number; down: number } }> = [];
  for (const s of suggestions) for (const n of (s.payload?.nodes ?? [])) items.push({ sugId: s.id, author: s.authorName, node: n, tally: s.votes?.[n.tempId] });

  return (
    <div className="gb-pop-in absolute right-4 top-16 z-30 flex max-h-[72vh] w-80 flex-col rounded-panel border border-outline-variant bg-surface-container text-on-surface shadow-elev-3">
      <div className="flex items-center justify-between border-b border-outline-variant p-3">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold"><MessageSquare size={15} /> Public suggestions ({items.length})</h2>
        <button onClick={onClose} aria-label="Close" className="rounded p-0.5 text-on-surface-variant transition hover:bg-surface-variant"><X size={15} /></button>
      </div>
      {items.length === 0 ? (
        <p className="p-6 text-center text-sm text-on-surface-variant">No pending suggestions yet. Public additions appear here (and as hazy ghosts on the board) for you to accept or discard.</p>
      ) : (
        <ul className="flex-1 space-y-1.5 overflow-y-auto p-2">
          {items.map((it) => (
            <li key={`${it.sugId}:${it.node.tempId}`} className="rounded-control border border-outline-variant bg-surface p-2">
              <button onClick={() => onLocate(it.sugId, it.node.tempId, it.node.x, it.node.y)} className="block w-full text-left" title="Jump to it on the board">
                <GhostSnippet node={it.node} />
                <div className="mt-0.5 truncate text-[11px] text-on-surface-variant">
                  — {it.author ?? "anonymous"}
                  {it.tally && (it.tally.up || it.tally.down) ? ` · ▲${it.tally.up} ▼${it.tally.down}` : ""}
                </div>
              </button>
              <div className="mt-1.5 flex items-center gap-1.5">
                <button onClick={() => onAccept(it.sugId, it.node.tempId)} className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-xs font-medium text-on-primary transition hover:opacity-90 active:scale-[.97]">
                  <Check size={12} /> Accept
                </button>
                <button onClick={() => onDiscard(it.sugId, it.node.tempId)} className="flex items-center gap-1 rounded px-2 py-1 text-xs text-error transition hover:bg-error-container hover:text-on-error-container active:scale-[.97]">
                  <Trash2 size={12} /> Discard
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function GhostSnippet({ node }: { node: SuggestionDTO["payload"]["nodes"][number] }) {
  if (node.type === "swatch") {
    const hex = String((node.data as { hex?: string })?.hex ?? "#888888");
    return (
      <span className="flex items-center gap-1.5 text-sm text-on-surface">
        <span className="inline-block h-3 w-3 shrink-0 rounded-sm border border-outline-variant" style={{ background: hex }} /> {hex}
      </span>
    );
  }
  if (node.type === "link") return <span className="block truncate text-sm text-on-surface">{String((node.data as { url?: string })?.url ?? "link")}</span>;
  return <span className="block truncate text-sm text-on-surface">{String((node.data as { text?: string })?.text ?? "") || "(empty note)"}</span>;
}

// ── compact icon-rail toolbar helpers ───────────────────────────────────────
// Shared single-open coordinator: only one dropdown/popover open at a time, closes on Escape / outside-click.
type ToolbarMenuKey = "add" | "more" | "search" | "tagfilter" | null;

// An icon-only control. Always carries BOTH title + aria-label (labels are otherwise hidden in the rail).
function IconButton({
  label,
  onClick,
  active,
  disabled,
  pressed,
  children,
}: {
  label: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      className={`flex items-center justify-center rounded p-1.5 transition active:scale-[.97] disabled:opacity-40 ${active ? "text-primary" : "text-on-surface hover:bg-surface-variant"}`}
    >
      {children}
    </button>
  );
}

// A bordered, backdrop-blurred pill that groups one or more IconButtons (matches the existing rail vocabulary).
function RailGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-auto flex items-center gap-0.5 rounded-control border border-outline-variant bg-surface-container/95 p-1 shadow-elev-1 backdrop-blur">
      {children}
    </div>
  );
}

// A trigger IconButton + an absolutely-positioned panel (reuses the context-menu styling). Caller owns open state.
function ToolbarMenu({
  label,
  open,
  onToggle,
  onClose,
  highlight,
  align = "left",
  trigger,
  children,
  panelClassName,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  highlight?: boolean;
  align?: "left" | "right";
  trigger: React.ReactNode;
  children: React.ReactNode;
  panelClassName?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number } | null>(null);

  // Measure the trigger and render the panel in a PORTAL to <body> at a FIXED position. The toolbar pills
  // use backdrop-blur, which creates a stacking context AND (on mobile) an overflow clip — a child panel
  // can't escape either with z-index alone, so it gets cut off. Portaling to <body> sidesteps both.
  useEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      setPos(
        align === "right"
          ? { top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) }
          : { top: r.bottom + 4, left: Math.max(8, r.left) },
      );
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!(e.target instanceof globalThis.Node)) return;
      // Stay open for clicks on the trigger OR the portaled panel (the panel lives outside `ref` now).
      if (!ref.current?.contains(e.target) && !panelRef.current?.contains(e.target)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={onToggle}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex items-center justify-center rounded p-1.5 transition active:scale-[.97] ${open || highlight ? "text-primary" : "text-on-surface hover:bg-surface-variant"}`}
      >
        {trigger}
      </button>
      {open && pos && typeof document !== "undefined" &&
        createPortal(
          <div
            ref={panelRef}
            style={{ position: "fixed", top: pos.top, left: pos.left, right: pos.right }}
            className={`gb-pop-in z-[70] rounded-panel border border-outline-variant bg-surface-container text-sm text-on-surface shadow-elev-3 ${panelClassName ?? "min-w-44 overflow-hidden py-1"}`}
          >
            {children}
          </div>,
          document.body,
        )}
    </div>
  );
}

function MenuItem({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <li role="none">
      <button
        role="menuitem"
        onClick={onClick}
        className={`block w-full px-3 py-1.5 text-left transition-colors hover:bg-surface-variant active:scale-[.99] ${danger ? "text-error hover:bg-error-container hover:text-on-error-container" : ""}`}
      >
        {children}
      </button>
    </li>
  );
}

function SaveBadge({ status }: { status: SaveStatus }) {
  if (status === "idle") return null;
  const label = status === "saving" ? "Saving…" : status === "saved" ? "Saved" : "Save failed";
  const cls =
    status === "error"
      ? "border-error/40 bg-error-container/90 text-on-error-container"
      : "border-outline-variant bg-surface-container/95 text-on-surface-variant";
  return (
    <div
      role="status"
      aria-live="polite"
      className={`gb-fade-in pointer-events-none flex items-center gap-1 rounded-control border ${cls} px-2 py-1 text-xs shadow-elev-1 backdrop-blur`}
    >
      {status === "saved" && <Check size={13} className="text-primary" />}
      {label}
    </div>
  );
}

export default function BoardCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
