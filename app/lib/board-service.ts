import { revalidateTag } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/app/lib/db";
import { authorize, type Principal, type Role } from "@/app/lib/authz";
import { tags } from "@/app/lib/cache-tags";
import { serializeNode, serializeEdge } from "@/app/lib/boards";
import { NODE_TYPES, parseNodeData, type SnapshotNode, type SnapshotEdge } from "@/app/lib/types";

// Headless board service used by the REST API (#14) and the MCP server.
//
// This is deliberately NOT a "use server" module: it takes an explicit Principal (resolved from
// an API token rather than a session) and is callable from Route Handlers. It shares the exact
// same authority path as the editor — authorize()/GRANTS, parseNodeData(), cache tags — so the
// public API can never do anything the RBAC layer wouldn't allow in the UI. The editor's own
// "use server" actions keep their updateTag() read-your-writes semantics; route handlers use
// revalidateTag(tag,'max') (stale-while-revalidate) per Next 16, so the two paths invalidate
// the same tags but with the invalidation primitive correct for each caller.

/** Typed error carrying an HTTP status so route handlers can map cleanly. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "error",
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Resolve role + assert a capability; throws ApiError(403) on deny, ApiError(404) if no membership. */
async function gate(principal: Principal, boardId: string, cap: Parameters<typeof authorize>[2]): Promise<Role> {
  const res = await authorize(principal, boardId, cap);
  if (!res.role) throw new ApiError(404, "Board not found", "not_found"); // hide existence from non-members
  if (!res.ok) throw new ApiError(403, `Forbidden: ${cap}`, "forbidden");
  return res.role;
}

// ───────────────────────────── Boards ─────────────────────────────

export async function listBoards(principal: Principal) {
  if (!principal) throw new ApiError(401, "Unauthorized", "unauthorized");
  const rows = await prisma.board.findMany({
    where: { memberships: { some: { userId: principal.userId } } },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      publicId: true,
      title: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { nodes: true, edges: true } },
      memberships: { where: { userId: principal.userId }, select: { role: true } },
    },
  });
  return rows.map((b) => ({
    id: b.id,
    publicId: b.publicId,
    title: b.title,
    role: b.memberships[0]?.role ?? null,
    nodeCount: b._count.nodes,
    edgeCount: b._count.edges,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  }));
}

export async function createBoardSvc(principal: Principal, title?: string) {
  if (!principal) throw new ApiError(401, "Unauthorized", "unauthorized");
  const clean = (title?.trim() || "Untitled board").slice(0, 200);
  const board = await prisma.$transaction(async (tx) => {
    const b = await tx.board.create({ data: { title: clean, userId: principal.userId } });
    await tx.boardMembership.create({ data: { userId: principal.userId, boardId: b.id, role: "OWNER" } });
    return b;
  });
  revalidateTag(tags.boardsList(), "max");
  return { id: board.id, publicId: board.publicId, title: board.title, role: "OWNER" as const };
}

export async function getBoardFull(principal: Principal, boardId: string) {
  await gate(principal, boardId, "board:view");
  const board = await prisma.board.findUnique({
    where: { id: boardId },
    select: {
      id: true,
      publicId: true,
      title: true,
      settings: true,
      createdAt: true,
      updatedAt: true,
      nodes: {
        select: {
          id: true, type: true, parentId: true, layout: true, collapsed: true, order: true,
          posX: true, posY: true, width: true, height: true, zIndex: true, data: true,
        },
      },
      edges: {
        select: { id: true, sourceId: true, targetId: true, kind: true, type: true, animated: true, label: true, data: true },
      },
    },
  });
  if (!board) throw new ApiError(404, "Board not found", "not_found");
  const nodes = board.nodes.map(serializeNode);
  const edges = board.edges.map(serializeEdge);
  return {
    id: board.id,
    publicId: board.publicId,
    title: board.title,
    createdAt: board.createdAt.toISOString(),
    updatedAt: board.updatedAt.toISOString(),
    nodes,
    edges,
  };
}

// ───────────────────────────── Nodes ─────────────────────────────

export type CreateNodeInput = {
  type: string;
  x?: number;
  y?: number;
  data?: Record<string, unknown>;
  parentId?: string | null;
};

export async function createNodeSvc(principal: Principal, boardId: string, input: CreateNodeInput): Promise<SnapshotNode> {
  await gate(principal, boardId, "node:edit");
  if (!(NODE_TYPES as readonly string[]).includes(input.type)) {
    throw new ApiError(422, `Unknown node type '${input.type}'. Expected one of: ${NODE_TYPES.join(", ")}.`, "invalid_type");
  }
  const clean = parseNodeData(input.type, input.data ?? {}); // throws ZodError -> mapped to 400
  if (input.parentId) {
    const parent = await prisma.node.findFirst({ where: { id: input.parentId, boardId }, select: { id: true } });
    if (!parent) throw new ApiError(422, "parentId does not belong to this board", "invalid_parent");
  }
  const dims = input.type === "swatch" ? { width: 120, height: 120 } : input.type === "image" ? { width: 220, height: 160 } : {};
  const node = await prisma.node.create({
    data: {
      boardId,
      type: input.type,
      layout: "manual",
      posX: input.x ?? 0,
      posY: input.y ?? 0,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      ...dims,
      data: clean as Prisma.InputJsonValue,
    },
  });
  revalidateTag(tags.board(boardId), "max");
  return serializeNode(node);
}

export type UpdateNodeInput = {
  data?: Record<string, unknown>;
  x?: number;
  y?: number;
  width?: number | null;
  height?: number | null;
  parentId?: string | null;
  collapsed?: boolean;
};

export async function updateNodeSvc(
  principal: Principal,
  boardId: string,
  nodeId: string,
  input: UpdateNodeInput,
): Promise<SnapshotNode> {
  await gate(principal, boardId, "node:edit");
  const node = await prisma.node.findFirst({ where: { id: nodeId, boardId }, select: { type: true, data: true } });
  if (!node) throw new ApiError(404, "Node not found", "not_found");
  const patch: Prisma.NodeUpdateInput = {};
  if (input.data !== undefined) {
    const merged = { ...((node.data as Record<string, unknown>) ?? {}), ...input.data };
    patch.data = parseNodeData(node.type, merged) as Prisma.InputJsonValue;
  }
  if (input.x !== undefined) patch.posX = input.x;
  if (input.y !== undefined) patch.posY = input.y;
  if (input.width !== undefined) patch.width = input.width;
  if (input.height !== undefined) patch.height = input.height;
  if (input.collapsed !== undefined) patch.collapsed = input.collapsed;
  if (input.parentId !== undefined) {
    if (input.parentId === nodeId) throw new ApiError(422, "A node cannot be its own parent", "invalid_parent");
    if (input.parentId) {
      const parent = await prisma.node.findFirst({ where: { id: input.parentId, boardId }, select: { id: true } });
      if (!parent) throw new ApiError(422, "parentId does not belong to this board", "invalid_parent");
    }
    patch.parent = input.parentId ? { connect: { id: input.parentId } } : { disconnect: true };
  }
  const updated = await prisma.node.update({ where: { id: nodeId }, data: patch });
  revalidateTag(tags.board(boardId), "max");
  return serializeNode(updated);
}

export async function deleteNodeSvc(principal: Principal, boardId: string, nodeId: string): Promise<void> {
  await gate(principal, boardId, "node:delete");
  const res = await prisma.node.deleteMany({ where: { id: nodeId, boardId } });
  if (res.count === 0) throw new ApiError(404, "Node not found", "not_found");
  revalidateTag(tags.board(boardId), "max");
}

// ───────────────────────────── Edges (connectors) ─────────────────────────────

export type CreateEdgeInput = { sourceId: string; targetId: string; label?: string | null };

export async function createEdgeSvc(principal: Principal, boardId: string, input: CreateEdgeInput): Promise<SnapshotEdge> {
  await gate(principal, boardId, "node:edit");
  if (input.sourceId === input.targetId) throw new ApiError(422, "sourceId and targetId must differ", "invalid_edge");
  const endpoints = await prisma.node.findMany({
    where: { boardId, id: { in: [input.sourceId, input.targetId] } },
    select: { id: true },
  });
  if (endpoints.length !== 2) throw new ApiError(422, "sourceId/targetId must both belong to this board", "invalid_edge");
  const edge = await prisma.edge.create({
    data: {
      boardId, sourceId: input.sourceId, targetId: input.targetId, kind: "connector", type: "animated", animated: true,
      label: input.label ? input.label.slice(0, 120) : null,
    },
  });
  revalidateTag(tags.board(boardId), "max");
  return serializeEdge(edge);
}

export async function deleteEdgeSvc(principal: Principal, boardId: string, edgeId: string): Promise<void> {
  await gate(principal, boardId, "node:delete");
  const res = await prisma.edge.deleteMany({ where: { id: edgeId, boardId } });
  if (res.count === 0) throw new ApiError(404, "Edge not found", "not_found");
  revalidateTag(tags.board(boardId), "max");
}
