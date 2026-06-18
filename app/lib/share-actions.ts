"use server";

import { randomBytes } from "node:crypto";
import { revalidateTag, updateTag } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/app/lib/db";
import { getPrincipal } from "@/app/lib/session";
import { assertCan } from "@/app/lib/authz";
import { tags } from "@/app/lib/cache-tags";
import { parseNodeData, type SnapshotNode, type SnapshotEdge } from "@/app/lib/types";
import { publishLive } from "@/app/lib/live-bus";

// Publish a LIVE read-only view: just flip the published flag (the public surface reads the board's
// current public-safe graph on demand — see getLiveShare). No snapshot is taken anymore.
export async function publishShare(boardId: string): Promise<{ secret: string }> {
  await assertCan(await getPrincipal(), boardId, "share:publish");
  const existing = await prisma.publicShare.findFirst({ where: { boardId }, select: { id: true, secret: true } });
  let secret: string;
  if (existing) {
    secret = existing.secret;
    await prisma.publicShare.update({ where: { id: existing.id }, data: { isPublished: true } });
  } else {
    secret = randomBytes(24).toString("base64url");
    await prisma.publicShare.create({ data: { boardId, secret, mode: "LIVE", isPublished: true } });
  }
  revalidateTag(tags.share(secret), { expire: 0 });
  updateTag(tags.boardMeta(boardId));
  return { secret };
}

export async function unpublishShare(boardId: string): Promise<{ ok: true }> {
  await assertCan(await getPrincipal(), boardId, "share:publish");
  const s = await prisma.publicShare.findFirst({ where: { boardId }, select: { id: true, secret: true } });
  if (s) {
    await prisma.publicShare.update({ where: { id: s.id }, data: { isPublished: false } });
    revalidateTag(tags.share(s.secret), { expire: 0 });
    updateTag(tags.boardMeta(boardId));
  }
  return { ok: true };
}

export async function setSuggestionsOpen(boardId: string, open: boolean): Promise<{ ok: true }> {
  await assertCan(await getPrincipal(), boardId, "share:publish");
  await prisma.publicShare.updateMany({ where: { boardId }, data: { suggestionsOpen: open } });
  return { ok: true };
}

export async function listSuggestions(boardId: string) {
  await assertCan(await getPrincipal(), boardId, "suggestion:accept");
  const share = await prisma.publicShare.findFirst({ where: { boardId }, select: { id: true } });
  if (!share) return [];
  const rows = await prisma.suggestion.findMany({
    where: { shareId: share.id, status: "PENDING" },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, authorName: true, payload: true, createdAt: true },
  });
  // attach per-item vote tallies so the owner sees community sentiment when reviewing ghosts
  const grouped = rows.length
    ? await prisma.suggestionVote.groupBy({
        by: ["suggestionId", "tempId", "value"],
        where: { suggestionId: { in: rows.map((r) => r.id) } },
        _count: { _all: true },
      })
    : [];
  const tally = new Map<string, Record<string, { up: number; down: number }>>();
  for (const g of grouped) {
    const m = tally.get(g.suggestionId) ?? {};
    const cell = m[g.tempId] ?? { up: 0, down: 0 };
    if (g.value > 0) cell.up = g._count._all;
    else cell.down = g._count._all;
    m[g.tempId] = cell;
    tally.set(g.suggestionId, m);
  }
  return rows.map((r) => ({ ...r, votes: tally.get(r.id) ?? {} }));
}

type PNode = { tempId?: string; type?: string; x?: number; y?: number; width?: number | null; height?: number | null; data?: Record<string, unknown> };
type PEdge = { source?: string; target?: string; data?: Record<string, unknown> };
const num = (v: unknown, f: number) => (typeof v === "number" && Number.isFinite(v) ? v : f);
const ALLOWED = new Set(["text", "swatch", "link"]);

// Materialize chosen suggestion items into canonical nodes/edges WITH CREDIT (the anti-grief accept
// flow). `itemTempIds` selects which proposed nodes to adopt now; omit/empty = adopt the whole
// suggestion (the share-page bulk button). Per-item accept is concurrency-safe via a payloadRev
// optimistic lock + an in-transaction re-read, so a moderator's accept and the author's live drag can't
// clobber each other or resurrect a node the author just deleted. Returns the materialized graph so the
// caller (editor) can drop it straight into the canvas.
export async function acceptSuggestion(
  suggestionId: string,
  itemTempIds?: string[] | null,
  posOverrides?: Record<string, { x: number; y: number }> | null,
): Promise<{ ok: true; nodes: SnapshotNode[]; edges: SnapshotEdge[] }> {
  const principal = await getPrincipal();
  const head = await prisma.suggestion.findUnique({
    where: { id: suggestionId },
    select: { share: { select: { boardId: true } } },
  });
  if (!head) throw new Error("Not found");
  const boardId = head.share.boardId;
  await assertCan(principal, boardId, "suggestion:accept");

  const outNodes: SnapshotNode[] = [];
  const outEdges: SnapshotEdge[] = [];
  const resolved: string[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    outNodes.length = 0;
    outEdges.length = 0;
    resolved.length = 0;
    let conflict = false;

    await prisma.$transaction(async (tx) => {
      const cur = await tx.suggestion.findUnique({
        where: { id: suggestionId },
        select: { status: true, payload: true, payloadRev: true, authorName: true },
      });
      if (!cur || cur.status !== "PENDING") throw new Error("Already reviewed");
      const payload = (cur.payload as { nodes?: PNode[]; edges?: PEdge[] }) ?? {};
      const nodes = payload.nodes ?? [];
      const edges = payload.edges ?? [];
      const targets = itemTempIds && itemTempIds.length ? new Set(itemTempIds) : new Set(nodes.map((n) => String(n.tempId)));
      const credit = { name: cur.authorName ?? "anonymous", suggestedAt: new Date().toISOString().slice(0, 10) };

      // 1) Materialize the selected nodes; keep the rest pending.
      const idMap = new Map<string, string>(); // tempId -> new real node id
      const remainingNodes: PNode[] = [];
      let off = 0;
      for (const pn of nodes) {
        const tempId = String(pn.tempId ?? "");
        if (!targets.has(tempId)) { remainingNodes.push(pn); continue; }
        const type = ALLOWED.has(String(pn.type)) ? String(pn.type) : "text";
        let clean: Record<string, unknown>;
        try {
          clean = parseNodeData(type, { ...(pn.data ?? {}), credit });
        } catch {
          continue; // invalid node data — drop it (don't keep an unusable ghost)
        }
        const dims = type === "swatch" ? { width: pn.width ?? 120, height: pn.height ?? 120 } : {};
        // Honor a moderator's drag (posOverrides) — they may have moved the ghost before accepting.
        const ov = posOverrides?.[tempId];
        const posX = ov && Number.isFinite(ov.x) ? ov.x : num(pn.x, 40 + off);
        const posY = ov && Number.isFinite(ov.y) ? ov.y : num(pn.y, 40 + off);
        const created = await tx.node.create({
          data: { boardId, type, layout: "manual", posX, posY, ...dims, data: clean as Prisma.InputJsonValue },
        });
        if (tempId) idMap.set(tempId, created.id);
        resolved.push(tempId);
        off += 36;
        outNodes.push({
          id: created.id, type: created.type, parentId: created.parentId, layout: created.layout,
          collapsed: created.collapsed, order: created.order, x: created.posX ?? 0, y: created.posY ?? 0,
          width: created.width, height: created.height, zIndex: created.zIndex, data: clean,
        });
      }

      // 2) Rewrite edge endpoints that pointed at a just-accepted tempId so they now reference the real
      //    node id (a legal endpoint form). Materialize any edge whose BOTH ends are real board nodes
      //    (verified); leave edges still waiting on a pending ghost in the payload.
      const remap = (ref: string) => idMap.get(ref) ?? ref;
      const pendingTempIds = new Set(remainingNodes.map((n) => String(n.tempId)));
      const remainingEdges: PEdge[] = [];
      for (const pe of edges) {
        const s = remap(String(pe.source ?? ""));
        const t = remap(String(pe.target ?? ""));
        if (!s || !t || s === t) continue; // junk
        if (pendingTempIds.has(s) || pendingTempIds.has(t)) { remainingEdges.push({ source: s, target: t }); continue; }
        // both endpoints claim to be real board node ids — verify ownership before creating the edge
        const found = await tx.node.count({ where: { boardId, id: { in: [s, t] } } });
        if (found !== 2) continue; // an endpoint isn't a real node on this board → drop (never dangle)
        const e = await tx.edge.create({
          data: { boardId, sourceId: s, targetId: t, kind: "connector", type: "animated", animated: true },
        });
        outEdges.push({ id: e.id, source: e.sourceId, target: e.targetId, kind: e.kind, type: e.type, animated: e.animated, label: e.label, data: {} });
      }

      // 3) Write back the surviving payload under the rev lock; empty → the whole suggestion is ACCEPTED.
      const empty = remainingNodes.length === 0;
      const upd = await tx.suggestion.updateMany({
        where: { id: suggestionId, status: "PENDING", payloadRev: cur.payloadRev },
        data: empty
          ? { status: "ACCEPTED", reviewedAt: new Date(), reviewedBy: principal!.userId, payload: { nodes: [], edges: [] } as unknown as Prisma.InputJsonValue, payloadRev: cur.payloadRev + 1 }
          : { payload: { nodes: remainingNodes, edges: remainingEdges } as unknown as Prisma.InputJsonValue, payloadRev: cur.payloadRev + 1 },
      });
      if (upd.count === 0) { conflict = true; throw new Error("conflict"); } // rev moved → roll back + retry
    }).catch((err) => {
      if (conflict) return; // swallow; retry loop handles it
      throw err;
    });

    if (!conflict) break;
  }

  updateTag(tags.board(boardId));
  updateTag(tags.suggestions(boardId));
  if (resolved.length) {
    publishLive(boardId, JSON.stringify({ type: "sug-resolved", op: "accepted", suggestionId, tempIds: resolved }));
    publishLive(boardId, JSON.stringify({ type: "refresh" })); // public spectators pull the now-real nodes
  }
  return { ok: true, nodes: outNodes, edges: outEdges };
}

// Discard chosen items (or the whole suggestion when itemTempIds is omitted). Splices the items + any
// connector touching them out of the payload; when nothing remains the row flips REJECTED.
export async function discardSuggestionItems(
  suggestionId: string,
  itemTempIds?: string[] | null,
): Promise<{ ok: true }> {
  const principal = await getPrincipal();
  const head = await prisma.suggestion.findUnique({
    where: { id: suggestionId },
    select: { share: { select: { boardId: true } } },
  });
  if (!head) return { ok: true };
  const boardId = head.share.boardId;
  await assertCan(principal, boardId, "suggestion:accept");

  const removed: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    removed.length = 0;
    let conflict = false;
    await prisma.$transaction(async (tx) => {
      const cur = await tx.suggestion.findUnique({
        where: { id: suggestionId },
        select: { status: true, payload: true, payloadRev: true },
      });
      if (!cur || cur.status !== "PENDING") throw new Error("Already reviewed");
      const payload = (cur.payload as { nodes?: PNode[]; edges?: PEdge[] }) ?? {};
      const nodes = payload.nodes ?? [];
      const edges = payload.edges ?? [];
      const targets = itemTempIds && itemTempIds.length ? new Set(itemTempIds) : new Set(nodes.map((n) => String(n.tempId)));
      const remainingNodes = nodes.filter((n) => !targets.has(String(n.tempId)));
      for (const n of nodes) if (targets.has(String(n.tempId))) removed.push(String(n.tempId));
      // sweep any connector touching a removed item
      const remainingEdges = edges.filter((e) => !targets.has(String(e.source)) && !targets.has(String(e.target)));
      const empty = remainingNodes.length === 0;
      const upd = await tx.suggestion.updateMany({
        where: { id: suggestionId, status: "PENDING", payloadRev: cur.payloadRev },
        data: empty
          ? { status: "REJECTED", reviewedAt: new Date(), reviewedBy: principal!.userId, payload: { nodes: [], edges: [] } as unknown as Prisma.InputJsonValue, payloadRev: cur.payloadRev + 1 }
          : { payload: { nodes: remainingNodes, edges: remainingEdges } as unknown as Prisma.InputJsonValue, payloadRev: cur.payloadRev + 1 },
      });
      if (upd.count === 0) { conflict = true; throw new Error("conflict"); }
    }).catch((err) => {
      if (conflict) return;
      throw err;
    });
    if (!conflict) break;
  }

  updateTag(tags.suggestions(boardId));
  if (removed.length) publishLive(boardId, JSON.stringify({ type: "sug-resolved", op: "discarded", suggestionId, tempIds: removed }));
  return { ok: true };
}

// Back-compat: the share page's "Reject" rejects the whole suggestion.
export async function rejectSuggestion(suggestionId: string): Promise<{ ok: true }> {
  return discardSuggestionItems(suggestionId, null);
}
