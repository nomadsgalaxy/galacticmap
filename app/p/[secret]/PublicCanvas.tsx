"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  ConnectionMode,
  useReactFlow,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type Connection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { X, Plus, Type, Palette, Link2, Trash2, Check, Loader2, ThumbsUp, ThumbsDown, Users } from "lucide-react";
import type { ShareSnapshot } from "@/app/lib/public-db";
import { TextNode } from "@/app/(editor)/boards/[id]/_components/nodes/TextNode";
import { SwatchNode } from "@/app/(editor)/boards/[id]/_components/nodes/SwatchNode";
import { ImageNode } from "@/app/(editor)/boards/[id]/_components/nodes/ImageNode";
import { LinkNode } from "@/app/(editor)/boards/[id]/_components/nodes/LinkNode";
import { SpreadsheetNode } from "@/app/(editor)/boards/[id]/_components/nodes/SpreadsheetNode";
import { TrackerNode } from "@/app/(editor)/boards/[id]/_components/nodes/TrackerNode";
import { CloudNode } from "@/app/(editor)/boards/[id]/_components/nodes/CloudNode";
import { VariablesProvider } from "@/app/(editor)/boards/[id]/_components/VariablesContext";
import { AnimatedEdge } from "@/app/(editor)/boards/[id]/_components/edges/AnimatedEdge";
import { toRFEdge } from "@/app/(editor)/boards/[id]/_components/edges/rfMap";
import { useColorMode } from "@/app/_components/useColorMode";

// The public view reuses the editor's node + edge components (read-only) so the live board renders
// identically. When suggestions are open, guests get the same node tools, and their additions are
// persisted LIVE (no "Submit") as a pending suggestion that appears as a ghost on the owner's board.
// Guests keep editing/moving their items until a moderator accepts or discards them.
const nodeTypes = { text: TextNode, swatch: SwatchNode, image: ImageNode, link: LinkNode, spreadsheet: SpreadsheetNode, tracker: TrackerNode, cloud: CloudNode };
const CLOUD_PAD = 28; // matches the editor's cloud padding so public group regions look identical
const edgeTypes = { animated: AnimatedEdge };

const POLL_MS = 3000; // fallback poll cadence when the live SSE stream is unavailable
const PERSIST_MS = 500; // debounce before pushing the working set to the server

type Tool = "text" | "swatch" | "link";
type PNode = { id: string; type: Tool; x: number; y: number; width?: number; height?: number; data: Record<string, unknown> };
type PEdge = { id: string; source: string; target: string };
type SaveState = "idle" | "saving" | "saved" | "error";
// A pending suggestion from anyone (public-safe projection + per-item vote tallies).
type CSuggestionNode = { tempId: string; type: string; x: number; y: number; width?: number | null; height?: number | null; data: Record<string, unknown> };
type CSuggestion = { id: string; authorName: string | null; nodes: CSuggestionNode[]; edges: { source: string; target: string }[]; votes: Record<string, { up: number; down: number }> };

export function PublicCanvas({ secret, snapshot, embed = false }: { secret: string; snapshot: ShareSnapshot; embed?: boolean }) {
  return (
    <div className="relative h-[100dvh] w-full">
      <ReactFlowProvider>
        <PublicBoard secret={secret} snapshot={snapshot} embed={embed} />
      </ReactFlowProvider>
    </div>
  );
}

// `embed` = read-only showcase mode for <iframe> embedding: no suggestion/voting UI, trimmed chrome.
function PublicBoard({ secret, snapshot, embed }: { secret: string; snapshot: ShareSnapshot; embed: boolean }) {
  const rf = useReactFlow();
  const colorMode = useColorMode();
  const [graph, setGraph] = useState<ShareSnapshot>(snapshot);
  const [proposed, setProposed] = useState<{ nodes: PNode[]; edges: PEdge[] }>({ nodes: [], edges: [] });
  const [name, setName] = useState("");
  const [save, setSave] = useState<SaveState>("idle");
  // Everyone's pending suggestions (mine + others), with vote tallies. Others render as read-only ghosts.
  const [allSuggestions, setAllSuggestions] = useState<CSuggestion[]>([]);
  const [ownId, setOwnId] = useState<string | null>(null);
  const [myVotes, setMyVotes] = useState<Record<string, number>>({}); // "sugId:tempId" -> 1|-1
  const tmp = useRef(0);
  const suggesting = !embed && graph.suggestionsOpen; // embeds are view-only — never recommend additions

  // Anonymous author identity: an opaque token (per share) that gates editing this author's own pending
  // suggestion. Stored client-side only; the server keeps just its hash. Clearing storage = a fresh row.
  const authorToken = useRef<string>("");
  const suggestionId = useRef<string | null>(null);
  useEffect(() => {
    try {
      const key = `gb-suggest-token:${secret}`;
      let t = localStorage.getItem(key);
      if (!t) {
        t = crypto.randomUUID();
        localStorage.setItem(key, t);
      }
      authorToken.current = t;
    } catch {
      authorToken.current = `t_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    }
  }, [secret]);

  // Reconcile the ghost layer with the server's current PENDING set (self-heals after accept/discard,
  // even if an incremental frame was missed).
  const loadSuggestions = useCallback(async () => {
    if (embed) return; // embeds never fetch/show suggestions
    try {
      const res = await fetch(`/api/p/${secret}/suggestions`, { cache: "no-store" });
      if (!res.ok) return;
      const j = (await res.json()) as { suggestions?: CSuggestion[] };
      setAllSuggestions(j.suggestions ?? []);
    } catch {
      /* keep last good */
    }
  }, [secret, embed]);

  // ── Live updates (SSE; poll fallback) ──
  const lastJson = useRef<string>("");
  const refreshRef = useRef<() => void>(() => {});
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const res = await fetch(`/api/p/${secret}/graph`, { cache: "no-store" });
        if (!res.ok || !active) return;
        const text = await res.text();
        if (text !== lastJson.current) {
          lastJson.current = text;
          setGraph(JSON.parse(text) as ShareSnapshot);
        }
      } catch {
        /* keep last good */
      }
    };
    refreshRef.current = refresh;
    const applyPos = (moved: { id: string; x: number; y: number }[]) => {
      const m = new Map(moved.map((n) => [n.id, n]));
      setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (m.has(n.id) ? { ...n, x: m.get(n.id)!.x, y: m.get(n.id)!.y } : n)) }));
      lastJson.current = "";
    };
    let pollIv: ReturnType<typeof setInterval> | null = null;
    const startPoll = () => {
      if (!pollIv) pollIv = setInterval(refresh, POLL_MS);
    };
    const stopPoll = () => {
      if (pollIv) {
        clearInterval(pollIv);
        pollIv = null;
      }
    };
    let es: EventSource | null = null;
    try {
      es = new EventSource(`/api/p/${secret}/stream`);
      es.onopen = stopPoll;
      es.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as {
            type: string;
            op?: string;
            nodes?: { id: string; x: number; y: number }[];
            suggestion?: { id: string; authorName: string | null; payload?: { nodes?: CSuggestionNode[]; edges?: { source: string; target: string }[] } };
            suggestionId?: string;
            tempId?: string;
            tempIds?: string[];
            up?: number;
            down?: number;
          };
          if (msg.type === "pos" && msg.nodes) applyPos(msg.nodes);
          else if (msg.type === "refresh") void refresh();
          else if (msg.type === "sug" && msg.op === "upsert" && msg.suggestion) {
            const s = msg.suggestion;
            const cs: CSuggestion = { id: s.id, authorName: s.authorName, nodes: s.payload?.nodes ?? [], edges: s.payload?.edges ?? [], votes: {} };
            setAllSuggestions((prev) => {
              const i = prev.findIndex((x) => x.id === cs.id);
              if (i === -1) return [...prev, cs];
              const next = prev.slice();
              next[i] = { ...cs, votes: prev[i].votes }; // preserve tallies across content updates
              return next;
            });
          } else if (msg.type === "sug" && msg.op === "remove" && msg.suggestionId) {
            const id = msg.suggestionId;
            setAllSuggestions((prev) => prev.filter((x) => x.id !== id));
          } else if (msg.type === "sug-resolved" && msg.suggestionId) {
            const id = msg.suggestionId;
            const ids = new Set(msg.tempIds ?? []);
            setAllSuggestions((prev) =>
              prev.flatMap((x) => {
                if (x.id !== id) return [x];
                const nodes = x.nodes.filter((n) => !ids.has(n.tempId));
                const edges = x.edges.filter((e) => !ids.has(String(e.source)) && !ids.has(String(e.target)));
                return nodes.length ? [{ ...x, nodes, edges }] : [];
              }),
            );
            if (id === suggestionId.current) {
              setProposed((p) => ({
                nodes: p.nodes.filter((n) => !ids.has(n.id)),
                edges: p.edges.filter((e) => !ids.has(e.source) && !ids.has(e.target)),
              }));
            }
            if (msg.op === "accepted") void refresh(); // adopted items are now real on the board
            void loadSuggestions(); // reconcile the ghost layer with the server's PENDING set
          } else if (msg.type === "sug-vote" && msg.suggestionId && msg.tempId) {
            const { suggestionId: id, tempId, up = 0, down = 0 } = msg;
            setAllSuggestions((prev) => prev.map((x) => (x.id === id ? { ...x, votes: { ...x.votes, [tempId]: { up, down } } } : x)));
          }
        } catch {
          /* ignore */
        }
      };
      es.onerror = startPoll;
    } catch {
      startPoll();
    }
    return () => {
      active = false;
      stopPoll();
      es?.close();
    };
  }, [secret, loadSuggestions]);

  // Initial load + a low-frequency reconcile so the ghost layer always converges to the server's
  // PENDING set (an accepted/discarded item disappears within a few seconds even if its SSE frame
  // was missed). Instant updates still come over SSE; this is the safety net.
  useEffect(() => {
    void loadSuggestions();
    const iv = setInterval(() => {
      if (typeof document === "undefined" || !document.hidden) void loadSuggestions();
    }, 7000);
    return () => clearInterval(iv);
  }, [loadSuggestions]);

  // ── Live persistence: debounce the working set up to the server on every change (no "Submit"). ──
  useEffect(() => {
    if (!suggesting) return;
    // nothing to send and nothing to clear → skip the no-op POST (e.g. first paint)
    if (proposed.nodes.length === 0 && !suggestionId.current) return;
    const t = setTimeout(async () => {
      if (!authorToken.current) return;
      const payload = {
        nodes: proposed.nodes.map((n) => ({
          tempId: n.id,
          type: n.type,
          x: n.x,
          y: n.y,
          ...(n.width ? { width: n.width } : {}),
          ...(n.height ? { height: n.height } : {}),
          data: n.data,
        })),
        edges: proposed.edges.map((e) => ({ source: e.source, target: e.target })),
      };
      setSave("saving");
      try {
        const res = await fetch(`/api/p/${secret}/suggest`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ authorToken: authorToken.current, authorName: name || undefined, proposal: payload }),
        });
        if (res.ok) {
          const j = (await res.json().catch(() => ({}))) as { suggestionId?: string | null };
          if (j.suggestionId) {
            suggestionId.current = j.suggestionId;
            setOwnId(j.suggestionId);
          } else if (proposed.nodes.length === 0) {
            suggestionId.current = null; // cleared
            setOwnId(null);
          }
          setSave("saved");
        } else {
          setSave("error");
        }
      } catch {
        setSave("error");
      }
    }, PERSIST_MS);
    return () => clearTimeout(t);
  }, [proposed, name, suggesting, secret]);

  // Others' pending suggestions as read-only ghosts (my own renders from the editable proposal layer).
  const otherGhostNodes = useMemo<Node[]>(() => {
    if (embed) return []; // embeds show only the published board, no pending suggestions
    const out: Node[] = [];
    let placed = 0;
    for (const s of allSuggestions) {
      if (s.id === ownId) continue;
      for (const pn of s.nodes) {
        const x = Number.isFinite(pn.x) ? pn.x : 60 + (placed % 6) * 210;
        const y = Number.isFinite(pn.y) ? pn.y : 60 + Math.floor(placed / 6) * 130;
        placed += 1;
        out.push({
          id: `osug:${s.id}:${pn.tempId}`,
          type: pn.type,
          position: { x, y },
          data: { ...pn.data },
          draggable: false,
          selectable: false,
          deletable: false,
          connectable: false,
          focusable: false,
          className: "gb-suggested-open", // public viewers see suggestions clearly (no blur gate)
          ...(pn.type === "swatch" && pn.width != null && pn.height != null
            ? { width: pn.width, height: pn.height, style: { width: pn.width, height: pn.height } }
            : {}),
        });
      }
    }
    return out;
  }, [allSuggestions, ownId, embed]);

  const otherGhostEdges = useMemo<Edge[]>(() => {
    const out: Edge[] = [];
    const liveIds = new Set(graph.nodes.map((n) => n.id));
    for (const s of allSuggestions) {
      if (s.id === ownId) continue;
      const temp = new Set(s.nodes.map((n) => n.tempId));
      const resolve = (r: string) => (temp.has(r) ? `osug:${s.id}:${r}` : liveIds.has(r) ? r : null);
      s.edges.forEach((e, i) => {
        const src = resolve(String(e.source));
        const tgt = resolve(String(e.target));
        if (!src || !tgt || src === tgt) return;
        out.push({ id: `osuge:${s.id}:${i}`, source: src, target: tgt, type: "animated", className: "gb-suggested-open", selectable: false, deletable: false, data: {} });
      });
    }
    return out;
  }, [allSuggestions, ownId, graph.nodes]);

  const vote = useCallback(
    async (sugId: string, tempId: string, value: number) => {
      const key = `${sugId}:${tempId}`;
      const next = (myVotes[key] ?? 0) === value ? 0 : value; // click the active arrow again to clear
      setMyVotes((v) => ({ ...v, [key]: next }));
      try {
        const res = await fetch(`/api/p/${secret}/vote`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ authorToken: authorToken.current, suggestionId: sugId, tempId, value: next }),
        });
        if (res.ok) {
          const j = (await res.json()) as { up: number; down: number };
          setAllSuggestions((prev) => prev.map((s) => (s.id === sugId ? { ...s, votes: { ...s.votes, [tempId]: { up: j.up, down: j.down } } } : s)));
        }
      } catch {
        /* leave optimistic state */
      }
    },
    [secret, myVotes],
  );

  // ── Render: live board (read-only) + the guest's own proposal layer ──
  const nodes: Node[] = useMemo(() => {
    const live: Node[] = graph.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: { x: n.x, y: n.y },
      data: n.data,
      zIndex: n.zIndex, // honor editor "bring to front / send to back" on the public board
      draggable: false,
      selectable: false,
      deletable: false,
      connectable: suggesting,
      // Any node with explicit dimensions renders at that size (swatch/image always; resized text too).
      ...(n.width != null && n.height != null
        ? { width: n.width, height: n.height, style: { width: n.width, height: n.height } }
        : {}),
    }));
    const mine: Node[] = proposed.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: { x: n.x, y: n.y },
      data: n.data,
      draggable: true,
      selectable: true,
      deletable: true,
      connectable: true,
      className: "gb-proposed",
      ...(n.type === "swatch" && n.width != null && n.height != null
        ? { width: n.width, height: n.height, style: { width: n.width, height: n.height } }
        : {}),
    }));
    // Cloud groups: a translucent colored region behind their members (mirrors the editor). Sized from
    // the members' bounding box; member sizes fall back to 180×70 for auto-sized nodes (no stored dims).
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const clouds: Node[] = [];
    for (const g of graph.groups ?? []) {
      const members = g.nodeIds.map((id) => byId.get(id)).filter((n): n is (typeof graph.nodes)[number] => !!n);
      if (members.length === 0) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const m of members) {
        const w = m.width ?? 180, h = m.height ?? 70;
        minX = Math.min(minX, m.x); minY = Math.min(minY, m.y);
        maxX = Math.max(maxX, m.x + w); maxY = Math.max(maxY, m.y + h);
      }
      const width = maxX - minX + CLOUD_PAD * 2;
      const height = maxY - minY + CLOUD_PAD * 2 + 22; // extra top room for the label chip
      clouds.push({
        id: `cloud:${g.id}`,
        type: "cloud",
        position: { x: minX - CLOUD_PAD, y: minY - CLOUD_PAD - 22 },
        data: { label: g.label, color: g.color, tags: g.tags },
        width, height, style: { width, height },
        zIndex: -1000,
        selectable: false, draggable: false, deletable: false, connectable: false,
      });
    }
    return [...clouds, ...live, ...otherGhostNodes, ...mine];
  }, [graph.nodes, graph.groups, proposed.nodes, suggesting, otherGhostNodes]);

  const edges: Edge[] = useMemo(() => {
    const live = graph.edges.map((e) => ({ ...toRFEdge(e), selectable: false, deletable: false }));
    const mine = proposed.edges.map((e) => ({
      ...toRFEdge({ id: e.id, source: e.source, target: e.target, type: "animated", data: {} }),
      className: "gb-proposed",
      deletable: true,
    }));
    return [...live, ...otherGhostEdges, ...mine];
  }, [graph.edges, proposed.edges, otherGhostEdges]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setProposed((p) => {
      let ns = p.nodes;
      const removed: string[] = [];
      for (const c of changes) {
        if (c.type === "position" && c.position) ns = ns.map((n) => (n.id === c.id ? { ...n, x: c.position!.x, y: c.position!.y } : n));
        else if (c.type === "remove") removed.push(c.id);
      }
      if (removed.length) ns = ns.filter((n) => !removed.includes(n.id));
      const es = removed.length ? p.edges.filter((e) => !removed.includes(e.source) && !removed.includes(e.target)) : p.edges;
      return ns === p.nodes && es === p.edges ? p : { nodes: ns, edges: es };
    });
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const removed = changes.filter((c) => c.type === "remove").map((c) => c.id);
    if (removed.length) setProposed((p) => ({ ...p, edges: p.edges.filter((e) => !removed.includes(e.id)) }));
  }, []);

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return;
    setProposed((p) => ({ ...p, edges: [...p.edges, { id: `tmpe_${tmp.current++}`, source: c.source!, target: c.target! }] }));
  }, []);

  const addProposed = useCallback(
    (type: Tool, data: Record<string, unknown>) => {
      const c = rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      const off = (proposed.nodes.length % 6) * 18;
      const node: PNode = { id: `tmp_${tmp.current++}`, type, x: c.x + off, y: c.y + off, data };
      if (type === "swatch") {
        node.width = 120;
        node.height = 120;
      }
      setProposed((p) => ({ ...p, nodes: [...p.nodes, node] }));
    },
    [rf, proposed.nodes.length],
  );

  const clearProposal = useCallback(() => setProposed({ nodes: [], edges: [] }), []);
  const count = proposed.nodes.length + proposed.edges.length;

  return (
    <VariablesProvider nodes={graph.nodes}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        colorMode={colorMode}
        connectionMode={ConnectionMode.Loose}
        nodesDraggable={false}
        nodesConnectable={suggesting}
        elementsSelectable={suggesting}
        deleteKeyCode={suggesting ? ["Backspace", "Delete"] : null}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} color="var(--md-sys-color-outline-variant)" />
        {!embed && <MiniMap pannable zoomable style={{ bottom: 76 }} />}
        <Controls showInteractive={false} />
      </ReactFlow>

      {!embed && (
        <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-2 p-3">
          <div className="rounded-control border border-outline-variant bg-surface-container/95 px-3 py-1.5 text-sm font-medium text-on-surface shadow-elev-1 backdrop-blur">
            {graph.boardTitle} <span className="text-on-surface-variant">· public · live</span>
          </div>
        </header>
      )}

      {suggesting && (
        <ProposePanel
          count={count}
          name={name}
          onName={setName}
          onAdd={addProposed}
          onClear={clearProposal}
          save={save}
        />
      )}

      {!embed && <CommunityPanel suggestions={allSuggestions} ownId={ownId} myVotes={myVotes} onVote={vote} />}
    </VariablesProvider>
  );
}

// A Google-Docs-style pane listing everyone's pending suggestion items with up/down voting + tallies.
function CommunityPanel({
  suggestions,
  ownId,
  myVotes,
  onVote,
}: {
  suggestions: CSuggestion[];
  ownId: string | null;
  myVotes: Record<string, number>;
  onVote: (sugId: string, tempId: string, value: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const items = useMemo(() => {
    const out: { sugId: string; author: string | null; mine: boolean; node: CSuggestionNode; tally: { up: number; down: number } }[] = [];
    for (const s of suggestions) for (const n of s.nodes) out.push({ sugId: s.id, author: s.authorName, mine: s.id === ownId, node: n, tally: s.votes[n.tempId] ?? { up: 0, down: 0 } });
    return out;
  }, [suggestions, ownId]);
  if (items.length === 0) return null;

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-4 left-16 z-50 flex items-center gap-1.5 rounded-full border border-outline-variant bg-surface-container/95 px-4 py-2.5 text-sm font-medium text-on-surface shadow-elev-2 backdrop-blur transition hover:bg-surface-variant active:scale-[.98]"
      >
        <Users size={16} /> Suggestions ({items.length})
      </button>
    );
  }
  return (
    <div className="gb-pop-in fixed bottom-4 left-16 z-50 flex max-h-[70vh] w-80 flex-col rounded-modal border border-outline-variant bg-surface-container text-on-surface shadow-elev-3">
      <div className="flex items-center justify-between border-b border-outline-variant p-3">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <Users size={15} /> Community suggestions
        </h2>
        <button onClick={() => setOpen(false)} aria-label="Close" className="rounded p-0.5 text-on-surface-variant transition hover:bg-surface-variant">
          <X size={15} />
        </button>
      </div>
      <ul className="flex-1 space-y-1.5 overflow-y-auto p-2">
        {items.map((it) => {
          const key = `${it.sugId}:${it.node.tempId}`;
          const mine = myVotes[key] ?? 0;
          return (
            <li key={key} className="flex items-center gap-2 rounded-control border border-outline-variant bg-surface p-2">
              <div className="min-w-0 flex-1">
                <ItemSnippet node={it.node} />
                <div className="mt-0.5 truncate text-[11px] text-on-surface-variant">— {it.author ?? "anonymous"}{it.mine ? " · you" : ""}</div>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <button onClick={() => onVote(it.sugId, it.node.tempId, 1)} aria-label="Upvote" className={`flex items-center rounded p-1 transition hover:bg-surface-variant active:scale-90 ${mine === 1 ? "text-primary" : "text-on-surface-variant"}`}>
                  <ThumbsUp size={14} />
                </button>
                <span className="min-w-5 text-center text-xs tabular-nums text-on-surface-variant" title={`${it.tally.up} up · ${it.tally.down} down`}>{it.tally.up - it.tally.down}</span>
                <button onClick={() => onVote(it.sugId, it.node.tempId, -1)} aria-label="Downvote" className={`flex items-center rounded p-1 transition hover:bg-surface-variant active:scale-90 ${mine === -1 ? "text-error" : "text-on-surface-variant"}`}>
                  <ThumbsDown size={14} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ItemSnippet({ node }: { node: CSuggestionNode }) {
  if (node.type === "swatch") {
    const hex = String(node.data?.hex ?? "#888888");
    return (
      <span className="flex items-center gap-1.5 text-sm text-on-surface">
        <span className="inline-block h-3 w-3 shrink-0 rounded-sm border border-outline-variant" style={{ background: hex }} /> {hex}
      </span>
    );
  }
  if (node.type === "link") return <span className="block truncate text-sm text-on-surface">{String(node.data?.url ?? "link")}</span>;
  return <span className="block truncate text-sm text-on-surface">{String(node.data?.text ?? "") || "(empty note)"}</span>;
}

function ProposePanel({
  count,
  name,
  onName,
  onAdd,
  onClear,
  save,
}: {
  count: number;
  name: string;
  onName: (v: string) => void;
  onAdd: (type: Tool, data: Record<string, unknown>) => void;
  onClear: () => void;
  save: SaveState;
}) {
  const [open, setOpen] = useState(false);
  const [tool, setTool] = useState<Tool>("text");
  const [text, setText] = useState("");
  const [hex, setHex] = useState("#8b5cf6");
  const [url, setUrl] = useState("");
  const [err, setErr] = useState("");

  const add = () => {
    if (tool === "text") {
      if (!text.trim()) return;
      onAdd("text", { text: text.trim().slice(0, 5000) });
      setText("");
    } else if (tool === "swatch") {
      onAdd("swatch", { hex });
    } else {
      const u = url.trim();
      if (!u || !/^https?:\/\//i.test(u)) {
        setErr("Enter a full URL (https://…)");
        return;
      }
      onAdd("link", { url: u });
      setUrl("");
    }
    setErr("");
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-primary px-4 py-2.5 text-sm font-medium text-on-primary shadow-elev-3 transition hover:opacity-90 active:scale-[.98]"
      >
        <Plus size={16} /> Suggest changes{count ? ` (${count})` : ""}
      </button>
    );
  }

  const TABS: { t: Tool; label: string; Icon: typeof Type }[] = [
    { t: "text", label: "Text", Icon: Type },
    { t: "swatch", label: "Swatch", Icon: Palette },
    { t: "link", label: "Link", Icon: Link2 },
  ];

  return (
    <div className="gb-pop-in fixed bottom-4 left-1/2 z-50 w-72 -translate-x-1/2 rounded-modal border border-outline-variant bg-surface-container p-4 text-on-surface shadow-elev-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Suggest changes</h2>
        <button onClick={() => setOpen(false)} aria-label="Close" className="rounded p-0.5 text-on-surface-variant transition hover:bg-surface-variant">
          <X size={15} />
        </button>
      </div>

      <div className="mb-2 flex gap-1 rounded-control border border-outline-variant p-1">
        {TABS.map((tb) => (
          <button
            key={tb.t}
            onClick={() => setTool(tb.t)}
            className={`flex flex-1 items-center justify-center gap-1 rounded px-1.5 py-1 text-xs transition ${
              tool === tb.t ? "bg-secondary-container text-on-secondary-container" : "text-on-surface-variant hover:bg-surface-variant"
            }`}
          >
            <tb.Icon size={13} /> {tb.label}
          </button>
        ))}
      </div>

      {tool === "text" && (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          spellCheck
          placeholder="Idea text…"
          className="mb-2 w-full resize-none rounded-control border border-outline-variant bg-surface px-2 py-1.5 text-sm text-on-surface outline-none focus-visible:border-primary"
        />
      )}
      {tool === "swatch" && (
        <div className="mb-2 flex items-center gap-2">
          <input type="color" value={hex} onChange={(e) => setHex(e.target.value)} className="h-8 w-10 cursor-pointer rounded border border-outline-variant bg-surface" />
          <span className="font-mono text-xs text-on-surface-variant">{hex}</span>
        </div>
      )}
      {tool === "link" && (
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…"
          className="mb-2 w-full rounded-control border border-outline-variant bg-surface px-2 py-1.5 text-sm text-on-surface outline-none focus-visible:border-primary"
        />
      )}

      <button
        onClick={add}
        className="mb-3 flex w-full items-center justify-center gap-1.5 rounded-control border border-outline-variant px-2.5 py-1.5 text-xs font-medium text-on-surface transition hover:bg-surface-variant active:scale-[.98]"
      >
        <Plus size={14} /> Add to board
      </button>

      <p className="mb-2 text-[11px] text-on-surface-variant">
        Items you add appear instantly on the owner&apos;s board as suggestions. Drag to place them, drag between
        nodes to connect. A moderator can accept or discard each one.
      </p>

      <input
        value={name}
        onChange={(e) => onName(e.target.value)}
        placeholder="Your name (optional — shown as credit)"
        className="mb-2 w-full rounded-control border border-outline-variant bg-surface px-2 py-1.5 text-sm text-on-surface outline-none focus-visible:border-primary"
      />

      {err && <p className="mb-2 text-xs text-error">{err}</p>}

      <div className="flex items-center justify-between gap-2">
        <SaveDot save={save} count={count} />
        <button
          onClick={onClear}
          disabled={count === 0}
          className="flex items-center gap-1 rounded-control px-2 py-1.5 text-xs text-on-surface-variant transition hover:bg-surface-variant active:scale-[.98] disabled:opacity-40"
        >
          <Trash2 size={13} /> Clear mine
        </button>
      </div>
    </div>
  );
}

function SaveDot({ save, count }: { save: SaveState; count: number }) {
  if (count === 0) return <span className="text-[11px] text-on-surface-variant">No suggestions yet</span>;
  if (save === "saving") return <span className="flex items-center gap-1 text-[11px] text-on-surface-variant"><Loader2 size={12} className="animate-spin" /> Saving…</span>;
  if (save === "error") return <span className="text-[11px] text-error">Couldn&apos;t save — retrying</span>;
  return <span className="flex items-center gap-1 text-[11px] text-on-surface-variant"><Check size={12} className="text-primary" /> Saved · {count} live</span>;
}
