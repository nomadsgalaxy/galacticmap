"use server";

import { updateTag } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/app/lib/db";
import { getPrincipal } from "@/app/lib/session";
import { assertCan } from "@/app/lib/authz";
import { tags } from "@/app/lib/cache-tags";
import { parseNodeData, type SnapshotNode, type SnapshotEdge } from "@/app/lib/types";

export async function createNode(
  boardId: string,
  type: string,
  position: { x: number; y: number },
  data: Record<string, unknown>,
  parentId?: string | null,
): Promise<SnapshotNode> {
  await assertCan(await getPrincipal(), boardId, "node:edit");
  const clean = parseNodeData(type, data);
  // Default tile sizes so resizable nodes have an initial box (text auto-sizes).
  const dims =
    type === "swatch" ? { width: 120, height: 120 } : type === "image" ? { width: 220, height: 160 } : {};
  const node = await prisma.node.create({
    data: {
      boardId,
      type,
      layout: "manual",
      posX: position.x,
      posY: position.y,
      ...(parentId ? { parentId } : {}),
      ...dims,
      data: clean as Prisma.InputJsonValue,
    },
  });
  updateTag(tags.board(boardId));
  return {
    id: node.id,
    type: node.type,
    parentId: node.parentId,
    layout: node.layout,
    collapsed: node.collapsed,
    order: node.order,
    x: node.posX ?? 0,
    y: node.posY ?? 0,
    width: node.width,
    height: node.height,
    zIndex: node.zIndex,
    data: clean,
  };
}

export async function createEdge(
  boardId: string,
  sourceId: string,
  targetId: string,
  opts?: { sourceHandle?: string | null; targetHandle?: string | null },
): Promise<SnapshotEdge> {
  await assertCan(await getPrincipal(), boardId, "node:edit");
  // The chosen anchors live in the freeform edge.data (no schema column needed).
  const data: Record<string, unknown> = {};
  if (opts?.sourceHandle) data.sourceHandle = opts.sourceHandle;
  if (opts?.targetHandle) data.targetHandle = opts.targetHandle;
  const edge = await prisma.edge.create({
    data: {
      boardId, sourceId, targetId, kind: "connector", type: "animated", animated: true,
      ...(Object.keys(data).length ? { data: data as Prisma.InputJsonValue } : {}),
    },
  });
  updateTag(tags.board(boardId));
  return {
    id: edge.id,
    source: edge.sourceId,
    target: edge.targetId,
    kind: edge.kind,
    type: edge.type,
    animated: edge.animated,
    label: edge.label,
    data: (edge.data as Record<string, unknown>) ?? {},
  };
}

// Flip a connector's direction: swap its endpoints (and the anchors they attach to).
export async function swapEdgeEnds(boardId: string, edgeId: string): Promise<{ ok: true }> {
  await assertCan(await getPrincipal(), boardId, "node:edit");
  const edge = await prisma.edge.findFirst({
    where: { id: edgeId, boardId },
    select: { sourceId: true, targetId: true, data: true },
  });
  if (!edge) throw new Error("Edge not found");
  const d = (edge.data as Record<string, unknown>) ?? {};
  const data = { ...d, sourceHandle: d.targetHandle, targetHandle: d.sourceHandle };
  await prisma.edge.update({
    where: { id: edgeId },
    data: { sourceId: edge.targetId, targetId: edge.sourceId, data: data as Prisma.InputJsonValue },
  });
  updateTag(tags.board(boardId));
  return { ok: true };
}

// Re-point a connector's endpoint(s) when the user drags an edge end onto another node/anchor.
export async function reconnectEdge(
  boardId: string,
  edgeId: string,
  conn: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null },
): Promise<{ ok: true }> {
  await assertCan(await getPrincipal(), boardId, "node:edit");
  const edge = await prisma.edge.findFirst({ where: { id: edgeId, boardId }, select: { data: true } });
  if (!edge) throw new Error("Edge not found");
  const ids = [...new Set([conn.source, conn.target])];
  const found = await prisma.node.findMany({ where: { boardId, id: { in: ids } }, select: { id: true } });
  if (found.length !== ids.length) throw new Error("Endpoints must belong to this board");
  const d = (edge.data as Record<string, unknown>) ?? {};
  const data = { ...d, sourceHandle: conn.sourceHandle ?? undefined, targetHandle: conn.targetHandle ?? undefined };
  await prisma.edge.update({
    where: { id: edgeId },
    data: { sourceId: conn.source, targetId: conn.target, data: data as Prisma.InputJsonValue },
  });
  updateTag(tags.board(boardId));
  return { ok: true };
}

export async function deleteElements(
  boardId: string,
  nodeIds: string[],
  edgeIds: string[],
): Promise<{ ok: true }> {
  await assertCan(await getPrincipal(), boardId, "node:delete");
  await prisma.$transaction([
    prisma.edge.deleteMany({ where: { boardId, id: { in: edgeIds } } }),
    prisma.node.deleteMany({ where: { boardId, id: { in: nodeIds } } }),
  ]);
  updateTag(tags.board(boardId));
  return { ok: true };
}

export async function updateNodeData(
  boardId: string,
  nodeId: string,
  data: Record<string, unknown>,
): Promise<{ ok: true }> {
  await assertCan(await getPrincipal(), boardId, "node:edit");
  const node = await prisma.node.findFirst({ where: { id: nodeId, boardId }, select: { type: true, data: true } });
  if (!node) throw new Error("Node not found");
  // Merge into the existing data so partial edits (e.g. just tags) don't drop other fields.
  const merged = { ...((node.data as Record<string, unknown>) ?? {}), ...data };
  const clean = parseNodeData(node.type, merged);
  await prisma.node.update({
    where: { id: nodeId },
    data: { data: clean as Prisma.InputJsonValue },
  });
  updateTag(tags.board(boardId));
  return { ok: true };
}

// Detach (parentId=null) or re-parent a node. Validates the new parent belongs to the board and
// would not create a cycle (a node can't become a descendant of itself).
export async function setNodeParent(
  boardId: string,
  nodeId: string,
  parentId: string | null,
): Promise<{ ok: true }> {
  await assertCan(await getPrincipal(), boardId, "node:edit");
  if (parentId) {
    if (parentId === nodeId) throw new Error("A node cannot be its own parent");
    const rows = await prisma.node.findMany({ where: { boardId }, select: { id: true, parentId: true } });
    const byId = new Map(rows.map((r) => [r.id, r.parentId]));
    if (!byId.has(parentId)) throw new Error("Parent not in board");
    // walk up from the proposed parent; if we reach nodeId, it'd be a cycle
    let cur: string | null | undefined = parentId;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      if (cur === nodeId) throw new Error("Cannot parent a node to its own descendant");
      seen.add(cur);
      cur = byId.get(cur) ?? null;
    }
  }
  await prisma.node.updateMany({ where: { id: nodeId, boardId }, data: { parentId } });
  updateTag(tags.board(boardId));
  return { ok: true };
}

export async function toggleCollapse(
  boardId: string,
  nodeId: string,
  collapsed: boolean,
): Promise<{ ok: true }> {
  await assertCan(await getPrincipal(), boardId, "node:edit");
  await prisma.node.updateMany({ where: { id: nodeId, boardId }, data: { collapsed } });
  updateTag(tags.board(boardId));
  return { ok: true };
}

export async function updateEdgeLabel(
  boardId: string,
  edgeId: string,
  label: string,
): Promise<{ ok: true }> {
  await assertCan(await getPrincipal(), boardId, "node:edit");
  await prisma.edge.updateMany({ where: { id: edgeId, boardId }, data: { label: label.slice(0, 120) || null } });
  updateTag(tags.board(boardId));
  return { ok: true };
}

// Connector design: merge style fields into edge.data + toggle animated. `data` carries
// color/width/lineStyle/routing/arrow/flowSpeed (consumed by AnimatedEdge); `animated` mirrors
// lineStyle==="flow" so React Flow's own dash animation stays in sync.
export async function updateEdgeStyle(
  boardId: string,
  edgeId: string,
  patch: { data?: Record<string, unknown>; animated?: boolean },
): Promise<{ ok: true }> {
  await assertCan(await getPrincipal(), boardId, "node:edit");
  const edge = await prisma.edge.findFirst({ where: { id: edgeId, boardId }, select: { data: true } });
  if (!edge) throw new Error("Edge not found");
  const merged = { ...((edge.data as Record<string, unknown>) ?? {}), ...(patch.data ?? {}) };
  await prisma.edge.update({
    where: { id: edgeId },
    data: {
      data: merged as Prisma.InputJsonValue,
      ...(patch.animated !== undefined ? { animated: patch.animated } : {}),
    },
  });
  updateTag(tags.board(boardId));
  return { ok: true };
}

// Full-graph reconcile (used by undo/redo): make the DB match the given node/edge set.
type SyncNode = {
  id: string;
  type: string;
  x: number;
  y: number;
  width?: number | null;
  height?: number | null;
  zIndex?: number;
  data?: Record<string, unknown>;
};
type SyncEdge = {
  id: string;
  source: string;
  target: string;
  type: string;
  animated: boolean;
  label?: string | null;
  data?: Record<string, unknown>;
};
const asJson = (v: unknown) => (v == null ? undefined : (v as Prisma.InputJsonValue));

export async function syncBoardGraph(
  boardId: string,
  nodes: SyncNode[],
  edges: SyncEdge[],
): Promise<{ ok: true }> {
  await assertCan(await getPrincipal(), boardId, "node:edit");
  // Node.id/Edge.id are global PKs, so an upsert by {id} could match (and overwrite) another
  // board's row. Drop any incoming id already owned by a DIFFERENT board (IDOR guard).
  const inNodeIds = nodes.map((n) => n.id);
  const inEdgeIds = edges.map((e) => e.id);
  const [foreignNodes, foreignEdges] = await Promise.all([
    inNodeIds.length ? prisma.node.findMany({ where: { id: { in: inNodeIds }, NOT: { boardId } }, select: { id: true } }) : Promise.resolve([]),
    inEdgeIds.length ? prisma.edge.findMany({ where: { id: { in: inEdgeIds }, NOT: { boardId } }, select: { id: true } }) : Promise.resolve([]),
  ]);
  const blockNode = new Set(foreignNodes.map((n) => n.id));
  const blockEdge = new Set(foreignEdges.map((e) => e.id));
  const safeNodes = nodes.filter((n) => !blockNode.has(n.id));
  const safeEdges = edges.filter((e) => !blockEdge.has(e.id));
  const nodeIds = safeNodes.map((n) => n.id);
  const edgeIds = safeEdges.map((e) => e.id);
  await prisma.$transaction([
    prisma.edge.deleteMany({ where: { boardId, id: { notIn: edgeIds.length ? edgeIds : ["__none__"] } } }),
    prisma.node.deleteMany({ where: { boardId, id: { notIn: nodeIds.length ? nodeIds : ["__none__"] } } }),
    ...safeNodes.map((n) =>
      prisma.node.upsert({
        where: { id: n.id },
        create: {
          id: n.id,
          boardId,
          type: n.type,
          layout: "manual",
          posX: n.x,
          posY: n.y,
          width: n.width ?? null,
          height: n.height ?? null,
          zIndex: n.zIndex ?? 0,
          data: asJson(n.data),
        },
        update: {
          type: n.type,
          posX: n.x,
          posY: n.y,
          width: n.width ?? null,
          height: n.height ?? null,
          zIndex: n.zIndex ?? 0,
          data: asJson(n.data),
        },
      }),
    ),
    ...safeEdges.map((e) =>
      prisma.edge.upsert({
        where: { id: e.id },
        create: {
          id: e.id,
          boardId,
          sourceId: e.source,
          targetId: e.target,
          kind: "connector",
          type: e.type,
          animated: e.animated,
          label: e.label ?? null,
          data: asJson(e.data),
        },
        update: {
          sourceId: e.source,
          targetId: e.target,
          type: e.type,
          animated: e.animated,
          label: e.label ?? null,
          data: asJson(e.data),
        },
      }),
    ),
  ]);
  updateTag(tags.board(boardId));
  return { ok: true };
}
