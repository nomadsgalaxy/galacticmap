"use server";

import { updateTag } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/app/lib/db";
import { getPrincipal } from "@/app/lib/session";
import { assertCan } from "@/app/lib/authz";
import { tags as cacheTags } from "@/app/lib/cache-tags";

const normTags = (arr: unknown): string[] =>
  Array.isArray(arr)
    ? [...new Set(arr.map((t) => String(t).trim()).filter(Boolean).map((t) => t.slice(0, 40)))].slice(0, 50)
    : [];

/** Union the given tags into each node's data.tags (used by branch-tag + multi-select-tag). */
export async function addTagsToNodes(
  boardId: string,
  nodeIds: string[],
  newTags: string[],
): Promise<{ ok: true }> {
  await assertCan(await getPrincipal(), boardId, "node:edit");
  const clean = normTags(newTags);
  if (clean.length === 0 || nodeIds.length === 0) return { ok: true };
  const rows = await prisma.node.findMany({
    where: { id: { in: nodeIds }, boardId },
    select: { id: true, data: true },
  });
  await prisma.$transaction(
    rows.map((r) => {
      const data = (r.data as Record<string, unknown>) ?? {};
      const merged = normTags([...(Array.isArray(data.tags) ? data.tags : []), ...clean]);
      return prisma.node.update({
        where: { id: r.id },
        data: { data: { ...data, tags: merged } as Prisma.InputJsonValue },
      });
    }),
  );
  updateTag(cacheTags.board(boardId));
  return { ok: true };
}

export async function removeTagFromNodes(
  boardId: string,
  nodeIds: string[],
  tag: string,
): Promise<{ ok: true }> {
  await assertCan(await getPrincipal(), boardId, "node:edit");
  const rows = await prisma.node.findMany({ where: { id: { in: nodeIds }, boardId }, select: { id: true, data: true } });
  await prisma.$transaction(
    rows.map((r) => {
      const data = (r.data as Record<string, unknown>) ?? {};
      const next = (Array.isArray(data.tags) ? data.tags : []).filter((t) => t !== tag);
      return prisma.node.update({ where: { id: r.id }, data: { data: { ...data, tags: next } as Prisma.InputJsonValue } });
    }),
  );
  updateTag(cacheTags.board(boardId));
  return { ok: true };
}

export type GroupDTO = {
  id: string;
  label: string | null;
  color: string | null;
  tags: string[];
  nodeIds: string[];
};

function toGroupDTO(g: { id: string; label: string | null; color: string | null; tags: unknown; nodeIds: unknown }): GroupDTO {
  return {
    id: g.id,
    label: g.label,
    color: g.color,
    tags: Array.isArray(g.tags) ? (g.tags as string[]) : [],
    nodeIds: Array.isArray(g.nodeIds) ? (g.nodeIds as string[]) : [],
  };
}

/** Create a named "cloud" group around the given member nodes. */
export async function createGroup(
  boardId: string,
  nodeIds: string[],
  label?: string,
  color?: string,
): Promise<GroupDTO> {
  await assertCan(await getPrincipal(), boardId, "node:edit");
  // keep only member ids that belong to this board
  const valid = await prisma.node.findMany({ where: { id: { in: nodeIds }, boardId }, select: { id: true } });
  const ids = valid.map((n) => n.id);
  const g = await prisma.nodeGroup.create({
    data: {
      boardId,
      label: label?.trim().slice(0, 80) || null,
      color: color ?? null,
      tags: [] as unknown as Prisma.InputJsonValue,
      nodeIds: ids as unknown as Prisma.InputJsonValue,
    },
  });
  updateTag(cacheTags.board(boardId));
  return toGroupDTO(g);
}

export async function updateGroup(
  boardId: string,
  groupId: string,
  patch: { label?: string | null; color?: string | null; tags?: string[]; nodeIds?: string[] },
): Promise<GroupDTO> {
  await assertCan(await getPrincipal(), boardId, "node:edit");
  const data: Prisma.NodeGroupUpdateManyMutationInput = {};
  if (patch.label !== undefined) data.label = patch.label?.slice(0, 80) || null;
  if (patch.color !== undefined) data.color = patch.color;
  if (patch.tags !== undefined) data.tags = normTags(patch.tags) as unknown as Prisma.InputJsonValue;
  if (patch.nodeIds !== undefined) {
    // never trust client nodeIds — keep only members that belong to THIS board
    const valid = await prisma.node.findMany({ where: { id: { in: patch.nodeIds }, boardId }, select: { id: true } });
    data.nodeIds = valid.map((n) => n.id) as unknown as Prisma.InputJsonValue;
  }
  // Scope the write to {id, boardId} so a member of board A can't mutate board B's group (IDOR).
  const res = await prisma.nodeGroup.updateMany({ where: { id: groupId, boardId }, data });
  if (res.count === 0) throw new Error("Group not found");
  const g = await prisma.nodeGroup.findUniqueOrThrow({
    where: { id: groupId },
    select: { id: true, label: true, color: true, tags: true, nodeIds: true },
  });
  updateTag(cacheTags.board(boardId));
  return toGroupDTO(g);
}

export async function deleteGroup(boardId: string, groupId: string): Promise<{ ok: true }> {
  await assertCan(await getPrincipal(), boardId, "node:edit");
  await prisma.nodeGroup.deleteMany({ where: { id: groupId, boardId } });
  updateTag(cacheTags.board(boardId));
  return { ok: true };
}
