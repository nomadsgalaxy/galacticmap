import { cacheLife, cacheTag } from "next/cache";
import { prisma } from "@/app/lib/db";
import { tags } from "@/app/lib/cache-tags";
import type { SnapshotNode, SnapshotEdge } from "@/app/lib/types";

// Prisma row -> plain serializable snapshot (no Date/Json objects leaking to the client).
type NodeRow = {
  id: string;
  type: string;
  parentId: string | null;
  layout: string;
  collapsed: boolean;
  order: number;
  posX: number | null;
  posY: number | null;
  width: number | null;
  height: number | null;
  zIndex: number;
  data: unknown;
};
type EdgeRow = {
  id: string;
  sourceId: string;
  targetId: string;
  kind: string;
  type: string;
  animated: boolean;
  label: string | null;
  data: unknown;
};

export function serializeNode(n: NodeRow): SnapshotNode {
  return {
    id: n.id,
    type: n.type,
    parentId: n.parentId,
    layout: n.layout,
    collapsed: n.collapsed,
    order: n.order,
    x: n.posX ?? 0,
    y: n.posY ?? 0,
    width: n.width,
    height: n.height,
    zIndex: n.zIndex,
    data: (n.data as Record<string, unknown>) ?? {},
  };
}

export function serializeEdge(e: EdgeRow): SnapshotEdge {
  return {
    id: e.id,
    source: e.sourceId,
    target: e.targetId,
    kind: e.kind,
    type: e.type,
    animated: e.animated,
    label: e.label,
    data: (e.data as Record<string, unknown>) ?? {},
  };
}

/** Title/settings only — disjoint cache tag so a rename doesn't bust the graph cache. */
export async function getBoardMeta(id: string) {
  "use cache";
  cacheLife("hours");
  cacheTag(tags.boardMeta(id));
  return prisma.board.findUnique({
    where: { id },
    select: { id: true, title: true, settings: true },
  });
}

/** Nodes + (connector) edges as a plain snapshot. Tree edges are derived client-side (Phase 3). */
export async function getBoardGraph(
  id: string,
): Promise<{ nodes: SnapshotNode[]; edges: SnapshotEdge[] } | null> {
  "use cache";
  cacheLife("hours");
  cacheTag(tags.board(id));
  const board = await prisma.board.findUnique({
    where: { id },
    select: {
      id: true,
      nodes: {
        select: {
          id: true,
          type: true,
          parentId: true,
          layout: true,
          collapsed: true,
          order: true,
          posX: true,
          posY: true,
          width: true,
          height: true,
          zIndex: true,
          data: true,
        },
      },
      edges: {
        select: {
          id: true,
          sourceId: true,
          targetId: true,
          kind: true,
          type: true,
          animated: true,
          label: true,
          data: true,
        },
      },
    },
  });
  if (!board) return null;
  return { nodes: board.nodes.map(serializeNode), edges: board.edges.map(serializeEdge) };
}

/** Named cloud groups for a board (shares the board cache tag so tagging busts it). */
export async function getBoardGroups(id: string) {
  "use cache";
  cacheLife("hours");
  cacheTag(tags.board(id));
  const rows = await prisma.nodeGroup.findMany({
    where: { boardId: id },
    orderBy: { createdAt: "asc" },
    select: { id: true, label: true, color: true, tags: true, nodeIds: true },
  });
  return rows.map((g) => ({
    id: g.id,
    label: g.label,
    color: g.color,
    tags: Array.isArray(g.tags) ? (g.tags as string[]) : [],
    nodeIds: Array.isArray(g.nodeIds) ? (g.nodeIds as string[]) : [],
  }));
}

/** The user's role on a board (or null if not a member). */
export async function getUserRole(userId: string, boardId: string) {
  const m = await prisma.boardMembership.findUnique({
    where: { userId_boardId: { userId, boardId } },
    select: { role: true },
  });
  return m?.role ?? null;
}

export async function getShareStatus(boardId: string) {
  return prisma.publicShare.findFirst({
    where: { boardId },
    select: { secret: true, isPublished: true, suggestionsOpen: true },
  });
}

export async function listMembers(boardId: string) {
  return prisma.boardMembership.findMany({
    where: { boardId },
    orderBy: { createdAt: "asc" },
    select: { userId: true, role: true, user: { select: { email: true, name: true } } },
  });
}

export async function listInvitations(boardId: string) {
  return prisma.invitation.findMany({
    where: { boardId, acceptedAt: null },
    orderBy: { createdAt: "desc" },
    select: { email: true, role: true, token: true, expiresAt: true },
  });
}

/** Boards the user is a member of (per-user, dynamic — call inside <Suspense>). */
export async function listBoardsForUser(userId: string) {
  return prisma.board.findMany({
    where: { memberships: { some: { userId } } },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      updatedAt: true,
      _count: { select: { nodes: true } },
      memberships: { where: { userId }, select: { role: true } },
    },
  });
}
