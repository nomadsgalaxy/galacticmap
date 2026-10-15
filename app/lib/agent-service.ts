// Agent collaboration over the REST API: read a board as an outline, and change it in one batch, either
// applied directly or proposed for a human to review. Takes an explicit API principal like board-service,
// and goes through the same authorize() grants, parseNodeData() validation and cache tags as the editor.
import { randomBytes } from "node:crypto";
import { revalidateTag } from "next/cache";
import { Prisma } from "@prisma/client";
import { z, ZodError } from "zod";
import { prisma } from "@/app/lib/db";
import type { ApiPrincipal } from "@/app/lib/api-token";
import { tags } from "@/app/lib/cache-tags";
import { serializeNode, serializeEdge } from "@/app/lib/boards";
import { NODE_TYPES, parseNodeData, type SnapshotNode, type SnapshotEdge } from "@/app/lib/types";
import { ApiError, announceGraph, gate, getBoardFull, type GroupSnapshot } from "@/app/lib/board-service";
import { publishLive } from "@/app/lib/live-bus";
import { normalizeProposal } from "@/app/lib/public-db";
import { findSpot, rectOf, sizeOf, union, type Dir, type Rect } from "@/app/lib/board-layout";
import { outlineText } from "@/app/lib/board-outline";

// ── describe_board ───────────────────────────────────────────────────────────────────────────────────
export async function describeBoard(principal: ApiPrincipal, boardId: string, maxChars?: number): Promise<string> {
  return outlineText(await getBoardFull(principal, boardId), maxChars);
}

// ── apply_changes ────────────────────────────────────────────────────────────────────────────────────
// Every id field accepts either a real id or a `ref` given to something created earlier in the same batch.
const Id = z.string().min(1).max(100);
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected #rrggbb");
const Tags = z.array(z.string().min(1).max(40)).max(50);
const Place = z.object({
  near: Id.optional().describe("node to sit next to"),
  in: Id.optional().describe("group to join and sit beside"),
  dir: z.enum(["right", "left", "above", "below"]).optional(),
}).strict();
const Size = z.number().positive().max(5000);

export const ChangeOp = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add_node"), ref: Id.optional(), type: z.enum(NODE_TYPES), data: z.record(z.unknown()).optional(),
    x: z.number().finite().optional(), y: z.number().finite().optional(), width: Size.optional(), height: Size.optional(),
    place: Place.optional(), parent: Id.optional(), group: Id.optional(),
  }).strict(),
  z.object({
    op: z.literal("update_node"), id: Id, data: z.record(z.unknown()).optional(),
    x: z.number().finite().optional(), y: z.number().finite().optional(), width: Size.nullable().optional(), height: Size.nullable().optional(),
    place: Place.optional(), parent: Id.nullable().optional(), collapsed: z.boolean().optional(),
    addTags: Tags.optional(), removeTags: Tags.optional(),
  }).strict(),
  z.object({ op: z.literal("delete_node"), id: Id }).strict(),
  z.object({ op: z.literal("add_edge"), ref: Id.optional(), source: Id, target: Id, label: z.string().max(120).optional() }).strict(),
  z.object({ op: z.literal("update_edge"), id: Id, label: z.string().max(120).nullable() }).strict(),
  z.object({ op: z.literal("delete_edge"), id: Id }).strict(),
  z.object({
    op: z.literal("add_group"), ref: Id.optional(), label: z.string().max(80).optional(), color: Hex.optional(),
    tags: Tags.optional(), nodes: z.array(Id).max(500),
  }).strict(),
  z.object({
    op: z.literal("update_group"), id: Id, label: z.string().max(80).nullable().optional(), color: Hex.nullable().optional(),
    tags: Tags.optional(), addNodes: z.array(Id).max(500).optional(), removeNodes: z.array(Id).max(500).optional(),
  }).strict(),
  z.object({ op: z.literal("delete_group"), id: Id }).strict(),
]);
export type ChangeOp = z.infer<typeof ChangeOp>;

export const ChangeSet = z.object({
  ops: z.array(ChangeOp).min(1).max(200),
  mode: z.enum(["apply", "propose"]).default("apply"),
  dryRun: z.boolean().default(false),
}).strict();

export type ChangeResult = {
  mode: "apply" | "propose";
  applied: boolean;
  refs: Record<string, string>;
  nodes: SnapshotNode[];
  edges: SnapshotEdge[];
  groups: GroupSnapshot[];
  deleted: { nodes: string[]; edges: string[]; groups: string[] };
  versionId?: string;
  suggestionId?: string;
};

const PROPOSE_TYPES = new Set(["text", "swatch", "link"]); // what the suggestion review flow can accept
const SNAPSHOT_AT = 10; // batches this big (or with any delete) get a restorable "before" version first
const KEEP_AGENT_VERSIONS = 10;
const AGENT_VERSION_PREFIX = "Before agent changes";
const day = () => new Date().toISOString().slice(0, 10);

class DryRun extends Error {}

async function authorName(principal: ApiPrincipal): Promise<string> {
  const t = await prisma.apiToken.findUnique({ where: { id: principal.tokenId }, select: { name: true } });
  return `${(t?.name ?? "API").slice(0, 60)} (agent)`;
}

// Board state the batch works on, updated op by op so later ops see earlier ones.
type State = { nodes: Map<string, SnapshotNode>; edges: Map<string, SnapshotEdge>; groups: Map<string, GroupSnapshot> };

function resolver(state: State, refs: Map<string, string>) {
  const pick = <T>(map: Map<string, T>, kind: string) => (i: number, ref: string): string => {
    const id = refs.get(ref) ?? ref;
    if (!map.has(id)) throw new ApiError(422, `ops[${i}]: no ${kind} '${ref}' on this board (or created earlier in this batch)`, "unknown_ref");
    return id;
  };
  return { node: pick(state.nodes, "node"), edge: pick(state.edges, "connector"), group: pick(state.groups, "group") };
}

function cleanData(i: number, type: string, data: Record<string, unknown>): Record<string, unknown> {
  try {
    return parseNodeData(type, data);
  } catch (e) {
    const msg = e instanceof ZodError ? e.issues.map((x) => `${x.path.join(".") || "data"}: ${x.message}`).join("; ") : String(e);
    throw new ApiError(422, `ops[${i}]: invalid data for a ${type} node — ${msg}`, "invalid_data");
  }
}

// Where a node goes: explicit x/y wins, else beside its `place` anchor (or its mind-map parent), else below the board.
function position(
  state: State, r: ReturnType<typeof resolver>, i: number, self: string | null,
  o: { x?: number; y?: number; place?: z.infer<typeof Place>; parent?: string | null }, w: number, h: number,
): { x: number; y: number } | null {
  if (o.x !== undefined && o.y !== undefined) return { x: o.x, y: o.y };
  const others = [...state.nodes.values()].filter((n) => n.id !== self);
  let anchor: Rect | null = null, dir: Dir = o.place?.dir ?? "right";
  if (o.place?.near) anchor = rectOf(state.nodes.get(r.node(i, o.place.near))!);
  else if (o.place?.in) {
    const g = state.groups.get(r.group(i, o.place.in))!;
    anchor = union(g.nodeIds.filter((id) => id !== self && state.nodes.has(id)).map((id) => rectOf(state.nodes.get(id)!)));
    dir = o.place.dir ?? "below";
  } else if (o.parent) anchor = rectOf(state.nodes.get(r.node(i, o.parent))!);
  else if (self) return null; // an update without x/y/place keeps its position
  return findSpot(others.map(rectOf), anchor, dir, w, h);
}

function wouldCycle(state: State, nodeId: string, parentId: string): boolean {
  for (let p: string | null = parentId, hops = 0; p && hops < 10_000; p = state.nodes.get(p)?.parentId ?? null, hops++) if (p === nodeId) return true;
  return false;
}

const uniq = (xs: string[]) => [...new Set(xs)];

export async function applyChanges(principal: ApiPrincipal, boardId: string, raw: unknown): Promise<ChangeResult> {
  const set = ChangeSet.parse(raw);
  const by = await authorName(principal);
  if (set.mode === "propose") return propose(principal, boardId, set.ops, set.dryRun, by);

  await gate(principal, boardId, "node:edit");
  if (set.ops.some((o) => o.op.startsWith("delete_"))) await gate(principal, boardId, "node:delete");

  const board = await getBoardFull(principal, boardId);
  const result: ChangeResult = {
    mode: "apply", applied: !set.dryRun, refs: {}, nodes: [], edges: [], groups: [],
    deleted: { nodes: [], edges: [], groups: [] },
  };

  try {
    await prisma.$transaction(async (tx) => {
      const state: State = {
        nodes: new Map(board.nodes.map((n) => [n.id, n])),
        edges: new Map(board.edges.map((e) => [e.id, e])),
        groups: new Map(board.groups.map((g) => [g.id, { ...g, nodeIds: [...g.nodeIds] }])),
      };
      const refs = new Map<string, string>();
      const r = resolver(state, refs);
      const touchedNodes = new Set<string>(), touchedEdges = new Set<string>(), touchedGroups = new Set<string>();
      const deleted = result.deleted;
      const saveGroup = async (g: GroupSnapshot) => {
        await tx.nodeGroup.update({
          where: { id: g.id },
          data: { label: g.label, color: g.color, tags: g.tags as unknown as Prisma.InputJsonValue, nodeIds: g.nodeIds as unknown as Prisma.InputJsonValue },
        });
        touchedGroups.add(g.id);
      };
      const addRef = (i: number, ref: string | undefined, id: string) => {
        if (!ref) return;
        if (refs.has(ref)) throw new ApiError(422, `ops[${i}]: ref '${ref}' is already used in this batch`, "duplicate_ref");
        refs.set(ref, id);
      };

      // Safety net: big or destructive batches get a restorable snapshot first (History → Restore).
      if (!set.dryRun && (set.ops.length >= SNAPSHOT_AT || set.ops.some((o) => o.op.startsWith("delete_")))) {
        const v = await tx.boardVersion.create({
          data: {
            boardId, label: `${AGENT_VERSION_PREFIX} · ${by}`,
            snapshot: { nodes: board.nodes, edges: board.edges, groups: board.groups } as unknown as Prisma.InputJsonValue,
            nodeCount: board.nodes.length, edgeCount: board.edges.length, createdBy: principal.userId,
          },
        });
        result.versionId = v.id;
        const old = await tx.boardVersion.findMany({
          where: { boardId, label: { startsWith: AGENT_VERSION_PREFIX } }, orderBy: { createdAt: "desc" }, skip: KEEP_AGENT_VERSIONS, select: { id: true },
        });
        if (old.length) await tx.boardVersion.deleteMany({ where: { id: { in: old.map((x) => x.id) } } });
      }

      for (const [i, o] of set.ops.entries()) {
        switch (o.op) {
          case "add_node": {
            const data = cleanData(i, o.type, { credit: { name: by, suggestedAt: day() }, ...(o.data ?? {}) });
            const dims = o.width && o.height ? { width: o.width, height: o.height }
              : o.type === "swatch" ? { width: 120, height: 120 } : o.type === "image" ? { width: 220, height: 160 } : {};
            const { w, h } = sizeOf(o.type, dims.width, dims.height, data);
            const parentId = o.parent ? r.node(i, o.parent) : null;
            const group = o.group ? state.groups.get(r.group(i, o.group))! : null;
            const place = o.place ?? (group ? { in: group.id } : undefined);
            const pos = position(state, r, i, null, { x: o.x, y: o.y, place, parent: parentId }, w, h)!;
            const row = await tx.node.create({
              data: { boardId, type: o.type, layout: "manual", posX: pos.x, posY: pos.y, ...dims, ...(parentId ? { parentId } : {}), data: data as Prisma.InputJsonValue },
            });
            const n = serializeNode(row);
            state.nodes.set(n.id, n);
            touchedNodes.add(n.id);
            addRef(i, o.ref, n.id);
            if (group && !group.nodeIds.includes(n.id)) { group.nodeIds.push(n.id); await saveGroup(group); }
            break;
          }
          case "update_node": {
            const id = r.node(i, o.id), cur = state.nodes.get(id)!;
            const patch: Prisma.NodeUpdateInput = {};
            if (o.data || o.addTags || o.removeTags) {
              const merged = { ...cur.data, ...(o.data ?? {}) };
              if (o.addTags || o.removeTags) {
                const drop = new Set(o.removeTags ?? []);
                merged.tags = uniq([...((merged.tags as string[] | undefined) ?? []), ...(o.addTags ?? [])]).filter((t) => !drop.has(t));
              }
              patch.data = cleanData(i, cur.type, merged) as Prisma.InputJsonValue;
            }
            if (o.width !== undefined) patch.width = o.width;
            if (o.height !== undefined) patch.height = o.height;
            if (o.collapsed !== undefined) patch.collapsed = o.collapsed;
            if (o.parent !== undefined) {
              const parentId = o.parent === null ? null : r.node(i, o.parent);
              if (parentId === id || (parentId && wouldCycle(state, id, parentId))) {
                throw new ApiError(422, `ops[${i}]: that parent would put the node inside its own subtree`, "invalid_parent");
              }
              patch.parent = parentId ? { connect: { id: parentId } } : { disconnect: true };
            }
            const { w, h } = sizeOf(cur.type, o.width ?? cur.width, o.height ?? cur.height, cur.data);
            const pos = o.x !== undefined || o.y !== undefined
              ? { x: o.x ?? cur.x, y: o.y ?? cur.y }
              : position(state, r, i, id, { place: o.place }, w, h);
            if (pos) { patch.posX = pos.x; patch.posY = pos.y; }
            const n = serializeNode(await tx.node.update({ where: { id }, data: patch }));
            state.nodes.set(id, n);
            touchedNodes.add(id);
            break;
          }
          case "delete_node": {
            const id = r.node(i, o.id);
            await tx.node.delete({ where: { id } }); // connectors cascade; children are detached (SetNull)
            state.nodes.delete(id);
            touchedNodes.delete(id);
            deleted.nodes.push(id);
            for (const [eid, e] of state.edges) if (e.source === id || e.target === id) { state.edges.delete(eid); touchedEdges.delete(eid); deleted.edges.push(eid); }
            for (const n of state.nodes.values()) if (n.parentId === id) { state.nodes.set(n.id, { ...n, parentId: null }); touchedNodes.add(n.id); }
            for (const g of state.groups.values()) if (g.nodeIds.includes(id)) { g.nodeIds = g.nodeIds.filter((x) => x !== id); await saveGroup(g); }
            break;
          }
          case "add_edge": {
            const s = r.node(i, o.source), t = r.node(i, o.target);
            if (s === t) throw new ApiError(422, `ops[${i}]: a connector needs two different nodes`, "invalid_edge");
            const e = serializeEdge(await tx.edge.create({
              data: { boardId, sourceId: s, targetId: t, kind: "connector", type: "animated", animated: true, label: o.label ?? null },
            }));
            state.edges.set(e.id, e);
            touchedEdges.add(e.id);
            addRef(i, o.ref, e.id);
            break;
          }
          case "update_edge": {
            const id = r.edge(i, o.id);
            const e = serializeEdge(await tx.edge.update({ where: { id }, data: { label: o.label } }));
            state.edges.set(id, e);
            touchedEdges.add(id);
            break;
          }
          case "delete_edge": {
            const id = r.edge(i, o.id);
            await tx.edge.delete({ where: { id } });
            state.edges.delete(id);
            touchedEdges.delete(id);
            deleted.edges.push(id);
            break;
          }
          case "add_group": {
            const members = uniq(o.nodes.map((n) => r.node(i, n)));
            const row = await tx.nodeGroup.create({
              data: {
                boardId, label: o.label ?? null, color: o.color ?? null,
                tags: (o.tags ?? []) as unknown as Prisma.InputJsonValue, nodeIds: members as unknown as Prisma.InputJsonValue,
              },
            });
            const g: GroupSnapshot = { id: row.id, label: row.label, color: row.color, tags: o.tags ?? [], nodeIds: members };
            state.groups.set(g.id, g);
            touchedGroups.add(g.id);
            addRef(i, o.ref, g.id);
            break;
          }
          case "update_group": {
            const g = state.groups.get(r.group(i, o.id))!;
            if (o.label !== undefined) g.label = o.label;
            if (o.color !== undefined) g.color = o.color;
            if (o.tags) g.tags = uniq(o.tags);
            const drop = new Set((o.removeNodes ?? []).map((n) => r.node(i, n)));
            g.nodeIds = uniq([...g.nodeIds, ...(o.addNodes ?? []).map((n) => r.node(i, n))]).filter((id) => !drop.has(id));
            await saveGroup(g);
            break;
          }
          case "delete_group": {
            const id = r.group(i, o.id);
            await tx.nodeGroup.delete({ where: { id } });
            state.groups.delete(id);
            touchedGroups.delete(id);
            deleted.groups.push(id);
            break;
          }
        }
      }

      result.refs = Object.fromEntries(refs);
      result.nodes = [...touchedNodes].map((id) => state.nodes.get(id)!).filter(Boolean);
      result.edges = [...touchedEdges].map((id) => state.edges.get(id)!).filter(Boolean);
      result.groups = [...touchedGroups].map((id) => state.groups.get(id)!).filter(Boolean);
      if (set.dryRun) throw new DryRun();
    }, { timeout: 20_000 });
  } catch (e) {
    if (!(e instanceof DryRun)) throw e;
  }

  if (!set.dryRun) {
    revalidateTag(tags.board(boardId), { expire: 0 });
    announceGraph(boardId, {
      nodes: result.nodes, edges: result.edges, groups: result.groups,
      deletedNodeIds: result.deleted.nodes, deletedEdgeIds: result.deleted.edges, deletedGroupIds: result.deleted.groups, by,
    });
  }
  return result;
}

// ── propose mode ─────────────────────────────────────────────────────────────────────────────────────
// Additions become one pending suggestion: they show up as ghosts on the owner's canvas and are accepted
// or discarded item by item, with credit to the agent. Edits/moves/deletes need mode "apply".
async function propose(principal: ApiPrincipal, boardId: string, ops: ChangeOp[], dryRun: boolean, by: string): Promise<ChangeResult> {
  await gate(principal, boardId, "board:view");
  const board = await getBoardFull(principal, boardId);
  const state: State = {
    nodes: new Map(board.nodes.map((n) => [n.id, n])),
    edges: new Map(),
    groups: new Map(board.groups.map((g) => [g.id, g])),
  };
  const refs = new Map<string, string>();
  const r = resolver(state, refs);
  const nodes: { tempId: string; type: string; x: number; y: number; width: number | null; height: number | null; data: Record<string, unknown> }[] = [];
  const edges: { source: string; target: string }[] = [];

  for (const [i, o] of ops.entries()) {
    if (o.op === "add_node") {
      if (!PROPOSE_TYPES.has(o.type)) throw new ApiError(422, `ops[${i}]: proposals can add text, swatch or link nodes; use mode "apply" for a ${o.type}`, "unsupported_in_propose");
      const data = cleanData(i, o.type, o.data ?? {});
      const dims = o.type === "swatch" ? { w: 120, h: 120 } : sizeOf(o.type, o.width, o.height, data);
      const parentId = o.parent ? r.node(i, o.parent) : null;
      const place = o.place ?? (o.group ? { in: o.group } : undefined);
      const pos = position(state, r, i, null, { x: o.x, y: o.y, place, parent: parentId }, dims.w, dims.h)!;
      const tempId = `agent-${i}-${randomBytes(4).toString("hex")}`;
      if (o.ref) {
        if (refs.has(o.ref)) throw new ApiError(422, `ops[${i}]: ref '${o.ref}' is already used in this batch`, "duplicate_ref");
        refs.set(o.ref, tempId);
      }
      // Ghosts count as occupied space so the next proposed node doesn't land on top of this one.
      state.nodes.set(tempId, { id: tempId, type: o.type, parentId: null, layout: "manual", collapsed: false, order: 0, x: pos.x, y: pos.y, width: o.type === "swatch" ? 120 : null, height: o.type === "swatch" ? 120 : null, zIndex: 0, data });
      nodes.push({ tempId, type: o.type, x: pos.x, y: pos.y, width: o.type === "swatch" ? 120 : null, height: o.type === "swatch" ? 120 : null, data });
    } else if (o.op === "add_edge") {
      const s = r.node(i, o.source), t = r.node(i, o.target);
      if (s === t) throw new ApiError(422, `ops[${i}]: a connector needs two different nodes`, "invalid_edge");
      edges.push({ source: s, target: t });
    } else {
      throw new ApiError(422, `ops[${i}]: proposals can only add_node and add_edge; use mode "apply" for ${o.op}`, "unsupported_in_propose");
    }
  }

  const proposal = normalizeProposal({ nodes, edges });
  if (!proposal) throw new ApiError(422, "A proposal needs 1–40 nodes and at most 80 connectors", "invalid_proposal");
  const result: ChangeResult = {
    mode: "propose", applied: false, refs: Object.fromEntries(refs), nodes: [], edges: [], groups: [],
    deleted: { nodes: [], edges: [], groups: [] },
  };
  if (dryRun) return { ...result, refs: Object.fromEntries(refs) };

  // Suggestions hang off the board's share. Boards that were never published get one that stays
  // unpublished: the public routes 404 on it, so it only carries proposals until the owner publishes.
  const share = (await prisma.publicShare.findFirst({ where: { boardId }, select: { id: true } }))
    ?? (await prisma.publicShare.create({ data: { boardId, secret: randomBytes(24).toString("base64url"), mode: "LIVE", isPublished: false }, select: { id: true } }));
  const sug = await prisma.suggestion.create({
    data: { shareId: share.id, status: "PENDING", payloadVersion: 2, authorName: by, payload: proposal as unknown as Prisma.InputJsonValue },
    select: { id: true },
  });
  revalidateTag(tags.suggestions(boardId), { expire: 0 });
  publishLive(boardId, JSON.stringify({ type: "sug", op: "upsert", suggestion: { id: sug.id, authorName: by, payload: proposal } }));
  return { ...result, suggestionId: sug.id };
}
