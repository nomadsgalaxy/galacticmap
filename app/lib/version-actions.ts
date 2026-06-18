"use server";

import { updateTag } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/app/lib/db";
import { getPrincipal } from "@/app/lib/session";
import { assertCan } from "@/app/lib/authz";
import { tags } from "@/app/lib/cache-tags";
import type { SnapshotNode, SnapshotEdge } from "@/app/lib/types";

const MAX_VERSIONS = 30; // keep storage bounded; oldest unnamed trimmed past this

type GroupSnap = { label: string | null; color: string | null; tags: string[]; nodeIds: string[] };
type Graph = { nodes: SnapshotNode[]; edges: SnapshotEdge[]; groups?: GroupSnap[] };

async function readGraph(boardId: string): Promise<Graph> {
  const board = await prisma.board.findUnique({
    where: { id: boardId },
    select: {
      nodes: {
        select: {
          id: true, type: true, parentId: true, layout: true, collapsed: true, order: true,
          posX: true, posY: true, width: true, height: true, zIndex: true, data: true, style: true,
        },
      },
      edges: { select: { id: true, sourceId: true, targetId: true, kind: true, type: true, animated: true, label: true, data: true, style: true } },
      groups: { select: { label: true, color: true, tags: true, nodeIds: true } },
    },
  });
  if (!board) throw new Error("Board not found");
  return {
    nodes: board.nodes.map((n) => ({
      id: n.id, type: n.type, parentId: n.parentId, layout: n.layout, collapsed: n.collapsed, order: n.order,
      x: n.posX ?? 0, y: n.posY ?? 0, width: n.width, height: n.height, zIndex: n.zIndex,
      data: (n.data as Record<string, unknown>) ?? {}, style: (n.style as Record<string, unknown>) ?? null,
    })),
    edges: board.edges.map((e) => ({
      id: e.id, source: e.sourceId, target: e.targetId, kind: e.kind, type: e.type, animated: e.animated,
      label: e.label, data: (e.data as Record<string, unknown>) ?? {}, style: (e.style as Record<string, unknown>) ?? null,
    })),
    groups: board.groups.map((g) => ({
      label: g.label, color: g.color,
      tags: Array.isArray(g.tags) ? (g.tags as string[]) : [],
      nodeIds: Array.isArray(g.nodeIds) ? (g.nodeIds as string[]) : [],
    })),
  };
}

/** Snapshot the current board graph as a named/unnamed version. */
export async function saveVersion(boardId: string, label?: string): Promise<{ ok: true }> {
  await assertCan(await getPrincipal(), boardId, "node:edit");
  const principal = await getPrincipal();
  const graph = await readGraph(boardId);
  await prisma.boardVersion.create({
    data: {
      boardId,
      label: label?.trim().slice(0, 120) || null,
      snapshot: graph as unknown as Prisma.InputJsonValue,
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      createdBy: principal?.userId ?? null,
    },
  });
  // Trim oldest UNNAMED versions beyond the cap (keep named ones).
  const all = await prisma.boardVersion.findMany({
    where: { boardId },
    orderBy: { createdAt: "desc" },
    select: { id: true, label: true },
  });
  if (all.length > MAX_VERSIONS) {
    const trimmable = all.slice(MAX_VERSIONS).filter((v) => !v.label).map((v) => v.id);
    if (trimmable.length) await prisma.boardVersion.deleteMany({ where: { id: { in: trimmable } } });
  }
  updateTag(tags.boardMeta(boardId));
  return { ok: true };
}

export async function listVersions(boardId: string) {
  await assertCan(await getPrincipal(), boardId, "board:view");
  return prisma.boardVersion.findMany({
    where: { boardId },
    orderBy: { createdAt: "desc" },
    select: { id: true, label: true, nodeCount: true, edgeCount: true, createdAt: true },
  });
}

/** Replace the board's entire graph with a stored version (full restore / time-travel). */
export async function restoreVersion(boardId: string, versionId: string): Promise<{ ok: true }> {
  await assertCan(await getPrincipal(), boardId, "node:edit");
  const version = await prisma.boardVersion.findFirst({
    where: { id: versionId, boardId },
    select: { snapshot: true },
  });
  if (!version) throw new Error("Version not found");
  const graph = version.snapshot as unknown as Graph;
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const groups = Array.isArray(graph.groups) ? graph.groups : [];
  const nodeIds = new Set(nodes.map((n) => n.id));

  await prisma.$transaction(async (tx) => {
    // Wipe current graph + groups (NodeGroup has no FK to Node, so wipe it explicitly).
    await tx.edge.deleteMany({ where: { boardId } });
    await tx.node.deleteMany({ where: { boardId } });
    await tx.nodeGroup.deleteMany({ where: { boardId } });
    // Recreate nodes with parentId=null first (avoids self-FK ordering issues)...
    for (const n of nodes) {
      await tx.node.create({
        data: {
          id: n.id, boardId, type: n.type, layout: n.layout ?? "manual", collapsed: !!n.collapsed,
          order: n.order ?? 0, posX: n.x, posY: n.y, width: n.width ?? null, height: n.height ?? null,
          zIndex: n.zIndex ?? 0, data: (n.data ?? {}) as Prisma.InputJsonValue,
          style: (n.style ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
    }
    // ...then re-link valid parents (never self-parent — would hang client tree traversals).
    for (const n of nodes) {
      if (n.parentId && n.parentId !== n.id && nodeIds.has(n.parentId)) {
        await tx.node.update({ where: { id: n.id }, data: { parentId: n.parentId } });
      }
    }
    // Recreate connector edges whose endpoints survived.
    for (const e of edges) {
      if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
      await tx.edge.create({
        data: {
          id: e.id, boardId, sourceId: e.source, targetId: e.target, kind: e.kind ?? "connector",
          type: e.type ?? "animated", animated: e.animated ?? true, label: e.label ?? null,
          data: (e.data ?? {}) as Prisma.InputJsonValue,
          style: (e.style ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
    }
    // Recreate cloud groups, pruning member ids that didn't survive.
    for (const g of groups) {
      const members = (Array.isArray(g.nodeIds) ? g.nodeIds : []).filter((id) => nodeIds.has(id));
      await tx.nodeGroup.create({
        data: {
          boardId, label: g.label ?? null, color: g.color ?? null,
          tags: (Array.isArray(g.tags) ? g.tags : []) as unknown as Prisma.InputJsonValue,
          nodeIds: members as unknown as Prisma.InputJsonValue,
        },
      });
    }
  });
  updateTag(tags.board(boardId));
  return { ok: true };
}

export async function deleteVersion(boardId: string, versionId: string): Promise<{ ok: true }> {
  await assertCan(await getPrincipal(), boardId, "node:edit");
  await prisma.boardVersion.deleteMany({ where: { id: versionId, boardId } });
  updateTag(tags.boardMeta(boardId));
  return { ok: true };
}
