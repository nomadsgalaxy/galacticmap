"use server";

import { updateTag } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/app/lib/db";
import { getPrincipal } from "@/app/lib/session";
import { assertCan } from "@/app/lib/authz";
import { tags } from "@/app/lib/cache-tags";
import { parseNodeData, type SnapshotNode } from "@/app/lib/types";
import { generateMindMap, expandNodeIdeas, summarizeTexts } from "@/app/lib/ai";

const toSnapshot = (n: {
  id: string; type: string; parentId: string | null; layout: string; collapsed: boolean; order: number;
  posX: number | null; posY: number | null; width: number | null; height: number | null; zIndex: number; data: unknown;
}): SnapshotNode => ({
  id: n.id, type: n.type, parentId: n.parentId, layout: n.layout, collapsed: n.collapsed, order: n.order,
  x: n.posX ?? 0, y: n.posY ?? 0, width: n.width, height: n.height, zIndex: n.zIndex,
  data: (n.data as Record<string, unknown>) ?? {},
});

async function createTextNode(
  boardId: string,
  text: string,
  pos: { x: number; y: number },
  parentId: string | null,
): Promise<SnapshotNode> {
  const data = parseNodeData("text", { text });
  const node = await prisma.node.create({
    data: {
      boardId, type: "text", layout: "manual", posX: pos.x, posY: pos.y,
      ...(parentId ? { parentId } : {}), data: data as Prisma.InputJsonValue,
    },
  });
  return toSnapshot(node);
}

/**
 * Generate a mind-map from a prompt and insert it as a parentId tree anchored near `anchor`.
 * Positions are a simple depth/column layout; the user can hit Tidy to dagre-lay it out.
 */
export async function generateMap(
  boardId: string,
  prompt: string,
  anchor: { x: number; y: number },
): Promise<SnapshotNode[]> {
  await assertCan(await getPrincipal(), boardId, "node:edit");
  const clean = prompt.trim().slice(0, 500);
  if (!clean) throw new Error("Enter a topic.");
  const ai = await generateMindMap(clean);

  // depth + per-depth ordering for a readable column layout
  const byId = new Map(ai.map((n) => [n.id, n]));
  const depthOf = (id: string): number => {
    let d = 0;
    let cur = byId.get(id);
    const seen = new Set<string>();
    while (cur && cur.parent && !seen.has(cur.id)) {
      seen.add(cur.id);
      d++;
      cur = byId.get(cur.parent);
    }
    return d;
  };
  const perDepth = new Map<number, number>();
  const pos = new Map<string, { x: number; y: number }>();
  // stable order: roots first then by original order
  const ordered = [...ai].sort((a, b) => depthOf(a.id) - depthOf(b.id));
  for (const n of ordered) {
    const d = depthOf(n.id);
    const i = perDepth.get(d) ?? 0;
    perDepth.set(d, i + 1);
    pos.set(n.id, { x: anchor.x + d * 260, y: anchor.y + i * 110 });
  }

  // BFS create so a parent's real id exists before its children
  const tempToReal = new Map<string, string>();
  const created: SnapshotNode[] = [];
  const childrenOf = new Map<string | null, string[]>();
  for (const n of ai) {
    const key = n.parent;
    (childrenOf.get(key) ?? childrenOf.set(key, []).get(key)!).push(n.id);
  }
  const queue: Array<{ id: string; parentTemp: string | null }> = (childrenOf.get(null) ?? []).map((id) => ({ id, parentTemp: null }));
  while (queue.length) {
    const { id, parentTemp } = queue.shift()!;
    const node = byId.get(id)!;
    const parentReal = parentTemp ? tempToReal.get(parentTemp) ?? null : null;
    const snap = await createTextNode(boardId, node.label, pos.get(id) ?? anchor, parentReal);
    tempToReal.set(id, snap.id);
    created.push(snap);
    for (const childId of childrenOf.get(id) ?? []) queue.push({ id: childId, parentTemp: id });
  }

  updateTag(tags.board(boardId));
  return created;
}

/** Expand a node into AI-suggested child nodes (parented to it). */
export async function expandNodeAI(boardId: string, nodeId: string): Promise<SnapshotNode[]> {
  await assertCan(await getPrincipal(), boardId, "node:edit");
  const node = await prisma.node.findFirst({
    where: { id: nodeId, boardId },
    select: { id: true, type: true, posX: true, posY: true, width: true, data: true },
  });
  if (!node) throw new Error("Node not found");
  const label =
    node.type === "text" ? String((node.data as { text?: string })?.text ?? "") : node.type;
  const existing = await prisma.node.findMany({
    where: { boardId, parentId: nodeId },
    select: { data: true, type: true },
  });
  const siblingLabels = existing
    .map((c) => (c.type === "text" ? String((c.data as { text?: string })?.text ?? "") : ""))
    .filter(Boolean);

  const ideas = await expandNodeIdeas(label || "this idea", siblingLabels);
  if (ideas.length === 0) throw new Error("No suggestions.");

  const baseX = (node.posX ?? 0) + (typeof node.width === "number" ? node.width : 180) + 80;
  const baseY = (node.posY ?? 0) - ((ideas.length - 1) * 110) / 2;
  const created: SnapshotNode[] = [];
  for (let i = 0; i < ideas.length; i++) {
    created.push(await createTextNode(boardId, ideas[i], { x: baseX, y: baseY + i * 110 }, nodeId));
  }
  updateTag(tags.board(boardId));
  return created;
}

/** Summarize a node's whole subtree (or itself) into a new text node placed beside it. */
export async function summarizeBranch(boardId: string, nodeId: string): Promise<SnapshotNode> {
  await assertCan(await getPrincipal(), boardId, "node:edit");
  const all = await prisma.node.findMany({
    where: { boardId },
    select: { id: true, parentId: true, type: true, posX: true, posY: true, data: true },
  });
  const childrenOf = new Map<string, string[]>();
  for (const n of all) if (n.parentId) (childrenOf.get(n.parentId) ?? childrenOf.set(n.parentId, []).get(n.parentId)!).push(n.id);
  const byId = new Map(all.map((n) => [n.id, n]));
  const root = byId.get(nodeId);
  if (!root) throw new Error("Node not found");

  // gather subtree text (root + descendants)
  const texts: string[] = [];
  const stack = [nodeId];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = byId.get(id);
    if (n?.type === "text") {
      const t = String((n.data as { text?: string })?.text ?? "").trim();
      if (t) texts.push(t);
    }
    for (const c of childrenOf.get(id) ?? []) stack.push(c);
  }
  if (texts.length === 0) throw new Error("Nothing to summarize (no text in this branch).");

  const summary = await summarizeTexts(texts);
  const node = await createTextNode(
    boardId,
    summary || "_(empty summary)_",
    { x: (root.posX ?? 0), y: (root.posY ?? 0) - 200 },
    null,
  );
  updateTag(tags.board(boardId));
  return node;
}
